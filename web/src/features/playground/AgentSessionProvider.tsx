import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listAgents } from "../../shared/api/agents";
import {
  AGENT_STREAM_FRAME_TYPE,
  AGENT_STREAM_FRAME_TYPE_VALUES,
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
import type {
  AgentInfo,
  AgentInputPart,
  AgentSessionSummary,
  AgentStreamFrame,
  AgentTurnData,
} from "../../shared/api/types";
import type { ChatState } from "./chatState";
import {
  applyStreamFrames,
  applyTimelineUpdates,
  createTimelineRuntime,
  endTimelineStream,
  mergeTimelinePage,
  type TimelineRuntime,
} from "./timelineRuntime";

export type AgentSessionConnectionStatus = "idle" | "connecting" | "open" | "closed";

type SessionRuntime = {
  timeline: TimelineRuntime;
  status: AgentSessionConnectionStatus;
  historyLoading: boolean;
  historyPrepending: boolean;
  historyHasMore: boolean;
  historyBeforeSequence: number | null;
  historyVersion: number;
  agentCodeOverride: string;
  lastAccessedAt: number;
};

function createSessionRuntime(): SessionRuntime {
  return {
    timeline: createTimelineRuntime(),
    status: "idle",
    historyLoading: false,
    historyPrepending: false,
    historyHasMore: false,
    historyBeforeSequence: null,
    historyVersion: 0,
    agentCodeOverride: "",
    lastAccessedAt: Date.now(),
  };
}

const HISTORY_PAGE_SIZE = 80;
const MAX_CACHED_SESSION_RUNTIMES = 8;
const RECONNECT_DELAY_MS = 750;

type AgentSessionContextValue = {
  sessions: AgentSessionSummary[];
  sessionsLoading: boolean;
  sessionsLoadingMore: boolean;
  sessionsHasMore: boolean;
  refreshSessions: () => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  syncSessionSummaries: (items: AgentSessionSummary[]) => void;
  deleteSession: (sessionId: string) => Promise<void>;
  dropSessionRuntime: (sessionId: string) => void;
  activeSessionId: string | null;
  activeSessionSummary: AgentSessionSummary | null;
  selectSession: (sessionId: string | null, options?: { navigateBlank?: boolean }) => void;
  chatState: ChatState;
  status: AgentSessionConnectionStatus;
  historyLoading: boolean;
  historyPrepending: boolean;
  historyHasMore: boolean;
  historyVersion: number;
  agents: AgentInfo[];
  defaultAgentCode: string;
  activeAgentCode: string;
  setActiveAgentCode: (code: string) => void;
  send: (content: AgentInputPart[], sessionId: string | null, sandboxContainerId: number | null) => Promise<void>;
  updateSelectedSandboxContainer: (sessionId: string, sandboxContainerId: number | null) => Promise<AgentSessionSummary | null>;
  interrupt: (sessionId?: string | null) => Promise<void>;
  cancelAll: (sessionId?: string | null) => Promise<void>;
  loadPreviousHistory: (sessionId?: string | null) => Promise<void>;
};

type ActiveSocket = {
  sessionId: string;
  socket: WebSocket;
  cleanup: () => void;
};

const AgentSessionContext = createContext<AgentSessionContextValue | null>(null);

export function useAgentSessionContext(): AgentSessionContextValue {
  const value = useContext(AgentSessionContext);
  if (!value) throw new Error("useAgentSessionContext must be used inside AgentSessionProvider");
  return value;
}

export function AgentSessionProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [sessionSummaries, setSessionSummaries] = useState<Map<string, AgentSessionSummary>>(() => new Map());
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<Map<string, SessionRuntime>>(() => new Map());
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [defaultAgentCode, setDefaultAgentCode] = useState("");
  const [pendingAgentCode, setPendingAgentCode] = useState("");

  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const runtimesRef = useRef(runtimes);
  runtimesRef.current = runtimes;
  const sessionsPageRef = useRef(1);
  const sessionsLoadingMoreRef = useRef(false);
  const manualBlankSessionRef = useRef(false);
  const activeSocketRef = useRef<ActiveSocket | null>(null);
  const connectForRef = useRef<(sessionId: string) => boolean>(() => false);
  const reconnectTimerRef = useRef<number | null>(null);
  const pendingFramesRef = useRef<{ sessionId: string; frames: AgentStreamFrame[] } | null>(null);
  const frameRequestRef = useRef<number | null>(null);
  const ensuredHistoryRef = useRef<Set<string>>(new Set());
  const historyControllersRef = useRef<Map<string, AbortController>>(new Map());
  const catchupControllersRef = useRef<Map<string, AbortController>>(new Map());
  const sessionListControllerRef = useRef<AbortController | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const deletedSessionsRef = useRef<Set<string>>(new Set());
  const sandboxSelectionGenerationRef = useRef<Map<string, number>>(new Map());
  const controlCommandSessionsRef = useRef<Set<string>>(new Set());

  const updateRuntime = useCallback((sessionId: string, update: (runtime: SessionRuntime) => SessionRuntime) => {
    setRuntimes((current) => {
      const existing = current.get(sessionId) ?? createSessionRuntime();
      const updated = update(existing);
      const nextRuntime = updated.lastAccessedAt === existing.lastAccessedAt
        ? { ...updated, lastAccessedAt: Date.now() }
        : updated;
      if (nextRuntime === existing) return current;
      const next = new Map(current);
      next.set(sessionId, nextRuntime);
      return next;
    });
  }, []);

  const initRuntime = useCallback((sessionId: string) => {
    updateRuntime(sessionId, (runtime) => runtime);
  }, [updateRuntime]);

  const abortSessionRequests = useCallback((sessionId: string) => {
    historyControllersRef.current.get(sessionId)?.abort();
    historyControllersRef.current.delete(sessionId);
    catchupControllersRef.current.get(sessionId)?.abort();
    catchupControllersRef.current.delete(sessionId);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const clearPendingFrames = useCallback((sessionId?: string) => {
    if (sessionId && pendingFramesRef.current?.sessionId !== sessionId) return;
    pendingFramesRef.current = null;
    if (frameRequestRef.current !== null) {
      window.cancelAnimationFrame(frameRequestRef.current);
      frameRequestRef.current = null;
    }
  }, []);

  const closeActiveSocket = useCallback((endStreaming = false) => {
    clearReconnectTimer();
    const active = activeSocketRef.current;
    if (!active) return;
    activeSocketRef.current = null;
    active.cleanup();
    active.socket.close();
    abortSessionRequests(active.sessionId);
    clearPendingFrames(active.sessionId);
    updateRuntime(active.sessionId, (runtime) => ({
      ...runtime,
      status: "closed",
      historyLoading: false,
      historyPrepending: false,
      timeline: endStreaming ? endTimelineStream(runtime.timeline) : runtime.timeline,
    }));
  }, [abortSessionRequests, clearPendingFrames, clearReconnectTimer, updateRuntime]);

  const dropSessionRuntime = useCallback((sessionId: string) => {
    if (activeSocketRef.current?.sessionId === sessionId) closeActiveSocket();
    abortSessionRequests(sessionId);
    ensuredHistoryRef.current.delete(sessionId);
    sandboxSelectionGenerationRef.current.delete(sessionId);
    controlCommandSessionsRef.current.delete(sessionId);
    setRuntimes((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
    setSessionSummaries((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  }, [abortSessionRequests, closeActiveSocket]);

  const syncSessionSummaries = useCallback((items: AgentSessionSummary[]) => {
    if (!items.length) return;
    setSessionSummaries((current) => {
      const next = new Map(current);
      for (const session of items) next.set(session.session_id, session);
      return next;
    });
  }, []);

  const syncSession = useCallback((item: AgentSessionSummary) => {
    syncSessionSummaries([item]);
    setSessions((current) => {
      if (item.session_type !== SESSION_TYPE.CHAT) {
        return current.filter((session) => session.session_id !== item.session_id);
      }
      if (!current.some((session) => session.session_id === item.session_id)) return [item, ...current];
      return current.map((session) => session.session_id === item.session_id ? item : session);
    });
  }, [syncSessionSummaries]);

  useEffect(() => {
    listAgents()
      .then((response) => {
        setAgents(response.data?.items ?? []);
        setDefaultAgentCode(response.data?.default_code ?? "");
      })
      .catch(showApiError);
  }, []);

  const refreshSessions = useCallback(async (silent = false) => {
    sessionListControllerRef.current?.abort();
    const controller = new AbortController();
    sessionListControllerRef.current = controller;
    if (!silent) setSessionsLoading(true);
    try {
      const response = await listAgentSessions(
        { page: 1, size: RESOURCE_PAGE_SIZE },
        controller.signal,
      );
      if (sessionListControllerRef.current !== controller) return;
      const items = response.data?.items ?? [];
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
        if (!silent) setSessionsLoading(false);
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
      const items = response.data?.items ?? [];
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
    frameRequestRef.current = null;
    const pending = pendingFramesRef.current;
    pendingFramesRef.current = null;
    if (!pending || deletedSessionsRef.current.has(pending.sessionId)) return;
    updateRuntime(pending.sessionId, (runtime) => ({
      ...runtime,
      timeline: applyStreamFrames(runtime.timeline, pending.frames),
    }));
    if (pending.frames.some((frame) => (
      frame.type === AGENT_STREAM_FRAME_TYPE.RUN_STATE && !frame.main_agent_running
    ) || (
      frame.type === AGENT_STREAM_FRAME_TYPE.ITEM_UPSERT
      && frame.item.type === AGENT_TIMELINE_ITEM_TYPE.USER_MESSAGE
    ))) {
      void refreshSessionsRef.current(true);
    }
  }, [updateRuntime]);

  const enqueueFrame = useCallback((sessionId: string, frame: AgentStreamFrame) => {
    const pending = pendingFramesRef.current;
    if (pending?.sessionId === sessionId) pending.frames.push(frame);
    else pendingFramesRef.current = { sessionId, frames: [frame] };
    if (frameRequestRef.current === null) {
      frameRequestRef.current = window.requestAnimationFrame(flushPendingFrames);
    }
  }, [flushPendingFrames]);

  const refreshLatestTimeline = useCallback((sessionId: string) => {
    if (deletedSessionsRef.current.has(sessionId)) return;
    historyControllersRef.current.get(sessionId)?.abort();
    historyControllersRef.current.delete(sessionId);
    catchupControllersRef.current.get(sessionId)?.abort();
    const controller = new AbortController();
    catchupControllersRef.current.set(sessionId, controller);
    listAgentTimeline(sessionId, { limit: HISTORY_PAGE_SIZE }, controller.signal)
      .then((response) => {
        if (catchupControllersRef.current.get(sessionId) !== controller) return;
        if (deletedSessionsRef.current.has(sessionId)) return;
        const data = response.data;
        if (!data?.items.length) return;
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          timeline: mergeTimelinePage(runtime.timeline, data.items),
          historyLoading: false,
          historyPrepending: false,
          historyHasMore: data.has_more,
          historyBeforeSequence: data.next_before_sequence ?? null,
          historyVersion: runtime.historyVersion + 1,
        }));
      })
      .catch((error) => {
        if (!isAbortError(error)) return;
      })
      .finally(() => {
        if (catchupControllersRef.current.get(sessionId) === controller) {
          catchupControllersRef.current.delete(sessionId);
        }
      });
  }, [updateRuntime]);

  const connectFor = useCallback((sessionId: string): boolean => {
    if (activeSessionIdRef.current !== sessionId || deletedSessionsRef.current.has(sessionId)) return false;
    const existing = activeSocketRef.current;
    if (existing?.sessionId === sessionId && (
      existing.socket.readyState === WebSocket.CONNECTING
      || existing.socket.readyState === WebSocket.OPEN
    )) return true;
    if (existing) closeActiveSocket();
    clearReconnectTimer();

    const token = getStoredAccessToken();
    if (!token) {
      updateRuntime(sessionId, (runtime) => ({ ...runtime, status: "closed" }));
      return false;
    }

    const socket = new WebSocket(buildAgentStreamUrl(sessionId, token));
    updateRuntime(sessionId, (runtime) => ({ ...runtime, status: "connecting" }));

    const onOpen = () => {
      if (activeSocketRef.current?.socket !== socket) return;
      updateRuntime(sessionId, (runtime) => ({ ...runtime, status: "open" }));
      if (ensuredHistoryRef.current.has(sessionId)) refreshLatestTimeline(sessionId);
    };
    const onMessage = (event: MessageEvent) => {
      if (activeSocketRef.current?.socket !== socket) return;
      try {
        const frame = parseAgentStreamFrame(JSON.parse(event.data) as unknown);
        if (frame) enqueueFrame(sessionId, frame);
      } catch {
        return;
      }
    };
    const onTerminate = () => {
      if (activeSocketRef.current?.socket !== socket) return;
      activeSocketRef.current = null;
      cleanup();
      abortSessionRequests(sessionId);
      clearPendingFrames(sessionId);
      updateRuntime(sessionId, (runtime) => ({
        ...runtime,
        status: "closed",
        historyLoading: false,
        historyPrepending: false,
        timeline: endTimelineStream(runtime.timeline),
      }));
      if (activeSessionIdRef.current === sessionId && !deletedSessionsRef.current.has(sessionId)) {
        clearReconnectTimer();
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connectForRef.current(sessionId);
        }, RECONNECT_DELAY_MS);
      }
    };
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onTerminate);
      socket.removeEventListener("error", onTerminate);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onTerminate);
    socket.addEventListener("error", onTerminate);
    activeSocketRef.current = { sessionId, socket, cleanup };
    return true;
  }, [abortSessionRequests, clearPendingFrames, clearReconnectTimer, closeActiveSocket, enqueueFrame, refreshLatestTimeline, updateRuntime]);
  connectForRef.current = connectFor;

  const loadHistory = useCallback((sessionId: string) => {
    if (deletedSessionsRef.current.has(sessionId)) return;
    historyControllersRef.current.get(sessionId)?.abort();
    const controller = new AbortController();
    historyControllersRef.current.set(sessionId, controller);
    initRuntime(sessionId);
    updateRuntime(sessionId, (runtime) => ({ ...runtime, historyLoading: true }));
    listAgentTimeline(sessionId, { limit: HISTORY_PAGE_SIZE }, controller.signal)
      .then((response) => {
        if (historyControllersRef.current.get(sessionId) !== controller) return;
        if (deletedSessionsRef.current.has(sessionId)) return;
        const data = response.data;
        ensuredHistoryRef.current.add(sessionId);
        updateRuntime(sessionId, (runtime) => ({
          ...runtime,
          timeline: mergeTimelinePage(runtime.timeline, data?.items ?? []),
          historyLoading: false,
          historyHasMore: Boolean(data?.has_more),
          historyBeforeSequence: data?.next_before_sequence ?? null,
          historyVersion: runtime.historyVersion + 1,
        }));
      })
      .catch((error) => {
        if (isAbortError(error) || deletedSessionsRef.current.has(sessionId)) return;
        showApiError(error);
        updateRuntime(sessionId, (runtime) => ({ ...runtime, historyLoading: false }));
      })
      .finally(() => {
        if (historyControllersRef.current.get(sessionId) === controller) {
          historyControllersRef.current.delete(sessionId);
        }
      });
  }, [initRuntime, updateRuntime]);

  const ensureHistoryLoaded = useCallback((sessionId: string) => {
    if (!ensuredHistoryRef.current.has(sessionId)) loadHistory(sessionId);
  }, [loadHistory]);

  const openLiveSession = useCallback((sessionId: string) => {
    initRuntime(sessionId);
    ensuredHistoryRef.current.add(sessionId);
    manualBlankSessionRef.current = false;
    setActiveSessionId(sessionId);
  }, [initRuntime]);

  const loadPreviousHistory = useCallback(async (sessionId: string | null = activeSessionId) => {
    const targetSessionId = sessionId ?? activeSessionId;
    if (!targetSessionId || deletedSessionsRef.current.has(targetSessionId)) return;
    const runtime = runtimesRef.current.get(targetSessionId);
    if (!runtime?.historyHasMore || runtime.historyBeforeSequence === null || runtime.historyPrepending) return;
    historyControllersRef.current.get(targetSessionId)?.abort();
    const controller = new AbortController();
    historyControllersRef.current.set(targetSessionId, controller);
    updateRuntime(targetSessionId, (current) => ({ ...current, historyPrepending: true }));
    try {
      const response = await listAgentTimeline(targetSessionId, {
        before_sequence: runtime.historyBeforeSequence,
        limit: HISTORY_PAGE_SIZE,
      }, controller.signal);
      if (historyControllersRef.current.get(targetSessionId) !== controller) return;
      if (deletedSessionsRef.current.has(targetSessionId)) return;
      const data = response.data;
      updateRuntime(targetSessionId, (current) => ({
        ...current,
        timeline: mergeTimelinePage(current.timeline, data?.items ?? []),
        historyPrepending: false,
        historyHasMore: Boolean(data?.has_more),
        historyBeforeSequence: data?.next_before_sequence ?? null,
        historyVersion: current.historyVersion + 1,
      }));
    } catch (error) {
      if (!isAbortError(error) && !deletedSessionsRef.current.has(targetSessionId)) showApiError(error);
      updateRuntime(targetSessionId, (current) => ({ ...current, historyPrepending: false }));
    } finally {
      if (historyControllersRef.current.get(targetSessionId) === controller) {
        historyControllersRef.current.delete(targetSessionId);
      }
    }
  }, [activeSessionId, updateRuntime]);

  const selectSession = useCallback((sessionId: string | null, options: { navigateBlank?: boolean } = {}) => {
    if (sessionId) initRuntime(sessionId);
    manualBlankSessionRef.current = sessionId === null && options.navigateBlank !== false;
    setActiveSessionId(sessionId);
  }, [initRuntime]);

  useEffect(() => {
    if (!activeSessionId) {
      closeActiveSocket();
      return;
    }
    initRuntime(activeSessionId);
    ensureHistoryLoaded(activeSessionId);
    connectFor(activeSessionId);
    return () => {
      if (activeSocketRef.current?.sessionId === activeSessionId) closeActiveSocket();
    };
  }, [activeSessionId, closeActiveSocket, connectFor, ensureHistoryLoaded, initRuntime]);

  useEffect(() => {
    if (activeSessionId || manualBlankSessionRef.current) return;
    const running = sessions.find((session) => session.is_running);
    if (running) setActiveSessionId(running.session_id);
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (runtimes.size <= MAX_CACHED_SESSION_RUNTIMES) return;
    const removable = [...runtimes.entries()]
      .filter(([sessionId]) => sessionId !== activeSessionId)
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)
      .slice(0, runtimes.size - MAX_CACHED_SESSION_RUNTIMES);
    if (!removable.length) return;
    for (const [sessionId] of removable) {
      abortSessionRequests(sessionId);
      ensuredHistoryRef.current.delete(sessionId);
    }
    setRuntimes((current) => {
      const next = new Map(current);
      for (const [sessionId] of removable) next.delete(sessionId);
      return next;
    });
  }, [abortSessionRequests, activeSessionId, runtimes]);

  const sessionAgentCode = useCallback((sessionId: string | null): string => {
    if (!sessionId) return "";
    return sessionSummaries.get(sessionId)?.agent_code ?? "";
  }, [sessionSummaries]);

  const activeAgentCode = useMemo(() => {
    if (!activeSessionId) return pendingAgentCode || defaultAgentCode;
    const runtime = runtimes.get(activeSessionId);
    return runtime?.agentCodeOverride || sessionAgentCode(activeSessionId) || defaultAgentCode;
  }, [activeSessionId, defaultAgentCode, pendingAgentCode, runtimes, sessionAgentCode]);

  const setActiveAgentCode = useCallback((code: string) => {
    if (!agents.some((agent) => agent.code === code)) return;
    if (!activeSessionId) {
      setPendingAgentCode(code);
      return;
    }
    updateRuntime(activeSessionId, (runtime) => ({ ...runtime, agentCodeOverride: code }));
  }, [activeSessionId, agents, updateRuntime]);

  const getSessionAgentCode = useCallback((sessionId: string | null) => {
    if (!sessionId) return pendingAgentCode || defaultAgentCode;
    const runtime = runtimesRef.current.get(sessionId);
    return runtime?.agentCodeOverride || sessionAgentCode(sessionId) || defaultAgentCode;
  }, [defaultAgentCode, pendingAgentCode, sessionAgentCode]);

  const updateSelectedSandboxContainer = useCallback(async (sessionId: string, sandboxContainerId: number | null) => {
    const generation = (sandboxSelectionGenerationRef.current.get(sessionId) ?? 0) + 1;
    sandboxSelectionGenerationRef.current.set(sessionId, generation);
    const response = await updateAgentSessionSandboxContainer(sessionId, {
      sandbox_container_id: sandboxContainerId,
    });
    if (sandboxSelectionGenerationRef.current.get(sessionId) !== generation || deletedSessionsRef.current.has(sessionId)) {
      return null;
    }
    const summary = response.data ?? null;
    if (summary) syncSession(summary);
    return summary;
  }, [syncSession]);

  const applyTurnData = useCallback((data: AgentTurnData) => {
    syncSession(data.session);
    updateRuntime(data.session_id, (runtime) => ({
      ...runtime,
      timeline: applyTimelineUpdates(runtime.timeline, data.updates, data.main_agent_running),
    }));
  }, [syncSession, updateRuntime]);

  const send = useCallback(async (
    content: AgentInputPart[],
    sessionId: string | null,
    sandboxContainerId: number | null,
  ) => {
    const agentCode = getSessionAgentCode(sessionId);
    try {
      if (sessionId) {
        const response = await submitAgentSessionTurn(sessionId, {
          content,
          agent_code: agentCode || null,
          sandbox_container_id: sandboxContainerId,
        });
        const data = requireTurnData(response.data);
        applyTurnData(data);
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
      openLiveSession(data.session_id);
      setPendingAgentCode("");
    } catch (error) {
      showApiError(error);
      throw error;
    }
  }, [applyTurnData, connectFor, getSessionAgentCode, openLiveSession]);

  const interrupt = useCallback(async (sessionId: string | null = activeSessionId) => {
    const targetSessionId = sessionId ?? activeSessionId;
    if (!targetSessionId || controlCommandSessionsRef.current.has(targetSessionId)) return;
    controlCommandSessionsRef.current.add(targetSessionId);
    try {
      const response = await interruptAgentSession(targetSessionId);
      if (!deletedSessionsRef.current.has(targetSessionId)) applyTurnData(requireTurnData(response.data));
    } catch (error) {
      if (!deletedSessionsRef.current.has(targetSessionId)) showApiError(error);
    } finally {
      controlCommandSessionsRef.current.delete(targetSessionId);
    }
  }, [activeSessionId, applyTurnData]);

  const cancelAll = useCallback(async (sessionId: string | null = activeSessionId) => {
    const targetSessionId = sessionId ?? activeSessionId;
    if (!targetSessionId || controlCommandSessionsRef.current.has(targetSessionId)) return;
    controlCommandSessionsRef.current.add(targetSessionId);
    try {
      const response = await cancelAllAgentSessionTasks(targetSessionId);
      if (!deletedSessionsRef.current.has(targetSessionId)) applyTurnData(requireTurnData(response.data));
    } catch (error) {
      if (!deletedSessionsRef.current.has(targetSessionId)) showApiError(error);
    } finally {
      controlCommandSessionsRef.current.delete(targetSessionId);
    }
  }, [activeSessionId, applyTurnData]);

  const deleteSession = useCallback(async (sessionId: string) => {
    if (deletedSessionsRef.current.has(sessionId)) return;
    deletedSessionsRef.current.add(sessionId);
    dropSessionRuntime(sessionId);
    if (activeSessionIdRef.current === sessionId) selectSession(null);
    try {
      const response = await deleteAgentSession(sessionId);
      showApiSuccess(response);
      await refreshSessions();
    } catch (error) {
      showApiError(error);
      await refreshSessions();
    } finally {
      deletedSessionsRef.current.delete(sessionId);
    }
  }, [dropSessionRuntime, refreshSessions, selectSession]);

  useEffect(() => () => {
    closeActiveSocket();
    clearPendingFrames();
    sessionListControllerRef.current?.abort();
    loadMoreControllerRef.current?.abort();
    for (const controller of historyControllersRef.current.values()) controller.abort();
    for (const controller of catchupControllersRef.current.values()) controller.abort();
    historyControllersRef.current.clear();
    catchupControllersRef.current.clear();
  }, [clearPendingFrames, closeActiveSocket]);

  const defaultRuntime = useMemo(createSessionRuntime, []);
  const activeRuntime = activeSessionId ? runtimes.get(activeSessionId) ?? defaultRuntime : defaultRuntime;
  const activeSessionSummary = activeSessionId ? sessionSummaries.get(activeSessionId) ?? null : null;
  const value = useMemo<AgentSessionContextValue>(() => ({
    sessions,
    sessionsLoading,
    sessionsLoadingMore,
    sessionsHasMore: sessions.length < sessionsTotal,
    refreshSessions,
    loadMoreSessions,
    syncSessionSummaries,
    deleteSession,
    dropSessionRuntime,
    activeSessionId,
    activeSessionSummary,
    selectSession,
    chatState: activeRuntime.timeline.state,
    status: activeRuntime.status,
    historyLoading: activeRuntime.historyLoading,
    historyPrepending: activeRuntime.historyPrepending,
    historyHasMore: activeRuntime.historyHasMore,
    historyVersion: activeRuntime.historyVersion,
    agents,
    defaultAgentCode,
    activeAgentCode,
    setActiveAgentCode,
    send,
    updateSelectedSandboxContainer,
    interrupt,
    cancelAll,
    loadPreviousHistory,
  }), [
    activeAgentCode,
    activeRuntime,
    activeSessionId,
    activeSessionSummary,
    agents,
    cancelAll,
    defaultAgentCode,
    deleteSession,
    dropSessionRuntime,
    historyControllersRef,
    interrupt,
    loadMoreSessions,
    loadPreviousHistory,
    refreshSessions,
    selectSession,
    send,
    sessions,
    sessionsLoading,
    sessionsLoadingMore,
    sessionsTotal,
    setActiveAgentCode,
    syncSessionSummaries,
    updateSelectedSandboxContainer,
  ]);

  return <AgentSessionContext.Provider value={value}>{children}</AgentSessionContext.Provider>;
}

function requireTurnData(data: AgentTurnData | null | undefined): AgentTurnData {
  if (!data) throw new Error("agent session turn response missing data");
  return data;
}

const AGENT_STREAM_FRAME_TYPE_SET = new Set<string>(AGENT_STREAM_FRAME_TYPE_VALUES);

function parseAgentStreamFrame(value: unknown): AgentStreamFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const type = Reflect.get(value, "type");
  if (typeof type !== "string" || !AGENT_STREAM_FRAME_TYPE_SET.has(type)) return null;
  return value as AgentStreamFrame;
}

function mergeRefreshedSessionHead(
  current: AgentSessionSummary[],
  head: AgentSessionSummary[],
): AgentSessionSummary[] {
  const headIds = new Set(head.map((session) => session.session_id));
  return [...head, ...current.filter((session) => !headIds.has(session.session_id))];
}
