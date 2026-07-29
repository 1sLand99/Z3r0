import type {
  AgentInputPart,
  AgentTimelineItem,
  AgentTimelineReportAttachment,
  AgentTimelineSubagentItem,
  AgentTimelineToolItem,
} from "../../shared/api/types";

export type ThinkingItem = {
  kind: "thinking";
  id: string;
  segmentId: string;
  text: string;
  complete: boolean;
};

export type TextItem = {
  kind: "text";
  id: string;
  segmentId: string;
  text: string;
  complete: boolean;
};

export type ToolExecutionItem = {
  kind: "tool";
  id: string;
  callId: AgentTimelineToolItem["call_id"];
  name: AgentTimelineToolItem["name"];
  arguments: NonNullable<AgentTimelineToolItem["arguments"]>;
  output: AgentTimelineToolItem["output"];
  isError: boolean;
  resolved: boolean;
  nested?: NestedTranscript;
  subagentTask?: SubagentExecutionItem;
};

export type SubagentExecutionItem = {
  kind: "subagent";
  id: AgentTimelineSubagentItem["item_id"];
  createdAt: AgentTimelineSubagentItem["created_at"];
  runId: AgentTimelineSubagentItem["run_id"];
  parentAgentCode: AgentTimelineSubagentItem["parent_agent_code"];
  parentAgentInstanceId: AgentTimelineSubagentItem["parent_agent_instance_id"];
  agentCode: AgentTimelineSubagentItem["agent_code"];
  status: AgentTimelineSubagentItem["status"];
  resultPreview: AgentTimelineSubagentItem["result_preview"];
  errorPreview: AgentTimelineSubagentItem["error_preview"];
  resultChars: AgentTimelineSubagentItem["result_chars"];
  errorChars: AgentTimelineSubagentItem["error_chars"];
  truncated: AgentTimelineSubagentItem["truncated"];
  progress: AgentTimelineSubagentItem["progress"];
};

export type ErrorItem = { kind: "error"; id: string; message: string };
export type ExecutionItem = ToolExecutionItem | SubagentExecutionItem;
export type TranscriptBlock = ThinkingItem | TextItem | ExecutionItem | ErrorItem;

export type ReportAttachmentItem = {
  kind: "report";
  id: string;
  callId: AgentTimelineToolItem["call_id"];
  reportId: AgentTimelineReportAttachment["report_id"];
  filename: AgentTimelineReportAttachment["filename"];
  size: AgentTimelineReportAttachment["size"];
  chars: AgentTimelineReportAttachment["chars"];
};

export type TranscriptAttachmentItem = ReportAttachmentItem;

export type AgentTranscript = {
  createdAt: AgentTimelineItem["created_at"] | "";
  agentName: string;
  blocks: TranscriptBlock[];
  attachments: TranscriptAttachmentItem[];
};

export type NestedTranscript = AgentTranscript;

export type ChatNode =
  | {
      kind: "user";
      id: string;
      createdAt: AgentTimelineItem["created_at"];
      content: AgentInputPart[];
      displayText: string;
      targetAgentCode: string;
    }
  | ({ kind: "agent"; id: string } & AgentTranscript);

export type ChatState = {
  nodes: ChatNode[];
  streaming: boolean;
};

export type StreamingItem = ThinkingItem | TextItem;
