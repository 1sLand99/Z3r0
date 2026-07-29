import {
  AGENT_STREAM_FRAME_TYPE,
  AGENT_TIMELINE_CONTENT_STATE,
  AGENT_TIMELINE_ITEM_TYPE,
  AGENT_TIMELINE_TOOL_STATE,
} from "../../shared/api/generated/constants";
import type {
  AgentStreamFrame,
  AgentTimelineItem,
  AgentTimelineSubagentItem,
  AgentTimelineToolItem,
} from "../../shared/api/types";
import type {
  AgentTranscript,
  ChatNode,
  ChatState,
  ReportAttachmentItem,
  SubagentExecutionItem,
  ToolExecutionItem,
  TranscriptAttachmentItem,
  TranscriptBlock,
} from "./transcriptTypes";

type BlockLocation = {
  nodeIndex: number;
  path: number[];
  placement: "block" | "subagent";
};

export type TimelineRuntime = {
  items: Map<string, AgentTimelineItem>;
  orderedItemIds: string[];
  locations: Map<string, BlockLocation>;
  userNodeIndexes: Map<string, number>;
  latestSequence: number;
  currentAgentNodeIndex: number | null;
  state: ChatState;
};

export function createTimelineRuntime(): TimelineRuntime {
  return {
    items: new Map(),
    orderedItemIds: [],
    locations: new Map(),
    userNodeIndexes: new Map(),
    latestSequence: 0,
    currentAgentNodeIndex: null,
    state: { nodes: [], streaming: false },
  };
}

export function mergeTimelinePage(
  runtime: TimelineRuntime,
  items: readonly AgentTimelineItem[],
): TimelineRuntime {
  let changed = false;
  for (const item of items) {
    const current = runtime.items.get(item.item_id);
    if (current && current.revision >= item.revision) continue;
    runtime.items.set(item.item_id, item);
    changed = true;
  }
  return changed ? rebuildTimeline(runtime) : runtime;
}

export function applyTimelineUpdates(
  runtime: TimelineRuntime,
  items: readonly AgentTimelineItem[],
  mainAgentRunning: boolean,
): TimelineRuntime {
  let next = applyItemsIncrementally(runtime, items);
  if (next.state.streaming !== mainAgentRunning) {
    next = { ...next, state: { ...next.state, streaming: mainAgentRunning } };
  }
  return next;
}

export function applyStreamFrames(
  runtime: TimelineRuntime,
  frames: readonly AgentStreamFrame[],
): TimelineRuntime {
  let next = runtime;
  let running = runtime.state.streaming;

  for (const frame of frames) {
    switch (frame.type) {
      case AGENT_STREAM_FRAME_TYPE.SNAPSHOT:
        running = frame.main_agent_running;
        next.latestSequence = Math.max(next.latestSequence, frame.latest_sequence);
        next = applyItemsIncrementally(next, frame.items);
        break;
      case AGENT_STREAM_FRAME_TYPE.ITEM_UPSERT:
        next = applyItemsIncrementally(next, [frame.item]);
        break;
      case AGENT_STREAM_FRAME_TYPE.TEXT_APPEND:
        next = applyTextAppend(next, frame);
        break;
      case AGENT_STREAM_FRAME_TYPE.RUN_STATE:
        running = frame.main_agent_running;
        break;
    }
  }

  if (next.state.streaming !== running) {
    next = { ...next, state: { ...next.state, streaming: running } };
  }
  return next;
}

export function endTimelineStream(runtime: TimelineRuntime): TimelineRuntime {
  if (!runtime.state.streaming) return runtime;
  return { ...runtime, state: { ...runtime.state, streaming: false } };
}

function applyItemsIncrementally(
  runtime: TimelineRuntime,
  items: readonly AgentTimelineItem[],
): TimelineRuntime {
  if (!items.length) return runtime;
  let next = runtime;
  let requiresRebuild = false;
  const ordered = [...items].sort((left, right) => left.sequence - right.sequence);

  for (const item of ordered) {
    const current = next.items.get(item.item_id);
    if (current && current.revision >= item.revision) continue;
    next.items.set(item.item_id, item);
    if (current) {
      if (current.sequence !== item.sequence) {
        requiresRebuild = true;
        continue;
      }
      next = replaceRenderedItem(next, item);
      continue;
    }
    if (item.sequence <= next.latestSequence) {
      requiresRebuild = true;
      continue;
    }
    next.orderedItemIds.push(item.item_id);
    next.latestSequence = item.sequence;
    next = appendRenderedItem(next, item);
  }

  return requiresRebuild ? rebuildTimeline(next) : next;
}

function applyTextAppend(
  runtime: TimelineRuntime,
  frame: Extract<AgentStreamFrame, { type: "text_append" }>,
): TimelineRuntime {
  const current = runtime.items.get(frame.item_id);
  if (
    !current
    || (current.type !== AGENT_TIMELINE_ITEM_TYPE.TEXT && current.type !== AGENT_TIMELINE_ITEM_TYPE.THINKING)
    || current.sequence !== frame.sequence
    || frame.revision !== current.revision + 1
  ) {
    return runtime;
  }
  const item = { ...current, revision: frame.revision, text: current.text + frame.delta };
  runtime.items.set(item.item_id, item);
  return replaceRenderedItem(runtime, item);
}

function rebuildTimeline(runtime: TimelineRuntime): TimelineRuntime {
  runtime.orderedItemIds = [...runtime.items.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map((item) => item.item_id);
  runtime.locations.clear();
  runtime.userNodeIndexes.clear();
  runtime.latestSequence = 0;
  runtime.currentAgentNodeIndex = null;
  const streaming = runtime.state.streaming;
  runtime.state = { nodes: [], streaming };
  let next = runtime;
  for (const itemId of runtime.orderedItemIds) {
    const item = runtime.items.get(itemId);
    if (!item) continue;
    runtime.latestSequence = Math.max(runtime.latestSequence, item.sequence);
    next = appendRenderedItem(next, item);
  }
  return next;
}

function appendRenderedItem(runtime: TimelineRuntime, item: AgentTimelineItem): TimelineRuntime {
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE) {
    const nodes = runtime.state.nodes.slice();
    const nodeIndex = nodes.length;
    nodes.push({
      kind: "user",
      id: item.item_id,
      createdAt: item.created_at,
      content: item.content,
      displayText: item.display_text,
      targetAgentCode: item.target_agent_code,
    });
    runtime.userNodeIndexes.set(item.item_id, nodeIndex);
    runtime.currentAgentNodeIndex = null;
    return withNodes(runtime, nodes);
  }
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.TURN_BOUNDARY) {
    if (!item.parent_item_id) runtime.currentAgentNodeIndex = null;
    return runtime;
  }

  if (item.parent_item_id) {
    return appendNestedItem(runtime, item);
  }

  const nodes = runtime.state.nodes.slice();
  let nodeIndex = runtime.currentAgentNodeIndex;
  let agent = nodeIndex === null ? null : nodes[nodeIndex];
  if (!agent || agent.kind !== "agent") {
    nodeIndex = nodes.length;
    agent = {
      kind: "agent",
      id: `agent:${item.item_id}`,
      ...createTranscript(item.created_at, item.agent_name),
    };
    nodes.push(agent);
    runtime.currentAgentNodeIndex = nodeIndex;
  } else if (nodeIndex !== null) {
    agent = cloneAgentNode(agent);
    if (!agent.agentName && item.agent_name) agent.agentName = item.agent_name;
    nodes[nodeIndex] = agent;
  }
  const block = blockFromItem(item);
  if (!block) return withNodes(runtime, nodes);
  if (nodeIndex === null) return runtime;
  const blockIndex = agent.blocks.length;
  agent.blocks.push(block);
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.TOOL) {
    agent.attachments = mergeToolAttachments(agent.attachments, item);
  }
  runtime.locations.set(item.item_id, { nodeIndex, path: [blockIndex], placement: "block" });
  return withNodes(runtime, nodes);
}

function appendNestedItem(runtime: TimelineRuntime, item: AgentTimelineItem): TimelineRuntime {
  const parent = runtime.locations.get(item.parent_item_id ?? "");
  if (!parent || parent.placement !== "block") return runtime;
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.SUBAGENT) {
    const nodes = updateToolAtPath(runtime.state.nodes, parent, (tool) => ({
      ...tool,
      subagentTask: subagentFromItem(item),
    }));
    runtime.locations.set(item.item_id, { ...parent, placement: "subagent" });
    return withNodes(runtime, nodes);
  }
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.TURN_BOUNDARY) return runtime;
  const block = blockFromItem(item);
  if (!block) return runtime;
  let childIndex = -1;
  const nodes = updateToolAtPath(runtime.state.nodes, parent, (tool) => {
    const nested = cloneTranscript(tool.nested ?? createTranscript(item.created_at, item.agent_name));
    if (!nested.agentName && item.agent_name) nested.agentName = item.agent_name;
    childIndex = nested.blocks.length;
    nested.blocks.push(block);
    if (item.type === AGENT_TIMELINE_ITEM_TYPE.TOOL) {
      nested.attachments = mergeToolAttachments(nested.attachments, item);
    }
    return { ...tool, nested };
  });
  if (childIndex < 0) return runtime;
  runtime.locations.set(item.item_id, {
    nodeIndex: parent.nodeIndex,
    path: [...parent.path, childIndex],
    placement: "block",
  });
  return withNodes(runtime, nodes);
}

function replaceRenderedItem(runtime: TimelineRuntime, item: AgentTimelineItem): TimelineRuntime {
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE) {
    const nodeIndex = runtime.userNodeIndexes.get(item.item_id);
    if (nodeIndex === undefined) return runtime;
    const nodes = runtime.state.nodes.slice();
    nodes[nodeIndex] = {
      kind: "user",
      id: item.item_id,
      createdAt: item.created_at,
      content: item.content,
      displayText: item.display_text,
      targetAgentCode: item.target_agent_code,
    };
    return withNodes(runtime, nodes);
  }
  const location = runtime.locations.get(item.item_id);
  if (!location) return runtime;
  if (location.placement === "subagent" && item.type === AGENT_TIMELINE_ITEM_TYPE.SUBAGENT) {
    return withNodes(runtime, updateToolAtPath(runtime.state.nodes, location, (tool) => ({
      ...tool,
      subagentTask: subagentFromItem(item),
    })));
  }
  const block = blockFromItem(item);
  if (!block) return runtime;
  return withNodes(runtime, replaceBlockAtPath(runtime.state.nodes, location, item, block));
}

function replaceBlockAtPath(
  source: ChatNode[],
  location: BlockLocation,
  item: AgentTimelineItem,
  replacement: TranscriptBlock,
): ChatNode[] {
  const nodes = source.slice();
  const node = nodes[location.nodeIndex];
  if (!node || node.kind !== "agent") return source;
  nodes[location.nodeIndex] = {
    ...node,
    ...replaceTranscriptBlock(node, location.path, 0, item, replacement),
  };
  return nodes;
}

function replaceTranscriptBlock(
  transcript: AgentTranscript,
  path: number[],
  depth: number,
  item: AgentTimelineItem,
  replacement: TranscriptBlock,
): AgentTranscript {
  const index = path[depth];
  const current = transcript.blocks[index];
  if (!current) return transcript;
  const blocks = transcript.blocks.slice();
  if (depth === path.length - 1) {
    blocks[index] = preserveToolChildren(current, replacement);
    return {
      ...transcript,
      blocks,
      attachments: item.type === AGENT_TIMELINE_ITEM_TYPE.TOOL
        ? mergeToolAttachments(transcript.attachments, item)
        : transcript.attachments,
    };
  }
  if (current.kind !== "tool" || !current.nested) return transcript;
  blocks[index] = {
    ...current,
    nested: replaceTranscriptBlock(current.nested, path, depth + 1, item, replacement),
  };
  return { ...transcript, blocks };
}

function updateToolAtPath(
  source: ChatNode[],
  location: BlockLocation,
  update: (tool: ToolExecutionItem) => ToolExecutionItem,
): ChatNode[] {
  const nodes = source.slice();
  const node = nodes[location.nodeIndex];
  if (!node || node.kind !== "agent") return source;
  nodes[location.nodeIndex] = { ...node, ...updateToolInTranscript(node, location.path, 0, update) };
  return nodes;
}

function updateToolInTranscript(
  transcript: AgentTranscript,
  path: number[],
  depth: number,
  update: (tool: ToolExecutionItem) => ToolExecutionItem,
): AgentTranscript {
  const index = path[depth];
  const current = transcript.blocks[index];
  if (!current || current.kind !== "tool") return transcript;
  const blocks = transcript.blocks.slice();
  if (depth === path.length - 1) {
    blocks[index] = update(current);
  } else if (current.nested) {
    blocks[index] = {
      ...current,
      nested: updateToolInTranscript(current.nested, path, depth + 1, update),
    };
  }
  return { ...transcript, blocks };
}

function blockFromItem(item: AgentTimelineItem): TranscriptBlock | null {
  switch (item.type) {
    case AGENT_TIMELINE_ITEM_TYPE.THINKING:
      return {
        kind: "thinking",
        id: item.item_id,
        segmentId: item.item_id,
        text: item.text,
        complete: item.state === AGENT_TIMELINE_CONTENT_STATE.COMPLETED,
      };
    case AGENT_TIMELINE_ITEM_TYPE.TEXT:
      return {
        kind: "text",
        id: item.item_id,
        segmentId: item.item_id,
        text: item.text,
        complete: item.state === AGENT_TIMELINE_CONTENT_STATE.COMPLETED,
      };
    case AGENT_TIMELINE_ITEM_TYPE.TOOL:
      return {
        kind: "tool",
        id: item.item_id,
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments ?? {},
        output: item.output,
        isError: item.state === AGENT_TIMELINE_TOOL_STATE.FAILED,
        resolved: item.state !== AGENT_TIMELINE_TOOL_STATE.PENDING,
      };
    case AGENT_TIMELINE_ITEM_TYPE.SUBAGENT:
      return subagentFromItem(item);
    case AGENT_TIMELINE_ITEM_TYPE.ERROR:
      return { kind: "error", id: item.item_id, message: item.message || "agent run failed" };
    case AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE:
    case AGENT_TIMELINE_ITEM_TYPE.TURN_BOUNDARY:
      return null;
  }
}

function subagentFromItem(item: AgentTimelineSubagentItem): SubagentExecutionItem {
  return {
    kind: "subagent",
    id: item.item_id,
    createdAt: item.created_at,
    runId: item.run_id,
    parentAgentCode: item.parent_agent_code,
    parentAgentInstanceId: item.parent_agent_instance_id,
    agentCode: item.agent_code,
    status: item.status,
    resultPreview: item.result_preview,
    errorPreview: item.error_preview,
    resultChars: item.result_chars,
    errorChars: item.error_chars,
    truncated: item.truncated,
    progress: item.progress,
  };
}

function mergeToolAttachments(
  current: TranscriptAttachmentItem[],
  item: AgentTimelineToolItem,
): TranscriptAttachmentItem[] {
  const retained = current.filter((attachment) => attachment.callId !== item.call_id);
  const additions: ReportAttachmentItem[] = (item.attachments ?? []).map((attachment) => ({
    kind: "report",
    id: `report:${attachment.report_id}`,
    callId: item.call_id,
    reportId: attachment.report_id,
    filename: attachment.filename,
    size: attachment.size,
    chars: attachment.chars,
  }));
  return additions.length || retained.length !== current.length ? [...retained, ...additions] : current;
}

function preserveToolChildren(current: TranscriptBlock, replacement: TranscriptBlock): TranscriptBlock {
  if (current.kind !== "tool" || replacement.kind !== "tool") return replacement;
  return { ...replacement, nested: current.nested, subagentTask: current.subagentTask };
}

function createTranscript(createdAt: string, agentName = ""): AgentTranscript {
  return { createdAt, agentName, blocks: [], attachments: [] };
}

function cloneTranscript(transcript: AgentTranscript): AgentTranscript {
  return {
    ...transcript,
    blocks: transcript.blocks.slice(),
    attachments: transcript.attachments.slice(),
  };
}

function cloneAgentNode(node: Extract<ChatNode, { kind: "agent" }>) {
  return { ...node, ...cloneTranscript(node) };
}

function withNodes(runtime: TimelineRuntime, nodes: ChatNode[]): TimelineRuntime {
  if (nodes === runtime.state.nodes) return runtime;
  return { ...runtime, state: { ...runtime.state, nodes } };
}
