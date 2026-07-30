import { AGENT_SUBORDINATE_STATUS } from "../../shared/api/generated/constants";
import type { ChatNode, NestedTranscript, SubagentExecutionItem, TranscriptBlock } from "./chatState";

export type SubagentTab = {
  agentCode: string;
  status: SubagentExecutionItem["status"];
  runs: Array<{
    runId: string;
    status: SubagentExecutionItem["status"];
    order: number;
  }>;
};

export type SubagentSelection = string;

export type SubagentRunTarget = {
  task: SubagentExecutionItem;
  transcript?: NestedTranscript;
  live: boolean;
};

export type SubagentTarget = {
  runs: SubagentRunTarget[];
};

export function collectSubagentTabs(nodes: ChatNode[]): SubagentTab[] {
  const tabs = new Map<string, Map<string, SubagentTab["runs"][number]>>();
  let order = 0;
  for (const { task } of subagentRuns(nodes)) {
    order += 1;
    let runs = tabs.get(task.agentCode);
    if (!runs) {
      runs = new Map();
      tabs.set(task.agentCode, runs);
    }
    runs.set(task.runId, { runId: task.runId, status: task.status, order });
  }
  return Array.from(tabs, ([agentCode, runMap]) => {
    const runs = Array.from(runMap.values());
    const latest = runs.reduce((current, run) => run.order > current.order ? run : current);
    return {
      agentCode,
      status: runs.some((run) => isSubagentRunning(run.status))
        ? AGENT_SUBORDINATE_STATUS.RUNNING
        : latest.status,
      runs,
    };
  });
}

export function latestRunningSubagentTab(tabs: SubagentTab[]): SubagentTab | null {
  let latest: { tab: SubagentTab; order: number } | null = null;
  for (const tab of tabs) {
    for (const run of tab.runs) {
      if (!isSubagentRunning(run.status) || (latest && latest.order >= run.order)) continue;
      latest = { tab, order: run.order };
    }
  }
  return latest?.tab ?? null;
}

export function latestSubagentTab(tabs: SubagentTab[]): SubagentTab | null {
  let latest: { tab: SubagentTab; order: number } | null = null;
  for (const tab of tabs) {
    for (const run of tab.runs) {
      if (latest && latest.order >= run.order) continue;
      latest = { tab, order: run.order };
    }
  }
  return latest?.tab ?? null;
}

export function findSubagentTarget(nodes: ChatNode[], selection: SubagentSelection): SubagentTarget | null {
  const runs = new Map<string, SubagentRunTarget>();
  for (const { task, transcript } of subagentRuns(nodes, true)) {
    if (task.agentCode !== selection || runs.has(task.runId)) continue;
    runs.set(task.runId, { task, transcript, live: isSubagentRunning(task.status) });
  }
  const orderedRuns = Array.from(runs.values()).reverse();
  return orderedRuns.length ? { runs: orderedRuns } : null;
}

export function subagentStatusColor(status: SubagentExecutionItem["status"]): "red" | "green" | "amber" {
  if (isSubagentFailed(status)) return "red";
  return status === AGENT_SUBORDINATE_STATUS.COMPLETED ? "green" : "amber";
}

export function subordinateStatusLabel(status: SubagentExecutionItem["status"]) {
  switch (status) {
    case AGENT_SUBORDINATE_STATUS.RUNNING:
      return "Running";
    case AGENT_SUBORDINATE_STATUS.COMPLETED:
      return "Completed";
    case AGENT_SUBORDINATE_STATUS.CANCELED:
      return "Canceled";
    case AGENT_SUBORDINATE_STATUS.FAILED:
      return "Failed";
  }
}

export function isSubagentRunning(status: SubagentExecutionItem["status"] | undefined): boolean {
  return status === AGENT_SUBORDINATE_STATUS.RUNNING;
}

export function isSubagentFailed(status: SubagentExecutionItem["status"] | undefined): boolean {
  return status === AGENT_SUBORDINATE_STATUS.FAILED || status === AGENT_SUBORDINATE_STATUS.CANCELED;
}

function* subagentRuns(nodes: ChatNode[], reverse = false): Generator<SubagentRunTarget> {
  const start = reverse ? nodes.length - 1 : 0;
  const end = reverse ? -1 : nodes.length;
  const step = reverse ? -1 : 1;

  for (let i = start; i !== end; i += step) {
    const node = nodes[i];
    if (node.kind !== "agent") continue;
    yield* subagentRunsFromBlocks(node.blocks, reverse);
  }
}

function* subagentRunsFromBlocks(blocks: TranscriptBlock[], reverse: boolean): Generator<SubagentRunTarget> {
  const start = reverse ? blocks.length - 1 : 0;
  const end = reverse ? -1 : blocks.length;
  const step = reverse ? -1 : 1;

  for (let i = start; i !== end; i += step) {
    const block = blocks[i];
    if (reverse && block.kind === "tool" && block.nested) {
      yield* subagentRunsFromBlocks(block.nested.blocks, true);
    }
    const task = subagentTask(block);
    if (task?.agentCode && task.runId) {
      yield {
        task,
        transcript: block.kind === "tool" ? block.nested : undefined,
        live: isSubagentRunning(task.status),
      };
    }
    if (!reverse && block.kind === "tool" && block.nested) {
      yield* subagentRunsFromBlocks(block.nested.blocks, false);
    }
  }
}

function subagentTask(block: TranscriptBlock): SubagentExecutionItem | undefined {
  if (block.kind === "subagent") return block;
  if (block.kind === "tool") return block.subagentTask;
  return undefined;
}
