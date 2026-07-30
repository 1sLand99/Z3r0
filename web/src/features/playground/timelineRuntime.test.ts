import { describe, expect, it, vi } from "vitest";
import {
  AGENT_STREAM_FRAME_TYPE,
  AGENT_SUBORDINATE_STATUS,
  AGENT_TIMELINE_ATTACHMENT_TYPE,
  AGENT_TIMELINE_CONTENT_STATE,
  AGENT_TIMELINE_ITEM_TYPE,
  AGENT_TIMELINE_TOOL_STATE,
} from "../../shared/api/generated/constants";
import type {
  AgentStreamFrame,
  AgentTimelineItem,
  AgentTimelineSubagentItem,
  AgentTimelineTextItem,
  AgentTimelineToolItem,
  AgentTimelineUserMessageItem,
} from "../../shared/api/types";
import type {
  ChatNode,
  SubagentExecutionItem,
  ToolExecutionItem,
  TranscriptBlock,
} from "./chatState";
import {
  normalizeAgentTimelinePageData,
  normalizeAgentTurnData,
  parseAgentStreamFrame,
  validAgentSessionSummaries,
  validTimelineItems,
} from "./agentStreamProtocol";
import {
  AgentSessionRuntimeStore,
  VIRTUAL_LIST_FIRST_ITEM_INDEX,
  mergeInitialHistory,
  mergeLatestHistory,
  mergePreviousHistory,
  replaceSessionTimeline,
} from "./sessionRuntimeStore";
import {
  applyStreamFrames,
  createTimelineRuntime,
  getTimelineItem,
  mergeTimelinePage,
} from "./timelineRuntime";
import {
  collectSubagentTabs,
  findSubagentTarget,
  latestRunningSubagentTab,
  latestSubagentTab,
} from "./subagentView";

describe("agent stream protocol", () => {
  it("accepts complete discriminated frames and rejects malformed render payloads", () => {
    const validSnapshot = {
      type: AGENT_STREAM_FRAME_TYPE.SNAPSHOT,
      items: [userItem(1)],
      latest_sequence: 1,
      main_agent_running: false,
    };
    expect(parseAgentStreamFrame(validSnapshot)).toEqual(validSnapshot);
    expect(parseAgentStreamFrame({
      ...validSnapshot,
      items: [{ ...userItem(1), content: undefined }],
    })).toMatchObject({ items: [] });
    expect(parseAgentStreamFrame({
      ...validSnapshot,
      latest_sequence: 0,
    })).toMatchObject({ items: [] });
    expect(parseAgentStreamFrame({
      type: AGENT_STREAM_FRAME_TYPE.TEXT_APPEND,
      item_id: "",
      sequence: 1,
      revision: 2,
      delta: "x",
    })).toBeNull();
  });

  it("filters malformed REST and turn items through the same contract", () => {
    const valid = textItem(2, "answer");
    expect(validTimelineItems([
      valid,
      { ...valid, item_id: "", sequence: 3 },
      { ...valid, item_id: "text-4", sequence: 4, state: "unknown" },
    ])).toEqual([valid]);
    expect(validTimelineItems({ items: [valid] })).toEqual([]);
  });

  it("validates timeline page ownership, cursor monotonicity, and item boundaries", () => {
    const valid = normalizeAgentTimelinePageData({
      session_id: "session",
      items: [userItem(1), { ...textItem(2), item_id: "" }],
      has_more: true,
      next_before_sequence: 1,
    }, "session", 3);

    expect(valid).toEqual({
      sessionId: "session",
      items: [userItem(1)],
      hasMore: true,
      nextBeforeSequence: 1,
    });
    expect(normalizeAgentTimelinePageData({
      session_id: "other",
      items: [],
      has_more: false,
      next_before_sequence: null,
    }, "session")).toBeNull();
    expect(normalizeAgentTimelinePageData({
      session_id: "session",
      items: [userItem(3)],
      has_more: true,
      next_before_sequence: 3,
    }, "session", 3)).toBeNull();
  });

  it("validates session summaries and normalizes mutation envelopes", () => {
    const session = sessionSummary("session");
    const validUpdate = textItem(2, "answer");
    const normalized = normalizeAgentTurnData({
      session_id: session.session_id,
      session,
      main_agent_running: true,
      updates: [validUpdate, { ...validUpdate, item_id: "" }],
    });

    expect(normalized).toMatchObject({
      session_id: "session",
      main_agent_running: true,
      updates: [validUpdate],
    });
    expect(normalizeAgentTurnData({
      session_id: "other",
      session,
      main_agent_running: true,
      updates: [],
    })).toBeNull();
    expect(validAgentSessionSummaries([session, { ...session, message_count: -1 }])).toEqual([session]);
    expect(validAgentSessionSummaries({ items: [session] })).toEqual([]);
  });
});

describe("timeline runtime", () => {
  it("deduplicates revisions, orders pages, and never mutates an older snapshot", () => {
    const empty = createTimelineRuntime();
    const first = mergeTimelinePage(empty, [textItem(2, "answer"), userItem(1, "question")]);

    expect(empty.baseItems.size).toBe(0);
    expect(empty.state.nodes).toEqual([]);
    expect(first.orderedItemIds).toEqual(["user-1", "text-2"]);
    expect(first.latestSequence).toBe(2);
    expect(first.state.nodes).toHaveLength(2);
    expect(first.state.nodes[1]).toMatchObject({ kind: "agent", targetAgentCode: "default" });

    const ignored = mergeTimelinePage(first, [{ ...textItem(2, "stale"), revision: 0 }]);
    expect(ignored).toBe(first);
    expect((getTimelineItem(first, "text-2") as AgentTimelineTextItem).text).toBe("answer");
  });

  it("combines contiguous text frames in one immutable commit and detects revision gaps", () => {
    const base = mergeTimelinePage(createTimelineRuntime(), [userItem(1), textItem(2, "a")]);
    const frames: AgentStreamFrame[] = [
      textFrame(2, 2, "b"),
      textFrame(2, 3, "c"),
    ];
    const streamed = applyStreamFrames(base, frames);

    expect((getTimelineItem(streamed, "text-2") as AgentTimelineTextItem).text).toBe("abc");
    expect((getTimelineItem(streamed, "text-2") as AgentTimelineTextItem).revision).toBe(3);
    expect((getTimelineItem(base, "text-2") as AgentTimelineTextItem).text).toBe("a");
    expect(streamed.baseItems).toBe(base.baseItems);
    expect(streamed.baseItemEstimatedBytes).toBe(base.baseItemEstimatedBytes);
    expect(streamed.orderedItemIds).toBe(base.orderedItemIds);
    expect(streamed.locations).toBe(base.locations);
    expect(streamed.streamingItems).not.toBe(base.streamingItems);

    const gap = applyStreamFrames(streamed, [textFrame(2, 5, "lost")]);
    expect(gap.needsReconciliation).toBe(true);
    expect((getTimelineItem(gap, "text-2") as AgentTimelineTextItem).text).toBe("abc");
  });

  it("replays deferred revisions after a REST or snapshot baseline fills the gap", () => {
    const base = mergeTimelinePage(createTimelineRuntime(), [textItem(2, "a")]);
    const deferred = applyStreamFrames(base, [
      textFrame(2, 3, "c"),
      textFrame(2, 4, "d"),
    ]);
    const reconciled = mergeTimelinePage(deferred, [textItem(2, "ab", 2)]);

    expect((getTimelineItem(reconciled, "text-2") as AgentTimelineTextItem).text).toBe("abcd");
    expect((getTimelineItem(reconciled, "text-2") as AgentTimelineTextItem).revision).toBe(4);
    expect(reconciled.needsReconciliation).toBe(false);
    expect(reconciled.deferredTextFrames.size).toBe(0);
    expect(reconciled.deferredEstimatedBytes).toBe(0);
    expect(deferred.needsReconciliation).toBe(true);
    expect(deferred.deferredTextFrames.get("text-2")).toHaveLength(2);
    expect((getTimelineItem(base, "text-2") as AgentTimelineTextItem).text).toBe("a");
  });

  it("retains immutable deep snapshots while updating and appending nested blocks in one batch", () => {
    const parent = toolItem(2);
    const firstChild = nestedTextItem(3, parent.item_id, "before");
    const base = mergeTimelinePage(createTimelineRuntime(), [userItem(1), parent, firstChild]);
    const oldAgent = base.state.nodes[1];
    expect(oldAgent?.kind).toBe("agent");
    if (!oldAgent || oldAgent.kind !== "agent") throw new Error("missing agent node");
    const oldTool = oldAgent.blocks[0];
    expect(oldTool?.kind).toBe("tool");
    if (!oldTool || oldTool.kind !== "tool" || !oldTool.nested) throw new Error("missing nested transcript");
    const oldNested = oldTool.nested;

    const updated = mergeTimelinePage(base, [
      { ...firstChild, revision: 2, text: "after" },
      nestedTextItem(4, parent.item_id, "second"),
    ]);
    const updatedAgent = updated.state.nodes[1];
    if (!updatedAgent || updatedAgent.kind !== "agent") throw new Error("missing updated agent node");
    const updatedTool = updatedAgent.blocks[0];
    if (!updatedTool || updatedTool.kind !== "tool" || !updatedTool.nested) {
      throw new Error("missing updated nested transcript");
    }

    expect(oldNested.blocks).toEqual([expect.objectContaining({ id: "nested-text-3", text: "before" })]);
    expect(updatedTool.nested.blocks).toEqual([
      expect.objectContaining({ id: "nested-text-3", text: "after" }),
      expect.objectContaining({ id: "nested-text-4", text: "second" }),
    ]);
    expect(updatedAgent).not.toBe(oldAgent);
    expect(updatedTool).not.toBe(oldTool);
    expect(updatedTool.nested).not.toBe(oldNested);
  });

  it("updates and appends tool attachments in a batch without mutating older snapshots", () => {
    const firstTool = {
      ...toolItem(2),
      attachments: [reportAttachment("first", "first.txt")],
    };
    const base = mergeTimelinePage(createTimelineRuntime(), [userItem(1), firstTool]);
    const oldAgent = base.state.nodes[1];
    if (!oldAgent || oldAgent.kind !== "agent") throw new Error("missing agent node");

    const updated = mergeTimelinePage(base, [
      {
        ...firstTool,
        revision: 2,
        attachments: [reportAttachment("first-updated", "first-updated.txt")],
      },
      {
        ...toolItem(3),
        attachments: [reportAttachment("second", "second.txt")],
      },
    ]);
    const updatedAgent = updated.state.nodes[1];
    if (!updatedAgent || updatedAgent.kind !== "agent") throw new Error("missing updated agent node");

    expect(oldAgent.attachments.map((attachment) => attachment.id)).toEqual(["report:first"]);
    expect(updatedAgent.attachments.map((attachment) => attachment.id)).toEqual([
      "report:first-updated",
      "report:second",
    ]);
    expect(updatedAgent.attachments).not.toBe(oldAgent.attachments);
  });

  it("renders orphaned nested items until an earlier page supplies their parent", () => {
    const parent = toolItem(2);
    const child = nestedTextItem(3, parent.item_id, "nested output");
    const orphaned = mergeTimelinePage(createTimelineRuntime(), [child]);
    const orphanAgent = orphaned.state.nodes[0];
    expect(orphanAgent).toMatchObject({
      kind: "agent",
      blocks: [expect.objectContaining({ id: child.item_id, text: "nested output" })],
    });

    const resolved = mergeTimelinePage(orphaned, [parent]);
    const resolvedAgent = resolved.state.nodes[0];
    if (!resolvedAgent || resolvedAgent.kind !== "agent") throw new Error("missing resolved agent node");
    const resolvedTool = resolvedAgent.blocks[0];
    expect(resolvedTool).toMatchObject({ kind: "tool", id: parent.item_id });
    if (!resolvedTool || resolvedTool.kind !== "tool") throw new Error("missing resolved parent tool");
    expect(resolvedTool.nested?.blocks).toEqual([
      expect.objectContaining({ id: child.item_id, text: "nested output" }),
    ]);
  });

  it("rebuilds projection when a revised item changes structural identity", () => {
    const base = mergeTimelinePage(createTimelineRuntime(), [userItem(1), textItem(2, "answer")]);
    const moved = mergeTimelinePage(base, [{
      ...toolItem(3),
      item_id: "text-2",
      sequence: 2,
      revision: 2,
    }]);

    const agent = moved.state.nodes[1];
    if (!agent || agent.kind !== "agent") throw new Error("missing rebuilt agent node");
    expect(agent.blocks).toEqual([
      expect.objectContaining({ kind: "tool", id: "text-2", callId: "call-3" }),
    ]);
    expect(moved.locations.get("text-2")).toMatchObject({ placement: "block", path: [0] });
    expect(base.state.nodes[1]).toMatchObject({
      kind: "agent",
      blocks: [expect.objectContaining({ kind: "text", id: "text-2" })],
    });
  });

  it("accounts for both the stable baseline and the streaming text overlay", () => {
    const base = mergeTimelinePage(createTimelineRuntime(), [textItem(2, "a")]);
    const streamed = applyStreamFrames(base, [textFrame(2, 2, "b")]);
    const completed = mergeTimelinePage(streamed, [textItem(2, "abc", 3)]);

    expect(streamed.estimatedBytes).toBeGreaterThan(base.estimatedBytes * 1.5);
    expect(completed.streamingItems.size).toBe(0);
    expect(completed.streamingItemEstimatedBytes.size).toBe(0);
    expect(completed.estimatedBytes).toBeLessThan(streamed.estimatedBytes);
  });

  it("converges when missing text frames arrive out of order without a REST request", () => {
    const base = mergeTimelinePage(createTimelineRuntime(), [textItem(2, "a")]);
    const deferred = applyStreamFrames(base, [textFrame(2, 3, "c")]);
    const reconciled = applyStreamFrames(deferred, [textFrame(2, 2, "b")]);

    expect((getTimelineItem(reconciled, "text-2") as AgentTimelineTextItem).text).toBe("abc");
    expect((getTimelineItem(reconciled, "text-2") as AgentTimelineTextItem).revision).toBe(3);
    expect(reconciled.needsReconciliation).toBe(false);
  });

  it("drops stale frame prefixes and applies only the unseen contiguous suffix", () => {
    const base = mergeTimelinePage(createTimelineRuntime(), [textItem(2, "ab", 2)]);
    const streamed = applyStreamFrames(base, [
      textFrame(2, 2, "duplicate"),
      textFrame(2, 3, "c"),
      textFrame(2, 4, "d"),
    ]);

    expect((getTimelineItem(streamed, "text-2") as AgentTimelineTextItem).text).toBe("abcd");
    expect(streamed.needsReconciliation).toBe(false);
  });

  it("converges when the websocket snapshot and initial REST page arrive in either order", () => {
    const snapshot: AgentStreamFrame = {
      type: AGENT_STREAM_FRAME_TYPE.SNAPSHOT,
      items: [textItem(4, "live")],
      latest_sequence: 4,
      main_agent_running: true,
    };
    const history = [userItem(1), textItem(2, "old"), userItem(3)];

    const websocketFirst = mergeTimelinePage(
      applyStreamFrames(createTimelineRuntime(), [snapshot]),
      history,
    );
    const restFirst = applyStreamFrames(
      mergeTimelinePage(createTimelineRuntime(), history),
      [snapshot],
    );

    expect(websocketFirst.orderedItemIds).toEqual(restFirst.orderedItemIds);
    expect(websocketFirst.state).toEqual(restFirst.state);
    expect(websocketFirst.state.streaming).toBe(true);
  });
});

describe("session history state", () => {
  it("keeps the prepend cursor independent from latest-head reconciliation", () => {
    const store = new AgentSessionRuntimeStore();
    const runtime = store.ensure("session");
    const initial = mergeInitialHistory(runtime, {
      items: [userItem(21), textItem(22, "tail")],
      hasMore: true,
      nextBeforeSequence: 21,
    });
    const reconciled = mergeLatestHistory(initial, [textItem(22, "new tail", 2), userItem(23)]);

    expect(reconciled.history.beforeSequence).toBe(21);
    expect(reconciled.history.hasMoreBefore).toBe(true);
    expect(getTimelineItem(reconciled.timeline, "user-23")?.sequence).toBe(23);
  });

  it("never lets an older REST catchup overwrite newer websocket text", () => {
    const initial = mergeInitialHistory(new AgentSessionRuntimeStore().ensure("session"), {
      items: [textItem(2, "ab", 2)],
      hasMore: false,
      nextBeforeSequence: null,
    });
    const streamed = replaceSessionTimeline(
      initial,
      applyStreamFrames(initial.timeline, [textFrame(2, 3, "c")]),
    );
    const staleCatchup = mergeLatestHistory(streamed, [textItem(2, "older", 2)]);

    expect(staleCatchup).toBe(streamed);
    expect((getTimelineItem(staleCatchup.timeline, "text-2") as AgentTimelineTextItem).text).toBe("abc");
  });

  it("advances only the previous-page cursor and preserves the virtual viewport anchor", () => {
    const store = new AgentSessionRuntimeStore();
    const initial = mergeInitialHistory(store.ensure("session"), {
      items: [userItem(3), textItem(4, "tail")],
      hasMore: true,
      nextBeforeSequence: 3,
    });
    const prepended = mergePreviousHistory(initial, {
      items: [userItem(1), textItem(2, "head")],
      hasMore: false,
      nextBeforeSequence: null,
    });

    expect(prepended.history.firstItemIndex).toBe(VIRTUAL_LIST_FIRST_ITEM_INDEX - 2);
    expect(prepended.history.beforeSequence).toBeNull();
    expect(prepended.history.hasMoreBefore).toBe(false);
    expect(prepended.timeline.state.nodes.map((node) => node.id)).toEqual([
      "user-1",
      "agent:text-2",
      "user-3",
      "agent:text-4",
    ]);
  });

  it("prepends a turn-aligned page without replaying the existing transcript", () => {
    const store = new AgentSessionRuntimeStore();
    const liveTail = {
      ...textItem(4, "tail"),
      state: AGENT_TIMELINE_CONTENT_STATE.STREAMING,
    };
    const initial = mergeInitialHistory(store.ensure("session"), {
      items: [userItem(3), liveTail],
      hasMore: true,
      nextBeforeSequence: 3,
    });
    const oldTail = initial.timeline.state.nodes[1];
    const prepended = mergePreviousHistory(initial, {
      items: [userItem(1), textItem(2, "head")],
      hasMore: false,
      nextBeforeSequence: null,
    });
    const rebuilt = mergeTimelinePage(createTimelineRuntime(), [
      userItem(1),
      textItem(2, "head"),
      userItem(3),
      liveTail,
    ]);
    const streamed = applyStreamFrames(prepended.timeline, [textFrame(4, 2, "!")]);

    expect(prepended.timeline.state).toEqual(rebuilt.state);
    expect(prepended.timeline.state.nodes[3]).toBe(oldTail);
    expect(prepended.timeline.locations.get("text-4")?.nodeIndex).toBe(3);
    expect((getTimelineItem(streamed, "text-4") as AgentTimelineTextItem).text).toBe("tail!");
    expect(prepended.timeline.state.nodes[3]).toBe(oldTail);
  });

  it("rebuilds across a boundary-only page start so inherited agent targeting stays correct", () => {
    const store = new AgentSessionRuntimeStore();
    const initial = mergeInitialHistory(store.ensure("session"), {
      items: [boundaryItem(3), textItem(4, "continued")],
      hasMore: true,
      nextBeforeSequence: 3,
    });
    const merged = mergePreviousHistory(initial, {
      items: [userItem(1), textItem(2, "first")],
      hasMore: false,
      nextBeforeSequence: null,
    });

    expect(merged.timeline.state.nodes[2]).toMatchObject({
      kind: "agent",
      targetAgentCode: "default",
      blocks: [expect.objectContaining({ id: "text-4" })],
    });
  });
});

describe("session runtime store", () => {
  it("notifies only subscribers of the changed session", () => {
    const store = new AgentSessionRuntimeStore();
    store.ensure("a");
    store.ensure("b");
    const onA = vi.fn();
    const onB = vi.fn();
    store.subscribe("a", onA);
    store.subscribe("b", onB);

    store.update("a", (runtime) => ({ ...runtime, status: "open" }));

    expect(onA).toHaveBeenCalledOnce();
    expect(onB).not.toHaveBeenCalled();
  });

  it("evicts least-recently-used inactive runtimes by estimated bytes", () => {
    const store = new AgentSessionRuntimeStore(250 * 1024);
    store.ensure("oldest");
    store.ensure("middle");
    store.ensure("active");

    const evicted = store.evict("active");

    expect(evicted).toEqual(["oldest"]);
    expect(store.has("oldest")).toBe(false);
    expect(store.has("middle")).toBe(true);
    expect(store.has("active")).toBe(true);
  });

  it("accounts for large inline images instead of treating every session equally", () => {
    const store = new AgentSessionRuntimeStore(400 * 1024);
    const image = userItem(1);
    image.content = [{
      type: "image",
      media_type: "image/png",
      detail: "auto",
      data: "x".repeat(180 * 1024),
    }];
    store.update("image", (runtime) => replaceSessionTimeline(
      runtime,
      mergeTimelinePage(runtime.timeline, [image]),
    ));
    store.ensure("active");

    expect(store.estimatedBytes()).toBeGreaterThan(400 * 1024);
    expect(store.evict("active")).toEqual(["image"]);
  });

  it("keeps byte accounting exact across updates, drops, and eviction", () => {
    const store = new AgentSessionRuntimeStore(250 * 1024);
    store.ensure("a");
    store.ensure("b");
    const initialBytes = store.estimatedBytes();
    store.update("a", (runtime) => ({ ...runtime, status: "open" }));
    expect(store.estimatedBytes()).toBe(initialBytes);

    store.drop("a");
    expect(store.estimatedBytes()).toBe(96 * 1024);
    store.ensure("a");
    expect(store.estimatedBytes()).toBe(initialBytes);
    expect(store.evict("b")).toEqual([]);
  });
});

describe("nested subagent projection", () => {
  it("converges to the same deep projection from live frames and durable history", () => {
    const parent = toolItem(2);
    const child = subagentTimelineItem(3, parent.item_id, "child-run", "child");
    const childText = {
      ...nestedTextItem(4, parent.item_id, "a"),
      state: AGENT_TIMELINE_CONTENT_STATE.STREAMING,
    };
    const childTool = { ...toolItem(5), parent_item_id: parent.item_id };
    const grandchild = subagentTimelineItem(6, childTool.item_id, "grand-run", "grandchild");
    const completedParent = {
      ...parent,
      revision: 2,
      state: AGENT_TIMELINE_TOOL_STATE.COMPLETED,
      output: "started",
    };
    const completedChildTool = {
      ...childTool,
      revision: 2,
      state: AGENT_TIMELINE_TOOL_STATE.COMPLETED,
      output: "started",
    };
    const completedChild = {
      ...child,
      revision: 2,
      status: AGENT_SUBORDINATE_STATUS.COMPLETED,
      result_preview: "child done",
      result_chars: 10,
      progress: "",
    };
    const completedGrandchild = {
      ...grandchild,
      revision: 2,
      status: AGENT_SUBORDINATE_STATUS.COMPLETED,
      result_preview: "grandchild done",
      result_chars: 15,
      progress: "",
    };
    const completedChildText = {
      ...childText,
      revision: 3,
      state: AGENT_TIMELINE_CONTENT_STATE.COMPLETED,
      text: "ab",
    };

    const live = applyStreamFrames(
      mergeTimelinePage(createTimelineRuntime(), [userItem(1)]),
      [
        itemFrame(parent),
        itemFrame(completedParent),
        itemFrame(child),
        itemFrame(childText),
        itemFrame(childTool),
        itemFrame(completedChildTool),
        itemFrame(grandchild),
        {
          type: AGENT_STREAM_FRAME_TYPE.TEXT_APPEND,
          item_id: childText.item_id,
          sequence: childText.sequence,
          revision: 2,
          delta: "b",
        },
        itemFrame(completedChildText),
        itemFrame(completedGrandchild),
        itemFrame(completedChild),
        { type: AGENT_STREAM_FRAME_TYPE.RUN_STATE, main_agent_running: false },
      ],
    );
    const history = mergeTimelinePage(createTimelineRuntime(), [
      userItem(1),
      completedParent,
      completedChild,
      completedChildText,
      completedChildTool,
      completedGrandchild,
    ]);

    expect(live.state).toEqual(history.state);
    expect(collectSubagentTabs(live.state.nodes)).toEqual(collectSubagentTabs(history.state.nodes));
    expect(findSubagentTarget(live.state.nodes, "grandchild")?.runs[0]).toMatchObject({
      task: { runId: "grand-run", status: AGENT_SUBORDINATE_STATUS.COMPLETED },
    });
  });

  it("discovers deeply nested runs and preserves their transcript targets", () => {
    const childTask = subagentTask("child-run", "child");
    const parentTask = subagentTask("parent-run", "parent");
    const childTool = toolBlock("child-tool", childTask, [textBlock("child-text", "nested output")]);
    const parentTool = toolBlock("parent-tool", parentTask, [childTool]);
    const nodes: ChatNode[] = [{
      kind: "agent",
      id: "agent:root",
      targetAgentCode: "default",
      createdAt: "2026-01-01T00:00:00Z",
      agentName: "Agent",
      blocks: [parentTool],
      attachments: [],
    }];

    expect(collectSubagentTabs(nodes).map((tab) => tab.agentCode)).toEqual(["parent", "child"]);
    expect(findSubagentTarget(nodes, "child")?.runs[0]).toMatchObject({
      task: { runId: "child-run" },
      transcript: { blocks: [{ id: "child-text", text: "nested output" }] },
    });
  });

  it("tracks each run status independently and selects tabs by actual latest run order", () => {
    const nodes: ChatNode[] = [{
      kind: "agent",
      id: "agent:root",
      targetAgentCode: "default",
      createdAt: "2026-01-01T00:00:00Z",
      agentName: "Agent",
      blocks: [
        toolBlock("alpha-running", subagentTask("alpha-1", "alpha"), []),
        toolBlock("beta-running", subagentTask("beta-1", "beta"), []),
        toolBlock("alpha-completed", subagentTask(
          "alpha-2",
          "alpha",
          AGENT_SUBORDINATE_STATUS.COMPLETED,
        ), []),
      ],
      attachments: [],
    }];

    const tabs = collectSubagentTabs(nodes);
    const alpha = tabs.find((tab) => tab.agentCode === "alpha");
    expect(alpha?.status).toBe(AGENT_SUBORDINATE_STATUS.RUNNING);
    expect(alpha?.runs).toEqual([
      expect.objectContaining({ runId: "alpha-1", status: AGENT_SUBORDINATE_STATUS.RUNNING }),
      expect.objectContaining({ runId: "alpha-2", status: AGENT_SUBORDINATE_STATUS.COMPLETED }),
    ]);
    expect(latestRunningSubagentTab(tabs)?.agentCode).toBe("beta");
    expect(latestSubagentTab(tabs)?.agentCode).toBe("alpha");
  });
});

function userItem(sequence: number, displayText = "question"): AgentTimelineUserMessageItem {
  return {
    type: AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE,
    item_id: `user-${sequence}`,
    sequence,
    revision: 1,
    parent_item_id: null,
    created_at: "2026-01-01T00:00:00Z",
    agent_name: "",
    content: [{ type: "text", text: displayText }],
    display_text: displayText,
    target_agent_code: "default",
  };
}

function sessionSummary(sessionId: string) {
  return {
    agent_code: "default",
    created_at: "2026-01-01T00:00:00Z",
    is_running: false,
    message_count: 1,
    owner_id: 1,
    project_id: null,
    run_error: "",
    run_finished_at: null,
    run_started_at: null,
    runtime_agent_code: "default",
    runtime_sandbox_container_generation: 0,
    runtime_sandbox_container_id: null,
    selected_sandbox_container_generation: 0,
    selected_sandbox_container_id: null,
    session_id: sessionId,
    session_type: "chat",
    title: "Session",
    updated_at: "2026-01-01T00:00:00Z",
  } as const;
}

function textItem(sequence: number, text = "answer", revision = 1): AgentTimelineTextItem {
  return {
    type: AGENT_TIMELINE_ITEM_TYPE.TEXT,
    item_id: `text-${sequence}`,
    sequence,
    revision,
    parent_item_id: null,
    created_at: "2026-01-01T00:00:01Z",
    agent_name: "Agent",
    state: AGENT_TIMELINE_CONTENT_STATE.COMPLETED,
    text,
  };
}

function boundaryItem(sequence: number): AgentTimelineItem {
  return {
    type: AGENT_TIMELINE_ITEM_TYPE.TURN_BOUNDARY,
    item_id: `boundary-${sequence}`,
    sequence,
    revision: 1,
    parent_item_id: null,
    created_at: "2026-01-01T00:00:01Z",
    agent_name: "Agent",
  };
}

function nestedTextItem(sequence: number, parentItemId: string, text: string): AgentTimelineTextItem {
  return {
    ...textItem(sequence, text),
    item_id: `nested-text-${sequence}`,
    parent_item_id: parentItemId,
  };
}

function toolItem(sequence: number): AgentTimelineToolItem {
  return {
    type: AGENT_TIMELINE_ITEM_TYPE.TOOL,
    item_id: `tool-${sequence}`,
    sequence,
    revision: 1,
    parent_item_id: null,
    created_at: "2026-01-01T00:00:01Z",
    agent_name: "Agent",
    call_id: `call-${sequence}`,
    name: "delegate",
    arguments: {},
    output: "",
    state: AGENT_TIMELINE_TOOL_STATE.PENDING,
    attachments: [],
  };
}

function reportAttachment(reportId: string, filename: string) {
  return {
    type: AGENT_TIMELINE_ATTACHMENT_TYPE.REPORT,
    report_id: reportId,
    filename,
    size: 10,
    chars: 10,
  } as const;
}

function textFrame(sequence: number, revision: number, delta: string): AgentStreamFrame {
  return {
    type: AGENT_STREAM_FRAME_TYPE.TEXT_APPEND,
    item_id: `text-${sequence}`,
    sequence,
    revision,
    delta,
  };
}

function itemFrame(item: AgentTimelineItem): AgentStreamFrame {
  return { type: AGENT_STREAM_FRAME_TYPE.ITEM_UPSERT, item };
}

function subagentTimelineItem(
  sequence: number,
  parentItemId: string,
  runId: string,
  agentCode: string,
): AgentTimelineSubagentItem {
  return {
    type: AGENT_TIMELINE_ITEM_TYPE.SUBAGENT,
    item_id: `subagent:${runId}`,
    sequence,
    revision: 1,
    parent_item_id: parentItemId,
    created_at: "2026-01-01T00:00:01Z",
    agent_name: agentCode,
    run_id: runId,
    parent_agent_code: "default",
    parent_agent_instance_id: "main",
    agent_code: agentCode,
    status: AGENT_SUBORDINATE_STATUS.RUNNING,
    result_preview: "",
    error_preview: "",
    result_chars: 0,
    error_chars: 0,
    truncated: false,
    progress: "running",
  };
}

function subagentTask(
  runId: string,
  agentCode: string,
  status: SubagentExecutionItem["status"] = AGENT_SUBORDINATE_STATUS.RUNNING,
): SubagentExecutionItem {
  return {
    kind: "subagent",
    id: `subagent:${runId}`,
    createdAt: "2026-01-01T00:00:00Z",
    runId,
    parentAgentCode: "default",
    parentAgentInstanceId: "main",
    agentCode,
    status,
    resultPreview: "",
    errorPreview: "",
    resultChars: 0,
    errorChars: 0,
    truncated: false,
    progress: "running",
  };
}

function toolBlock(
  id: string,
  task: SubagentExecutionItem,
  blocks: TranscriptBlock[],
): ToolExecutionItem {
  return {
    kind: "tool",
    id,
    callId: id,
    name: "delegate",
    arguments: {},
    output: "",
    isError: false,
    resolved: false,
    subagentTask: task,
    nested: {
      createdAt: "2026-01-01T00:00:00Z",
      agentName: task.agentCode,
      blocks,
      attachments: [],
    },
  };
}

function textBlock(id: string, text: string) {
  return { kind: "text" as const, id, segmentId: id, text, complete: true };
}

const _typecheckTimelineItems: AgentTimelineItem[] = [userItem(1), textItem(2)];
void _typecheckTimelineItems;
