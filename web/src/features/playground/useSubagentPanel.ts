import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatState } from "./chatState";
import {
  collectSubagentTabs,
  isSubagentRunning,
  latestRunningSubagentTab,
  latestSubagentTab,
  type SubagentTab,
  type SubagentSelection,
} from "./subagentView";

export function useSubagentPanel(chatState: ChatState, scopeKey: string | null, subagentVersion: number) {
  const [selection, setSelection] = useState<{
    scopeKey: string | null;
    value: SubagentSelection | null;
  }>(() => ({ scopeKey, value: null }));
  const knownRunsRef = useRef<Set<string>>(new Set());
  const suppressedAutoOpenRunIdsRef = useRef<Set<string>>(new Set());
  const selectedSubagent = selection.scopeKey === scopeKey ? selection.value : null;
  const setSelectedSubagent = useCallback((value: SubagentSelection | null) => {
    setSelection({ scopeKey, value });
  }, [scopeKey]);

  const tabs = useMemo(
    () => collectSubagentTabs(chatState.nodes),
    // subagentVersion changes only when the reducer changes subagent-relevant data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey, subagentVersion],
  );

  useEffect(() => {
    knownRunsRef.current = new Set();
    suppressedAutoOpenRunIdsRef.current = new Set();
    setSelection({ scopeKey, value: null });
  }, [scopeKey]);

  useEffect(() => {
    const knownRuns = knownRunsRef.current;
    const suppressedRunIds = suppressedAutoOpenRunIdsRef.current;
    let newestRunning: SubagentTab | null = null;
    let newestRunningOrder = -1;
    let newestRunningRunId: string | null = null;

    for (const tab of tabs) {
      for (const run of tab.runs) {
        if (knownRuns.has(run.runId)) continue;
        knownRuns.add(run.runId);
        if (isSubagentRunning(run.status) && run.order > newestRunningOrder) {
          newestRunning = tab;
          newestRunningOrder = run.order;
          newestRunningRunId = run.runId;
        }
      }
    }

    const latestRunning = latestRunningSubagentTab(tabs);
    const latestRunningRunIdValue = latestRunning
      ? latestRunningRunId(latestRunning)
      : null;

    if (selectedSubagent && !tabs.some((tab) => tab.agentCode === selectedSubagent)) {
      setSelectedSubagent(latestRunning?.agentCode ?? latestSubagentTab(tabs)?.agentCode ?? null);
      return;
    }

    if (newestRunning && newestRunningRunId && !suppressedRunIds.has(newestRunningRunId)) {
      setSelectedSubagent(newestRunning.agentCode);
      return;
    }

    if (
      !selectedSubagent
      && latestRunning
      && latestRunningRunIdValue
      && !suppressedRunIds.has(latestRunningRunIdValue)
    ) {
      setSelectedSubagent(latestRunning.agentCode);
    }
  }, [selectedSubagent, setSelectedSubagent, tabs]);

  const closeSubagentPanel = useCallback(() => {
    const latestRunning = latestRunningSubagentTab(tabs);
    const runId = latestRunning ? latestRunningRunId(latestRunning) : null;
    if (runId) suppressedAutoOpenRunIdsRef.current.add(runId);
    setSelectedSubagent(null);
  }, [setSelectedSubagent, tabs]);

  return useMemo(() => ({
    selectedSubagent,
    setSelectedSubagent,
    subagentTabs: tabs,
    closeSubagentPanel,
  }), [closeSubagentPanel, selectedSubagent, setSelectedSubagent, tabs]);
}

function latestRunningRunId(tab: SubagentTab): string | null {
  let latest: SubagentTab["runs"][number] | null = null;
  for (const run of tab.runs) {
    if (!isSubagentRunning(run.status) || (latest && latest.order >= run.order)) continue;
    latest = run;
  }
  return latest?.runId ?? null;
}
