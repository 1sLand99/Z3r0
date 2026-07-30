import { Button, Spin } from "@douyinfe/semi-ui";
import { ArrowDown, AtSign, RotateCcw, Sparkles } from "lucide-react";
import {
  forwardRef,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { Virtuoso, type Components, type VirtuosoHandle } from "react-virtuoso";
import { AGENT_INPUT_PART_TYPE } from "../../shared/api/generated/constants";
import type { AgentImageInputPart, AgentInfo, AgentInputPart } from "../../shared/api/types";
import { formatDateTime } from "../../shared/lib/date";
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
  hasPrevious: boolean;
  firstItemIndex: number;
  agents: AgentInfo[];
  selectedSubagent: SubagentSelection | null;
  onLoadPrevious: () => void;
  onRetryHistory: () => void;
  onOpenSubagent: (selection: SubagentSelection) => void;
};

type PendingAgentItem = {
  kind: "pending-agent";
  id: string;
  agentName: string;
};

type ChatListItem = ChatNode | PendingAgentItem;

const AT_BOTTOM_THRESHOLD_PX = 24;

export function ChatStream({
  nodes,
  streaming,
  loading,
  loadingPrevious,
  historyError,
  hasPrevious,
  firstItemIndex,
  agents,
  selectedSubagent,
  onLoadPrevious,
  onRetryHistory,
  onOpenSubagent,
}: ChatStreamProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const previousLastNodeIdRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<ImagePreviewState>(null);
  const [atBottom, setAtBottom] = useState(true);
  const agentNameByCode = useMemo(
    () => new Map(agents.map((agent) => [agent.code, agent.name])),
    [agents],
  );
  const openImagePreview = useCallback((image: AgentImageInputPart, index: number) => {
    setPreview({
      src: imageDataUrl(image),
      alt: `User attachment ${index + 1}`,
    });
  }, []);
  const closeImagePreview = useCallback(() => setPreview(null), []);
  const lastNode = nodes[nodes.length - 1];
  const pendingAgent = streaming && lastNode?.kind === "user";
  const pendingAgentName = pendingAgent
    ? resolveAgentName(agentNameByCode, lastNode.targetAgentCode)
    : "";
  const items = useMemo<ChatListItem[]>(() => (
    pendingAgent
      ? [...nodes, {
          kind: "pending-agent",
          id: `pending-agent:${lastNode.id}`,
          agentName: pendingAgentName,
        }]
      : nodes
  ), [lastNode, nodes, pendingAgent, pendingAgentName]);
  const hasRenderableMessages = useMemo(
    () => items.some((item) => item.kind !== "agent" || !isTranscriptEmpty(item)),
    [items],
  );
  const components = useMemo<Components<ChatListItem>>(() => (
    loadingPrevious
      ? { List: ChatList, Header: HistoryLoader }
      : { List: ChatList }
  ), [loadingPrevious]);
  const itemContent = useCallback((index: number, node: ChatListItem) => {
    if (node.kind === "pending-agent") {
      return (
        <AgentBlock
          agentName={node.agentName}
          transcript={emptyAgentTranscript()}
          live
          selectedSubagent={selectedSubagent}
          onOpenSubagent={onOpenSubagent}
        />
      );
    }
    if (node.kind === "user") {
      return (
        <UserBubble
          content={node.content}
          displayText={node.displayText}
          targetName={resolveAgentName(agentNameByCode, node.targetAgentCode)}
          createdAt={node.createdAt}
          onPreviewImage={openImagePreview}
        />
      );
    }
    return (
      <AgentBlock
        agentName={node.agentName || resolveAgentName(agentNameByCode, node.targetAgentCode)}
        transcript={node}
        live={streaming && index === items.length - 1}
        selectedSubagent={selectedSubagent}
        onOpenSubagent={onOpenSubagent}
      />
    );
  }, [agentNameByCode, items.length, onOpenSubagent, openImagePreview, selectedSubagent, streaming]);
  const startReached = useCallback(() => {
    if (hasPrevious && !loading && !loadingPrevious) onLoadPrevious();
  }, [hasPrevious, loading, loadingPrevious, onLoadPrevious]);
  const scrollToLatest = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
  }, []);

  useLayoutEffect(() => {
    const currentLastNodeId = lastNode?.id ?? null;
    const previousLastNodeId = previousLastNodeIdRef.current;
    let appendedUserMessage = false;
    if (previousLastNodeId !== null && previousLastNodeId !== currentLastNodeId) {
      const previousTailIndex = nodes.findIndex((node) => node.id === previousLastNodeId);
      if (previousTailIndex >= 0) {
        for (let index = previousTailIndex + 1; index < nodes.length; index += 1) {
          if (nodes[index]?.kind === "user") {
            appendedUserMessage = true;
            break;
          }
        }
      }
    }
    previousLastNodeIdRef.current = currentLastNodeId;
    if (appendedUserMessage) {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    }
  }, [lastNode, nodes]);

  return (
    <div className="chat-surface">
      {hasRenderableMessages ? (
        <Virtuoso
          ref={virtuosoRef}
          className="chat-viewport"
          aria-label="Conversation messages"
          data={items}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={{ index: "LAST", align: "end" }}
          computeItemKey={(_index, node) => node.id}
          components={components}
          itemContent={itemContent}
          followOutput
          atBottomStateChange={setAtBottom}
          atBottomThreshold={AT_BOTTOM_THRESHOLD_PX}
          increaseViewportBy={{ top: 700, bottom: 900 }}
          startReached={startReached}
        />
      ) : <ChatEmptyState />}
      {loading && nodes.length === 0 ? (
        <div className="chat-overlay-loading" aria-label="Loading conversation history">
          <Spin spinning />
        </div>
      ) : null}
      {historyError ? (
        <div className="chat-overlay-error" role="alert">
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
      {hasRenderableMessages && !atBottom ? (
        <Button
          className="message-scroll-tail-floating chat-scroll-tail-floating"
          icon={<ArrowDown size={16} />}
          theme="solid"
          type="tertiary"
          onClick={scrollToLatest}
          aria-label="Scroll to latest message"
        />
      ) : null}
      <ImagePreview preview={preview} onClose={closeImagePreview} />
    </div>
  );
}

const ChatList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { style?: CSSProperties }>(
  function ChatList({ children, className, ...props }, ref) {
    return <div {...props} ref={ref} className={`chat-stream ${className ?? ""}`}>{children}</div>;
  },
);

function HistoryLoader() {
  return (
    <div className="chat-history-loader" aria-label="Loading earlier messages">
      <Spin spinning size="small" />
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
