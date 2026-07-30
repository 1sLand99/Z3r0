import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocation } from "react-router-dom";
import { DEFAULT_ADMIN_PATH } from "../../app/routePaths";
import { listAgents } from "../../shared/api/agents";
import {
  AGENT_STREAM_FRAME_TYPE,
  AGENT_TIMELINE_ITEM_TYPE,
  RESOURCE_PAGE_SIZE,
  SESSION_TYPE,
} from "../../shared/api/generated/constants";
import {
  buildAgentStreamUrl,
  cancelAllAgentSessionTasks,
  createAgentSessionTurn,
  deleteAgentSession,
  interruptAgentSession,
  listAgentSessions,
  listAgentTimeline,
  submitAgentSessionTurn,
  updateAgentSessionSandboxContainer,
} from "../../shared/api/agentSessions";
import { isAbortError } from "../../shared/api/client";
import { showApiError, showApiSuccess } from "../../shared/api/feedback";
import { getStoredAccessToken } from "../../shared/auth/session";
import { mergeByKey } from "../../shared/lib/array";
import { shallowEqual } from "../../shared/lib/object";
import type {
  AgentInfo,
  AgentInputPart,
  AgentSessionSummary,
  AgentStreamFrame,
  AgentTurnData,
} from "../../shared/api/types";
import {
  normalizeAgentTimelinePageData,
  normalizeAgentTurnData,
  parseAgentSessionSummary,
  parseAgentStreamFrame,
  validAgentSessionSummaries,
} from "./agentStreamProtocol";
import {
  AgentSessionRuntimeStore,
  mergeInitialHistory,
  mergeLatestHistory,
  mergePreviousHistory,
  replaceSessionTimeline,
  type SessionRuntime,
} from "./sessionRuntimeStore";
import {
  applyStreamFrames,
  applyTimelineUpdates,
} from "./timelineRuntime";

export type { AgentSessionConnectionStatus } from "./sessionRuntimeStore";

const HISTORY_PAGE_SIZE = 80;
const CONNECT_TIMEOUT_MS = 12_000;
const SNAPSHOT_TIMEOUT_MS = 12_000;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const HIDDEN_RECONNECT_MIN_DELAY_MS = 15_000;
const FRAME_FLUSH_FALLBACK_MS = 100;
const MAX_PENDING_STREAM_FRAMES = 256;

type AgentSessionDirectoryValue = {
  sessions: AgentSessionSummary[];
  sessionsLoading: boolean;
  sessionsLoadingMore: boolean;
  sessionsHasMore: boolean;
  activeSessionId: string | null;
  activeSessionSummary: AgentSessionSummary | null;
  refreshSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  syncSessionSummaries: (items: AgentSessionSummary[]) => void;
  deleteSession: (sessionId: string) => Promise<void>;
  dropSessionRuntime: (sessionId: string) => void;
  selectSession: (sessionId: string | null, options?: { navigateBlank?: boolean }) => void;
};

type AgentCatalogValue = {
  agents: AgentInfo[];
  defaultAgentCode: string;
};

type AgentSessionCommandsValue = {
  setActiveAgentCode: (code: string) => void;
  send: (
    content: AgentInputPart[],
    sessionId: string | null,
    sandboxContainerId: number | null,
  ) => Promise<void>;
  updateSelectedSandboxContainer: (
    sessionId: string,
    sandboxContainerId: number | null,
  ) => Promise<AgentSessionSummary | null>;
  interrupt: (sessionId?: string | null) => Promise<void>;
  cancelAll: (sessionId?: string | null) => Promise<void>;
  loadPreviousHistory: (sessionId?: string | null) => Promise<void>;
  retryInitialHistory: (sessionId?: string | null) => void;
};

type ActiveSocket = {
  sessionId: string;
  socket: WebSocket;
  cleanup: () => void;
};

type PendingFrames = {
  sessionId: string;
  frames: AgentStreamFrame[];
};

const AgentSessionDirectoryContext = createContext<AgentSessionDirectoryValue | null>(null);
const AgentCatalogContext = createContext<AgentCatalogValue | null>(null);
const AgentSessionCommandsContext = createContext<AgentSessionCommandsValue | null>(null);
const AgentSessionRuntimeStoreContext = createContext<AgentSessionRuntimeStore | null>(null);

export function useAgentSessionDirectory(): AgentSessionDirectoryValue {
  return requireContext(AgentSessionDirectoryContext, "useAgentSessionDirectory");
}

export function useAgentCatalog(): AgentCatalogValue {
  return requireContext(AgentCatalogContext, "useAgentCatalog");
}

export function useAgentSessionCommands(): AgentSessionCommandsValue {
  return requireContext(AgentSessionCommandsContext, "useAgentSessionCommands");
}

const selectRuntime = (runtime: SessionRuntime) => runtime;
const selectAgentOverride = (runtime: SessionRuntime) => runtime.agentCodeOverride;

export function useActiveSessionRuntime(): SessionRuntime {
  return useActiveSessionRuntimeSelector(selectRuntime);
}

export function useActiveSessionRuntimeSelector<Selected>(
  selector: (runtime: SessionRuntime) => Selected,
): Selected {
  const { activeSessionId } = useAgentSessionDirectory();
  const store = requireContext(AgentSessionRuntimeStoreContext, "useActiveSessionRuntimeSelector");
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(activeSessionId, listener),
    [activeSessionId, store],
  );
  const getSnapshot = useCallback(
    () => selectorRef.current(store.getSnapshot(activeSessionId)),
    [activeSessionId, store],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useActiveAgentCode(): string {
  const { activeSessionId, activeSessionSummary } = useAgentSessionDirectory();
  const { defaultAgentCode } = useAgentCatalog();
  const override = useActiveSessionRuntimeSelector(selectAgentOverride);
  const pendingAgentCode = requireContext(PendingAgentCodeContext, "useActiveAgentCode");
  if (!activeSessionId) return pendingAgentCode || defaultAgentCode;
  return override || activeSessionSummary?.agent_code || defaultAgentCode;
}

const PendingAgentCodeContext = createContext<string | null>(null);

export function AgentSessionProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const runtimeStore = useMemo(() => new AgentSessionRuntimeStore(), []);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [sessionSummaries, setSessionSummaries] = useState<Map<string, AgentSessionSummary>>(() => new Map());
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [defaultAgentCode, setDefaultAgentCode] = useState("");
  const [pendingAgentCode, setPendingAgentCode] = useState("");

  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const activeSelectionGenerationRef = useRef(0);
  const streamingEnabledRef = useRef(location.pathname.startsWith(DEFAULT_ADMIN_PATH));
  streamingEnabledRef.current = location.pathname.startsWith(DEFAULT_ADMIN_PATH);
  const sessionsPageRef = useRef(1);
  const sessionsLoadingMoreRef = useRef(false);
  const manualBlankSessionRef = useRef(false);
  const activeSocketRef = useRef<ActiveSocket | null>(null);
  const socketCloseInProgressRef = useRef(false);
  const connectForRef = useRef<(sessionId: string) => boolean>(() => false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const permanentSocketFailureRef = useRef<string | null>(null);
  const pendingFramesRef = useRef<PendingFrames | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const frameFallbackTimerRef = useRef<number | null>(null);
  const initialHistoryControllersRef = useRef<Map<string, AbortController>>(new Map());
  const catchupControllersRef = useRef<Map<string, AbortController>>(new Map());
  const catchupRetryTimersRef = useRef<Map<string, number>>(new Map());
  const catchupRetryAttemptsRef = useRef<Map<string, number>>(new Map());
  const freshSnapshotRequestedRef = useRef<Set<string>>(new Set());
  const sessionListControllerRef = useRef<AbortController | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const deletedSessionsRef = useRef<Set<string>>(new Set());
  const sandboxSelectionControllersRef = useRef<Map<string, AbortController>>(new Map());
  const controlCommandSessionsRef = useRef<Set<string>>(new Set());
  const refreshLatestTimelineRef = useRef<(sessionId: string) => void>(() => undefined);
  const requestFreshSnapshotRef = useRef<(sessionId: string) => void>(() => undefined);

  const clearCatchupRetry = useCallback((sessionId: string) => {
    const retryTimer = catchupRetryTimersRef.current.get(sessionId);
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    catchupRetryTimersRef.current.delete(sessionId);
    catchupRetryAttemptsRef.current.delete(sessionId);
  }, []);

  const abortSessionRequests = useCallback((sessionId: string) => {
    initialHistoryControllersRef.current.get(sessionId)?.abort();
    initialHistoryControllersRef.current.delete(sessionId);
    catchupControllersRef.current.get(sessionId)?.abort();
    catchupControllersRef.current.delete(sessionId);
    clearCatchupRetry(sessionId);
    freshSnapshotRequestedRef.current.delete(sessionId);
    sandboxSelectionControllersRef.current.get(sessionId)?.abort();
    sandboxSelectionControllersRef.current.delete(sessionId);
    if (runtimeStore.has(sessionId)) {
      runtimeStore.update(sessionId, (runtime) => {
        if (!runtime.history.loadingInitial && !runtime.history.loadingPrevious) return runtime;
        return {
          ...runtime,
          history: {
            ...runtime.history,
            loadingInitial: false,
            loadingPrevious: false,
          },
        };
      });
    }
  }, [clearCatchupRetry, runtimeStore]);

  const evictRuntimeCache = useCallback(() => {
    const evicted = runtimeStore.evict(activeSessionIdRef.current);
    for (const sessionId of evicted) abortSessionRequests(sessionId);
  }, [abortSessionRequests, runtimeStore]);

  const updateRuntime = useCallback((
    sessionId: string,
    update: (runtime: SessionRuntime) => SessionRuntime,
  ) => {
    const next = runtimeStore.update(sessionId, update);
    evictRuntimeCache();
    return next;
  }, [evictRuntimeCache, runtimeStore]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const syncSessionSummaries = useCallback((items: AgentSessionSummary[]) => {
    if (!items.length) return;
    setSessionSummaries((current) => {
      let next: Map<string, AgentSessionSummary> | null = null;
      for (const session of items) {
        if (deletedSessionsRef.current.has(session.session_id)) continue;
        const existing = current.get(session.session_id);
        if (existing && shallowEqual(existing, session)) continue;
        next ??= new Map(current);
        next.set(session.session_id, session);
      }
      return next ?? current;
    });
  }, []);

  const syncSession = useCallback((item: AgentSessionSummary) => {
    syncSessionSummaries([item]);
    setSessions((current) => {
      if (item.session_type !== SESSION_TYPE.CHAT) {
        return current.some((session) => session.session_id === item.session_id)
          ? current.filter((session) => session.session_id !== item.session_id)
          : current;
      }
      const index = current.findIndex((session) => session.session_id === item.session_id);
      if (index < 0) return [item, ...current];
      if (shallowEqual(current[index], item)) return current;
      const next = current.slice();
      next[index] = item;
      return next;
    });
  }, [syncSessionSummaries]);

  useEffect(() => {
    let active = true;
    listAgents()
      .then((response) => {
        if (!active) return;
        setAgents(response.data?.items ?? []);
        setDefaultAgentCode(response.data?.default_code ?? "");
      })
      .catch((error) => {
        if (active) showApiError(error);
      });
    return () => { active = false; };
  }, []);

  const refreshSessions = useCallback(async (silent = false) => {
    sessionListControllerRef.current?.abort();
    if (!silent) {
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
      sessionsLoadingMoreRef.current = false;
      setSessionsLoadingMore(false);
    }
    const controller = new AbortController();
    sessionListControllerRef.current = controller;
    if (!silent) setSessionsLoading(true);
    try {
      const response = await listAgentSessions({ page: 1, size: RESOURCE_PAGE_SIZE }, controller.signal);
      if (sessionListControllerRef.current !== controller) return;
      const items = validAgentSessionSummaries(response.data?.items).filter(
        (session) => !deletedSessionsRef.current.has(session.session_id),
      );
      if (silent && sessionsPageRef.current > 1) {
        setSessions((current) => mergeRefreshedSessionHead(current, items));
      } else {
        setSessions(items);
        setSessionsPage(1);
        sessionsPageRef.current = 1;
      }
      setSessionsTotal(response.data?.total ?? items.length);
      syncSessionSummaries(items);
    } catch (error) {
      if (!isAbortError(error) && !silent) showApiError(error);
    } finally {
      if (sessionListControllerRef.current === controller) {
        sessionListControllerRef.current = null;
        setSessionsLoading(false);
      }
    }
  }, [syncSessionSummaries]);

  const loadMoreSessions = useCallback(async () => {
    if (sessionsLoadingMoreRef.current || sessions.length >= sessionsTotal) return;
    const nextPage = sessionsPage + 1;
    sessionsLoadingMoreRef.current = true;
    setSessionsLoadingMore(true);
    loadMoreControllerRef.current?.abort();
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    try {
      const response = await listAgentSessions(
        { page: nextPage, size: RESOURCE_PAGE_SIZE },
        controller.signal,
      );
      if (loadMoreControllerRef.current !== controller) return;
      const items = validAgentSessionSummaries(response.data?.items).filter(
        (session) => !deletedSessionsRef.current.has(session.session_id),
      );
      setSessions((current) => mergeByKey(current, items, (session) => session.session_id));
      setSessionsPage(nextPage);
      sessionsPageRef.current = nextPage;
      setSessionsTotal(response.data?.total ?? sessionsTotal);
      syncSessionSummaries(items);
    } catch (error) {
      if (!isAbortError(error)) showApiError(error);
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        sessionsLoadingMoreRef.current = false;
        setSessionsLoadingMore(false);
      }
    }
  }, [sessions.length, sessionsPage, sessionsTotal, syncSessionSummaries]);

  const refreshSessionsRef = useRef(refreshSessions);
  refreshSessionsRef.current = refreshSessions;

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const flushPendingFrames = useCallback(() => {
    if (frameRequestRef.current !== null) {
      window.cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }
    if (frameFallbackTimerRef.current !== null) {
      window.clearTimeout(frameFallbackTimerRef.current);
      frameFallbackTimerRef.current = null;
    }
    const pending = pendingFramesRef.current;
    pendingFramesRef.current = null;
    if (!pending || deletedSessionsRef.current.has(pending.sessionId)) return;
    let reconcile = false;
    let receivedSnapshot = false;
    let needsFreshSnapshot = false;
    let neededReconciliationBeforeBatch = false;
    updateRuntime(pending.sessionId, (runtime) => {
      neededReconciliationBeforeBatch = runtime.timeline.needsReconciliation;
      const timeline = applyStreamFrames(runtime.timeline, pending.frames);
      const snapshot = findLatestSnapshot(pending.frames);
      receivedSnapshot = Boolean(snapshot);
      const withTimeline = replaceSessionTimeline(runtime, timeline);
      const next = snapshot ? {
        ...withTimeline,
        socket: { snapshotReceived: true },
      } : withTimeline;
      needsFreshSnapshot = next.timeline.needsReconciliation;
      reconcile = next.history.initialLoaded && (
        receivedSnapshot
        || (!neededReconciliationBeforeBatch && next.timeline.needsReconciliation)
      );
      return next;
    });
    if (receivedSnapshot) {
      reconnectAttemptRef.current = 0;
      if (permanentSocketFailureRef.current === pending.sessionId) {
        permanentSocketFailureRef.current = null;
      }
    }
    if (!needsFreshSnapshot) {
      freshSnapshotRequestedRef.current.delete(pending.sessionId);
      clearCatchupRetry(pending.sessionId);
    } else if (receivedSnapshot && neededReconciliationBeforeBatch) {
      freshSnapshotRequestedRef.current.add(pending.sessionId);
    } else if (!freshSnapshotRequestedRef.current.has(pending.sessionId)) {
      freshSnapshotRequestedRef.current.add(pending.sessionId);
      requestFreshSnapshotRef.current(pending.sessionId);
    }
    if (reconcile) refreshLatestTimelineRef.current(pending.sessionId);
    if (pending.frames.some((frame) => (
      frame.type === AGENT_STREAM_FRAME_TYPE.SNAPSHOT
    ) || (
      frame.type === AGENT_STREAM_FRAME_TYPE.RUN_STATE && !frame.main_agent_running
    ) || (
      frame.type === AGENT_STREAM_FRAME_TYPE.ITEM_UPSERT
      && frame.item.type === AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE
    ))) {
      void refreshSessionsRef.current(true);
    }
  }, [clearCatchupRetry, updateRuntime]);

  const enqueueFrame = useCallback((sessionId: string, frame: AgentStreamFrame) => {
    const pending = pendingFramesRef.current;
    if (pending?.sessionId === sessionId) pending.frames.push(frame);
    else {
      if (pending) flushPendingFrames();
      pendingFramesRef.current = { sessionId, frames: [frame] };
    }
    if ((pendingFramesRef.current?.frames.length ?? 0) >= MAX_PENDING_STREAM_FRAMES) {
      flushPendingFrames();
      return;
    }
    if (frameRequestRef.current === null) {
      frameRequestRef.current = window.requestAnimationFrame(flushPendingFrames);
    }
    if (frameFallbackTimerRef.current === null) {
      frameFallbackTimerRef.current = window.setTimeout(flushPendingFrames, FRAME_FLUSH_FALLBACK_MS);
    }
  }, [flushPendingFrames]);

  const scheduleCatchupRetry = useCallback((sessionId: string) => {
    if (
      catchupRetryTimersRef.current.has(sessionId)
      || activeSessionIdRef.current !== sessionId
      || deletedSessionsRef.current.has(sessionId)
      || !runtimeStore.has(sessionId)
      || !runtimeStore.getSnapshot(sessionId).timeline.needsReconciliation
    ) return;
    const attempt = catchupRetryAttemptsRef.current.get(sessionId) ?? 0;
    catchupRetryAttemptsRef.current.set(sessionId, Math.min(attempt + 1, 8));
    const delay = Math.min(5_000, 250 * (2 ** attempt));
    const timer = window.setTimeout(() => {
      catchupRetryTimersRef.current.delete(sessionId);
      refreshLatestTimelineRef.current(sessionId);
    }, delay);
    catchupRetryTimersRef.current.set(sessionId, timer);
  }, [runtimeStore]);

  const refreshLatestTimeline = useCallback((sessionId: string) => {
    if (
      activeSessionIdRef.current !== sessionId
      || deletedSessionsRef.current.has(sessionId)
      || !runtimeStore.has(sessionId)
    ) return;
    if (catchupControllersRef.current.has(sessionId)) return;
    const retryTimer = catchupRetryTimersRef.current.get(sessionId);
    if (retryTimer !== undefined) {
      window.clearTimeout(retryTimer);
      catchupRetryTimersRef.current.delete(sessionId);
    }
    const controller = new AbortController();
    let retry = false;
    catchupControllersRef.current.set(sessionId, controller);
    listAgentTimeline(sessionId, { limit: HISTORY_PAGE_SIZE }, controller.signal)
      .then((response) => {
        if (catchupControllersRef.current.get(sessionId) !== controller) return;
        if (
          activeSessionIdRef.current !== sessionId
          || deletedSessionsRef.current.has(sessionId)
          || !runtimeStore.has(sessionId)
        ) return;
        const page = requireTimelinePageData(response.data, sessionId);
        const next = updateRuntime(sessionId, (runtime) => mergeLatestHistory(
          runtime,
          page.items,
        ));
        if (!next.timeline.needsReconciliation) {
          catchupRetryAttemptsRef.current.delete(sessionId);
          freshSnapshotRequestedRef.current.delete(sessionId);
          return;
        }
        retry = true;
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        retry = activeSessionIdRef.current === sessionId
          && !deletedSessionsRef.current.has(sessionId)
          && runtimeStore.has(sessionId)
          && runtimeStore.getSnapshot(sessionId).timeline.needsReconciliation;
      })
      .finally(() => {
        if (catchupControllersRef.current.get(sessionId) === controller) {
          catchupControllersRef.current.delete(sessionId);
          if (retry) scheduleCatchupRetry(sessionId);
        }
      });
  }, [runtimeStore, scheduleCatchupRetry, updateRuntime]);
  refreshLatestTimelineRef.current = refreshLatestTimeline;

  const scheduleReconnect = useCallback((sessionId: string) => {
    clearReconnectTimer();
    if (
      activeSessionIdRef.current !== sessionId
      || !streamingEnabledRef.current
      || deletedSessionsRef.current.has(sessionId)
      || permanentSocketFailureRef.current === sessionId
      || navigator.onLine === false
    ) return;
    const attempt = reconnectAttemptRef.current;
    reconnectAttemptRef.current += 1;
    const exponential = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** attempt));
    const jittered = Math.round(exponential * (0.8 + Math.random() * 0.4));
    const delay = document.visibilityState === "hidden"
      ? Math.max(HIDDEN_RECONNECT_MIN_DELAY_MS, jittered)
      : jittered;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      connectForRef.current(sessionId);
    }, delay);
  }, [clearReconnectTimer]);

  const closeActiveSocket = useCallback((abortRequests = false) => {
    clearReconnectTimer();
    const active = activeSocketRef.current;
    if (!active) return;
    activeSocketRef.current = null;
    socketCloseInProgressRef.current = true;
    try {
      flushPendingFrames();
    } finally {
      socketCloseInProgressRef.current = false;
    }
    active.cleanup();
    active.socket.close(1000, "client navigation");
    if (abortRequests) abortSessionRequests(active.sessionId);
    if (runtimeStore.has(active.sessionId)) {
      updateRuntime(active.sessionId, (runtime) => (
        runtime.status === "closed" ? runtime : { ...runtime, status: "closed" }
      ));
    }
  }, [abortSessionRequests, clearReconnectTimer, flushPendingFrames, runtimeStore, updateRuntime]);

  const connectFor = useCallback((sessionId: string): boolean => {
    if (
      activeSessionIdRef.current !== sessionId
      || !streamingEnabledRef.current
      || deletedSessionsRef.current.has(sessionId)
    ) return false;
    const existing = activeSocketRef.current;
    if (existing?.sessionId === sessionId && (
      existing.socket.readyState === WebSocket.CONNECTING
      || existing.socket.readyState === WebSocket.OPEN
    )) return true;
    if (existing) closeActiveSocket();
    clearReconnectTimer();

    const token = getStoredAccessToken();
    if (!token || navigator.onLine === false) {
      updateRuntime(sessionId, (runtime) => ({ ...runtime, status: "closed" }));
      return false;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(buildAgentStreamUrl(sessionId, token));
    } catch {
      updateRuntime(sessionId, (runtime) => ({ ...runtime, status: "closed" }));
      scheduleReconnect(sessionId);
      return false;
    }
    let terminated = false;
    let connectTimer = window.setTimeout(() => terminate(), CONNECT_TIMEOUT_MS);
    let snapshotTimer: number | null = null;
    updateRuntime(sessionId, (runtime) => ({
      ...runtime,
      status: "connecting",
      socket: { snapshotReceived: false },
    }));

    const onOpen = () => {
      if (activeSocketRef.current?.socket !== socket) return;
      window.clearTimeout(connectTimer);
      connectTimer = 0;
      snapshotTimer = window.setTimeout(() => terminate(), SNAPSHOT_TIMEOUT_MS);
      updateRuntime(sessionId, (runtime) => ({ ...runtime, status: "open" }));
    };
    const onMessage = (event: MessageEvent) => {
      if (activeSocketRef.current?.socket !== socket) return;
      if (typeof event.data !== "string") return;
      try {
        const frame = parseAgentStreamFrame(JSON.parse(event.data) as unknown);
        if (!frame) return;
        if (frame.type === AGENT_STREAM_FRAME_TYPE.SNAPSHOT && snapshotTimer !== null) {
          window.clearTimeout(snapshotTimer);
          snapshotTimer = null;
        }
        enqueueFrame(sessionId, frame);
      } catch {
        return;
      }
    };
    const onClose = (event: CloseEvent) => terminate(event.code);
    const cleanup = () => {
      if (connectTimer) window.clearTimeout(connectTimer);
      if (snapshotTimer !== null) window.clearTimeout(snapshotTimer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
    };
    function terminate(closeCode?: number) {
      if (terminated || activeSocketRef.current?.socket !== socket) return;
      terminated = true;
      activeSocketRef.current = null;
      socketCloseInProgressRef.current = true;
      try {
        flushPendingFrames();
      } finally {
        socketCloseInProgressRef.current = false;
      }
      cleanup();
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
      if (runtimeStore.has(sessionId)) {
        updateRuntime(sessionId, (runtime) => ({ ...runtime, status: "closed" }));
      }
      if (isPermanentSocketClose(closeCode)) {
        permanentSocketFailureRef.current = sessionId;
      } else {
        scheduleReconnect(sessionId);
      }
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    activeSocketRef.current = { sessionId, socket, cleanup };
    return true;
  }, [clearReconnectTimer, closeActiveSocket, enqueueFrame, flushPendingFrames, runtimeStore, scheduleReconnect, updateRuntime]);
  connectForRef.current = connectFor;

  const requestFreshSnapshot = useCallback((sessionId: string) => {
    if (
      activeSessionIdRef.current !== sessionId
      || deletedSessionsRef.current.has(sessionId)
      || !streamingEnabledRef.current
      || socketCloseInProgressRef.current
    ) return;
    if (activeSocketRef.current?.sessionId === sessionId) closeActiveSocket();
    reconnectAttemptRef.current = 0;
    connectForRef.current(sessionId);
  }, [closeActiveSocket]);
  requestFreshSnapshotRef.current = requestFreshSnapshot;

  const loadHistory = useCallback((sessionId: string) => {
    if (deletedSessionsRef.current.has(sessionId)) return;
    const runtime = runtimeStore.ensure(sessionId);
    if (runtime.history.initialLoaded || runtime.history.loadingInitial) return;
    initialHistoryControllersRef.current.get(sessionId)?.abort();
    const controller = new AbortController();
    initialHistoryControllersRef.current.set(sessionId, controller);
    updateRuntime(sessionId, (current) => ({
      ...current,
      history: { ...current.history, loadingInitial: true, initialError: null },
    }));
    listAgentTimeline(sessionId, { limit: HISTORY_PAGE_SIZE }, controller.signal)
      .then((response) => {
        if (initialHistoryControllersRef.current.get(sessionId) !== controller) return;
        if (deletedSessionsRef.current.has(sessionId) || !runtimeStore.has(sessionId)) return;
        const page = requireTimelinePageData(response.data, sessionId);
        const next = updateRuntime(sessionId, (current) => mergeInitialHistory(current, {
          items: page.items,
          hasMore: page.hasMore,
          nextBeforeSequence: page.nextBeforeSequence,
        }));
        if (next.socket.snapshotReceived) refreshLatestTimelineRef.current(sessionId);
      })
      .catch((error) => {
        if (isAbortError(error) || deletedSessionsRef.current.has(sessionId)) return;
        showApiError(error);
        if (runtimeStore.has(sessionId)) {
          updateRuntime(sessionId, (current) => ({
            ...current,
            history: {
              ...current.history,
              loadingInitial: false,
              initialError: errorMessage(error),
            },
          }));
        }
      })
      .finally(() => {
        if (initialHistoryControllersRef.current.get(sessionId) === controller) {
          initialHistoryControllersRef.current.delete(sessionId);
        }
      });
  }, [runtimeStore, updateRuntime]);

  const retryInitialHistory = useCallback((sessionId: string | null = activeSessionIdRef.current) => {
    const targetSessionId = sessionId ?? activeSessionIdRef.current;
    if (targetSessionId) loadHistory(targetSessionId);
  }, [loadHistory]);

  const loadPreviousHistory = useCallback(async (sessionId: string | null = activeSessionIdRef.current) => {
    const targetSessionId = sessionId ?? activeSessionIdRef.current;
    if (!targetSessionId || deletedSessionsRef.current.has(targetSessionId)) return;
    const runtime = runtimeStore.getSnapshot(targetSessionId);
    if (
      !runtime.history.initialLoaded
      || !runtime.history.hasMoreBefore
      || runtime.history.beforeSequence === null
      || runtime.history.loadingPrevious
    ) return;
    initialHistoryControllersRef.current.get(targetSessionId)?.abort();
    const controller = new AbortController();
    initialHistoryControllersRef.current.set(targetSessionId, controller);
    updateRuntime(targetSessionId, (current) => ({
      ...current,
      history: { ...current.history, loadingPrevious: true },
    }));
    try {
      const response = await listAgentTimeline(targetSessionId, {
        before_sequence: runtime.history.beforeSequence,
        limit: HISTORY_PAGE_SIZE,
      }, controller.signal);
      if (initialHistoryControllersRef.current.get(targetSessionId) !== controller) return;
      if (deletedSessionsRef.current.has(targetSessionId) || !runtimeStore.has(targetSessionId)) return;
      const page = requireTimelinePageData(
        response.data,
        targetSessionId,
        runtime.history.beforeSequence,
      );
      updateRuntime(targetSessionId, (current) => mergePreviousHistory(current, {
        items: page.items,
        hasMore: page.hasMore,
        nextBeforeSequence: page.nextBeforeSequence,
      }));
    } catch (error) {
      if (initialHistoryControllersRef.current.get(targetSessionId) !== controller) return;
      if (!isAbortError(error) && !deletedSessionsRef.current.has(targetSessionId)) showApiError(error);
      if (runtimeStore.has(targetSessionId)) {
        updateRuntime(targetSessionId, (current) => ({
          ...current,
          history: { ...current.history, loadingPrevious: false },
        }));
      }
    } finally {
      if (initialHistoryControllersRef.current.get(targetSessionId) === controller) {
        initialHistoryControllersRef.current.delete(targetSessionId);
      }
    }
  }, [runtimeStore, updateRuntime]);

  const selectSession = useCallback((
    sessionId: string | null,
    options: { navigateBlank?: boolean } = {},
  ) => {
    activeSelectionGenerationRef.current += 1;
    const previousSessionId = activeSessionIdRef.current;
    if (previousSessionId && previousSessionId !== sessionId) {
      if (activeSocketRef.current?.sessionId === previousSessionId) closeActiveSocket();
      abortSessionRequests(previousSessionId);
      reconnectAttemptRef.current = 0;
    }
    if (sessionId) {
      runtimeStore.ensure(sessionId);
      if (permanentSocketFailureRef.current === sessionId) permanentSocketFailureRef.current = null;
    }
    manualBlankSessionRef.current = sessionId === null && options.navigateBlank !== false;
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    evictRuntimeCache();
    if (sessionId && previousSessionId === sessionId && !activeSocketRef.current) {
      connectForRef.current(sessionId);
    }
  }, [abortSessionRequests, closeActiveSocket, evictRuntimeCache, runtimeStore]);

  const openLiveSession = useCallback((sessionId: string) => {
    updateRuntime(sessionId, (runtime) => ({
      ...runtime,
      history: {
        ...runtime.history,
        initialLoaded: true,
        initialError: null,
        loadingInitial: false,
        hasMoreBefore: false,
        beforeSequence: null,
      },
    }));
    manualBlankSessionRef.current = false;
    activeSelectionGenerationRef.current += 1;
    reconnectAttemptRef.current = 0;
    permanentSocketFailureRef.current = null;
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  }, [updateRuntime]);

  const streamingEnabled = location.pathname.startsWith(DEFAULT_ADMIN_PATH);
  useEffect(() => {
    if (!activeSessionId || !streamingEnabled) {
      closeActiveSocket(true);
      return;
    }
    runtimeStore.ensure(activeSessionId);
    loadHistory(activeSessionId);
    connectFor(activeSessionId);
    return () => {
      if (activeSocketRef.current?.sessionId === activeSessionId) closeActiveSocket(true);
    };
  }, [activeSessionId, closeActiveSocket, connectFor, loadHistory, runtimeStore, streamingEnabled]);

  useEffect(() => {
    if (activeSessionId || manualBlankSessionRef.current) return;
    const running = sessions.find((session) => session.is_running);
    if (running) {
      runtimeStore.ensure(running.session_id);
      activeSelectionGenerationRef.current += 1;
      activeSessionIdRef.current = running.session_id;
      setActiveSessionId(running.session_id);
    }
  }, [activeSessionId, runtimeStore, sessions]);

  useEffect(() => {
    const reconnectNow = () => {
      const sessionId = activeSessionIdRef.current;
      if (
        !sessionId
        || !streamingEnabledRef.current
        || permanentSocketFailureRef.current === sessionId
      ) return;
      reconnectAttemptRef.current = 0;
      clearReconnectTimer();
      connectForRef.current(sessionId);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !activeSocketRef.current) reconnectNow();
    };
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [clearReconnectTimer]);

  const setActiveAgentCode = useCallback((code: string) => {
    if (!agents.some((agent) => agent.code === code)) return;
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      activeSelectionGenerationRef.current += 1;
      setPendingAgentCode(code);
      return;
    }
    updateRuntime(sessionId, (runtime) => (
      runtime.agentCodeOverride === code ? runtime : { ...runtime, agentCodeOverride: code }
    ));
  }, [agents, updateRuntime]);

  const getSessionAgentCode = useCallback((sessionId: string | null) => {
    if (!sessionId) return pendingAgentCode || defaultAgentCode;
    const runtime = runtimeStore.getSnapshot(sessionId);
    return runtime.agentCodeOverride || sessionSummaries.get(sessionId)?.agent_code || defaultAgentCode;
  }, [defaultAgentCode, pendingAgentCode, runtimeStore, sessionSummaries]);

  const updateSelectedSandboxContainer = useCallback(async (
    sessionId: string,
    sandboxContainerId: number | null,
  ) => {
    sandboxSelectionControllersRef.current.get(sessionId)?.abort();
    const controller = new AbortController();
    sandboxSelectionControllersRef.current.set(sessionId, controller);
    try {
      const response = await updateAgentSessionSandboxContainer(sessionId, {
        sandbox_container_id: sandboxContainerId,
      }, controller.signal);
      if (
        sandboxSelectionControllersRef.current.get(sessionId) !== controller
        || deletedSessionsRef.current.has(sessionId)
      ) return null;
      const summary = response.data === null || response.data === undefined
        ? null
        : parseAgentSessionSummary(response.data);
      if (response.data && !summary) throw new Error("agent session sandbox response is malformed");
      if (summary) syncSession(summary);
      return summary;
    } finally {
      if (sandboxSelectionControllersRef.current.get(sessionId) === controller) {
        sandboxSelectionControllersRef.current.delete(sessionId);
      }
    }
  }, [syncSession]);

  const applyTurnData = useCallback((data: AgentTurnData) => {
    if (deletedSessionsRef.current.has(data.session_id)) return;
    syncSession(data.session);
    updateRuntime(data.session_id, (runtime) => replaceSessionTimeline(
      runtime,
      applyTimelineUpdates(runtime.timeline, data.updates, data.main_agent_running),
    ));
  }, [syncSession, updateRuntime]);

  const reconcileTerminalTimeline = useCallback((sessionId: string) => {
    catchupControllersRef.current.get(sessionId)?.abort();
    catchupControllersRef.current.delete(sessionId);
    refreshLatestTimeline(sessionId);
  }, [refreshLatestTimeline]);

  const send = useCallback(async (
    content: AgentInputPart[],
    sessionId: string | null,
    sandboxContainerId: number | null,
  ) => {
    const agentCode = getSessionAgentCode(sessionId);
    const selectionGeneration = activeSelectionGenerationRef.current;
    try {
      if (sessionId) {
        const response = await submitAgentSessionTurn(sessionId, {
          content,
          agent_code: agentCode || null,
          sandbox_container_id: sandboxContainerId,
        });
        applyTurnData(requireTurnData(response.data));
        if (permanentSocketFailureRef.current === sessionId) permanentSocketFailureRef.current = null;
        connectFor(sessionId);
        return;
      }
      const response = await createAgentSessionTurn({
        content,
        agent_code: agentCode || null,
        sandbox_container_id: sandboxContainerId,
      });
      const data = requireTurnData(response.data);
      applyTurnData(data);
      if (
        activeSessionIdRef.current === null
        && activeSelectionGenerationRef.current === selectionGeneration
      ) {
        setPendingAgentCode("");
        openLiveSession(data.session_id);
      }
    } catch (error) {
      showApiError(error);
      throw error;
    }
  }, [applyTurnData, connectFor, getSessionAgentCode, openLiveSession]);

  const interrupt = useCallback(async (sessionId: string | null = activeSessionIdRef.current) => {
    const targetSessionId = sessionId ?? activeSessionIdRef.current;
    if (!targetSessionId || controlCommandSessionsRef.current.has(targetSessionId)) return;
    controlCommandSessionsRef.current.add(targetSessionId);
    try {
      const response = await interruptAgentSession(targetSessionId);
      if (!deletedSessionsRef.current.has(targetSessionId)) {
        applyTurnData(requireTurnData(response.data));
        reconcileTerminalTimeline(targetSessionId);
      }
    } catch (error) {
      if (!deletedSessionsRef.current.has(targetSessionId)) showApiError(error);
    } finally {
      controlCommandSessionsRef.current.delete(targetSessionId);
    }
  }, [applyTurnData, reconcileTerminalTimeline]);

  const cancelAll = useCallback(async (sessionId: string | null = activeSessionIdRef.current) => {
    const targetSessionId = sessionId ?? activeSessionIdRef.current;
    if (!targetSessionId || controlCommandSessionsRef.current.has(targetSessionId)) return;
    controlCommandSessionsRef.current.add(targetSessionId);
    try {
      const response = await cancelAllAgentSessionTasks(targetSessionId);
      if (!deletedSessionsRef.current.has(targetSessionId)) {
        applyTurnData(requireTurnData(response.data));
        reconcileTerminalTimeline(targetSessionId);
      }
    } catch (error) {
      if (!deletedSessionsRef.current.has(targetSessionId)) showApiError(error);
    } finally {
      controlCommandSessionsRef.current.delete(targetSessionId);
    }
  }, [applyTurnData, reconcileTerminalTimeline]);

  const dropSessionRuntime = useCallback((sessionId: string) => {
    deletedSessionsRef.current.add(sessionId);
    if (activeSocketRef.current?.sessionId === sessionId) closeActiveSocket(true);
    abortSessionRequests(sessionId);
    controlCommandSessionsRef.current.delete(sessionId);
    runtimeStore.drop(sessionId);
    setSessionSummaries((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
    if (activeSessionIdRef.current === sessionId) {
      manualBlankSessionRef.current = true;
      activeSelectionGenerationRef.current += 1;
      reconnectAttemptRef.current = 0;
      activeSessionIdRef.current = null;
      setActiveSessionId(null);
    }
  }, [abortSessionRequests, closeActiveSocket, runtimeStore]);

  const deleteSession = useCallback(async (sessionId: string) => {
    if (deletedSessionsRef.current.has(sessionId)) return;
    deletedSessionsRef.current.add(sessionId);
    setSessions((current) => current.filter((session) => session.session_id !== sessionId));
    dropSessionRuntime(sessionId);
    try {
      const response = await deleteAgentSession(sessionId);
      showApiSuccess(response);
      await refreshSessions();
    } catch (error) {
      deletedSessionsRef.current.delete(sessionId);
      showApiError(error);
      await refreshSessions();
    }
  }, [dropSessionRuntime, refreshSessions]);

  useEffect(() => () => {
    closeActiveSocket();
    clearReconnectTimer();
    if (frameRequestRef.current !== null) window.cancelAnimationFrame(frameRequestRef.current);
    if (frameFallbackTimerRef.current !== null) window.clearTimeout(frameFallbackTimerRef.current);
    pendingFramesRef.current = null;
    sessionListControllerRef.current?.abort();
    loadMoreControllerRef.current?.abort();
    for (const controller of initialHistoryControllersRef.current.values()) controller.abort();
    for (const controller of catchupControllersRef.current.values()) controller.abort();
    for (const controller of sandboxSelectionControllersRef.current.values()) controller.abort();
    for (const timer of catchupRetryTimersRef.current.values()) window.clearTimeout(timer);
    initialHistoryControllersRef.current.clear();
    catchupControllersRef.current.clear();
    catchupRetryTimersRef.current.clear();
    catchupRetryAttemptsRef.current.clear();
    freshSnapshotRequestedRef.current.clear();
    sandboxSelectionControllersRef.current.clear();
  }, [clearReconnectTimer, closeActiveSocket]);

  const activeSessionSummary = activeSessionId ? sessionSummaries.get(activeSessionId) ?? null : null;
  const directoryValue = useMemo<AgentSessionDirectoryValue>(() => ({
    sessions,
    sessionsLoading,
    sessionsLoadingMore,
    sessionsHasMore: sessions.length < sessionsTotal,
    activeSessionId,
    activeSessionSummary,
    refreshSessions,
    loadMoreSessions,
    syncSessionSummaries,
    deleteSession,
    dropSessionRuntime,
    selectSession,
  }), [
    activeSessionId,
    activeSessionSummary,
    deleteSession,
    dropSessionRuntime,
    loadMoreSessions,
    refreshSessions,
    selectSession,
    sessions,
    sessionsLoading,
    sessionsLoadingMore,
    sessionsTotal,
    syncSessionSummaries,
  ]);
  const catalogValue = useMemo<AgentCatalogValue>(() => ({ agents, defaultAgentCode }), [agents, defaultAgentCode]);
  const commandsValue = useMemo<AgentSessionCommandsValue>(() => ({
    setActiveAgentCode,
    send,
    updateSelectedSandboxContainer,
    interrupt,
    cancelAll,
    loadPreviousHistory,
    retryInitialHistory,
  }), [
    cancelAll,
    interrupt,
    loadPreviousHistory,
    retryInitialHistory,
    send,
    setActiveAgentCode,
    updateSelectedSandboxContainer,
  ]);

  return (
    <AgentSessionRuntimeStoreContext.Provider value={runtimeStore}>
      <AgentSessionDirectoryContext.Provider value={directoryValue}>
        <AgentCatalogContext.Provider value={catalogValue}>
          <AgentSessionCommandsContext.Provider value={commandsValue}>
            <PendingAgentCodeContext.Provider value={pendingAgentCode}>
              {children}
            </PendingAgentCodeContext.Provider>
          </AgentSessionCommandsContext.Provider>
        </AgentCatalogContext.Provider>
      </AgentSessionDirectoryContext.Provider>
    </AgentSessionRuntimeStoreContext.Provider>
  );
}

function requireContext<Value>(context: React.Context<Value | null>, hookName: string): Value {
  const value = useContext(context);
  if (value === null) throw new Error(`${hookName} must be used inside AgentSessionProvider`);
  return value;
}

function requireTurnData(data: AgentTurnData | null | undefined): AgentTurnData {
  const normalized = normalizeAgentTurnData(data);
  if (!normalized) throw new Error("agent session turn response is malformed");
  return normalized;
}

function requireTimelinePageData(
  data: unknown,
  sessionId: string,
  beforeSequence: number | null = null,
) {
  const normalized = normalizeAgentTimelinePageData(data, sessionId, beforeSequence);
  if (!normalized) throw new Error("agent session timeline response is malformed");
  return normalized;
}

function findLatestSnapshot(frames: readonly AgentStreamFrame[]) {
  let latest: Extract<AgentStreamFrame, { type: "snapshot" }> | null = null;
  for (const frame of frames) {
    if (frame.type === AGENT_STREAM_FRAME_TYPE.SNAPSHOT) latest = frame;
  }
  return latest;
}

function isPermanentSocketClose(closeCode: number | undefined): boolean {
  return closeCode === 1008 || closeCode === 4001 || closeCode === 4003 || closeCode === 4401 || closeCode === 4403;
}

function mergeRefreshedSessionHead(
  current: AgentSessionSummary[],
  head: AgentSessionSummary[],
): AgentSessionSummary[] {
  const headIds = new Set(head.map((session) => session.session_id));
  const merged = [...head, ...current.filter((session) => !headIds.has(session.session_id))];
  if (merged.length !== current.length) return merged;
  return merged.every((session, index) => shallowEqual(session, current[index])) ? current : merged;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Failed to load conversation history";
}
