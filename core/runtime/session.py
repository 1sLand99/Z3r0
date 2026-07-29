"""Per-conversation Agent runtime: turn execution and pool lifecycle."""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum, auto
from typing import Any

from agents import Runner

from config import get_config
from core.agent.registry import AgentRegistry, SessionAgentGraph
from core.agent.tool_snapshot import AgentToolSnapshot
from core.conversation.context_budget import build_context_run_config
from core.conversation.retrieval import build_conversation_retrieval_query
from core.conversation.store import Z3r0Session
from core.lightrag.runtime import activate_lightrag_context
from core.runtime.context import AgentRuntimeContext, main_agent_instance_id
from core.runtime.coordination import (
    cancel_sandbox_subagents,
    cancel_session_subagents,
    set_agent_event_publisher,
)
from core.runtime.input_items import build_turn_input_item, display_text_from_content, retrieval_text_from_content
from core.runtime.live_projection import LiveEventProjection
from core.runtime.notification_dispatch import forget_target_notifications, signal_target_notifications
from core.runtime.partial_context import DeltaBuffer, discard_partial_stream, incomplete_segment_events, track_delta
from core.runtime.streaming import StreamIdleTimeout, next_segment_scope
from core.runtime.timeline import TimelineLogWriter
from core.sandbox.command_jobs import cancel_sandbox_async_commands, cancel_session_async_sandbox_commands
from core.task_runtime import InterruptSignal, TurnTrigger, iter_interruptible_events, replace_trigger, run_until_idle
from core.work_project import activate_work_project_context
from database import get_engine
from logger import get_logger
from schema.agent.events import (
    AgentEventSchema,
    AgentInputPart,
    AgentStreamFrameSchema,
    DoneEvent,
    ErrorEvent,
    RunStateEvent,
    TurnBoundaryEvent,
    UserMessageEvent,
)
from schema.agent.notifications import AgentNotificationSnapshot
from service.agent import notifications as agent_notifications
from service.agent.event_log import load_timeline_state
from service.agent.session_state import (
    force_mark_session_stopped as _force_mark_session_stopped,
    mark_session_running as _mark_session_running,
    mark_session_stopped as _mark_session_stopped,
    mark_sessions_stopped as _mark_sessions_stopped,
)


logger = get_logger(__name__)

_SUBSCRIBER_REBASE_THRESHOLD = 512
# Self-heal bound: how many times a driver may relaunch itself to drain
# outstanding work after an abnormal loop exit before it gives up and cancels
# the remaining work (prevents a hot relaunch loop on a persistent fault).
_MAX_DRIVER_RELAUNCH = 5
_DRIVER_RELAUNCH_BACKOFF_SECONDS = 0.5
_SubscriberQueue = asyncio.Queue[AgentStreamFrameSchema | None]


class AgentSessionAgentSwitchError(RuntimeError):
    pass


class _SessionLifecycle(Enum):
    IDLE = auto()
    RUNNING = auto()
    STOPPING = auto()
    CLOSING = auto()
    CLOSED = auto()


class AgentSession:
    def __init__(self, session_id: str, registry: AgentRegistry) -> None:
        self.session_id = session_id
        self._registry = registry
        self._lifecycle_lock = asyncio.Lock()
        self._stop_lock = asyncio.Lock()
        self._projection_lock = asyncio.Lock()
        self._turn_lock = asyncio.Lock()
        self._current_task: asyncio.Task | None = None
        self._driver_generation = 0
        self._lifecycle = _SessionLifecycle.IDLE
        self._subscribers: set[_SubscriberQueue] = set()
        self._live_projection = LiveEventProjection()
        self._timeline_loaded = False
        self._accept_external_events = True
        self._closing_requested = False
        self._log_writer = TimelineLogWriter(session_id)
        self._close_task: asyncio.Task[None] | None = None
        self._main_agent_code: str = ""
        self._active_agent_code: str = ""
        self._active_agent_instance_id: str = ""
        self._main_agent_instance_ids: set[str] = set()
        self._tool_snapshot: AgentToolSnapshot | None = None
        self._agent_graph: SessionAgentGraph | None = None

    def is_running(self) -> bool:
        task = self._current_task
        return task is not None and not task.done()

    @property
    def timeline_loaded(self) -> bool:
        return self._timeline_loaded

    def has_subscribers(self) -> bool:
        return bool(self._subscribers)

    async def subscribe(self) -> _SubscriberQueue:
        async with self._projection_lock:
            if self._closing_requested or self._lifecycle in (
                _SessionLifecycle.CLOSING,
                _SessionLifecycle.CLOSED,
            ):
                raise RuntimeError("agent session is closing")
            await self._ensure_timeline_loaded_locked()
            queue: _SubscriberQueue = asyncio.Queue()
            queue.put_nowait(self._live_projection.snapshot())
            self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: _SubscriberQueue) -> None:
        self._subscribers.discard(queue)

    async def start_turn(
        self,
        content: list[AgentInputPart],
        agent_code: str,
        context: AgentRuntimeContext,
    ) -> list[AgentStreamFrameSchema]:
        async with self._lifecycle_lock:
            self._raise_if_unavailable()
            self._reap_finished_driver_locked()
            if self.is_running():
                if self._active_agent_code and agent_code != self._active_agent_code:
                    raise AgentSessionAgentSwitchError(
                        "stop running tasks before switching agent"
                    )
                return await self._enqueue_user_message(content, agent_code, context)
            try:
                await _mark_session_running(
                    self.session_id,
                    agent_code=agent_code,
                    user_id=context.user.id,
                    sandbox_container_id=context.sandbox_container_id,
                    sandbox_container_generation=context.sandbox_container_generation,
                )
                events = await self._publish_run_state(True)
                events.extend(await self._publish(UserMessageEvent(
                    created_at=datetime.now(),
                    content=content,
                    display_text=display_text_from_content(content),
                    target_agent_code=agent_code,
                )))
            except Exception:
                await _force_mark_session_stopped(self.session_id)
                raise
            self._driver_generation += 1
            generation = self._driver_generation
            task = asyncio.create_task(
                self._drive(
                    content,
                    agent_code,
                    context,
                    generation=generation,
                    initial_user_event_published=True,
                ),
                name=f"agent-turn-{self.session_id}",
            )
            self._active_agent_code = agent_code
            self._active_agent_instance_id = context.agent_instance_id
            self._main_agent_instance_ids.add(context.agent_instance_id)
            self._set_driver(task)
            self._lifecycle = _SessionLifecycle.RUNNING
            return events

    async def _enqueue_user_message(
        self,
        content: list[AgentInputPart],
        agent_code: str,
        context: AgentRuntimeContext,
    ) -> list[AgentStreamFrameSchema]:
        # Queue a high-priority notification (instead of interrupting) so the
        # running loop preempts at its next safe point without losing state.
        target_instance = self._active_agent_instance_id or context.agent_instance_id or main_agent_instance_id(
            context.session_id, context.user.id, agent_code,
        )
        self._main_agent_instance_ids.add(target_instance)
        display_text = display_text_from_content(content)
        serialized_content = [part.model_dump() for part in content]
        await agent_notifications.enqueue_user_message_notification(
            session_id=self.session_id,
            target_agent_code=agent_code,
            target_agent_instance_id=target_instance,
            user_content=serialized_content,
            user_display_text=display_text,
            user_requested_agent_code=agent_code,
            sandbox_container_id=context.sandbox_container_id,
            sandbox_container_generation=context.sandbox_container_generation,
            sandbox_skill_metadata=context.sandbox_skill_metadata,
        )
        await signal_target_notifications(target_instance)
        events = await self._publish(UserMessageEvent(
            created_at=datetime.now(),
            content=content,
            display_text=display_text,
            target_agent_code=agent_code,
        ))
        return events

    async def start_notification_recovery(self, context: AgentRuntimeContext, *, recovered: bool = True) -> bool:
        # Launch a driver that drains pending main notifications with no initial
        # turn. recovered=True (boot) surfaces queued user bubbles never shown in
        # this process; recovered=False is the in-process resume kick.
        async with self._lifecycle_lock:
            self._raise_if_unavailable()
            self._reap_finished_driver_locked()
            if self.is_running():
                return False
            if not await agent_notifications.has_pending_main_agent_notification(
                session_id=self.session_id,
            ):
                return False
            try:
                await _mark_session_running(
                    self.session_id,
                    agent_code=context.agent_code,
                    user_id=context.user.id,
                    sandbox_container_id=context.sandbox_container_id,
                    sandbox_container_generation=context.sandbox_container_generation,
                )
                await self._publish_run_state(True)
            except Exception:
                await _force_mark_session_stopped(self.session_id)
                raise
            self._driver_generation += 1
            generation = self._driver_generation
            task = asyncio.create_task(
                self._drive(
                    None,
                    context.agent_code or "",
                    context,
                    generation=generation,
                    recovered=recovered,
                ),
                name=f"agent-recovery-{self.session_id}",
            )
            self._active_agent_code = context.agent_code
            self._active_agent_instance_id = context.agent_instance_id
            self._main_agent_instance_ids.add(context.agent_instance_id)
            self._set_driver(task)
            self._lifecycle = _SessionLifecycle.RUNNING
            return True

    async def interrupt(self) -> list[AgentStreamFrameSchema]:
        async with self._stop_lock:
            async with self._lifecycle_lock:
                self._raise_if_unavailable()
                task = self._current_task
                if not self.is_running() or task is None:
                    return []
                self._lifecycle = _SessionLifecycle.STOPPING
                task.cancel()
            await _await_canceled_task(task)
            await agent_notifications.cancel_main_agent_interrupted_notifications(
                self.session_id,
                "Discarded by user interrupt.",
            )
            await _mark_session_stopped(self.session_id)
            async with self._lifecycle_lock:
                if self._current_task is task:
                    self._clear_driver()
                self._lifecycle = _SessionLifecycle.IDLE
                events = await self._publish_run_state(False)
                await self._forget_active_main_signal()
            await self.flush_timeline()
            return events

    async def cancel_all(self) -> list[AgentStreamFrameSchema]:
        async with self._stop_lock:
            return await self._cancel_all_locked(final_state=_SessionLifecycle.IDLE)

    async def shutdown(self) -> None:
        await self.close()

    async def close(self) -> None:
        self._closing_requested = True
        close_task = self._close_task
        if close_task is None:
            close_task = asyncio.create_task(
                self._close_resources(),
                name=f"agent-session-close-{self.session_id}",
            )
            close_task.add_done_callback(self._consume_close_result)
            self._close_task = close_task
        try:
            await asyncio.shield(close_task)
        except asyncio.CancelledError as cancellation:
            try:
                await asyncio.shield(close_task)
            except asyncio.CancelledError:
                raise
            except BaseException as exc:
                raise cancellation from exc
            raise

    async def _close_resources(self) -> None:
        failures: list[Exception] = []
        async with self._stop_lock:
            async with self._lifecycle_lock:
                if self._lifecycle == _SessionLifecycle.CLOSED:
                    return
                self._lifecycle = _SessionLifecycle.CLOSING
            try:
                await self._cancel_all_locked(final_state=_SessionLifecycle.CLOSING)
            except Exception as exc:
                logger.error(
                    "agent session cancellation failed during close session=%s",
                    self.session_id,
                    exc_info=(type(exc), exc, exc.__traceback__),
                )
                failures.append(exc)

            async with self._projection_lock:
                self._accept_external_events = False
                self._close_subscribers()
                if self._timeline_loaded:
                    try:
                        await self._log_writer.stop()
                    except Exception as exc:
                        logger.error(
                            "timeline writer close failed session=%s",
                            self.session_id,
                            exc_info=(type(exc), exc, exc.__traceback__),
                        )
                        failures.append(exc)
                    finally:
                        self._timeline_loaded = False

            try:
                await self._dispose_agent_graph()
            except Exception as exc:
                logger.error(
                    "agent graph close failed session=%s",
                    self.session_id,
                    exc_info=(type(exc), exc, exc.__traceback__),
                )
                failures.append(exc)

            try:
                await self._forget_active_main_signal()
            except Exception as exc:
                logger.error(
                    "notification signal cleanup failed session=%s",
                    self.session_id,
                    exc_info=(type(exc), exc, exc.__traceback__),
                )
                failures.append(exc)

            async with self._lifecycle_lock:
                self._clear_driver()
                self._lifecycle = _SessionLifecycle.CLOSED

        if failures:
            raise ExceptionGroup(f"agent session close failed: {self.session_id}", failures)

    def _consume_close_result(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            logger.error(
                "agent session close task failed session=%s",
                self.session_id,
                exc_info=(type(exc), exc, exc.__traceback__),
            )

    async def _cancel_all_locked(
        self,
        *,
        final_state: _SessionLifecycle,
    ) -> list[AgentStreamFrameSchema]:
        async with self._lifecycle_lock:
            if self._lifecycle == _SessionLifecycle.CLOSED:
                return []
            closing = self._lifecycle == _SessionLifecycle.CLOSING
            if not closing:
                self._lifecycle = _SessionLifecycle.STOPPING
            task = self._current_task
            if task is not None and not task.done():
                task.cancel()
        if task is not None:
            await _await_canceled_task(task)
        failures = await _gather_labeled_operations(
            [
                ("subagents", cancel_session_subagents(self.session_id)),
                ("sandbox commands", cancel_session_async_sandbox_commands(self.session_id)),
                (
                    "notifications",
                    agent_notifications.cancel_session_notifications(
                        self.session_id,
                        "Agent session tasks canceled by user.",
                    ),
                ),
            ],
            context=f"cancel agent session {self.session_id}",
        )
        await _force_mark_session_stopped(self.session_id)
        async with self._lifecycle_lock:
            self._clear_driver()
            self._lifecycle = final_state
            events = await self._publish_run_state(False)
            await self._forget_active_main_signal()
        await self.flush_timeline()
        _raise_operation_failures(f"cancel agent session {self.session_id}", failures)
        return events

    async def claim_inactive_close(self) -> bool:
        """Atomically prevent new turns/subscribers before pool eviction."""
        async with self._lifecycle_lock:
            task = self._current_task
            stale_driver = self._lifecycle == _SessionLifecycle.RUNNING and task is not None and task.done()
            if self._lifecycle != _SessionLifecycle.IDLE and not stale_driver:
                return False
            previous = self._lifecycle
            previous_accept_external_events = self._accept_external_events
            self._lifecycle = _SessionLifecycle.CLOSING
            self._closing_requested = True
            try:
                async with self._projection_lock:
                    if self._subscribers:
                        self._lifecycle = previous
                        self._closing_requested = False
                        return False
                    self._accept_external_events = False
                    return True
            except BaseException:
                self._lifecycle = previous
                self._closing_requested = False
                self._accept_external_events = previous_accept_external_events
                raise

    def _close_subscribers(self) -> None:
        for queue in tuple(self._subscribers):
            queue.put_nowait(None)
        self._subscribers.clear()

    async def flush_timeline(self) -> None:
        async with self._projection_lock:
            if self._timeline_loaded:
                await self._log_writer.flush()

    def uses_sandbox_container(self, container_id: int) -> bool:
        return self._tool_snapshot is not None and self._tool_snapshot.sandbox_container_id == container_id

    async def invalidate_tool_binding(self) -> None:
        async with self._stop_lock:
            async with self._lifecycle_lock:
                if self._closing_requested or self._lifecycle in (
                    _SessionLifecycle.CLOSING,
                    _SessionLifecycle.CLOSED,
                ):
                    return
            await self._cancel_all_locked(final_state=_SessionLifecycle.STOPPING)
            async with self._lifecycle_lock:
                if self._lifecycle in (_SessionLifecycle.CLOSING, _SessionLifecycle.CLOSED):
                    return
                self._tool_snapshot = None
                await self._dispose_agent_graph()
                self._lifecycle = _SessionLifecycle.IDLE

    async def _execute_turn(
        self,
        trigger: TurnTrigger,
        agent_code: str,
        context: AgentRuntimeContext,
    ) -> Any:
        """Run a single agent turn described by *trigger*.

        Returns the SDK stream result on normal completion.
        Raises ``InterruptSignal`` when preempted by a pending notification.

        Context derivation, user-event emission, and nested-event tagging
        are all governed by the ``TurnTrigger``; callers set those flags
        via ``replace_trigger`` before passing the trigger in.
        """
        if trigger.has_notification:
            turn_context = _context_for_notification(context, trigger.notification)
            turn_agent_code = trigger.notification.target_agent_code
        else:
            turn_context = context
            turn_agent_code = agent_code

        def _tag(event: AgentEventSchema) -> AgentEventSchema:
            return _tag_notification_event(event, turn_context) if trigger.has_notification else event

        memory_session = Z3r0Session(
            session_id=self.session_id,
            engine=get_engine(),
            viewing_agent_code=turn_agent_code,
            agent_code_to_name=self._registry.code_to_name(),
            nested_for_agent_code=turn_context.nested_for_agent_code,
            nested_call_id=turn_context.nested_call_id,
        )
        current_retrieval_text = (
            retrieval_text_from_content(trigger.content)
            if trigger.content_is_retrieval_input
            else ""
        )
        retrieval_query = await build_conversation_retrieval_query(
            memory_session,
            current_retrieval_text,
        )
        async with activate_lightrag_context(turn_context, retrieval_query):
            async with activate_work_project_context(turn_context):
                return await self._execute_turn_with_context(
                    trigger=trigger,
                    turn_agent_code=turn_agent_code,
                    turn_context=turn_context,
                    tag=_tag,
                    memory_session=memory_session,
                )

    async def _execute_turn_with_context(
        self,
        *,
        trigger: TurnTrigger,
        turn_agent_code: str,
        turn_context: AgentRuntimeContext,
        tag: Callable[[AgentEventSchema], AgentEventSchema],
        memory_session: Z3r0Session,
    ) -> Any:
        # Setup phase (graph bind, compaction, runner build) runs under the same
        # exception protection as the stream: a failure here is surfaced as a
        # finalized Error+Done turn instead of escaping and tearing down the
        # session driver. Interrupt/cancel must still propagate.
        try:
            graph = await self._ensure_agent_graph(turn_agent_code, turn_context)
            agent = graph.get(turn_agent_code)
            turn_scope = _next_turn_scope(turn_context)

            if trigger.emit_user_event:
                await self._publish(UserMessageEvent(
                    created_at=datetime.now(),
                    content=trigger.content,
                    display_text=display_text_from_content(trigger.content),
                    target_agent_code=turn_agent_code,
                ))
            elif trigger.has_notification and not trigger.notification.is_user_message:
                # A continuation driven by a hidden notification (e.g. a subagent
                # completion fed back as a user-role context item) starts a new
                # agent turn with no visible user bubble. Emit a turn boundary so
                # the transcript separates it from the previous turn, matching the
                # boundary a real user message would create.
                await self._publish(tag(
                    TurnBoundaryEvent(created_at=datetime.now(), agent_name=agent.name),
                ))

            user_input = [build_turn_input_item(trigger)]
            agent_config = get_config().agents.get(turn_agent_code)
            if agent_config is not None:
                await memory_session.compact_if_needed(
                    agent_config=agent_config,
                    incoming_items=user_input,
                )

            stream = Runner.run_streamed(
                starting_agent=agent,
                session=memory_session,
                input=user_input,
                context=turn_context,
                max_turns=get_config().agent_runtime.main_max_turns,
                run_config=build_context_run_config(agent_config) if agent_config is not None else None,
            )
        except (InterruptSignal, asyncio.CancelledError):
            raise
        except Exception as exc:
            logger.exception("agent turn setup failed session=%s: %s", self.session_id, exc)
            await self._publish(tag(ErrorEvent(
                created_at=datetime.now(),
                agent_name=turn_agent_code,
                message=str(exc) or "agent turn setup failed",
            )))
            await self._publish(tag(DoneEvent(created_at=datetime.now(), agent_name=turn_agent_code)))
            return None

        buffers: dict[str, DeltaBuffer] = {}
        stream_error: ErrorEvent | None = None
        try:
            async for event in iter_interruptible_events(
                stream,
                session_id=self.session_id,
                agent_instance_id=turn_context.agent_instance_id,
                current_agent_name=agent.name,
                segment_scope=turn_scope,
            ):
                track_delta(buffers, event)
                await self._publish(tag(event))
            # Finalize segments left open by providers without a text-done event
            # (e.g. Chat Completions); otherwise the text is never persisted.
            for finalize_event in incomplete_segment_events(buffers, agent_name=agent.name):
                await self._publish(tag(finalize_event))
            buffers.clear()
        except (InterruptSignal, asyncio.CancelledError):
            # Both paths end the turn mid-flight; emit boundary + done so the
            # live projection sees in-flight deltas as finalized and clients
            # don't get a dangling stream on reconnect. Partial buffers are
            # intentionally dropped (see ``discard_partial_stream``).
            await self._finalize_interrupted_turn(
                stream=stream,
                buffers=buffers,
                tag=tag,
                agent_name=agent.name,
            )
            raise
        except StreamIdleTimeout as exc:
            await discard_partial_stream(stream, buffers, log_label="agent")
            logger.warning(
                "agent stream idle timeout session=%s agent=%s phase=%s timeout=%d",
                self.session_id, turn_agent_code, exc.phase, exc.timeout_seconds,
            )
            stream_error = ErrorEvent(created_at=datetime.now(), agent_name=agent.name, message=str(exc))
        except Exception as exc:
            await discard_partial_stream(stream, buffers, log_label="agent")
            logger.exception("agent stream failed session=%s: %s", self.session_id, exc)
            stream_error = ErrorEvent(created_at=datetime.now(), agent_name=agent.name, message=str(exc))
        if stream_error is not None:
            await self._publish(tag(stream_error))
        await self._publish(tag(DoneEvent(created_at=datetime.now(), agent_name=agent.name)))
        return stream

    async def _finalize_interrupted_turn(
        self,
        *,
        stream: Any,
        buffers: dict[str, DeltaBuffer],
        tag: Callable[[AgentEventSchema], AgentEventSchema],
        agent_name: str,
    ) -> None:
        boundary_events = incomplete_segment_events(buffers, agent_name=agent_name)
        await discard_partial_stream(stream, buffers, log_label="agent")
        for evt in boundary_events:
            await self._publish(tag(evt))
        await self._publish(tag(DoneEvent(created_at=datetime.now(), agent_name=agent_name)))

    async def _ensure_agent_graph(self, agent_code: str, context: AgentRuntimeContext) -> SessionAgentGraph:
        tool_snapshot = AgentToolSnapshot.from_context(context)
        if (
            self._agent_graph is None
            or self._main_agent_code != agent_code
            or self._tool_snapshot != tool_snapshot
        ):
            await self._dispose_agent_graph()
            self._main_agent_code = agent_code
            self._tool_snapshot = tool_snapshot
            self._agent_graph = self._registry.bind(tool_snapshot)
            logger.debug(
                "agent graph bound session=%s agent=%s sandbox=%s generation=%d",
                self.session_id,
                agent_code,
                tool_snapshot.sandbox_container_id,
                tool_snapshot.sandbox_container_generation,
            )
        return self._agent_graph

    async def _dispose_agent_graph(self) -> None:
        if self._agent_graph is None:
            return
        await self._agent_graph.close()
        self._agent_graph = None
        self._main_agent_code = ""

    async def _drive(
        self,
        content: list[AgentInputPart] | None,
        agent_code: str,
        context: AgentRuntimeContext,
        *,
        generation: int,
        attempt: int = 0,
        recovered: bool = False,
        initial_user_event_published: bool = False,
    ) -> None:
        # The single main-session driver (true-async, non-blocking): run the
        # optional initial turn, drain ready notifications, then end. On delegation
        # it ends and goes idle while children run; a child's completion kicks
        # resume_session. The finally only reconciles a post-drain claim race.
        async with self._turn_lock:
            task = asyncio.current_task()
            canceled = False
            try:
                context.agent_code = agent_code
                if not context.agent_instance_id:
                    context.agent_instance_id = main_agent_instance_id(
                        context.session_id, context.user.id, agent_code,
                    )

                is_initial = content is not None and not initial_user_event_published

                async def _run_turn(trigger: TurnTrigger) -> Any:
                    nonlocal is_initial
                    if recovered and trigger.notification is not None and trigger.notification.is_user_message:
                        # Boot recovery: the bubble was never published in this
                        # process, so surface it as the turn is consumed.
                        trigger = replace_trigger(trigger, emit_user_event=True)
                    elif is_initial and not trigger.has_notification:
                        trigger = replace_trigger(trigger, emit_user_event=True)
                    is_initial = False
                    return await self._execute_turn(trigger, agent_code, context)

                await run_until_idle(
                    session_id=self.session_id,
                    agent_instance_id=context.agent_instance_id,
                    initial_content=content,
                    run_turn=_run_turn,
                )
            except asyncio.CancelledError:
                canceled = True
                raise
            except Exception as exc:
                logger.exception("agent driver failed session=%s", self.session_id)
                await self._publish(ErrorEvent(created_at=datetime.now(), message=str(exc) or "agent turn failed"))
                await self._publish(DoneEvent(created_at=datetime.now()))
            finally:
                if not canceled and task is not None:
                    await self._settle_driver(
                        task,
                        generation=generation,
                        agent_code=agent_code,
                        context=context,
                        attempt=attempt,
                    )

    async def _settle_driver(
        self,
        task: asyncio.Task[Any],
        *,
        generation: int,
        agent_code: str,
        context: AgentRuntimeContext,
        attempt: int,
    ) -> None:
        pending = await agent_notifications.has_pending_notification(
            session_id=self.session_id,
            target_agent_instance_id=context.agent_instance_id,
        )
        if pending and attempt >= _MAX_DRIVER_RELAUNCH:
            logger.error(
                "agent driver relaunch budget exhausted session=%s target=%s; canceling outstanding work",
                self.session_id,
                context.agent_instance_id,
            )
            await agent_notifications.cancel_session_notifications(
                self.session_id,
                "Agent driver could not make progress.",
            )
            pending = False

        async with self._lifecycle_lock:
            if (
                self._lifecycle != _SessionLifecycle.RUNNING
                or self._driver_generation != generation
                or self._current_task is not task
            ):
                return
            if pending:
                new_task = asyncio.create_task(
                    self._relaunch_driver(
                        _DRIVER_RELAUNCH_BACKOFF_SECONDS * attempt,
                        agent_code,
                        context,
                        generation,
                        attempt + 1,
                    ),
                    name=f"agent-driver-relaunch-{self.session_id}",
                )
                self._set_driver(new_task)
                return

            self._clear_driver()
            await _mark_session_stopped(self.session_id)
            await self._publish_run_state(False)
            await self._forget_active_main_signal()
            await self.flush_timeline()
            self._lifecycle = _SessionLifecycle.IDLE

    async def _relaunch_driver(
        self,
        delay: float,
        agent_code: str,
        context: AgentRuntimeContext,
        generation: int,
        attempt: int,
    ) -> None:
        if delay > 0:
            await asyncio.sleep(delay)
        await self._drive(None, agent_code, context, generation=generation, attempt=attempt)

    async def _publish_run_state(self, running: bool) -> list[AgentStreamFrameSchema]:
        event = RunStateEvent(created_at=datetime.now(), running=running)
        return await self._publish(event)

    async def settle_idle(self) -> None:
        async with self._lifecycle_lock:
            if self._closing_requested or self._lifecycle != _SessionLifecycle.IDLE:
                return
            if await agent_notifications.has_pending_main_agent_notification(session_id=self.session_id):
                return
            await _mark_session_stopped(self.session_id)
            await self._publish_run_state(False)
            await self._forget_active_main_signal()
            await self.flush_timeline()

    async def _publish(self, event: AgentEventSchema) -> list[AgentStreamFrameSchema]:
        return await self._project(event, allow_closing=True)

    async def _ensure_timeline_loaded_locked(self) -> None:
        """Load the durable sequence head and active revision state once."""
        if self._timeline_loaded:
            return
        max_sequence, active_items = await load_timeline_state(self.session_id)
        self._live_projection.initialize(max_sequence, active_items)
        self._timeline_loaded = True
        self._log_writer.start()

    async def publish_external(self, event: AgentEventSchema) -> list[AgentStreamFrameSchema]:
        return await self._project(event, allow_closing=False)

    async def _project(
        self,
        event: AgentEventSchema,
        *,
        allow_closing: bool,
    ) -> list[AgentStreamFrameSchema]:
        async with self._projection_lock:
            self._raise_if_publish_unavailable(allow_closing=allow_closing)
            await self._ensure_timeline_loaded_locked()
            emission = self._live_projection.apply(event)
            for item in emission.persist:
                await self._log_writer.enqueue(item)
            for frame in emission.frames:
                for queue in tuple(self._subscribers):
                    self._enqueue_or_rebase(queue, frame)
            return list(emission.frames)

    def _enqueue_or_rebase(self, queue: _SubscriberQueue, frame: AgentStreamFrameSchema) -> None:
        if queue.qsize() < _SUBSCRIBER_REBASE_THRESHOLD:
            queue.put_nowait(frame)
            return

        while True:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        queue.put_nowait(self._live_projection.snapshot())

    def _raise_if_unavailable(self) -> None:
        if self._closing_requested or self._lifecycle in (
            _SessionLifecycle.STOPPING,
            _SessionLifecycle.CLOSING,
            _SessionLifecycle.CLOSED,
        ):
            raise AgentSessionAgentSwitchError("agent session is stopping")

    def _raise_if_publish_unavailable(self, *, allow_closing: bool) -> None:
        if self._lifecycle == _SessionLifecycle.CLOSED or (
            not allow_closing and (self._closing_requested or not self._accept_external_events)
        ):
            raise RuntimeError("agent session is closed")

    def _set_driver(self, task: asyncio.Task[Any]) -> None:
        task.add_done_callback(self._consume_driver_result)
        self._current_task = task

    def _reap_finished_driver_locked(self) -> None:
        task = self._current_task
        if self._lifecycle != _SessionLifecycle.RUNNING or task is None or not task.done():
            return
        self._consume_driver_result(task)
        logger.error(
            "reaping agent driver that exited before lifecycle settlement session=%s task=%s",
            self.session_id,
            task.get_name(),
        )
        self._clear_driver()
        self._lifecycle = _SessionLifecycle.IDLE

    def _consume_driver_result(self, task: asyncio.Task[Any]) -> None:
        if task.cancelled():
            return
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            logger.error(
                "agent driver task failed session=%s task=%s",
                self.session_id,
                task.get_name(),
                exc_info=(type(exc), exc, exc.__traceback__),
            )

    def _clear_driver(self) -> None:
        self._current_task = None
        self._active_agent_code = ""
        self._active_agent_instance_id = ""

    async def _forget_active_main_signal(self) -> None:
        instance_ids = tuple(self._main_agent_instance_ids)
        self._main_agent_instance_ids.clear()
        for instance_id in instance_ids:
            if instance_id:
                await forget_target_notifications(instance_id)


@dataclass
class _PooledSession:
    session: AgentSession
    last_used_at: float = field(default_factory=time.monotonic)
    closing: bool = False


@dataclass(frozen=True)
class _EvictionCandidate:
    session_id: str
    entry: _PooledSession
    last_used_at: float


class AgentSessionPool:
    def __init__(self, registry: AgentRegistry | None = None) -> None:
        cfg = get_config().agent_pool
        self._registry = registry or AgentRegistry()
        self._max_size = cfg.max_size
        self._ttl = cfg.ttl_seconds
        self._sweep_interval = cfg.sweep_interval_seconds
        self._pool: dict[str, _PooledSession] = {}
        self._sweeper_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._stopping = False

    @property
    def registry(self) -> AgentRegistry:
        return self._registry

    async def start(self) -> None:
        if self._sweeper_task is not None and not self._sweeper_task.done():
            return
        self._stopping = False
        self._sweeper_task = asyncio.create_task(self._sweep_loop(), name="agent-pool-sweeper")
        logger.debug(
            "agent pool started (ttl=%ds, interval=%ds, max_size=%d)",
            self._ttl, self._sweep_interval, self._max_size,
        )

    async def stop(self) -> None:
        self._stopping = True
        task, self._sweeper_task = self._sweeper_task, None
        if task is not None:
            if not task.done():
                task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        async with self._lock:
            entries = list(self._pool.values())
            session_ids = list(self._pool.keys())
            for entry in entries:
                entry.closing = True
        failures = await _gather_labeled_operations(
            [
                (f"session {session_id}", entry.session.shutdown())
                for session_id, entry in zip(session_ids, entries, strict=True)
            ],
            context="stop agent session pool",
        )
        async with self._lock:
            self._pool.clear()
        await _mark_sessions_stopped(session_ids)
        logger.debug("agent pool stopped")
        _raise_operation_failures("stop agent session pool", failures)

    async def get_or_create(self, session_id: str) -> AgentSession:
        async with self._lock:
            if self._stopping:
                raise AgentSessionAgentSwitchError("agent runtime is stopping")
            session = self._get_or_create_locked(session_id)
        await self._enforce_capacity(protected_session_id=session_id)
        return session

    async def _enforce_capacity(self, *, protected_session_id: str = "") -> None:
        async with self._lock:
            candidates = self._capacity_candidates_locked(protected_session_id=protected_session_id)
            overflow = max(0, len(self._pool) - self._max_size)
        evicted = await self._claim_inactive_evictions(candidates, limit=overflow)
        await self._close_evicted(evicted, reason="LRU")

    def _get_or_create_locked(self, session_id: str) -> AgentSession:
        if self._stopping:
            raise AgentSessionAgentSwitchError("agent runtime is stopping")
        entry = self._pool.get(session_id)
        if entry is None:
            entry = _PooledSession(session=AgentSession(session_id, self._registry))
            self._pool[session_id] = entry
            logger.debug("agent pool created session=%s", session_id)
        else:
            if entry.closing:
                raise AgentSessionAgentSwitchError("agent session is stopping")
            entry.last_used_at = time.monotonic()
        return entry.session

    async def discard(self, session_id: str) -> None:
        async with self._lock:
            entry = self._pool.get(session_id)
            if entry is not None:
                entry.closing = True
        if entry is None:
            await cancel_session_subagents(session_id)
            await cancel_session_async_sandbox_commands(session_id)
            await agent_notifications.cancel_session_notifications(
                session_id,
                "Agent session tasks canceled by user.",
            )
            await _force_mark_session_stopped(session_id)
            return
        try:
            await entry.session.shutdown()
        finally:
            async with self._lock:
                if self._pool.get(session_id) is entry:
                    self._pool.pop(session_id)
        logger.debug("agent pool discarded session=%s", session_id)

    async def invalidate_session_tool_binding(self, session_id: str) -> None:
        async with self._lock:
            entry = self._pool.get(session_id)
        if entry is None:
            return
        await entry.session.invalidate_tool_binding()

    async def flush_timeline(self, session_id: str) -> None:
        async with self._lock:
            entry = self._pool.get(session_id)
        if entry is not None:
            await entry.session.flush_timeline()

    async def main_agent_running(self, session_id: str) -> bool:
        async with self._lock:
            entry = self._pool.get(session_id)
            return entry is not None and entry.session.is_running()

    async def try_interrupt(self, session_id: str) -> list[AgentStreamFrameSchema]:
        async with self._lock:
            entry = self._pool.get(session_id)
        if entry is None:
            return []
        return await entry.session.interrupt()

    async def subscribe(self, session_id: str) -> tuple[AgentSession, _SubscriberQueue]:
        session = await self.get_or_create(session_id)
        return session, await session.subscribe()

    async def publish(self, session_id: str, event: AgentEventSchema) -> list[AgentStreamFrameSchema]:
        async with self._lock:
            entry = self._pool.get(session_id)
            if entry is None and self._stopping:
                raise AgentSessionAgentSwitchError("agent runtime is stopping")
            if entry is not None and entry.closing:
                raise AgentSessionAgentSwitchError("agent session is stopping")
            session = entry.session if entry is not None else self._get_or_create_locked(session_id)
        if entry is None:
            await self._enforce_capacity(protected_session_id=session_id)
        return await session.publish_external(event)

    async def settle_session_idle(self, session_id: str) -> None:
        # Wind down a session with no pending main turn (e.g. a canceled task):
        # mark the DB run stopped (no-op while other work is active) and publish
        # run_state=false for a pooled, non-running session.
        async with self._lock:
            entry = self._pool.get(session_id)
        if entry is not None:
            await entry.session.settle_idle()
        else:
            await _mark_session_stopped(session_id)

    async def cancel_all(self, session_id: str) -> list[AgentStreamFrameSchema]:
        async with self._lock:
            entry = self._pool.get(session_id)
        if entry is None:
            await cancel_session_subagents(session_id)
            await cancel_session_async_sandbox_commands(session_id)
            await agent_notifications.cancel_session_notifications(
                session_id,
                "Agent session tasks canceled by user.",
            )
            await _force_mark_session_stopped(session_id)
            return []
        return await entry.session.cancel_all()

    async def invalidate_tool_bindings(self, container_id: int | None = None) -> None:
        async with self._lock:
            entries = [
                entry for entry in self._pool.values()
                if container_id is None or entry.session.uses_sandbox_container(container_id)
            ]
        tasks = [entry.session.invalidate_tool_binding() for entry in entries]
        if container_id is not None:
            tasks.extend([
                cancel_sandbox_subagents(container_id),
                cancel_sandbox_async_commands(container_id),
            ])
        if not tasks:
            return
        failures = await _gather_labeled_operations(
            [(f"operation {index}", task) for index, task in enumerate(tasks, start=1)],
            context=f"invalidate tool bindings container={container_id}",
        )
        logger.debug("agent pool invalidated tool bindings container=%s count=%d", container_id, len(entries))
        _raise_operation_failures(f"invalidate tool bindings container={container_id}", failures)

    async def _sweep_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._sweep_interval)
                async with self._lock:
                    expired = self._sweep_expired_candidates_locked(time.monotonic())
                expired = await self._claim_inactive_evictions(expired)
                await self._close_evicted(expired, reason="idle")
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("agent pool sweep iteration failed")

    def _sweep_expired_candidates_locked(self, now: float) -> list[_EvictionCandidate]:
        if self._ttl <= 0:
            return []
        return [
            _EvictionCandidate(sid, entry, entry.last_used_at) for sid, entry in self._pool.items()
            if (
                not entry.session.is_running()
                and not entry.session.has_subscribers()
                and now - entry.last_used_at > self._ttl
            )
        ]

    def _capacity_candidates_locked(self, *, protected_session_id: str = "") -> list[_EvictionCandidate]:
        # only idle entries are evicted; running sessions may briefly exceed the cap
        overflow = len(self._pool) - self._max_size
        if overflow <= 0:
            return []
        return sorted(
            (
                _EvictionCandidate(sid, entry, entry.last_used_at)
                for sid, entry in self._pool.items()
                if (
                    sid != protected_session_id
                    and not entry.session.is_running()
                    and not entry.session.has_subscribers()
                )
            ),
            key=lambda item: item.last_used_at,
        )

    async def _claim_inactive_evictions(
        self,
        candidates: list[_EvictionCandidate],
        limit: int | None = None,
    ) -> list[tuple[str, _PooledSession]]:
        if not candidates or limit == 0:
            return []
        eligible: list[_EvictionCandidate] = []
        for candidate in candidates:
            entry = candidate.entry
            if entry.closing or entry.session.is_running() or entry.session.has_subscribers():
                continue
            if entry.last_used_at != candidate.last_used_at:
                continue
            eligible.append(candidate)
        if not eligible:
            return []

        active_ids = await agent_notifications.active_session_ids(
            [candidate.session_id for candidate in eligible]
        )
        eligible = [candidate for candidate in eligible if candidate.session_id not in active_ids]
        if limit is not None:
            eligible = eligible[:limit]
        if not eligible:
            return []

        claimed_entries: list[tuple[str, _PooledSession]] = []
        async with self._lock:
            for candidate in eligible:
                sid = candidate.session_id
                entry = self._pool.get(sid)
                if entry is not candidate.entry or entry.closing:
                    continue
                if entry.session.is_running() or entry.session.has_subscribers():
                    continue
                if entry.last_used_at != candidate.last_used_at:
                    continue
                entry.closing = True
                claimed_entries.append((sid, entry))

        close_claims: dict[str, bool] = {}
        for sid, entry in claimed_entries:
            try:
                close_claims[sid] = await entry.session.claim_inactive_close()
            except BaseException as exc:
                logger.error(
                    "agent pool claim close failed session=%s",
                    sid,
                    exc_info=(type(exc), exc, exc.__traceback__),
                )
                close_claims[sid] = False

        evicted: list[tuple[str, _PooledSession]] = []
        async with self._lock:
            for sid, candidate_entry in claimed_entries:
                entry = self._pool.get(sid)
                if entry is not candidate_entry:
                    continue
                if close_claims.get(sid, False):
                    evicted.append((sid, entry))
                else:
                    entry.closing = False
        return evicted

    async def _close_evicted(self, evicted: list[tuple[str, _PooledSession]], *, reason: str) -> None:
        if not evicted:
            return
        failures = await _gather_labeled_operations(
            [(f"session {sid}", entry.session.close()) for sid, entry in evicted],
            context=f"close {reason} evictions",
        )
        async with self._lock:
            for sid, entry in evicted:
                if self._pool.get(sid) is entry:
                    self._pool.pop(sid, None)
        for sid, _ in evicted:
            logger.debug("agent pool evicted %s session=%s", reason, sid)
        _raise_operation_failures(f"close {reason} evictions", failures)


_pool: AgentSessionPool | None = None


def get_agent_pool() -> AgentSessionPool:
    global _pool
    if _pool is None:
        _pool = AgentSessionPool()
    return _pool


def replace_agent_pool(pool: AgentSessionPool | None = None) -> AgentSessionPool:
    global _pool
    _pool = pool or AgentSessionPool()
    return _pool


def get_agent_registry() -> AgentRegistry:
    return get_agent_pool().registry


def _context_for_notification(
    base: AgentRuntimeContext,
    notification: AgentNotificationSnapshot,
) -> AgentRuntimeContext:
    sandbox_container_id, sandbox_generation, sandbox_skill_metadata = _notification_sandbox_scope(
        base,
        notification,
    )
    return AgentRuntimeContext(
        session_id=base.session_id,
        user=base.user,
        agent_code=notification.target_agent_code,
        agent_instance_id=notification.target_agent_instance_id,
        nested_for_agent_code=notification.nested_for_agent_code,
        nested_call_id=notification.nested_call_id,
        sandbox_container_id=sandbox_container_id,
        sandbox_container_generation=sandbox_generation,
        sandbox_skill_metadata=sandbox_skill_metadata,
        work_project_id=base.work_project_id,
        work_item_id=_notification_work_item_id(base, notification),
    )


def _notification_work_item_id(
    base: AgentRuntimeContext,
    notification: AgentNotificationSnapshot,
) -> int | None:
    value = notification.payload.get("work_item_id")
    return value if isinstance(value, int) and value > 0 else base.work_item_id


def _notification_sandbox_scope(
    base: AgentRuntimeContext,
    notification: AgentNotificationSnapshot,
) -> tuple[int | None, int, tuple[str, ...]]:
    if notification.sandbox_container_id is None:
        return None, 0, ()
    if notification.sandbox_container_id != base.sandbox_container_id:
        return None, 0, ()
    return (
        base.sandbox_container_id,
        base.sandbox_container_generation,
        base.sandbox_skill_metadata,
    )


def _tag_notification_event(event: AgentEventSchema, context: AgentRuntimeContext) -> AgentEventSchema:
    if not context.nested_for_agent_code or not hasattr(event, "nested_for"):
        return event
    return event.model_copy(update={
        "nested_for": context.nested_for_agent_code,
        "nested_call_id": context.nested_call_id,
    })


def _next_turn_scope(context: AgentRuntimeContext) -> str:
    owner = context.agent_instance_id or main_agent_instance_id(
        context.session_id,
        context.user.id,
        context.agent_code,
    )
    return next_segment_scope(owner)


async def _publish_to_current_pool(session_id: str, event: AgentEventSchema) -> None:
    await get_agent_pool().publish(session_id, event)


async def _await_canceled_task(task: asyncio.Task[Any]) -> None:
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        logger.error(
            "agent task exited with an error during cancellation task=%s",
            task.get_name(),
            exc_info=(type(exc), exc, exc.__traceback__),
        )


async def _gather_labeled_operations(
    operations: list[tuple[str, Awaitable[Any]]],
    *,
    context: str,
) -> list[Exception]:
    if not operations:
        return []
    results = await asyncio.gather(
        *(operation for _, operation in operations),
        return_exceptions=True,
    )
    failures: list[Exception] = []
    for (label, _), result in zip(operations, results, strict=True):
        if not isinstance(result, BaseException):
            continue
        if isinstance(result, Exception):
            failure = result
        else:
            failure = RuntimeError(f"{label} terminated with {type(result).__name__}")
            failure.__cause__ = result
        logger.error(
            "%s operation failed: %s",
            context,
            label,
            exc_info=(type(result), result, result.__traceback__),
        )
        failures.append(failure)
    return failures


def _raise_operation_failures(context: str, failures: list[Exception]) -> None:
    if failures:
        raise ExceptionGroup(context, failures)


set_agent_event_publisher(_publish_to_current_pool)
