"""Bounded durable writer for per-session timeline item snapshots."""

import asyncio

from logger import get_logger
from schema.agent.events import AgentTimelineItemSchema
from service.agent.event_log import upsert_timeline_items


logger = get_logger(__name__)

_WRITER_QUEUE_CAPACITY = 256
_FLUSH_RETRY_DELAYS_SECONDS = (0.1, 0.5, 1.5)


class TimelinePersistenceError(RuntimeError):
    pass


class _FlushBarrier:
    def __init__(self) -> None:
        self.future: asyncio.Future[None] = asyncio.get_running_loop().create_future()


_QueueItem = AgentTimelineItemSchema | _FlushBarrier | None


class TimelineLogWriter:
    def __init__(self, session_id: str) -> None:
        self._session_id = session_id
        self._queue: asyncio.Queue[_QueueItem] = asyncio.Queue(maxsize=_WRITER_QUEUE_CAPACITY)
        self._task: asyncio.Task[None] | None = None
        self._stop_task: asyncio.Task[None] | None = None
        self._failure: BaseException | None = None
        self._stopping = False
        self._control_lock = asyncio.Lock()

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        if self._stopping or self._task is not None:
            self._raise_unavailable()
            raise TimelinePersistenceError(
                f"timeline writer cannot be restarted for session {self._session_id}"
            )
        self._task = asyncio.create_task(self._run(), name=f"timeline-writer-{self._session_id}")
        self._task.add_done_callback(self._consume_task_result)

    async def enqueue(self, item: AgentTimelineItemSchema) -> None:
        async with self._control_lock:
            self._raise_unavailable()
            await self._put(item)
        self._raise_unavailable()

    async def flush(self) -> None:
        async with self._control_lock:
            self._raise_unavailable(allow_stopping=True)
            task = self._task
            if task is None:
                return
            if self._stopping:
                wait_for_stop = task
                barrier = None
            else:
                wait_for_stop = None
                barrier = _FlushBarrier()
                await self._put(barrier, allow_stopping=True)
        if wait_for_stop is not None:
            await wait_for_stop
        elif barrier is not None:
            await barrier.future
        self._raise_unavailable(allow_stopping=True)

    async def stop(self) -> None:
        stop_task: asyncio.Task[None] | None = None
        try:
            async with self._control_lock:
                writer = self._task
                if writer is None:
                    self._raise_unavailable(allow_stopping=True)
                    return
                stop_task = self._stop_task
                if stop_task is None:
                    self._stopping = True
                    stop_task = asyncio.create_task(
                        self._finish_stop(writer),
                        name=f"timeline-writer-stop-{self._session_id}",
                    )
                    stop_task.add_done_callback(self._consume_task_result)
                    self._stop_task = stop_task
            await asyncio.shield(stop_task)
        except asyncio.CancelledError as cancellation:
            if stop_task is None:
                raise
            try:
                await asyncio.shield(stop_task)
            except asyncio.CancelledError:
                raise
            except BaseException as exc:
                raise cancellation from exc
            raise
        self._raise_unavailable(allow_stopping=True)

    async def _finish_stop(self, writer: asyncio.Task[None]) -> None:
        try:
            await self._put(None, allow_stopping=True)
            await writer
        finally:
            if not writer.done():
                writer.cancel()
                try:
                    await writer
                except BaseException:
                    pass
            async with self._control_lock:
                if self._task is writer:
                    self._task = None

    async def _run(self) -> None:
        try:
            while True:
                first = await self._queue.get()
                if await self._process_batch(first):
                    return
        except asyncio.CancelledError as exc:
            failure = TimelinePersistenceError(
                f"timeline writer canceled for session {self._session_id}"
            )
            failure.__cause__ = exc
            self._failure = failure
            self._fail_queued_barriers(failure)
            raise
        except BaseException as exc:
            self._failure = exc
            self._fail_queued_barriers(exc)
            raise

    async def _process_batch(self, first: _QueueItem) -> bool:
        pending: dict[str, AgentTimelineItemSchema] = {}
        barriers: list[_FlushBarrier] = []
        stopping = self._collect(first, pending, barriers)
        while not stopping:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            stopping = self._collect(item, pending, barriers)

        try:
            await self._persist(list(pending.values()))
        except BaseException as exc:
            for barrier in barriers:
                if not barrier.future.done():
                    barrier.future.set_exception(exc)
            raise
        else:
            for barrier in barriers:
                if not barrier.future.done():
                    barrier.future.set_result(None)
        return stopping

    @staticmethod
    def _collect(
        item: _QueueItem,
        pending: dict[str, AgentTimelineItemSchema],
        barriers: list[_FlushBarrier],
    ) -> bool:
        if item is None:
            return True
        if isinstance(item, _FlushBarrier):
            barriers.append(item)
            return False
        current = pending.get(item.item_id)
        if current is None or item.revision > current.revision:
            pending[item.item_id] = item
        return False

    async def _persist(self, items: list[AgentTimelineItemSchema]) -> None:
        if not items:
            return
        attempts = len(_FLUSH_RETRY_DELAYS_SECONDS) + 1
        for attempt in range(attempts):
            try:
                await upsert_timeline_items(self._session_id, items)
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if attempt + 1 >= attempts:
                    raise TimelinePersistenceError(
                        f"timeline persistence failed for session {self._session_id}"
                    ) from exc
                await asyncio.sleep(_FLUSH_RETRY_DELAYS_SECONDS[attempt])

    def _raise_unavailable(self, *, allow_stopping: bool = False) -> None:
        if self._failure is not None:
            raise TimelinePersistenceError(
                f"timeline writer failed for session {self._session_id}"
            ) from self._failure
        if self._stopping and not allow_stopping:
            raise TimelinePersistenceError(f"timeline writer is stopping for session {self._session_id}")
        if self._task is not None and self._task.done() and not self._stopping:
            raise TimelinePersistenceError(f"timeline writer stopped for session {self._session_id}")

    async def _put(self, item: _QueueItem, *, allow_stopping: bool = False) -> None:
        self._raise_unavailable(allow_stopping=allow_stopping)
        writer = self._task
        if writer is None:
            raise TimelinePersistenceError(f"timeline writer is not running for session {self._session_id}")
        put_task = asyncio.create_task(self._queue.put(item))
        try:
            done, _ = await asyncio.wait(
                {put_task, writer},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if put_task not in done:
                put_task.cancel()
                try:
                    await put_task
                except asyncio.CancelledError:
                    pass
                self._raise_unavailable(allow_stopping=allow_stopping)
                raise TimelinePersistenceError(
                    f"timeline writer stopped while enqueueing for session {self._session_id}"
                )
            await put_task
            self._raise_unavailable(allow_stopping=allow_stopping)
        finally:
            if not put_task.done():
                put_task.cancel()
                try:
                    await put_task
                except BaseException:
                    pass

    def _consume_task_result(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            logger.error(
                "timeline writer task failed session=%s task=%s",
                self._session_id,
                task.get_name(),
                exc_info=(type(exc), exc, exc.__traceback__),
            )

    def _fail_queued_barriers(self, exc: BaseException) -> None:
        while True:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            if isinstance(item, _FlushBarrier) and not item.future.done():
                item.future.set_exception(exc)
