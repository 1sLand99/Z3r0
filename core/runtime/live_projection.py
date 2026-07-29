"""Project internal SDK events into the public, revisioned timeline protocol."""

import json
from dataclasses import dataclass
from uuid import uuid4

from schema.agent.events import (
    AgentEventSchema,
    AgentStreamFrameSchema,
    AgentStreamItemUpsertFrame,
    AgentStreamRunStateFrame,
    AgentStreamSnapshotFrame,
    AgentStreamTextAppendFrame,
    AgentTimelineContentStateSchema,
    AgentTimelineErrorItem,
    AgentTimelineItemSchema,
    AgentTimelineItemTypeSchema,
    AgentTimelineReportAttachment,
    AgentTimelineSubagentItem,
    AgentTimelineTextItem,
    AgentTimelineThinkingItem,
    AgentTimelineToolItem,
    AgentTimelineToolStateSchema,
    AgentTimelineTurnBoundaryItem,
    AgentTimelineUserMessageItem,
    DoneEvent,
    ErrorEvent,
    RunStateEvent,
    SubagentTaskEvent,
    TextCompleteEvent,
    TextDeltaEvent,
    ThinkingCompleteEvent,
    ThinkingDeltaEvent,
    ToolCallEvent,
    ToolResultEvent,
    TurnBoundaryEvent,
    UserMessageEvent,
)
from schema.agent.subordinates import AgentSubordinateStatus
from schema.common.tool_results import (
    ReportToolResultOutputSchema,
    ToolResultSchema,
    ToolResultStatusSchema,
    ToolResultTypeSchema,
)


@dataclass(frozen=True, slots=True)
class TimelineEmission:
    frames: tuple[AgentStreamFrameSchema, ...] = ()
    persist: tuple[AgentTimelineItemSchema, ...] = ()


class LiveEventProjection:
    """Own stable item identity, sequence, revision, and reconnect state."""

    def __init__(self) -> None:
        self._latest_sequence = 0
        self._main_agent_running = False
        self._items: dict[str, AgentTimelineItemSchema] = {}
        self._live_item_ids: dict[str, None] = {}

    @property
    def latest_sequence(self) -> int:
        return self._latest_sequence

    @property
    def main_agent_running(self) -> bool:
        return self._main_agent_running

    def initialize(self, latest_sequence: int, active_items: list[AgentTimelineItemSchema]) -> None:
        self._latest_sequence = max(0, latest_sequence)
        self._items = {item.item_id: item for item in active_items}
        self._live_item_ids = {item.item_id: None for item in active_items}

    def snapshot(self) -> AgentStreamSnapshotFrame:
        items = sorted(
            (self._items[item_id] for item_id in self._live_item_ids if item_id in self._items),
            key=lambda item: item.sequence,
        )
        return AgentStreamSnapshotFrame(
            main_agent_running=self._main_agent_running,
            latest_sequence=self._latest_sequence,
            items=items,
        )

    def apply(self, event: AgentEventSchema) -> TimelineEmission:
        if isinstance(event, RunStateEvent):
            return self._run_state(event.running)
        if isinstance(event, DoneEvent):
            return TimelineEmission()
        if isinstance(event, UserMessageEvent):
            return self._upsert(self._new_user_message(event), persist=True)
        if isinstance(event, TurnBoundaryEvent):
            return self._upsert(self._new_boundary(event), persist=True)
        if isinstance(event, (TextDeltaEvent, ThinkingDeltaEvent)):
            return self._append_content(event)
        if isinstance(event, (TextCompleteEvent, ThinkingCompleteEvent)):
            return self._complete_content(event)
        if isinstance(event, ToolCallEvent):
            return self._tool_call(event)
        if isinstance(event, ToolResultEvent):
            return self._tool_result(event)
        if isinstance(event, SubagentTaskEvent):
            return self._subagent(event)
        if isinstance(event, ErrorEvent):
            return self._upsert(self._new_error(event), persist=True)
        raise TypeError(f"unsupported agent event: {type(event).__name__}")

    def _run_state(self, running: bool) -> TimelineEmission:
        if running and not self._main_agent_running:
            self._prune_terminal_items()
        self._main_agent_running = running
        return TimelineEmission(frames=(AgentStreamRunStateFrame(main_agent_running=running),))

    def _append_content(self, event: TextDeltaEvent | ThinkingDeltaEvent) -> TimelineEmission:
        item_id = _content_item_id(event)
        current = self._items.get(item_id)
        if current is None:
            sequence, revision = self._new_identity()
            item = _content_item(event, item_id=item_id, sequence=sequence, revision=revision)
            return self._upsert(item, persist=False)
        if not isinstance(current, (AgentTimelineTextItem, AgentTimelineThinkingItem)):
            raise RuntimeError(f"timeline item identity collision: {item_id}")
        revision = current.revision + 1
        updated = current.model_copy(update={"revision": revision, "text": event.text})
        self._items[item_id] = updated
        self._live_item_ids[item_id] = None
        return TimelineEmission(frames=(AgentStreamTextAppendFrame(
            item_id=item_id,
            sequence=current.sequence,
            revision=revision,
            delta=event.delta,
        ),))

    def _complete_content(self, event: TextCompleteEvent | ThinkingCompleteEvent) -> TimelineEmission:
        item_id = _content_item_id(event)
        current = self._items.get(item_id)
        if current is None:
            sequence, revision = self._new_identity()
        else:
            if not isinstance(current, (AgentTimelineTextItem, AgentTimelineThinkingItem)):
                raise RuntimeError(f"timeline item identity collision: {item_id}")
            sequence, revision = current.sequence, current.revision + 1
        item = _content_item(
            event,
            item_id=item_id,
            sequence=sequence,
            revision=revision,
            state=AgentTimelineContentStateSchema.COMPLETED,
        )
        return self._upsert(item, persist=True)

    def _tool_call(self, event: ToolCallEvent) -> TimelineEmission:
        if not event.call_id or not event.name:
            return self._upsert(self._protocol_error(event, "invalid_tool_call", "Tool call is missing identity or name."), persist=True)
        item_id = _tool_item_id(event.call_id)
        current = self._items.get(item_id)
        if current is None:
            sequence, revision = self._new_identity()
        elif isinstance(current, AgentTimelineToolItem):
            sequence, revision = current.sequence, current.revision + 1
        else:
            raise RuntimeError(f"timeline item identity collision: {item_id}")
        item = AgentTimelineToolItem(
            item_id=item_id,
            sequence=sequence,
            revision=revision,
            created_at=current.created_at if isinstance(current, AgentTimelineToolItem) else event.created_at,
            agent_name=event.agent_name,
            parent_item_id=_parent_item_id(event.nested_call_id),
            call_id=event.call_id,
            name=event.name,
            arguments=event.arguments,
        )
        return self._upsert(item, persist=True)

    def _tool_result(self, event: ToolResultEvent) -> TimelineEmission:
        item_id = _tool_item_id(event.call_id)
        current = self._items.get(item_id)
        if not isinstance(current, AgentTimelineToolItem):
            return self._upsert(self._protocol_error(
                event,
                "orphan_tool_result",
                f"Tool result arrived before its call: {event.call_id or 'unknown'}.",
            ), persist=True)
        item = current.model_copy(update={
            "revision": current.revision + 1,
            "output": event.output,
            "state": AgentTimelineToolStateSchema.FAILED if event.is_error else AgentTimelineToolStateSchema.COMPLETED,
            "attachments": _attachments_from_tool_output(event.output),
        })
        return self._upsert(item, persist=True)

    def _subagent(self, event: SubagentTaskEvent) -> TimelineEmission:
        item_id = f"subagent:{event.run_id}"
        current = self._items.get(item_id)
        if current is None:
            sequence, revision = self._new_identity()
        elif isinstance(current, AgentTimelineSubagentItem):
            sequence, revision = current.sequence, current.revision + 1
        else:
            raise RuntimeError(f"timeline item identity collision: {item_id}")
        item = AgentTimelineSubagentItem(
            item_id=item_id,
            sequence=sequence,
            revision=revision,
            created_at=current.created_at if isinstance(current, AgentTimelineSubagentItem) else event.created_at,
            agent_name=event.agent_name,
            parent_item_id=_parent_item_id(event.nested_call_id),
            run_id=event.run_id,
            parent_agent_code=event.parent_agent_code,
            parent_agent_instance_id=event.parent_agent_instance_id,
            agent_code=event.agent_code,
            status=event.status,
            result_preview=event.result_preview,
            error_preview=event.error_preview,
            result_chars=event.result_chars,
            error_chars=event.error_chars,
            truncated=event.truncated,
            progress=event.progress,
        )
        return self._upsert(item, persist=True)

    def _new_user_message(self, event: UserMessageEvent) -> AgentTimelineUserMessageItem:
        sequence, revision = self._new_identity()
        return AgentTimelineUserMessageItem(
            item_id=_new_item_id("user"),
            sequence=sequence,
            revision=revision,
            created_at=event.created_at,
            content=event.content,
            display_text=event.display_text,
            target_agent_code=event.target_agent_code,
        )

    def _new_boundary(self, event: TurnBoundaryEvent) -> AgentTimelineTurnBoundaryItem:
        sequence, revision = self._new_identity()
        return AgentTimelineTurnBoundaryItem(
            item_id=_new_item_id("boundary"),
            sequence=sequence,
            revision=revision,
            created_at=event.created_at,
            agent_name=event.agent_name,
            parent_item_id=_parent_item_id(event.nested_call_id),
        )

    def _new_error(self, event: ErrorEvent) -> AgentTimelineErrorItem:
        sequence, revision = self._new_identity()
        return AgentTimelineErrorItem(
            item_id=_new_item_id("error"),
            sequence=sequence,
            revision=revision,
            created_at=event.created_at,
            agent_name=event.agent_name,
            parent_item_id=_parent_item_id(event.nested_call_id),
            message=event.message,
            code=event.code,
        )

    def _protocol_error(self, event: AgentEventSchema, code: str, message: str) -> AgentTimelineErrorItem:
        sequence, revision = self._new_identity()
        return AgentTimelineErrorItem(
            item_id=_new_item_id("error"),
            sequence=sequence,
            revision=revision,
            created_at=event.created_at,
            agent_name=getattr(event, "agent_name", ""),
            parent_item_id=_parent_item_id(getattr(event, "nested_call_id", "")),
            message=message,
            code=code,
        )

    def _upsert(self, item: AgentTimelineItemSchema, *, persist: bool) -> TimelineEmission:
        self._items[item.item_id] = item
        self._live_item_ids[item.item_id] = None
        return TimelineEmission(
            frames=(AgentStreamItemUpsertFrame(item=item),),
            persist=(item,) if persist else (),
        )

    def _new_identity(self) -> tuple[int, int]:
        self._latest_sequence += 1
        return self._latest_sequence, 1

    def _prune_terminal_items(self) -> None:
        retained = {item_id: item for item_id, item in self._items.items() if _is_active(item)}
        self._items = retained
        self._live_item_ids = {item_id: None for item_id in retained}


def _content_item(
    event: TextDeltaEvent | TextCompleteEvent | ThinkingDeltaEvent | ThinkingCompleteEvent,
    *,
    item_id: str,
    sequence: int,
    revision: int,
    state: AgentTimelineContentStateSchema = AgentTimelineContentStateSchema.STREAMING,
) -> AgentTimelineTextItem | AgentTimelineThinkingItem:
    cls = AgentTimelineThinkingItem if isinstance(event, (ThinkingDeltaEvent, ThinkingCompleteEvent)) else AgentTimelineTextItem
    return cls(
        item_id=item_id,
        sequence=sequence,
        revision=revision,
        created_at=event.created_at,
        agent_name=event.agent_name,
        parent_item_id=_parent_item_id(event.nested_call_id),
        text=event.text,
        state=state,
    )


def _content_item_id(event: TextDeltaEvent | TextCompleteEvent | ThinkingDeltaEvent | ThinkingCompleteEvent) -> str:
    prefix = "thinking" if isinstance(event, (ThinkingDeltaEvent, ThinkingCompleteEvent)) else "text"
    return f"{prefix}:{event.segment_id}"


def _tool_item_id(call_id: str) -> str:
    return f"tool:{call_id}"


def _parent_item_id(nested_call_id: str) -> str | None:
    return _tool_item_id(nested_call_id) if nested_call_id else None


def _new_item_id(prefix: str) -> str:
    return f"{prefix}:{uuid4()}"


def _is_active(item: AgentTimelineItemSchema) -> bool:
    if item.type in (AgentTimelineItemTypeSchema.THINKING, AgentTimelineItemTypeSchema.TEXT):
        return item.state == AgentTimelineContentStateSchema.STREAMING
    if item.type == AgentTimelineItemTypeSchema.TOOL:
        return item.state == AgentTimelineToolStateSchema.PENDING
    if item.type == AgentTimelineItemTypeSchema.SUBAGENT:
        return item.status == AgentSubordinateStatus.RUNNING
    return False


def _attachments_from_tool_output(output: str) -> list[AgentTimelineReportAttachment]:
    try:
        result = ToolResultSchema.model_validate_json(output)
        if result.status != ToolResultStatusSchema.SUCCESS or result.type != ToolResultTypeSchema.REPORT:
            return []
        report = ReportToolResultOutputSchema.model_validate(json.loads(result.output))
    except Exception:
        return []
    return [AgentTimelineReportAttachment(
        report_id=report.report_id,
        filename=report.filename,
        size=report.size,
        chars=report.chars,
    )]
