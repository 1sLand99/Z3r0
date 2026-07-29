from datetime import datetime
import base64
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator

from schema.agent.subordinates import AgentSubordinateStatus


class AgentEventTypeSchema(StrEnum):
    USER_MESSAGE = "user_message"
    TURN_BOUNDARY = "turn_boundary"
    RUN_STATE = "run_state"
    THINKING_DELTA = "thinking_delta"
    THINKING_COMPLETE = "thinking_complete"
    TEXT_DELTA = "text_delta"
    TEXT_COMPLETE = "text_complete"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    SUBAGENT_TASK = "subagent_task"
    DONE = "done"
    ERROR = "error"


class AgentTimelineItemTypeSchema(StrEnum):
    USER_MESSAGE = "user_message"
    TURN_BOUNDARY = "turn_boundary"
    THINKING = "thinking"
    TEXT = "text"
    TOOL = "tool"
    SUBAGENT = "subagent"
    ERROR = "error"


class AgentTimelineContentStateSchema(StrEnum):
    STREAMING = "streaming"
    COMPLETED = "completed"


class AgentTimelineToolStateSchema(StrEnum):
    PENDING = "pending"
    COMPLETED = "completed"
    FAILED = "failed"


class AgentStreamFrameTypeSchema(StrEnum):
    SNAPSHOT = "snapshot"
    ITEM_UPSERT = "item_upsert"
    TEXT_APPEND = "text_append"
    RUN_STATE = "run_state"


class AgentInputPartTypeSchema(StrEnum):
    TEXT = "text"
    IMAGE = "image"


class AgentImageDetailSchema(StrEnum):
    AUTO = "auto"
    LOW = "low"
    HIGH = "high"


class AgentImageMediaTypeSchema(StrEnum):
    PNG = "image/png"
    JPEG = "image/jpeg"
    WEBP = "image/webp"


MAX_AGENT_IMAGES = 4
MAX_AGENT_IMAGE_BYTES = 15 * 1024 * 1024 // 4
MAX_AGENT_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024
MAX_AGENT_TEXT_INPUT_CHARS = 20000


def _base64_length(byte_count: int) -> int:
    return ((byte_count + 2) // 3) * 4


_MAX_IMAGE_BASE64_LENGTH = _base64_length(MAX_AGENT_IMAGE_BYTES)


class AgentTextInputPart(BaseModel):
    type: Literal[AgentInputPartTypeSchema.TEXT] = AgentInputPartTypeSchema.TEXT
    text: str = Field(min_length=1, max_length=MAX_AGENT_TEXT_INPUT_CHARS)

    @field_validator("text", mode="before")
    @classmethod
    def normalize_text(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip()
        return value


class AgentImageInputPart(BaseModel):
    type: Literal[AgentInputPartTypeSchema.IMAGE] = AgentInputPartTypeSchema.IMAGE
    media_type: AgentImageMediaTypeSchema
    data: str = Field(min_length=1, max_length=_MAX_IMAGE_BASE64_LENGTH)
    detail: AgentImageDetailSchema = AgentImageDetailSchema.AUTO

    @field_validator("data")
    @classmethod
    def validate_base64_data(cls, value: str) -> str:
        compact = "".join(value.split())
        if compact.startswith("data:"):
            raise ValueError("image data must be raw base64 without a data URL prefix")
        try:
            base64.b64decode(compact, validate=True)
        except Exception as exc:
            raise ValueError("image data must be valid base64") from exc
        return compact


AgentInputPart = Annotated[
    AgentTextInputPart | AgentImageInputPart,
    Field(discriminator="type"),
]


class _AgentScopedEvent(BaseModel):
    created_at: datetime
    agent_name: str = ""
    # when set, this event was streamed from inside a nested subagent call.
    # `nested_for` is the parent agent code; `nested_call_id` matches the
    # parent's function_call.call_id so the UI can attach the event to the
    # corresponding ToolCard
    nested_for: str = ""
    nested_call_id: str = ""


class UserMessageEvent(BaseModel):
    type: Literal[AgentEventTypeSchema.USER_MESSAGE] = AgentEventTypeSchema.USER_MESSAGE
    created_at: datetime
    content: list[AgentInputPart] = Field(min_length=1)
    display_text: str = ""
    # the agent this message was @-mentioned to; UI renders it as a "@<name>" chip
    target_agent_code: str = ""


class TurnBoundaryEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.TURN_BOUNDARY] = AgentEventTypeSchema.TURN_BOUNDARY


class RunStateEvent(BaseModel):
    type: Literal[AgentEventTypeSchema.RUN_STATE] = AgentEventTypeSchema.RUN_STATE
    created_at: datetime
    running: bool


class TextDeltaEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.TEXT_DELTA] = AgentEventTypeSchema.TEXT_DELTA
    segment_id: str
    delta: str
    text: str


class TextCompleteEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.TEXT_COMPLETE] = AgentEventTypeSchema.TEXT_COMPLETE
    segment_id: str
    text: str


class ThinkingDeltaEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.THINKING_DELTA] = AgentEventTypeSchema.THINKING_DELTA
    segment_id: str
    delta: str
    text: str


class ThinkingCompleteEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.THINKING_COMPLETE] = AgentEventTypeSchema.THINKING_COMPLETE
    segment_id: str
    text: str


class ToolCallEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.TOOL_CALL] = AgentEventTypeSchema.TOOL_CALL
    call_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolResultEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.TOOL_RESULT] = AgentEventTypeSchema.TOOL_RESULT
    call_id: str
    output: str = ""
    is_error: bool = False


class SubagentTaskEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.SUBAGENT_TASK] = AgentEventTypeSchema.SUBAGENT_TASK
    run_id: str
    parent_agent_code: str = ""
    parent_agent_instance_id: str = ""
    agent_code: str
    status: AgentSubordinateStatus
    result_preview: str = ""
    error_preview: str = ""
    result_chars: int = 0
    error_chars: int = 0
    truncated: bool = False
    progress: str = ""


class DoneEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.DONE] = AgentEventTypeSchema.DONE


class ErrorEvent(_AgentScopedEvent):
    type: Literal[AgentEventTypeSchema.ERROR] = AgentEventTypeSchema.ERROR
    message: str
    code: str = ""


AgentEventSchema = Annotated[
    UserMessageEvent
    | TurnBoundaryEvent
    | RunStateEvent
    | TextDeltaEvent
    | TextCompleteEvent
    | ThinkingDeltaEvent
    | ThinkingCompleteEvent
    | ToolCallEvent
    | ToolResultEvent
    | SubagentTaskEvent
    | DoneEvent
    | ErrorEvent,
    Field(discriminator="type"),
]


class _AgentTimelineItem(BaseModel):
    item_id: str = Field(min_length=1)
    sequence: int = Field(ge=1)
    revision: int = Field(ge=1)
    created_at: datetime
    agent_name: str = ""
    parent_item_id: str | None = None


class AgentTimelineUserMessageItem(_AgentTimelineItem):
    type: Literal[AgentTimelineItemTypeSchema.USER_MESSAGE] = AgentTimelineItemTypeSchema.USER_MESSAGE
    content: list[AgentInputPart] = Field(min_length=1)
    display_text: str = ""
    target_agent_code: str = ""


class AgentTimelineTurnBoundaryItem(_AgentTimelineItem):
    type: Literal[AgentTimelineItemTypeSchema.TURN_BOUNDARY] = AgentTimelineItemTypeSchema.TURN_BOUNDARY


class AgentTimelineThinkingItem(_AgentTimelineItem):
    type: Literal[AgentTimelineItemTypeSchema.THINKING] = AgentTimelineItemTypeSchema.THINKING
    text: str = ""
    state: AgentTimelineContentStateSchema = AgentTimelineContentStateSchema.STREAMING


class AgentTimelineTextItem(_AgentTimelineItem):
    type: Literal[AgentTimelineItemTypeSchema.TEXT] = AgentTimelineItemTypeSchema.TEXT
    text: str = ""
    state: AgentTimelineContentStateSchema = AgentTimelineContentStateSchema.STREAMING


class AgentTimelineAttachmentTypeSchema(StrEnum):
    REPORT = "report"


class AgentTimelineReportAttachment(BaseModel):
    type: Literal[AgentTimelineAttachmentTypeSchema.REPORT] = AgentTimelineAttachmentTypeSchema.REPORT
    report_id: str
    filename: str
    size: int = Field(ge=0)
    chars: int = Field(ge=0)


AgentTimelineAttachmentSchema = Annotated[
    AgentTimelineReportAttachment,
    Field(discriminator="type"),
]


class AgentTimelineToolItem(_AgentTimelineItem):
    type: Literal[AgentTimelineItemTypeSchema.TOOL] = AgentTimelineItemTypeSchema.TOOL
    call_id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    output: str = ""
    state: AgentTimelineToolStateSchema = AgentTimelineToolStateSchema.PENDING
    attachments: list[AgentTimelineAttachmentSchema] = Field(default_factory=list)


class AgentTimelineSubagentItem(_AgentTimelineItem):
    type: Literal[AgentTimelineItemTypeSchema.SUBAGENT] = AgentTimelineItemTypeSchema.SUBAGENT
    run_id: str
    parent_agent_code: str = ""
    parent_agent_instance_id: str = ""
    agent_code: str
    status: AgentSubordinateStatus
    result_preview: str = ""
    error_preview: str = ""
    result_chars: int = 0
    error_chars: int = 0
    truncated: bool = False
    progress: str = ""


class AgentTimelineErrorItem(_AgentTimelineItem):
    type: Literal[AgentTimelineItemTypeSchema.ERROR] = AgentTimelineItemTypeSchema.ERROR
    message: str
    code: str = ""


AgentTimelineItemSchema = Annotated[
    AgentTimelineUserMessageItem
    | AgentTimelineTurnBoundaryItem
    | AgentTimelineThinkingItem
    | AgentTimelineTextItem
    | AgentTimelineToolItem
    | AgentTimelineSubagentItem
    | AgentTimelineErrorItem,
    Field(discriminator="type"),
]


class AgentStreamSnapshotFrame(BaseModel):
    type: Literal[AgentStreamFrameTypeSchema.SNAPSHOT] = AgentStreamFrameTypeSchema.SNAPSHOT
    main_agent_running: bool
    latest_sequence: int = Field(ge=0)
    items: list[AgentTimelineItemSchema]


class AgentStreamItemUpsertFrame(BaseModel):
    type: Literal[AgentStreamFrameTypeSchema.ITEM_UPSERT] = AgentStreamFrameTypeSchema.ITEM_UPSERT
    item: AgentTimelineItemSchema


class AgentStreamTextAppendFrame(BaseModel):
    type: Literal[AgentStreamFrameTypeSchema.TEXT_APPEND] = AgentStreamFrameTypeSchema.TEXT_APPEND
    item_id: str = Field(min_length=1)
    sequence: int = Field(ge=1)
    revision: int = Field(ge=1)
    delta: str


class AgentStreamRunStateFrame(BaseModel):
    type: Literal[AgentStreamFrameTypeSchema.RUN_STATE] = AgentStreamFrameTypeSchema.RUN_STATE
    main_agent_running: bool


AgentStreamFrameSchema = Annotated[
    AgentStreamSnapshotFrame
    | AgentStreamItemUpsertFrame
    | AgentStreamTextAppendFrame
    | AgentStreamRunStateFrame,
    Field(discriminator="type"),
]


def validate_agent_input_content(content: list[AgentInputPart]) -> None:
    image_count = sum(1 for part in content if isinstance(part, AgentImageInputPart))
    if image_count > MAX_AGENT_IMAGES:
        raise ValueError(f"at most {MAX_AGENT_IMAGES} images are allowed in one message")
    image_bytes = sum(
        _decoded_base64_length(part.data)
        for part in content
        if isinstance(part, AgentImageInputPart)
    )
    if image_bytes > MAX_AGENT_TOTAL_IMAGE_BYTES:
        raise ValueError("image payload is too large")


def _decoded_base64_length(value: str) -> int:
    padding = len(value) - len(value.rstrip("="))
    return len(value) * 3 // 4 - padding
