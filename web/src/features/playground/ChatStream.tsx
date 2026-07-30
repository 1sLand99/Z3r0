import { Button, Spin } from "@douyinfe/semi-ui";
import { AtSign, RotateCcw, Sparkles } from "lucide-react";
import { memo, useCallback, useMemo, useState, type RefObject } from "react";
import { AGENT_INPUT_PART_TYPE } from "../../shared/api/generated/constants";
import type { AgentImageInputPart, AgentInfo, AgentInputPart } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/date";
import { cx } from "../../shared/lib/className";
import { ImagePreview, imageDataUrl, type ImagePreviewState } from "./ImagePreview";
import type { AgentTranscript, ChatNode } from "./chatState";
import { TranscriptContent } from "./Transcript";
import { emptyAgentTranscript, isTranscriptEmpty } from "./transcriptView";
import type { SubagentSelection } from "./subagentView";

type ChatStreamProps = {
  nodes: ChatNode[];
  streaming: boolean;
  loading: boolean;
  loadingPrevious: boolean;
  historyError: string | null;
  agents: AgentInfo[];
  selectedSubagent: SubagentSelection | null;
  tailRef: RefObject<HTMLDivElement | null>;
  onRetryHistory: () => void;
  onOpenSubagent: (selection: SubagentSelection) => void;
};

type RenderedChatNode =
  | { kind: "user"; node: Extract<ChatNode, { kind: "user" }>; targetName: string }
  | { kind: "agent"; node: Extract<ChatNode, { kind: "agent" }>; agentName: string; live: boolean };

export function ChatStream({
  nodes,
  streaming,
  loading,
  loadingPrevious,
  historyError,
  agents,
  selectedSubagent,
  tailRef,
  onRetryHistory,
  onOpenSubagent,
}: ChatStreamProps) {
  const [preview, setPreview] = useState<ImagePreviewState>(null);
  const agentNameByCode = useMemo(
    () => new Map(agents.map((agent) => [agent.code, agent.name])),
    [agents],
  );
  const renderedNodes = useMemo(
    () => buildRenderedChatNodes(nodes, streaming, agentNameByCode),
    [agentNameByCode, nodes, streaming],
  );
  const openImagePreview = useCallback((image: AgentImageInputPart, index: number) => {
    setPreview({
      src: imageDataUrl(image),
      alt: `User attachment ${index + 1}`,
    });
  }, []);
  const closeImagePreview = useCallback(() => setPreview(null), []);
  const lastNode = nodes[nodes.length - 1];
  const pendingUser = streaming && lastNode?.kind === "user" ? lastNode : null;
  const hasRenderableMessages = renderedNodes.length > 0 || pendingUser !== null;

  return (
    <div className={cx("chat-stream", hasRenderableMessages ? "chat-stream-has-messages" : "chat-stream-empty")}>
      {loadingPrevious ? <HistoryLoader /> : null}
      {historyError ? (
        <div className="chat-history-error" role="alert">
          <span>{historyError}</span>
          <Button
            icon={<RotateCcw size={14} />}
            size="small"
            theme="solid"
            type="primary"
            onClick={onRetryHistory}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {loading && !hasRenderableMessages ? <ChatLoadingState /> : null}
      {!loading && !historyError && !hasRenderableMessages ? <ChatEmptyState /> : null}
      {renderedNodes.map((item) => item.kind === "user" ? (
        <UserBubble
          key={item.node.id}
          content={item.node.content}
          displayText={item.node.displayText}
          targetName={item.targetName}
          createdAt={item.node.createdAt}
          onPreviewImage={openImagePreview}
        />
      ) : (
        <AgentBlock
          key={item.node.id}
          agentName={item.agentName}
          transcript={item.node}
          live={item.live}
          selectedSubagent={selectedSubagent}
          onOpenSubagent={onOpenSubagent}
        />
      ))}
      {pendingUser ? (
        <AgentBlock
          key={`pending-agent:${pendingUser.id}`}
          agentName={resolveAgentName(agentNameByCode, pendingUser.targetAgentCode)}
          transcript={emptyAgentTranscript()}
          live
          selectedSubagent={selectedSubagent}
          onOpenSubagent={onOpenSubagent}
        />
      ) : null}
      <div ref={tailRef} className="chat-tail" />
      <ImagePreview preview={preview} onClose={closeImagePreview} />
    </div>
  );
}

function HistoryLoader() {
  return (
    <div className="chat-history-loader" aria-label="Loading earlier messages">
      <Spin spinning size="small" />
    </div>
  );
}

function ChatLoadingState() {
  return (
    <div className="chat-loading" aria-label="Loading conversation history">
      <Spin spinning />
    </div>
  );
}

function ChatEmptyState() {
  return (
    <div className="chat-empty">
      <div className="chat-empty-mark">
        <Sparkles size={28} />
      </div>
      <h2>Start a new conversation</h2>
      <p>
        Ask the security operations agent anything
        <br />
        - penetration tests, code audits, or threat triage.
      </p>
    </div>
  );
}

function buildRenderedChatNodes(
  nodes: ChatNode[],
  streaming: boolean,
  agentNameByCode: Map<string, string>,
): RenderedChatNode[] {
  const rendered: RenderedChatNode[] = [];
  const lastIndex = nodes.length - 1;

  nodes.forEach((node, index) => {
    if (node.kind === "user") {
      rendered.push({
        kind: "user",
        node,
        targetName: resolveAgentName(agentNameByCode, node.targetAgentCode),
      });
      return;
    }
    const live = streaming && index === lastIndex;
    if (!live && isTranscriptEmpty(node)) return;
    rendered.push({
      kind: "agent",
      node,
      agentName: node.agentName || resolveAgentName(agentNameByCode, node.targetAgentCode),
      live,
    });
  });

  return rendered;
}

function MessageTimestamp({ value }: { value: string }) {
  return <time className="message-timestamp" dateTime={value}>{formatDateTime(value)}</time>;
}

function resolveAgentName(agentNameByCode: Map<string, string>, agentCode: string) {
  return agentNameByCode.get(agentCode) ?? agentCode;
}

const UserBubble = memo(function UserBubble({
  content,
  displayText,
  targetName,
  createdAt,
  onPreviewImage,
}: {
  content: AgentInputPart[];
  displayText: string;
  targetName: string;
  createdAt: string;
  onPreviewImage: (image: AgentImageInputPart, index: number) => void;
}) {
  const textParts = content.filter(
    (part): part is Extract<AgentInputPart, { type: typeof AGENT_INPUT_PART_TYPE.TEXT }> => (
      part.type === AGENT_INPUT_PART_TYPE.TEXT
    ),
  );
  const imageParts = content.filter(
    (part): part is AgentImageInputPart => part.type === AGENT_INPUT_PART_TYPE.IMAGE,
  );
  const text = textParts.length
    ? textParts.map((part) => part.text).join("\n\n")
    : displayText;

  return (
    <div className="chat-row chat-row-user">
      <div className="chat-message chat-message-user">
        <MessageTimestamp value={createdAt} />
        <div className="user-bubble">
          {targetName || text ? (
            <div className="user-bubble-copy">
              {targetName ? (
                <span className="user-bubble-mention">
                  <AtSign size={11} />
                  <span>{targetName}</span>
                </span>
              ) : null}
              {text ? <span className="user-bubble-text">{text}</span> : null}
            </div>
          ) : null}
          {imageParts.length ? (
            <div className="user-bubble-images">
              {imageParts.map((part, index) => (
                <button
                  key={`${part.media_type}:${index}:${part.data.length}`}
                  type="button"
                  className="user-bubble-image-button"
                  onClick={() => onPreviewImage(part, index)}
                  aria-label={`Preview attachment ${index + 1}`}
                >
                  <img
                    className="user-bubble-image"
                    src={imageDataUrl(part)}
                    alt="User attachment"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

const AgentBlock = memo(function AgentBlock({
  agentName,
  transcript,
  live,
  selectedSubagent,
  onOpenSubagent,
}: {
  agentName: string;
  transcript: AgentTranscript;
  live: boolean;
  selectedSubagent: SubagentSelection | null;
  onOpenSubagent: (selection: SubagentSelection) => void;
}) {
  return (
    <div className="chat-row chat-row-agent">
      <div className="agent-block">
        <div className="agent-header">
          {agentName ? <span>{agentName}</span> : null}
          {live ? <span className="agent-pulse" /> : null}
          {transcript.createdAt ? <MessageTimestamp value={transcript.createdAt} /> : null}
        </div>
        <TranscriptContent
          transcript={transcript}
          live={live}
          pendingEmpty
          selectedSubagent={selectedSubagent}
          onOpenSubagent={onOpenSubagent}
        />
      </div>
    </div>
  );
});
