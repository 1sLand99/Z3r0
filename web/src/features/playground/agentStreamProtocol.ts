import {
  AGENT_IMAGE_DETAIL_VALUES,
  AGENT_IMAGE_MEDIA_TYPE_VALUES,
  AGENT_INPUT_PART_TYPE,
  AGENT_STREAM_FRAME_TYPE,
  AGENT_SUBORDINATE_STATUS_VALUES,
  AGENT_TIMELINE_ATTACHMENT_TYPE,
  AGENT_TIMELINE_CONTENT_STATE_VALUES,
  AGENT_TIMELINE_ITEM_TYPE,
  AGENT_TIMELINE_TOOL_STATE_VALUES,
  SESSION_TYPE_VALUES,
} from "../../shared/api/generated/constants";
import type {
  AgentInputPart,
  AgentSessionSummary,
  AgentStreamFrame,
  AgentTimelineItem,
  AgentTurnData,
} from "../../shared/api/types";

const TIMELINE_ITEM_TYPE_SET = new Set<string>(Object.values(AGENT_TIMELINE_ITEM_TYPE));
const CONTENT_STATE_SET = new Set<string>(AGENT_TIMELINE_CONTENT_STATE_VALUES);
const TOOL_STATE_SET = new Set<string>(AGENT_TIMELINE_TOOL_STATE_VALUES);
const SUBORDINATE_STATUS_SET = new Set<string>(AGENT_SUBORDINATE_STATUS_VALUES);
const IMAGE_MEDIA_TYPE_SET = new Set<string>(AGENT_IMAGE_MEDIA_TYPE_VALUES);
const IMAGE_DETAIL_SET = new Set<string>(AGENT_IMAGE_DETAIL_VALUES);
const SESSION_TYPE_SET = new Set<string>(SESSION_TYPE_VALUES);

export type NormalizedTimelinePageData = {
  sessionId: string;
  items: AgentTimelineItem[];
  hasMore: boolean;
  nextBeforeSequence: number | null;
};

export function validAgentSessionSummaries(
  items: unknown,
): AgentSessionSummary[] {
  return Array.isArray(items) ? items.filter(isAgentSessionSummary) : [];
}

export function parseAgentSessionSummary(value: unknown): AgentSessionSummary | null {
  return isAgentSessionSummary(value) ? value : null;
}

export function normalizeAgentTurnData(value: unknown): AgentTurnData | null {
  if (!isRecord(value)) return null;
  const sessionId = Reflect.get(value, "session_id");
  const session = Reflect.get(value, "session");
  const updates = Reflect.get(value, "updates");
  if (
    !isNonEmptyString(sessionId)
    || !isAgentSessionSummary(session)
    || session.session_id !== sessionId
    || typeof Reflect.get(value, "main_agent_running") !== "boolean"
    || !Array.isArray(updates)
  ) return null;
  return {
    ...value,
    session,
    session_id: sessionId,
    updates: validTimelineItems(updates),
  } as AgentTurnData;
}

export function validTimelineItems(items: unknown): AgentTimelineItem[] {
  return Array.isArray(items) ? items.filter(isTimelineItem) : [];
}

export function normalizeAgentTimelinePageData(
  value: unknown,
  expectedSessionId: string,
  beforeSequence: number | null = null,
): NormalizedTimelinePageData | null {
  if (!isRecord(value)) return null;
  const sessionId = Reflect.get(value, "session_id");
  const rawItems = Reflect.get(value, "items");
  const hasMore = Reflect.get(value, "has_more");
  const rawNextBeforeSequence = Reflect.get(value, "next_before_sequence");
  if (
    sessionId !== expectedSessionId
    || !Array.isArray(rawItems)
    || typeof hasMore !== "boolean"
    || !isOptionalPositiveInteger(rawNextBeforeSequence)
  ) return null;

  const nextBeforeSequence = rawNextBeforeSequence ?? null;
  if (
    (hasMore && nextBeforeSequence === null)
    || (!hasMore && nextBeforeSequence !== null)
    || (beforeSequence !== null && nextBeforeSequence !== null && nextBeforeSequence >= beforeSequence)
  ) return null;

  const items = validTimelineItems(rawItems);
  if (beforeSequence !== null && items.some((item) => item.sequence >= beforeSequence)) return null;
  return { sessionId, items, hasMore, nextBeforeSequence };
}

export function parseAgentStreamFrame(value: unknown): AgentStreamFrame | null {
  if (!isRecord(value)) return null;
  const type = Reflect.get(value, "type");
  switch (type) {
    case AGENT_STREAM_FRAME_TYPE.SNAPSHOT: {
      const items = Reflect.get(value, "items");
      const latestSequence = Reflect.get(value, "latest_sequence");
      if (
        !Array.isArray(items)
        || !isNonNegativeInteger(latestSequence)
        || typeof Reflect.get(value, "main_agent_running") !== "boolean"
      ) return null;
      return {
        ...value,
        items: validTimelineItems(items).filter((item) => item.sequence <= latestSequence),
      } as AgentStreamFrame;
    }
    case AGENT_STREAM_FRAME_TYPE.ITEM_UPSERT:
      return isTimelineItem(Reflect.get(value, "item")) ? value as AgentStreamFrame : null;
    case AGENT_STREAM_FRAME_TYPE.TEXT_APPEND:
      return isNonEmptyString(Reflect.get(value, "item_id"))
        && isPositiveInteger(Reflect.get(value, "sequence"))
        && isPositiveInteger(Reflect.get(value, "revision"))
        && typeof Reflect.get(value, "delta") === "string"
        ? value as AgentStreamFrame
        : null;
    case AGENT_STREAM_FRAME_TYPE.RUN_STATE:
      return typeof Reflect.get(value, "main_agent_running") === "boolean" ? value as AgentStreamFrame : null;
    default:
      return null;
  }
}

function isTimelineItem(value: unknown): value is AgentTimelineItem {
  if (!isRecord(value)) return false;
  const type = Reflect.get(value, "type");
  if (
    typeof type !== "string"
    || !TIMELINE_ITEM_TYPE_SET.has(type)
    || !isNonEmptyString(Reflect.get(value, "item_id"))
    || !isPositiveInteger(Reflect.get(value, "sequence"))
    || !isPositiveInteger(Reflect.get(value, "revision"))
    || typeof Reflect.get(value, "created_at") !== "string"
    || typeof Reflect.get(value, "agent_name") !== "string"
    || !isOptionalString(Reflect.get(value, "parent_item_id"))
  ) return false;

  switch (type) {
    case AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE: {
      const content = Reflect.get(value, "content");
      return Array.isArray(content)
        && content.every(isAgentInputPart)
        && typeof Reflect.get(value, "display_text") === "string"
        && typeof Reflect.get(value, "target_agent_code") === "string";
    }
    case AGENT_TIMELINE_ITEM_TYPE.TURN_BOUNDARY:
      return true;
    case AGENT_TIMELINE_ITEM_TYPE.THINKING:
    case AGENT_TIMELINE_ITEM_TYPE.TEXT:
      return typeof Reflect.get(value, "text") === "string"
        && CONTENT_STATE_SET.has(String(Reflect.get(value, "state")));
    case AGENT_TIMELINE_ITEM_TYPE.TOOL: {
      const args = Reflect.get(value, "arguments");
      const attachments = Reflect.get(value, "attachments");
      return isNonEmptyString(Reflect.get(value, "call_id"))
        && isNonEmptyString(Reflect.get(value, "name"))
        && typeof Reflect.get(value, "output") === "string"
        && TOOL_STATE_SET.has(String(Reflect.get(value, "state")))
        && (args === undefined || (isRecord(args) && !Array.isArray(args)))
        && (attachments === undefined || (
          Array.isArray(attachments) && attachments.every(isTimelineReportAttachment)
        ));
    }
    case AGENT_TIMELINE_ITEM_TYPE.SUBAGENT:
      return isNonEmptyString(Reflect.get(value, "run_id"))
        && typeof Reflect.get(value, "parent_agent_code") === "string"
        && typeof Reflect.get(value, "parent_agent_instance_id") === "string"
        && isNonEmptyString(Reflect.get(value, "agent_code"))
        && SUBORDINATE_STATUS_SET.has(String(Reflect.get(value, "status")))
        && typeof Reflect.get(value, "result_preview") === "string"
        && typeof Reflect.get(value, "error_preview") === "string"
        && isNonNegativeInteger(Reflect.get(value, "result_chars"))
        && isNonNegativeInteger(Reflect.get(value, "error_chars"))
        && typeof Reflect.get(value, "truncated") === "boolean"
        && typeof Reflect.get(value, "progress") === "string";
    case AGENT_TIMELINE_ITEM_TYPE.ERROR:
      return typeof Reflect.get(value, "message") === "string"
        && typeof Reflect.get(value, "code") === "string";
    default:
      return false;
  }
}

function isAgentSessionSummary(value: unknown): value is AgentSessionSummary {
  if (!isRecord(value)) return false;
  return isNonEmptyString(Reflect.get(value, "session_id"))
    && typeof Reflect.get(value, "created_at") === "string"
    && typeof Reflect.get(value, "updated_at") === "string"
    && typeof Reflect.get(value, "agent_code") === "string"
    && typeof Reflect.get(value, "is_running") === "boolean"
    && isNonNegativeInteger(Reflect.get(value, "message_count"))
    && isNonNegativeInteger(Reflect.get(value, "owner_id"))
    && isOptionalNonNegativeInteger(Reflect.get(value, "project_id"))
    && typeof Reflect.get(value, "run_error") === "string"
    && isOptionalString(Reflect.get(value, "run_finished_at"))
    && isOptionalString(Reflect.get(value, "run_started_at"))
    && typeof Reflect.get(value, "runtime_agent_code") === "string"
    && isNonNegativeInteger(Reflect.get(value, "runtime_sandbox_container_generation"))
    && isOptionalNonNegativeInteger(Reflect.get(value, "runtime_sandbox_container_id"))
    && isNonNegativeInteger(Reflect.get(value, "selected_sandbox_container_generation"))
    && isOptionalNonNegativeInteger(Reflect.get(value, "selected_sandbox_container_id"))
    && SESSION_TYPE_SET.has(String(Reflect.get(value, "session_type")))
    && typeof Reflect.get(value, "title") === "string";
}

function isAgentInputPart(value: unknown): value is AgentInputPart {
  if (!isRecord(value)) return false;
  const type = Reflect.get(value, "type");
  if (type === AGENT_INPUT_PART_TYPE.TEXT) {
    return isNonEmptyString(Reflect.get(value, "text"));
  }
  if (type === AGENT_INPUT_PART_TYPE.IMAGE) {
    return isNonEmptyString(Reflect.get(value, "data"))
      && IMAGE_MEDIA_TYPE_SET.has(String(Reflect.get(value, "media_type")))
      && IMAGE_DETAIL_SET.has(String(Reflect.get(value, "detail")));
  }
  return false;
}

function isTimelineReportAttachment(value: unknown): boolean {
  return isRecord(value)
    && Reflect.get(value, "type") === AGENT_TIMELINE_ATTACHMENT_TYPE.REPORT
    && isNonEmptyString(Reflect.get(value, "report_id"))
    && isNonEmptyString(Reflect.get(value, "filename"))
    && isNonNegativeInteger(Reflect.get(value, "size"))
    && isNonNegativeInteger(Reflect.get(value, "chars"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNonNegativeInteger(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || isNonNegativeInteger(value);
}

function isOptionalPositiveInteger(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || isPositiveInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
