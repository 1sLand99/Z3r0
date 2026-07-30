import type { AgentTimelineItem } from "../../shared/api/types";
import {
  createTimelineRuntime,
  mergeTimelinePage,
  prependTimelinePage,
  type TimelineRuntime,
} from "./timelineRuntime";

export type AgentSessionConnectionStatus = "idle" | "connecting" | "open" | "closed";

export type SessionHistoryState = {
  initialLoaded: boolean;
  initialError: string | null;
  loadingInitial: boolean;
  loadingPrevious: boolean;
  hasMoreBefore: boolean;
  beforeSequence: number | null;
  prependVersion: number;
};

export type SessionSocketState = {
  snapshotReceived: boolean;
};

export type SessionRuntime = {
  timeline: TimelineRuntime;
  status: AgentSessionConnectionStatus;
  history: SessionHistoryState;
  socket: SessionSocketState;
  agentCodeOverride: string;
};

export type TimelinePage = {
  items: readonly AgentTimelineItem[];
  hasMore: boolean;
  nextBeforeSequence: number | null;
};

type RuntimeEntry = {
  runtime: SessionRuntime;
  lastAccessedAt: number;
};

type Listener = () => void;

const DEFAULT_CACHE_BUDGET_BYTES = 48 * 1024 * 1024;
const RUNTIME_BASE_BYTES = 96 * 1024;

export function createSessionRuntime(): SessionRuntime {
  return {
    timeline: createTimelineRuntime(),
    status: "idle",
    history: {
      initialLoaded: false,
      initialError: null,
      loadingInitial: false,
      loadingPrevious: false,
      hasMoreBefore: false,
      beforeSequence: null,
      prependVersion: 0,
    },
    socket: { snapshotReceived: false },
    agentCodeOverride: "",
  };
}

const EMPTY_RUNTIME = createSessionRuntime();

export class AgentSessionRuntimeStore {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private totalEstimatedBytes = 0;

  constructor(private readonly cacheBudgetBytes = DEFAULT_CACHE_BUDGET_BYTES) {}

  ensure(sessionId: string): SessionRuntime {
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing.runtime;
    }
    const runtime = createSessionRuntime();
    this.entries.set(sessionId, { runtime, lastAccessedAt: Date.now() });
    this.totalEstimatedBytes += runtimeCost(runtime);
    return runtime;
  }

  getSnapshot = (sessionId: string | null): SessionRuntime => {
    if (!sessionId) return EMPTY_RUNTIME;
    return this.entries.get(sessionId)?.runtime ?? EMPTY_RUNTIME;
  };

  subscribe = (sessionId: string | null, listener: Listener): (() => void) => {
    if (!sessionId) return () => undefined;
    let sessionListeners = this.listeners.get(sessionId);
    if (!sessionListeners) {
      sessionListeners = new Set();
      this.listeners.set(sessionId, sessionListeners);
    }
    sessionListeners.add(listener);
    return () => {
      sessionListeners?.delete(listener);
      if (sessionListeners?.size === 0) this.listeners.delete(sessionId);
    };
  };

  update(sessionId: string, update: (runtime: SessionRuntime) => SessionRuntime): SessionRuntime {
    const current = this.ensure(sessionId);
    const next = update(current);
    const entry = this.entries.get(sessionId);
    if (!entry) return next;
    entry.lastAccessedAt = Date.now();
    if (next === current) return current;
    this.totalEstimatedBytes += runtimeCost(next) - runtimeCost(current);
    entry.runtime = next;
    for (const listener of this.listeners.get(sessionId) ?? []) listener();
    return next;
  }

  drop(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    this.entries.delete(sessionId);
    this.totalEstimatedBytes -= runtimeCost(entry.runtime);
    for (const listener of this.listeners.get(sessionId) ?? []) listener();
    return true;
  }

  evict(activeSessionId: string | null): string[] {
    if (this.totalEstimatedBytes <= this.cacheBudgetBytes) return [];
    if (this.entries.size <= (activeSessionId && this.entries.has(activeSessionId) ? 1 : 0)) return [];

    const candidates = [...this.entries.entries()]
      .filter(([sessionId]) => sessionId !== activeSessionId)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
    const evicted: string[] = [];
    for (const [sessionId, entry] of candidates) {
      if (this.totalEstimatedBytes <= this.cacheBudgetBytes) break;
      this.totalEstimatedBytes -= runtimeCost(entry.runtime);
      this.entries.delete(sessionId);
      evicted.push(sessionId);
      for (const listener of this.listeners.get(sessionId) ?? []) listener();
    }
    return evicted;
  }

  estimatedBytes(): number {
    return this.totalEstimatedBytes;
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }
}

export function replaceSessionTimeline(
  runtime: SessionRuntime,
  timeline: TimelineRuntime,
): SessionRuntime {
  if (timeline === runtime.timeline) return runtime;
  return {
    ...runtime,
    timeline,
  };
}

export function mergeInitialHistory(runtime: SessionRuntime, page: TimelinePage): SessionRuntime {
  const previousNodes = runtime.timeline.state.nodes;
  const timeline = mergeTimelinePage(runtime.timeline, page.items);
  const projectionChangedBeforeVisibleSnapshot = previousNodes.length > 0
    && timeline.state.nodes !== previousNodes;
  const withTimeline = replaceSessionTimeline(runtime, timeline);
  return {
    ...withTimeline,
    history: {
      ...withTimeline.history,
      initialLoaded: true,
      initialError: null,
      loadingInitial: false,
      hasMoreBefore: page.hasMore,
      beforeSequence: page.nextBeforeSequence,
      prependVersion: withTimeline.history.prependVersion + (projectionChangedBeforeVisibleSnapshot ? 1 : 0),
    },
  };
}

export function mergeLatestHistory(runtime: SessionRuntime, items: readonly AgentTimelineItem[]): SessionRuntime {
  const timeline = mergeTimelinePage(runtime.timeline, items);
  const withTimeline = replaceSessionTimeline(runtime, timeline);
  if (withTimeline === runtime) return runtime;
  return withTimeline;
}

export function mergePreviousHistory(runtime: SessionRuntime, page: TimelinePage): SessionRuntime {
  const previousNodes = runtime.timeline.state.nodes;
  const timeline = prependTimelinePage(runtime.timeline, page.items);
  const projectionChanged = timeline.state.nodes !== previousNodes;
  const withTimeline = replaceSessionTimeline(runtime, timeline);
  return {
    ...withTimeline,
    history: {
      ...withTimeline.history,
      loadingPrevious: false,
      hasMoreBefore: page.hasMore,
      beforeSequence: page.nextBeforeSequence,
      prependVersion: withTimeline.history.prependVersion + (projectionChanged ? 1 : 0),
    },
  };
}

function runtimeCost(runtime: SessionRuntime): number {
  return RUNTIME_BASE_BYTES + runtime.timeline.estimatedBytes + runtime.timeline.deferredEstimatedBytes;
}
