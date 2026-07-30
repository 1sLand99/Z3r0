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

type TextAppendFrame = Extract<AgentStreamFrame, { type: "text_append" }>;

export type TimelineRuntime = {
  baseItems: Map<string, AgentTimelineItem>;
  streamingItems: Map<string, AgentTimelineItem>;
  baseItemEstimatedBytes: Map<string, number>;
  streamingItemEstimatedBytes: Map<string, number>;
  deferredTextFrames: Map<string, TextAppendFrame[]>;
  orderedItemIds: string[];
  locations: Map<string, BlockLocation>;
  userNodeIndexes: Map<string, number>;
  latestSequence: number;
  currentAgentNodeIndex: number | null;
  currentTargetAgentCode: string;
  estimatedBytes: number;
  deferredEstimatedBytes: number;
  needsReconciliation: boolean;
  subagentVersion: number;
  state: ChatState;
};

type TimelineMutation = {
  ownedObjects: WeakSet<object>;
};

export function createTimelineRuntime(): TimelineRuntime {
  return {
    baseItems: new Map(),
    streamingItems: new Map(),
    baseItemEstimatedBytes: new Map(),
    streamingItemEstimatedBytes: new Map(),
    deferredTextFrames: new Map(),
    orderedItemIds: [],
    locations: new Map(),
    userNodeIndexes: new Map(),
    latestSequence: 0,
    currentAgentNodeIndex: null,
    currentTargetAgentCode: "",
    estimatedBytes: 0,
    deferredEstimatedBytes: 0,
    needsReconciliation: false,
    subagentVersion: 0,
    state: { nodes: [], streaming: false },
  };
}

export function mergeTimelinePage(
  runtime: TimelineRuntime,
  items: readonly AgentTimelineItem[],
): TimelineRuntime {
  return applyItemsIncrementally(runtime, items);
}

export function prependTimelinePage(
  runtime: TimelineRuntime,
  items: readonly AgentTimelineItem[],
): TimelineRuntime {
  if (!items.length) return runtime;
  if (!canPrependTimelinePage(runtime, items)) return applyItemsIncrementally(runtime, items);

  const prefix = applyItemsIncrementally(createTimelineRuntime(), items);
  if (!prefix.orderedItemIds.length) return runtime;
  const nodeOffset = prefix.state.nodes.length;
  const baseItems = new Map(prefix.baseItems);
  const baseItemEstimatedBytes = new Map(prefix.baseItemEstimatedBytes);
  const locations = new Map(prefix.locations);
  const userNodeIndexes = new Map(prefix.userNodeIndexes);

  for (const [itemId, item] of runtime.baseItems) baseItems.set(itemId, item);
  for (const [itemId, bytes] of runtime.baseItemEstimatedBytes) baseItemEstimatedBytes.set(itemId, bytes);
  for (const [itemId, location] of runtime.locations) {
    locations.set(itemId, { ...location, nodeIndex: location.nodeIndex + nodeOffset });
  }
  for (const [itemId, nodeIndex] of runtime.userNodeIndexes) {
    userNodeIndexes.set(itemId, nodeIndex + nodeOffset);
  }

  const hasCurrentItems = runtime.orderedItemIds.length > 0;
  return {
    ...runtime,
    baseItems,
    baseItemEstimatedBytes,
    orderedItemIds: [...prefix.orderedItemIds, ...runtime.orderedItemIds],
    locations,
    userNodeIndexes,
    latestSequence: hasCurrentItems ? runtime.latestSequence : prefix.latestSequence,
    currentAgentNodeIndex: hasCurrentItems
      ? runtime.currentAgentNodeIndex === null ? null : runtime.currentAgentNodeIndex + nodeOffset
      : prefix.currentAgentNodeIndex,
    currentTargetAgentCode: hasCurrentItems
      ? runtime.currentTargetAgentCode
      : prefix.currentTargetAgentCode,
    estimatedBytes: runtime.estimatedBytes + prefix.estimatedBytes,
    subagentVersion: prefix.subagentVersion > 0
      ? runtime.subagentVersion + 1
      : runtime.subagentVersion,
    state: {
      nodes: [...prefix.state.nodes, ...runtime.state.nodes],
      streaming: runtime.state.streaming,
    },
  };
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

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    switch (frame.type) {
      case AGENT_STREAM_FRAME_TYPE.SNAPSHOT:
        running = frame.main_agent_running;
        next = applyItemsIncrementally(next, frame.items);
        break;
      case AGENT_STREAM_FRAME_TYPE.ITEM_UPSERT:
        {
          const items = [frame.item];
          while (index + 1 < frames.length) {
            const candidate = frames[index + 1];
            if (candidate.type !== AGENT_STREAM_FRAME_TYPE.ITEM_UPSERT) break;
            items.push(candidate.item);
            index += 1;
          }
          next = applyItemsIncrementally(next, items);
        }
        break;
      case AGENT_STREAM_FRAME_TYPE.TEXT_APPEND:
        {
          const contiguous = [frame];
          let lastRevision = frame.revision;
          while (index + 1 < frames.length) {
            const candidate = frames[index + 1];
            if (
              candidate.type !== AGENT_STREAM_FRAME_TYPE.TEXT_APPEND
              || candidate.item_id !== frame.item_id
              || candidate.sequence !== frame.sequence
              || candidate.revision !== lastRevision + 1
            ) break;
            lastRevision = candidate.revision;
            contiguous.push(candidate);
            index += 1;
          }
          next = applyTextAppends(next, contiguous);
        }
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

export function getTimelineItem(runtime: TimelineRuntime, itemId: string): AgentTimelineItem | undefined {
  return runtime.streamingItems.get(itemId) ?? runtime.baseItems.get(itemId);
}

function applyItemsIncrementally(
  runtime: TimelineRuntime,
  items: readonly AgentTimelineItem[],
): TimelineRuntime {
  if (!items.length) return runtime;
  let next: TimelineRuntime | null = null;
  let mutation: TimelineMutation | null = null;
  let requiresRebuild = false;
  let subagentsChanged = false;
  const ordered = [...items].sort((left, right) => left.sequence - right.sequence);

  for (const item of ordered) {
    const currentRuntime = next ?? runtime;
    const current = getTimelineItem(currentRuntime, item.item_id);
    if (current && current.revision >= item.revision) continue;
    if (!next) {
      next = cloneTimelineRuntimeForItems(runtime);
      mutation = { ownedObjects: new WeakSet() };
    }
    setTimelineItem(next, item);
    if (item.type === AGENT_TIMELINE_ITEM_TYPE.SUBAGENT) subagentsChanged = true;
    if (current) {
      if (hasStructuralIdentityChange(current, item)) {
        requiresRebuild = true;
        continue;
      }
      next = replaceRenderedItem(next, item, mutation);
      next = replayDeferredTextFrames(next, item.item_id, mutation);
      continue;
    }
    if (item.sequence <= next.latestSequence) {
      requiresRebuild = true;
      next = replayDeferredTextFrames(next, item.item_id, mutation);
      continue;
    }
    next.orderedItemIds.push(item.item_id);
    next.latestSequence = item.sequence;
    next = appendRenderedItem(next, item, mutation);
    next = replayDeferredTextFrames(next, item.item_id, mutation);
  }

  if (!next) return runtime;
  let result = requiresRebuild ? rebuildTimeline(next, mutation) : next;
  if (subagentsChanged || requiresRebuild) {
    result = { ...result, subagentVersion: runtime.subagentVersion + 1 };
  }
  return result;
}

function hasStructuralIdentityChange(
  current: AgentTimelineItem,
  incoming: AgentTimelineItem,
): boolean {
  if (
    current.sequence !== incoming.sequence
    || current.type !== incoming.type
    || (current.parent_item_id ?? null) !== (incoming.parent_item_id ?? null)
  ) return true;
  if (
    current.type === AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE
    && incoming.type === AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE
  ) return current.target_agent_code !== incoming.target_agent_code;
  if (
    current.type === AGENT_TIMELINE_ITEM_TYPE.TOOL
    && incoming.type === AGENT_TIMELINE_ITEM_TYPE.TOOL
  ) return current.call_id !== incoming.call_id;
  return false;
}

function canPrependTimelinePage(
  runtime: TimelineRuntime,
  items: readonly AgentTimelineItem[],
): boolean {
  if (!runtime.orderedItemIds.length) return false;
  const firstCurrent = getTimelineItem(runtime, runtime.orderedItemIds[0]);
  if (
    !firstCurrent
    || firstCurrent.parent_item_id
    || firstCurrent.type !== AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE
  ) return false;

  const incomingIds = new Set<string>();
  const incomingSequences = new Set<number>();
  for (const item of items) {
    if (
      item.sequence >= firstCurrent.sequence
      || incomingIds.has(item.item_id)
      || incomingSequences.has(item.sequence)
      || getTimelineItem(runtime, item.item_id)
      || (item.parent_item_id && getTimelineItem(runtime, item.parent_item_id))
    ) return false;
    incomingIds.add(item.item_id);
    incomingSequences.add(item.sequence);
  }
  for (const itemId of runtime.orderedItemIds) {
    const item = getTimelineItem(runtime, itemId);
    if (item?.parent_item_id && incomingIds.has(item.parent_item_id)) return false;
  }
  return true;
}

function applyTextAppends(
  runtime: TimelineRuntime,
  frames: TextAppendFrame[],
): TimelineRuntime {
  const frame = frames[0];
  const current = getTimelineItem(runtime, frame.item_id);
  const pendingFrames = current
    ? frames.filter((candidate) => candidate.revision > current.revision)
    : frames;
  if (!pendingFrames.length) return runtime;
  const firstPendingFrame = pendingFrames[0];
  const lastPendingFrame = pendingFrames[pendingFrames.length - 1];
  if (
    !current
    || (current.type !== AGENT_TIMELINE_ITEM_TYPE.TEXT && current.type !== AGENT_TIMELINE_ITEM_TYPE.THINKING)
    || current.sequence !== firstPendingFrame.sequence
    || firstPendingFrame.revision !== current.revision + 1
  ) {
    return deferTextFrames(runtime, pendingFrames);
  }
  const next = cloneTimelineRuntimeForStreaming(runtime);
  const delta = pendingFrames.map((candidate) => candidate.delta).join("");
  const item = { ...current, revision: lastPendingFrame.revision, text: current.text + delta };
  const currentBytes = getTimelineItemEstimatedBytes(next, item.item_id, current);
  setStreamingTimelineItem(next, item, currentBytes + delta.length * 2);
  return replayDeferredTextFrames(replaceRenderedItem(next, item), item.item_id);
}

function deferTextFrames(runtime: TimelineRuntime, frames: TextAppendFrame[]): TimelineRuntime {
  const next = cloneTimelineRuntimeForStreaming(runtime);
  const itemId = frames[0].item_id;
  const previous = next.deferredTextFrames.get(itemId) ?? [];
  const byRevision = new Map<number, TextAppendFrame>();
  for (const frame of previous) byRevision.set(frame.revision, frame);
  for (const frame of frames) {
    if (!byRevision.has(frame.revision)) byRevision.set(frame.revision, frame);
  }
  if (byRevision.size === previous.length) return runtime;
  const deferred = [...byRevision.values()].sort((left, right) => left.revision - right.revision);
  next.deferredTextFrames.set(itemId, deferred);
  next.deferredEstimatedBytes += estimateTextFramesBytes(deferred) - estimateTextFramesBytes(previous);
  next.needsReconciliation = true;
  return next;
}

function replayDeferredTextFrames(
  runtime: TimelineRuntime,
  itemId: string,
  mutation?: TimelineMutation | null,
): TimelineRuntime {
  const deferred = runtime.deferredTextFrames.get(itemId);
  if (!deferred?.length) return runtime;
  const current = getTimelineItem(runtime, itemId);
  if (!current) return runtime;
  if (current.type !== AGENT_TIMELINE_ITEM_TYPE.TEXT && current.type !== AGENT_TIMELINE_ITEM_TYPE.THINKING) {
    return clearDeferredTextFrames(runtime, itemId, deferred);
  }
  const applicable = deferred.filter((frame) => frame.sequence === current.sequence);

  let revision = current.revision;
  let delta = "";
  let consumedThrough = -1;
  for (let index = 0; index < applicable.length; index += 1) {
    const frame = applicable[index];
    if (frame.revision <= revision) {
      consumedThrough = index;
      continue;
    }
    if (frame.revision !== revision + 1) break;
    revision = frame.revision;
    delta += frame.delta;
    consumedThrough = index;
  }

  const next = cloneTimelineRuntimeForStreaming(runtime);
  const remaining = applicable.slice(consumedThrough + 1);
  if (remaining.length) next.deferredTextFrames.set(itemId, remaining);
  else next.deferredTextFrames.delete(itemId);
  next.deferredEstimatedBytes += estimateTextFramesBytes(remaining) - estimateTextFramesBytes(deferred);
  next.needsReconciliation = next.deferredTextFrames.size > 0;
  if (!delta) return next;

  const item = { ...current, revision, text: current.text + delta };
  const currentBytes = getTimelineItemEstimatedBytes(next, item.item_id, current);
  setStreamingTimelineItem(next, item, currentBytes + delta.length * 2);
  return replaceRenderedItem(next, item, mutation);
}

function clearDeferredTextFrames(
  runtime: TimelineRuntime,
  itemId: string,
  deferred: readonly TextAppendFrame[],
): TimelineRuntime {
  const next = cloneTimelineRuntimeForStreaming(runtime);
  next.deferredTextFrames.delete(itemId);
  next.deferredEstimatedBytes -= estimateTextFramesBytes(deferred);
  next.needsReconciliation = next.deferredTextFrames.size > 0;
  return next;
}

function rebuildTimeline(runtime: TimelineRuntime, mutation: TimelineMutation | null): TimelineRuntime {
  runtime.orderedItemIds = [...runtime.baseItems.keys()]
    .map((itemId) => getTimelineItem(runtime, itemId))
    .filter((item): item is AgentTimelineItem => Boolean(item))
    .sort((left, right) => left.sequence - right.sequence)
    .map((item) => item.item_id);
  runtime.locations.clear();
  runtime.userNodeIndexes.clear();
  runtime.latestSequence = 0;
  runtime.currentAgentNodeIndex = null;
  runtime.currentTargetAgentCode = "";
  const streaming = runtime.state.streaming;
  runtime.state = { nodes: [], streaming };
  let next = runtime;
  for (const itemId of runtime.orderedItemIds) {
    const item = getTimelineItem(runtime, itemId);
    if (!item) continue;
    next.latestSequence = Math.max(next.latestSequence, item.sequence);
    next = appendRenderedItem(next, item, mutation);
  }
  return next;
}

function appendRenderedItem(
  runtime: TimelineRuntime,
  item: AgentTimelineItem,
  mutation?: TimelineMutation | null,
): TimelineRuntime {
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE) {
    const nodes = writableNodes(runtime, mutation);
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
    runtime.currentTargetAgentCode = item.target_agent_code;
    return withNodes(runtime, nodes);
  }
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.TURN_BOUNDARY) {
    if (!item.parent_item_id) runtime.currentAgentNodeIndex = null;
    return runtime;
  }

  if (item.parent_item_id) {
    const parent = runtime.locations.get(item.parent_item_id);
    if (parent?.placement === "block") return appendNestedItem(runtime, item, mutation);
  }

  const nodes = writableNodes(runtime, mutation);
  let nodeIndex = runtime.currentAgentNodeIndex;
  let agent = nodeIndex === null ? null : nodes[nodeIndex];
  if (!agent || agent.kind !== "agent") {
    nodeIndex = nodes.length;
    agent = {
      kind: "agent",
      id: `agent:${item.item_id}`,
      targetAgentCode: runtime.currentTargetAgentCode,
      ...createTranscript(item.created_at, item.agent_name),
    };
    nodes.push(agent);
    mutation?.ownedObjects.add(agent);
    runtime.currentAgentNodeIndex = nodeIndex;
  } else if (nodeIndex !== null) {
    const writableAgent = mutation
      ? ensureMutableAgentNode(nodes, nodeIndex, mutation)
      : cloneAgentNode(agent);
    if (!writableAgent) return runtime;
    agent = writableAgent;
    if (!agent.agentName && item.agent_name) agent.agentName = item.agent_name;
    nodes[nodeIndex] = agent;
  }
  const block = blockFromItem(item);
  if (!block) return withNodes(runtime, nodes);
  if (nodeIndex === null) return runtime;
  const blockIndex = agent.blocks.length;
  agent.blocks.push(block);
  mutation?.ownedObjects.add(block);
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.TOOL) {
    agent.attachments = appendToolAttachments(agent.attachments, item, Boolean(mutation));
  }
  runtime.locations.set(item.item_id, { nodeIndex, path: [blockIndex], placement: "block" });
  return withNodes(runtime, nodes);
}

function appendNestedItem(
  runtime: TimelineRuntime,
  item: AgentTimelineItem,
  mutation?: TimelineMutation | null,
): TimelineRuntime {
  const parent = runtime.locations.get(item.parent_item_id ?? "");
  if (!parent || parent.placement !== "block") return runtime;
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.SUBAGENT) {
    const nodes = updateToolAtPath(runtime.state.nodes, parent, (tool) => ({
      ...tool,
      subagentTask: subagentFromItem(item),
    }), mutation);
    runtime.locations.set(item.item_id, { ...parent, placement: "subagent" });
    return withNodes(runtime, nodes);
  }
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.TURN_BOUNDARY) return runtime;
  const block = blockFromItem(item);
  if (!block) return runtime;
  let childIndex = -1;
  const nodes = updateToolAtPath(runtime.state.nodes, parent, (tool) => {
    const nested = mutation
      ? ensureMutableNestedTranscript(tool, item.created_at, item.agent_name, mutation)
      : cloneTranscript(tool.nested ?? createTranscript(item.created_at, item.agent_name));
    if (!nested.agentName && item.agent_name) nested.agentName = item.agent_name;
    childIndex = nested.blocks.length;
    nested.blocks.push(block);
    mutation?.ownedObjects.add(block);
    if (item.type === AGENT_TIMELINE_ITEM_TYPE.TOOL) {
      nested.attachments = appendToolAttachments(nested.attachments, item, Boolean(mutation));
    }
    return mutation ? tool : { ...tool, nested };
  }, mutation);
  if (childIndex < 0) return runtime;
  runtime.locations.set(item.item_id, {
    nodeIndex: parent.nodeIndex,
    path: [...parent.path, childIndex],
    placement: "block",
  });
  return withNodes(runtime, nodes);
}

function replaceRenderedItem(
  runtime: TimelineRuntime,
  item: AgentTimelineItem,
  mutation?: TimelineMutation | null,
): TimelineRuntime {
  if (item.type === AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE) {
    const nodeIndex = runtime.userNodeIndexes.get(item.item_id);
    if (nodeIndex === undefined) return runtime;
    const nodes = writableNodes(runtime, mutation);
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
    }), mutation));
  }
  const block = blockFromItem(item);
  if (!block) return runtime;
  return withNodes(runtime, replaceBlockAtPath(
    runtime.state.nodes,
    location,
    item,
    block,
    mutation,
  ));
}

function replaceBlockAtPath(
  source: ChatNode[],
  location: BlockLocation,
  item: AgentTimelineItem,
  replacement: TranscriptBlock,
  mutation?: TimelineMutation | null,
): ChatNode[] {
  if (mutation) return replaceBlockAtPathMutable(source, location, item, replacement, mutation);
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
        ? mergeToolAttachments(transcript.attachments, item, false)
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

function replaceBlockAtPathMutable(
  nodes: ChatNode[],
  location: BlockLocation,
  item: AgentTimelineItem,
  replacement: TranscriptBlock,
  mutation: TimelineMutation,
): ChatNode[] {
  const agent = ensureMutableAgentNode(nodes, location.nodeIndex, mutation);
  if (!agent) return nodes;
  let transcript: AgentTranscript = agent;

  for (let depth = 0; depth < location.path.length; depth += 1) {
    const index = location.path[depth];
    const current = transcript.blocks[index];
    if (!current) return nodes;
    if (depth === location.path.length - 1) {
      const updated = preserveToolChildren(current, replacement);
      transcript.blocks[index] = updated;
      mutation.ownedObjects.add(updated);
      if (item.type === AGENT_TIMELINE_ITEM_TYPE.TOOL) {
        transcript.attachments = mergeToolAttachments(transcript.attachments, item, true);
      }
      return nodes;
    }
    if (current.kind !== "tool" || !current.nested) return nodes;
    const tool = ensureMutableTool(transcript, index, mutation);
    if (!tool?.nested) return nodes;
    transcript = ensureMutableExistingTranscript(tool, mutation);
  }
  return nodes;
}

function updateToolAtPath(
  source: ChatNode[],
  location: BlockLocation,
  update: (tool: ToolExecutionItem) => ToolExecutionItem,
  mutation?: TimelineMutation | null,
): ChatNode[] {
  if (mutation) return updateToolAtPathMutable(source, location, update, mutation);
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

function updateToolAtPathMutable(
  nodes: ChatNode[],
  location: BlockLocation,
  update: (tool: ToolExecutionItem) => ToolExecutionItem,
  mutation: TimelineMutation,
): ChatNode[] {
  const agent = ensureMutableAgentNode(nodes, location.nodeIndex, mutation);
  if (!agent) return nodes;
  let transcript: AgentTranscript = agent;

  for (let depth = 0; depth < location.path.length; depth += 1) {
    const index = location.path[depth];
    const tool = ensureMutableTool(transcript, index, mutation);
    if (!tool) return nodes;
    if (depth === location.path.length - 1) {
      const updated = update(tool);
      transcript.blocks[index] = updated;
      mutation.ownedObjects.add(updated);
      return nodes;
    }
    if (!tool.nested) return nodes;
    transcript = ensureMutableExistingTranscript(tool, mutation);
  }
  return nodes;
}

function ensureMutableAgentNode(
  nodes: ChatNode[],
  nodeIndex: number,
  mutation: TimelineMutation,
): Extract<ChatNode, { kind: "agent" }> | null {
  const current = nodes[nodeIndex];
  if (!current || current.kind !== "agent") return null;
  if (mutation.ownedObjects.has(current)) return current;
  const clone = cloneAgentNode(current);
  nodes[nodeIndex] = clone;
  mutation.ownedObjects.add(clone);
  return clone;
}

function ensureMutableTool(
  transcript: AgentTranscript,
  blockIndex: number,
  mutation: TimelineMutation,
): ToolExecutionItem | null {
  const current = transcript.blocks[blockIndex];
  if (!current || current.kind !== "tool") return null;
  if (mutation.ownedObjects.has(current)) return current;
  const clone = { ...current };
  transcript.blocks[blockIndex] = clone;
  mutation.ownedObjects.add(clone);
  return clone;
}

function ensureMutableExistingTranscript(
  tool: ToolExecutionItem,
  mutation: TimelineMutation,
): AgentTranscript {
  const current = tool.nested;
  if (!current) throw new Error("timeline location points to a missing nested transcript");
  if (mutation.ownedObjects.has(current)) return current;
  const clone = cloneTranscript(current);
  tool.nested = clone;
  mutation.ownedObjects.add(clone);
  return clone;
}

function ensureMutableNestedTranscript(
  tool: ToolExecutionItem,
  createdAt: string,
  agentName: string,
  mutation: TimelineMutation,
): AgentTranscript {
  if (tool.nested) return ensureMutableExistingTranscript(tool, mutation);
  const nested = createTranscript(createdAt, agentName);
  tool.nested = nested;
  mutation.ownedObjects.add(nested);
  return nested;
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
  mutate: boolean,
): TranscriptAttachmentItem[] {
  const additions = reportAttachmentsFromItem(item);
  if (mutate) {
    let writeIndex = 0;
    for (const attachment of current) {
      if (attachment.callId !== item.call_id) {
        current[writeIndex] = attachment;
        writeIndex += 1;
      }
    }
    current.length = writeIndex;
    current.push(...additions);
    return current;
  }
  const retained = current.filter((attachment) => attachment.callId !== item.call_id);
  return additions.length || retained.length !== current.length ? [...retained, ...additions] : current;
}

function appendToolAttachments(
  current: TranscriptAttachmentItem[],
  item: AgentTimelineToolItem,
  mutate: boolean,
): TranscriptAttachmentItem[] {
  const additions = reportAttachmentsFromItem(item);
  if (!additions.length) return current;
  if (mutate) {
    current.push(...additions);
    return current;
  }
  return [...current, ...additions];
}

function reportAttachmentsFromItem(item: AgentTimelineToolItem): ReportAttachmentItem[] {
  return (item.attachments ?? []).map((attachment) => ({
    kind: "report",
    id: `report:${attachment.report_id}`,
    callId: item.call_id,
    reportId: attachment.report_id,
    filename: attachment.filename,
    size: attachment.size,
    chars: attachment.chars,
  }));
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

function writableNodes(runtime: TimelineRuntime, mutation?: TimelineMutation | null): ChatNode[] {
  return mutation ? runtime.state.nodes : runtime.state.nodes.slice();
}

function cloneTimelineRuntimeForItems(runtime: TimelineRuntime): TimelineRuntime {
  return {
    ...runtime,
    baseItems: new Map(runtime.baseItems),
    streamingItems: new Map(runtime.streamingItems),
    baseItemEstimatedBytes: new Map(runtime.baseItemEstimatedBytes),
    streamingItemEstimatedBytes: new Map(runtime.streamingItemEstimatedBytes),
    deferredTextFrames: new Map(runtime.deferredTextFrames),
    orderedItemIds: runtime.orderedItemIds.slice(),
    locations: new Map(runtime.locations),
    userNodeIndexes: new Map(runtime.userNodeIndexes),
    state: { ...runtime.state, nodes: runtime.state.nodes.slice() },
  };
}

function cloneTimelineRuntimeForStreaming(runtime: TimelineRuntime): TimelineRuntime {
  return {
    ...runtime,
    streamingItems: new Map(runtime.streamingItems),
    streamingItemEstimatedBytes: new Map(runtime.streamingItemEstimatedBytes),
    deferredTextFrames: new Map(runtime.deferredTextFrames),
  };
}

function setTimelineItem(runtime: TimelineRuntime, item: AgentTimelineItem, estimatedBytes = estimateTimelineItemBytes(item)) {
  const retainedBytes = (runtime.baseItemEstimatedBytes.get(item.item_id) ?? 0)
    + (runtime.streamingItemEstimatedBytes.get(item.item_id) ?? 0);
  runtime.estimatedBytes += estimatedBytes - retainedBytes;
  runtime.baseItems.set(item.item_id, item);
  runtime.baseItemEstimatedBytes.set(item.item_id, estimatedBytes);
  runtime.streamingItems.delete(item.item_id);
  runtime.streamingItemEstimatedBytes.delete(item.item_id);
}

function setStreamingTimelineItem(runtime: TimelineRuntime, item: AgentTimelineItem, estimatedBytes: number) {
  const currentBytes = runtime.streamingItemEstimatedBytes.get(item.item_id) ?? 0;
  runtime.estimatedBytes += estimatedBytes - currentBytes;
  runtime.streamingItems.set(item.item_id, item);
  runtime.streamingItemEstimatedBytes.set(item.item_id, estimatedBytes);
}

function getTimelineItemEstimatedBytes(
  runtime: TimelineRuntime,
  itemId: string,
  item: AgentTimelineItem,
): number {
  return runtime.streamingItemEstimatedBytes.get(itemId)
    ?? runtime.baseItemEstimatedBytes.get(itemId)
    ?? estimateTimelineItemBytes(item);
}

function estimateTimelineItemBytes(item: AgentTimelineItem): number {
  return 384 + estimateValueBytes(item, new Set<object>());
}

function estimateValueBytes(value: unknown, seen: Set<object>): number {
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (value === null || value === undefined) return 0;
  if (typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return 24 + value.reduce((total, entry) => total + estimateValueBytes(entry, seen), 0);
  }
  let total = 48;
  for (const [key, entry] of Object.entries(value)) {
    total += key.length * 2 + estimateValueBytes(entry, seen);
  }
  return total;
}

function estimateTextFramesBytes(frames: readonly TextAppendFrame[]): number {
  return frames.reduce((total, frame) => (
    total + 96 + frame.item_id.length * 2 + frame.delta.length * 2
  ), 0);
}
