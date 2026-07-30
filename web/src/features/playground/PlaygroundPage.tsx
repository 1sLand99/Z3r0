import { Button, Popconfirm, Tooltip } from "@douyinfe/semi-ui";
import {
  Activity,
  Box,
  FolderKanban,
  FolderOpen,
  Monitor,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SquareStop,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import "../../app/styles/playground.css";
import { useAdminHeaderActions } from "../../app/layouts/AdminLayout";
import { showApiError, showApiSuccess } from "../../shared/api/feedback";
import { isAbortError } from "../../shared/api/client";
import { SANDBOX_CONTAINER_STATUS, SESSION_TYPE } from "../../shared/api/generated/constants";
import {
  canManageSandboxContainer,
  canOpenContainerNoVNC,
  deleteSandboxContainer,
  pauseSandboxContainer,
  queryAvailableSandboxContainers,
  resumeSandboxContainer,
  startSandboxContainer,
  stopSandboxContainer,
} from "../../shared/api/sandboxContainers";
import type { AgentInputPart, SandboxContainer } from "../../shared/api/types";
import { getWorkProject } from "../../shared/api/workProjects";
import { useOptionList } from "../../shared/hooks/useOptionList";
import { cx } from "../../shared/lib/className";
import { UI_TEXT } from "../../shared/lib/uiText";
import { useContainerShell } from "../container-shell/ContainerShellProvider";
import { WorkProjectInfoModal } from "../work-projects/WorkProjectInfoModal";
import { SandboxContainerFormModal } from "../sandbox-containers/SandboxContainerFormModal";
import {
  useActiveAgentCode,
  useActiveSessionRuntime,
  useActiveSessionRuntimeSelector,
  useAgentCatalog,
  useAgentSessionCommands,
  useAgentSessionDirectory,
  type AgentSessionConnectionStatus,
} from "./AgentSessionProvider";
import { ChatStream } from "./ChatStream";
import { Composer } from "./Composer";
import { MessageScrollPanel } from "./MessageScrollPanel";
import { SandboxSelector } from "./SandboxSelector";
import { SubagentSidePanel } from "./SubagentSidePanel";
import { useSubagentPanel } from "./useSubagentPanel";
import {
  isSubagentRunning,
  latestRunningSubagentTab,
  latestSubagentTab,
} from "./subagentView";

type PlaygroundLocationState = { sessionId?: string };

type SubagentControls = {
  count: number;
  hasRunning: boolean;
  openLatest: () => void;
};

const EMPTY_SUBAGENT_CONTROLS: SubagentControls = {
  count: 0,
  hasRunning: false,
  openLatest: () => undefined,
};

type SandboxActionButtonProps = {
  ariaLabel: string;
  disabled: boolean;
  icon: ReactNode;
  loading?: boolean;
  tooltip: string;
  onClick: () => void;
};

const STATUS_LABEL: Record<AgentSessionConnectionStatus, string> = {
  open: "Live",
  connecting: "Connecting",
  closed: "Disconnected",
  idle: "Idle",
};

export function PlaygroundPage() {
  const setHeaderActions = useAdminHeaderActions();
  const {
    activeSessionId, activeSessionSummary, selectSession,
    refreshSessions,
  } = useAgentSessionDirectory();
  const { agents } = useAgentCatalog();
  const {
    setActiveAgentCode, send, updateSelectedSandboxContainer, interrupt, cancelAll, loadPreviousHistory,
    retryInitialHistory,
  } = useAgentSessionCommands();
  const activeAgentCode = useActiveAgentCode();
  const location = useLocation();
  const navigate = useNavigate();
  const [sandboxContainerId, setSandboxContainerId] = useState<number | null>(null);
  const [projectSandboxContainerId, setProjectSandboxContainerId] = useState<number | null>(null);
  const [projectSandboxContainer, setProjectSandboxContainer] = useState<SandboxContainer | null>(null);
  const [projectSandboxScopeLoaded, setProjectSandboxScopeLoaded] = useState(false);
  const [projectRecordsOpen, setProjectRecordsOpen] = useState(false);
  const [createSandboxOpen, setCreateSandboxOpen] = useState(false);
  const [sandboxAction, setSandboxAction] = useState<string | null>(null);
  const [subagentControls, setSubagentControls] = useState<SubagentControls>(EMPTY_SUBAGENT_CONTROLS);
  const activeSessionIdRef = useRef(activeSessionId);
  const sandboxOperationRef = useRef({ busy: false, generation: 0 });
  activeSessionIdRef.current = activeSessionId;
  const { openFileManager, openNoVNC, openShell, syncContainerWindows } = useContainerShell();
  const sandboxOperationBusy = sandboxAction !== null;

  const activeProjectId = activeSessionSummary?.session_type === SESSION_TYPE.PROJECT ? activeSessionSummary.project_id ?? null : null;
  const querySandboxOptions = useCallback((params: { page: number; size: number; keyword: string }) => (
    queryAvailableSandboxContainers({
      ...params,
      work_project_id: activeProjectId ?? undefined,
      include_non_running: true,
    })
  ), [activeProjectId]);
  const sandboxOptions = useOptionList<SandboxContainer>({ query: querySandboxOptions });
  const availableSandboxContainers = sandboxOptions.items;
  const knownSandboxContainers = sandboxOptions.knownItems;
  const currentProjectSandboxContainer = useMemo(() => {
    if (!activeProjectId) return null;
    if (projectSandboxContainerId === null) return projectSandboxContainer;
    return findSandboxContainerById(availableSandboxContainers, projectSandboxContainerId) ?? projectSandboxContainer;
  }, [activeProjectId, availableSandboxContainers, projectSandboxContainer, projectSandboxContainerId]);
  const selectableSandboxContainers = useMemo(() => {
    if (activeProjectId) return currentProjectSandboxContainer ? [currentProjectSandboxContainer] : [];
    return availableSandboxContainers;
  }, [activeProjectId, availableSandboxContainers, currentProjectSandboxContainer]);
  const selectedSandboxContainer = useMemo(
    () => findSandboxContainerById(
      activeProjectId ? selectableSandboxContainers : knownSandboxContainers,
      sandboxContainerId,
    ),
    [activeProjectId, knownSandboxContainers, sandboxContainerId, selectableSandboxContainers],
  );
  const sandboxAccessUnavailableReason = getSandboxAccessUnavailableReason(selectedSandboxContainer);
  const sandboxManageUnavailableReason = sandboxAccessUnavailableReason ? "No permission to operate this sandbox" : null;
  const shellUnavailableReason = sandboxAccessUnavailableReason
    ?? getSandboxActionUnavailableReason(selectedSandboxContainer, { requiresControlProxy: true });
  const screenUnavailableReason = sandboxAccessUnavailableReason
    ?? getSandboxActionUnavailableReason(selectedSandboxContainer, { requiresNoVNC: true });
  const selectedSandboxName = selectedSandboxContainer?.container_name ?? "selected sandbox";
  const selectedSandboxActionId = selectedSandboxContainer?.id ?? 0;
  const canStartSelectedSandbox = Boolean(!sandboxManageUnavailableReason && selectedSandboxContainer && (
    selectedSandboxContainer.status === SANDBOX_CONTAINER_STATUS.CREATED
    || selectedSandboxContainer.status === SANDBOX_CONTAINER_STATUS.STOPPED
  ));
  const canStopSelectedSandbox = !sandboxManageUnavailableReason
    && selectedSandboxContainer?.status === SANDBOX_CONTAINER_STATUS.RUNNING;
  const canPauseSelectedSandbox = !sandboxManageUnavailableReason
    && selectedSandboxContainer?.status === SANDBOX_CONTAINER_STATUS.RUNNING;
  const canResumeSelectedSandbox = !sandboxManageUnavailableReason
    && selectedSandboxContainer?.status === SANDBOX_CONTAINER_STATUS.PAUSED;
  const openProjectRecords = useCallback(() => {
    setProjectRecordsOpen(true);
  }, []);
  const openSubagentPanel = useCallback(() => {
    subagentControls.openLatest();
  }, [subagentControls]);
  const handleSubagentControls = useCallback((next: SubagentControls) => {
    setSubagentControls((current) => (
      current.count === next.count
      && current.hasRunning === next.hasRunning
      && current.openLatest === next.openLatest
        ? current
        : next
    ));
  }, []);

  const openSelectedFileManager = useCallback(() => {
    if (selectedSandboxContainer) openFileManager(selectedSandboxContainer);
  }, [openFileManager, selectedSandboxContainer]);

  const openSelectedShell = useCallback(() => {
    if (selectedSandboxContainer) openShell(selectedSandboxContainer);
  }, [openShell, selectedSandboxContainer]);

  const openSelectedNoVNC = useCallback(() => {
    if (selectedSandboxContainer) openNoVNC(selectedSandboxContainer);
  }, [openNoVNC, selectedSandboxContainer]);

  // consume sessionId from navigate state (e.g. project "Go") then clear so
  // back-navigation does not retrigger the jump
  useLayoutEffect(() => {
    const incoming = (location.state as PlaygroundLocationState | null)?.sessionId;
    if (incoming) {
      selectSession(incoming);
      navigate(location.pathname, { replace: true });
    }
  }, [location.pathname, location.state, navigate, selectSession]);

  useEffect(() => {
    setSandboxContainerId(activeSessionSummary?.selected_sandbox_container_id ?? null);
  }, [activeSessionSummary?.selected_sandbox_container_id]);

  useEffect(() => {
    sandboxOperationRef.current.generation += 1;
    sandboxOperationRef.current.busy = false;
    setSandboxAction(null);
  }, [activeSessionId]);

  useEffect(() => {
    syncContainerWindows(selectedSandboxContainer);
  }, [
    activeSessionId,
    selectedSandboxContainer?.id,
    selectedSandboxContainer?.control_proxy_host_port,
    selectedSandboxContainer?.status,
    syncContainerWindows,
  ]);

  useEffect(() => {
    if (!activeProjectId) {
      setProjectSandboxContainerId(null);
      setProjectSandboxContainer(null);
      setProjectSandboxScopeLoaded(false);
      return;
    }
    let active = true;
    setProjectSandboxContainerId(null);
    setProjectSandboxContainer(null);
    setProjectSandboxScopeLoaded(false);
    getWorkProject(activeProjectId)
      .then((response) => {
        if (!active) return;
        const project = response.data;
        const containerId = project?.sandbox_container_id ?? null;
        setProjectSandboxContainerId(containerId);
        setProjectSandboxContainer(project?.sandbox_container ?? null);
        setSandboxContainerId(containerId);
        setProjectSandboxScopeLoaded(true);
      })
      .catch((error) => {
        if (!active) return;
        setProjectSandboxContainerId(null);
        setProjectSandboxContainer(null);
        setProjectSandboxScopeLoaded(true);
        showApiError(error);
      });
    return () => {
      active = false;
    };
  }, [activeProjectId]);

  const changeSandboxContainer = useCallback(async (nextContainerId: number | null) => {
    const nextContainer = findSandboxContainerById(selectableSandboxContainers, nextContainerId);
    if (!activeSessionId) {
      setSandboxContainerId(nextContainerId);
      syncContainerWindows(nextContainer);
      return;
    }
    const operation = beginSandboxOperation(sandboxOperationRef, activeSessionId, "select", setSandboxAction);
    if (!operation) return;
    try {
      const summary = await updateSelectedSandboxContainer(activeSessionId, nextContainerId);
      if (!isCurrentSandboxOperation(sandboxOperationRef, activeSessionIdRef, operation)) return;
      const selectedId = summary?.selected_sandbox_container_id ?? null;
      setSandboxContainerId(selectedId);
      syncContainerWindows(findSandboxContainerById(selectableSandboxContainers, selectedId));
    } catch (error) {
      if (!isAbortError(error) && isCurrentSandboxOperation(sandboxOperationRef, activeSessionIdRef, operation)) {
        showApiError(error);
      }
    } finally {
      finishSandboxOperation(sandboxOperationRef, operation, setSandboxAction);
    }
  }, [activeSessionId, selectableSandboxContainers, syncContainerWindows, updateSelectedSandboxContainer]);

  const handleSandboxCreated = useCallback((container: SandboxContainer) => {
    setCreateSandboxOpen(false);
    sandboxOptions.updateItems((current) => upsertSandboxContainer(current, container));
    if (!activeProjectId) {
      setSandboxContainerId(container.id);
      syncContainerWindows(container);
    }
  }, [activeProjectId, sandboxOptions.updateItems, syncContainerWindows]);

  const runSandboxMutation = useCallback(async (
    action: "start" | "stop" | "pause" | "resume",
    container: SandboxContainer | null,
  ) => {
    if (!container) return;
    const actionKey = `${action}:${container.id}`;
    const operation = beginSandboxOperation(sandboxOperationRef, activeSessionId, actionKey, setSandboxAction);
    if (!operation) return;
    try {
      const response = action === "start"
        ? await startSandboxContainer(container.id)
        : action === "stop"
          ? await stopSandboxContainer(container.id)
          : action === "pause"
          ? await pauseSandboxContainer(container.id)
            : await resumeSandboxContainer(container.id);
      if (!isCurrentSandboxOperation(sandboxOperationRef, activeSessionIdRef, operation)) return;
      showApiSuccess(response);
      const updatedContainer = response.data;
      if (updatedContainer) {
        sandboxOptions.updateItems((current) => upsertSandboxContainer(current, updatedContainer));
        if (updatedContainer.id === projectSandboxContainerId) setProjectSandboxContainer(updatedContainer);
        setSandboxContainerId(updatedContainer.id);
        syncContainerWindows(updatedContainer);
      }
    } catch (error) {
      if (isCurrentSandboxOperation(sandboxOperationRef, activeSessionIdRef, operation)) showApiError(error);
    } finally {
      finishSandboxOperation(sandboxOperationRef, operation, setSandboxAction);
    }
  }, [activeSessionId, projectSandboxContainerId, sandboxOptions.updateItems, syncContainerWindows]);

  const deleteSelectedSandboxContainer = useCallback(async () => {
    if (!selectedSandboxContainer) return;
    const actionKey = `delete:${selectedSandboxContainer.id}`;
    const operation = beginSandboxOperation(sandboxOperationRef, activeSessionId, actionKey, setSandboxAction);
    if (!operation) return;
    try {
      const response = await deleteSandboxContainer(selectedSandboxContainer.id);
      if (!isCurrentSandboxOperation(sandboxOperationRef, activeSessionIdRef, operation)) return;
      showApiSuccess(response);
      sandboxOptions.updateItems((current) => current.filter((container) => container.id !== selectedSandboxContainer.id));
      if (projectSandboxContainerId === selectedSandboxContainer.id) {
        setProjectSandboxContainerId(null);
        setProjectSandboxContainer(null);
      }
      setSandboxContainerId(null);
      syncContainerWindows(null);
      await refreshSessions();
    } catch (error) {
      if (isCurrentSandboxOperation(sandboxOperationRef, activeSessionIdRef, operation)) showApiError(error);
    } finally {
      finishSandboxOperation(sandboxOperationRef, operation, setSandboxAction);
    }
  }, [activeSessionId, projectSandboxContainerId, refreshSessions, sandboxOptions.updateItems, selectedSandboxContainer, syncContainerWindows]);

  useEffect(() => {
    if (activeSessionSummary?.session_type === SESSION_TYPE.PROJECT && projectSandboxScopeLoaded) {
      setSandboxContainerId(projectSandboxContainerId);
    }
  }, [activeSessionSummary?.session_type, projectSandboxContainerId, projectSandboxScopeLoaded]);

  const headerNode = useMemo(() => (
    <>
      <SandboxSelector
        containers={selectableSandboxContainers}
        source={sandboxOptions}
        value={sandboxContainerId}
        className="sandbox-selector-topbar"
        disabled={Boolean(activeProjectId) || sandboxOperationBusy}
        onChange={(id) => void changeSandboxContainer(id)}
      />
      <div className="sandbox-container-actions" aria-label="Selected sandbox actions">
        <SandboxActionButton
          ariaLabel="Create sandbox container"
          disabled={Boolean(activeProjectId)}
          icon={<Box size={15} />}
          tooltip={activeProjectId ? "Project sessions use the project's bound sandbox" : "Create sandbox container"}
          onClick={() => setCreateSandboxOpen(true)}
        />
        <SandboxActionButton
          ariaLabel={`Start ${selectedSandboxName}`}
          disabled={sandboxOperationBusy || !canStartSelectedSandbox}
          icon={<Play size={15} />}
          loading={sandboxAction === `start:${selectedSandboxActionId}`}
          tooltip={sandboxManageUnavailableReason ?? (canStartSelectedSandbox ? `Start ${selectedSandboxName}` : "Select a created or stopped sandbox")}
          onClick={() => void runSandboxMutation("start", selectedSandboxContainer)}
        />
        <SandboxActionButton
          ariaLabel={`Stop ${selectedSandboxName}`}
          disabled={sandboxOperationBusy || !canStopSelectedSandbox}
          icon={<SquareStop size={15} />}
          loading={sandboxAction === `stop:${selectedSandboxActionId}`}
          tooltip={sandboxManageUnavailableReason ?? (canStopSelectedSandbox ? `Stop ${selectedSandboxName}` : "Select a running sandbox")}
          onClick={() => void runSandboxMutation("stop", selectedSandboxContainer)}
        />
        <SandboxActionButton
          ariaLabel={`Pause ${selectedSandboxName}`}
          disabled={sandboxOperationBusy || !canPauseSelectedSandbox}
          icon={<Pause size={15} />}
          loading={sandboxAction === `pause:${selectedSandboxActionId}`}
          tooltip={sandboxManageUnavailableReason ?? (canPauseSelectedSandbox ? `Pause ${selectedSandboxName}` : "Select a running sandbox")}
          onClick={() => void runSandboxMutation("pause", selectedSandboxContainer)}
        />
        <SandboxActionButton
          ariaLabel={`Resume ${selectedSandboxName}`}
          disabled={sandboxOperationBusy || !canResumeSelectedSandbox}
          icon={<RotateCcw size={15} />}
          loading={sandboxAction === `resume:${selectedSandboxActionId}`}
          tooltip={sandboxManageUnavailableReason ?? (canResumeSelectedSandbox ? `Resume ${selectedSandboxName}` : "Select a paused sandbox")}
          onClick={() => void runSandboxMutation("resume", selectedSandboxContainer)}
        />
        <Popconfirm
          title="Delete container"
          content={selectedSandboxContainer ? `Delete ${selectedSandboxContainer.container_name}?` : "Select a sandbox first"}
          okType="danger"
          cancelText={UI_TEXT.cancel}
          onConfirm={() => void deleteSelectedSandboxContainer()}
        >
          <span>
            <SandboxActionButton
              ariaLabel={`Delete ${selectedSandboxName}`}
              disabled={sandboxOperationBusy || !selectedSandboxContainer || Boolean(sandboxManageUnavailableReason)}
              icon={<Trash2 size={15} />}
              loading={sandboxAction === `delete:${selectedSandboxActionId}`}
              tooltip={sandboxManageUnavailableReason ?? (selectedSandboxContainer ? `Delete ${selectedSandboxName}` : "Select a sandbox first")}
              onClick={() => undefined}
            />
          </span>
        </Popconfirm>
        <SandboxActionButton
          ariaLabel={`Open terminal for ${selectedSandboxName}`}
          disabled={Boolean(shellUnavailableReason)}
          icon={<SquareTerminal size={15} />}
          tooltip={shellUnavailableReason ?? `Open terminal for ${selectedSandboxName}`}
          onClick={openSelectedShell}
        />
        <SandboxActionButton
          ariaLabel={`Open screen for ${selectedSandboxName}`}
          disabled={Boolean(screenUnavailableReason)}
          icon={<Monitor size={15} />}
          tooltip={screenUnavailableReason ?? `Open screen for ${selectedSandboxName}`}
          onClick={openSelectedNoVNC}
        />
        <SandboxActionButton
          ariaLabel={`Browse files for ${selectedSandboxName}`}
          disabled={Boolean(shellUnavailableReason)}
          icon={<FolderOpen size={15} />}
          tooltip={shellUnavailableReason ?? `Browse files for ${selectedSandboxName}`}
          onClick={openSelectedFileManager}
        />
        {activeProjectId ? (
          <SandboxActionButton
            ariaLabel="Open project info"
            disabled={false}
            icon={<FolderKanban size={15} />}
            tooltip="Project info"
            onClick={openProjectRecords}
          />
        ) : null}
        <SandboxActionButton
          ariaLabel="Open subagent panel"
          disabled={subagentControls.count === 0}
          icon={<PanelRightOpen size={15} />}
          tooltip={subagentControls.count > 0 ? "Open subagent panel" : "No subagent messages"}
          onClick={openSubagentPanel}
        />
      </div>
      <Button icon={<Plus size={16} />} theme="solid" type="primary" onClick={() => selectSession(null)}>
        New chat
      </Button>
      <ConnectionStatus />
    </>
  ), [
    activeProjectId,
    canPauseSelectedSandbox,
    canResumeSelectedSandbox,
    canStartSelectedSandbox,
    canStopSelectedSandbox,
    changeSandboxContainer,
    deleteSelectedSandboxContainer,
    openProjectRecords,
    openSelectedFileManager,
    openSelectedNoVNC,
    openSelectedShell,
    openSubagentPanel,
    runSandboxMutation,
    sandboxAction,
    sandboxManageUnavailableReason,
    sandboxOperationBusy,
    sandboxContainerId,
    selectableSandboxContainers,
    sandboxOptions,
    screenUnavailableReason,
    selectSession,
    selectedSandboxActionId,
    selectedSandboxContainer,
    selectedSandboxName,
    shellUnavailableReason,
    subagentControls.count,
  ]);

  useLayoutEffect(() => {
    setHeaderActions(headerNode);
    return () => setHeaderActions(null);
  }, [headerNode, setHeaderActions]);

  return (
    <>
      <PlaygroundConversation
        activeSessionId={activeSessionId}
        activeAgentCode={activeAgentCode}
        sandboxContainerId={sandboxContainerId}
        agents={agents}
        setActiveAgentCode={setActiveAgentCode}
        send={send}
        interrupt={interrupt}
        cancelAll={cancelAll}
        loadPreviousHistory={loadPreviousHistory}
        retryInitialHistory={retryInitialHistory}
        onSubagentControls={handleSubagentControls}
      />
      <WorkProjectInfoModal
        open={projectRecordsOpen && Boolean(activeProjectId)}
        projectId={activeProjectId}
        onClose={() => setProjectRecordsOpen(false)}
      />
      <SandboxContainerFormModal
        open={createSandboxOpen}
        onCancel={() => setCreateSandboxOpen(false)}
        onCreated={handleSandboxCreated}
      />
    </>
  );
}

const selectConnectionStatus = (runtime: ReturnType<typeof useActiveSessionRuntime>) => runtime.status;

function ConnectionStatus() {
  const status = useActiveSessionRuntimeSelector(selectConnectionStatus);
  return (
    <span className={cx("stream-status", `stream-status-${status}`)}>
      <Activity size={14} />
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}

function PlaygroundConversation({
  activeSessionId,
  activeAgentCode,
  sandboxContainerId,
  agents,
  setActiveAgentCode,
  send,
  interrupt,
  cancelAll,
  loadPreviousHistory,
  retryInitialHistory,
  onSubagentControls,
}: {
  activeSessionId: string | null;
  activeAgentCode: string;
  sandboxContainerId: number | null;
  agents: ReturnType<typeof useAgentCatalog>["agents"];
  setActiveAgentCode: (code: string) => void;
  send: (content: AgentInputPart[], sessionId: string | null, sandboxContainerId: number | null) => Promise<void>;
  interrupt: (sessionId?: string | null) => Promise<void>;
  cancelAll: (sessionId?: string | null) => Promise<void>;
  loadPreviousHistory: (sessionId?: string | null) => Promise<void>;
  retryInitialHistory: (sessionId?: string | null) => void;
  onSubagentControls: (controls: SubagentControls) => void;
}) {
  const runtime = useActiveSessionRuntime();
  const { defaultAgentCode } = useAgentCatalog();
  const chatState = runtime.timeline.state;
  const {
    selectedSubagent,
    setSelectedSubagent,
    subagentTabs,
    closeSubagentPanel,
  } = useSubagentPanel(chatState, activeSessionId, runtime.timeline.subagentVersion);
  const tabsRef = useRef(subagentTabs);
  tabsRef.current = subagentTabs;
  const hasRunningSubagents = subagentTabs.some((tab) => isSubagentRunning(tab.status));
  const openLatestSubagent = useCallback(() => {
    const tabs = tabsRef.current;
    const tab = latestRunningSubagentTab(tabs) ?? latestSubagentTab(tabs);
    if (tab) setSelectedSubagent(tab.agentCode);
  }, [setSelectedSubagent]);

  useEffect(() => {
    onSubagentControls({
      count: subagentTabs.length,
      hasRunning: hasRunningSubagents,
      openLatest: openLatestSubagent,
    });
  }, [hasRunningSubagents, onSubagentControls, openLatestSubagent, subagentTabs.length]);
  useEffect(() => () => onSubagentControls(EMPTY_SUBAGENT_CONTROLS), [onSubagentControls]);

  const handleSend = useCallback(async (content: AgentInputPart[]) => {
    try {
      await send(content, activeSessionId, sandboxContainerId);
      return true;
    } catch {
      return false;
    }
  }, [activeSessionId, sandboxContainerId, send]);
  const handleInterrupt = useCallback(() => { void interrupt(); }, [interrupt]);
  const handleCancelAll = useCallback(() => { void cancelAll(); }, [cancelAll]);
  const handleLoadPrevious = useCallback(
    () => loadPreviousHistory(activeSessionId),
    [activeSessionId, loadPreviousHistory],
  );
  const handleRetryHistory = useCallback(() => {
    retryInitialHistory(activeSessionId);
  }, [activeSessionId, retryInitialHistory]);
  const agentSwitchDisabled = activeAgentCode === defaultAgentCode && hasRunningSubagents;
  const mainColumnRef = useRef<HTMLDivElement | null>(null);
  const composerLayerRef = useRef<HTMLDivElement | null>(null);
  const tailMessageId = useMemo(
    () => chatState.nodes.at(-1)?.id ?? null,
    [chatState.nodes],
  );

  useLayoutEffect(() => {
    const column = mainColumnRef.current;
    const composerLayer = composerLayerRef.current;
    if (!column || !composerLayer) return;
    const syncClearance = () => {
      column.style.setProperty(
        "--playground-composer-clearance",
        `${Math.ceil(composerLayer.getBoundingClientRect().height)}px`,
      );
    };
    syncClearance();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncClearance);
    observer.observe(composerLayer);
    return () => observer.disconnect();
  }, []);

  return (
    <section className={cx("playground-shell", selectedSubagent && "playground-shell-split")}>
      <div className="playground-main">
        <div className="playground-conversation-frame">
          <div ref={mainColumnRef} className="playground-main-column">
            <MessageScrollPanel
              ariaLabel="Conversation messages"
              className="playground-canvas-shell"
              contentClassName="playground-canvas"
              forceFollowKey={tailMessageId}
              loadingPrevious={runtime.history.loadingPrevious}
              onLoadPrevious={runtime.history.initialLoaded && runtime.history.hasMoreBefore
                ? handleLoadPrevious
                : undefined}
              preserveScrollKey={runtime.history.prependVersion}
              resetKey={activeSessionId ?? "new-chat"}
              scrollButtonClassName="chat-scroll-tail-floating"
            >
              {(tailRef) => (
                <ChatStream
                  key={activeSessionId ?? "new-chat"}
                  nodes={chatState.nodes}
                  streaming={chatState.streaming}
                  loading={runtime.history.loadingInitial}
                  loadingPrevious={runtime.history.loadingPrevious}
                  historyError={runtime.history.initialError}
                  agents={agents}
                  selectedSubagent={selectedSubagent}
                  tailRef={tailRef}
                  onRetryHistory={handleRetryHistory}
                  onOpenSubagent={setSelectedSubagent}
                />
              )}
            </MessageScrollPanel>
            <div ref={composerLayerRef} className="playground-composer">
              <Composer
                key={activeSessionId ?? "new-chat"}
                streaming={chatState.streaming}
                disabled={Boolean(activeSessionId) && !runtime.history.initialLoaded}
                agents={agents}
                activeAgentCode={activeAgentCode}
                agentSwitchDisabled={agentSwitchDisabled}
                canCancelAll={hasRunningSubagents}
                onPickAgent={setActiveAgentCode}
                onSend={handleSend}
                onInterrupt={handleInterrupt}
                onCancelAll={handleCancelAll}
              />
            </div>
          </div>
          {selectedSubagent ? (
            <SubagentSidePanel
              nodes={chatState.nodes}
              tabs={subagentTabs}
              agents={agents}
              selection={selectedSubagent}
              onSelect={setSelectedSubagent}
              onClose={closeSubagentPanel}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SandboxActionButton({ ariaLabel, disabled, icon, loading = false, onClick, tooltip }: SandboxActionButtonProps) {
  return (
    <Tooltip content={tooltip}>
      <span className="sandbox-action-tooltip">
        <Button
          aria-label={ariaLabel}
          className="sandbox-action-button"
          disabled={disabled}
          icon={icon}
          loading={loading}
          theme="borderless"
          type="tertiary"
          onClick={onClick}
        />
      </span>
    </Tooltip>
  );
}

function getSandboxActionUnavailableReason(
  container: SandboxContainer | null,
  options: { requiresControlProxy?: boolean; requiresNoVNC?: boolean },
) {
  if (!container) return "Select a sandbox first";
  if (container.status !== SANDBOX_CONTAINER_STATUS.RUNNING) return "Selected sandbox is not running";
  if (options.requiresControlProxy && container.control_proxy_host_port <= 0) return "Selected sandbox control port is not ready";
  if (options.requiresNoVNC && !canOpenContainerNoVNC(container)) return "Selected sandbox has no noVNC screen";
  return null;
}

function getSandboxAccessUnavailableReason(
  container: SandboxContainer | null,
) {
  if (!container) return null;
  if (canManageSandboxContainer(container)) return null;
  return "No permission to access this sandbox";
}

function upsertSandboxContainer(containers: SandboxContainer[], nextContainer: SandboxContainer) {
  if (!containers.some((container) => container.id === nextContainer.id)) {
    return [nextContainer, ...containers];
  }
  return containers.map((container) => (
    container.id === nextContainer.id ? nextContainer : container
  ));
}

function findSandboxContainerById(containers: SandboxContainer[], id: number | null) {
  if (id === null) return null;
  return containers.find((container) => container.id === id) ?? null;
}

type SandboxOperation = {
  generation: number;
  sessionId: string | null;
};

type SandboxOperationState = {
  busy: boolean;
  generation: number;
};

function beginSandboxOperation(
  operationRef: { current: SandboxOperationState },
  sessionId: string | null,
  action: string,
  setAction: (action: string | null) => void,
): SandboxOperation | null {
  if (operationRef.current.busy) return null;
  const generation = operationRef.current.generation + 1;
  operationRef.current = { busy: true, generation };
  setAction(action);
  return { generation, sessionId };
}

function isCurrentSandboxOperation(
  operationRef: { current: SandboxOperationState },
  activeSessionIdRef: { current: string | null },
  operation: SandboxOperation,
) {
  return operationRef.current.generation === operation.generation
    && activeSessionIdRef.current === operation.sessionId;
}

function finishSandboxOperation(
  operationRef: { current: SandboxOperationState },
  operation: SandboxOperation,
  setAction: (action: string | null) => void,
) {
  if (operationRef.current.generation !== operation.generation) return;
  operationRef.current.busy = false;
  setAction(null);
}
