import { Button } from "@douyinfe/semi-ui";
import { ArrowDown } from "lucide-react";
import { ReactNode, RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { cx } from "../../shared/lib/className";
import { useAutoFollowScroll } from "./useAutoFollowScroll";

type MessageScrollPanelProps = {
  ariaLabel: string;
  children: (tailRef: RefObject<HTMLDivElement | null>) => ReactNode;
  className?: string;
  contentClassName?: string;
  enabled?: boolean;
  forceFollowKey?: string | number | null;
  loadingPrevious?: boolean;
  onLoadPrevious?: () => Promise<void>;
  preserveScrollKey?: string | number | null;
  resetKey?: string | number | null;
  scrollButtonClassName?: string;
};

export function MessageScrollPanel({
  ariaLabel,
  children,
  className = "",
  contentClassName = "",
  enabled = true,
  forceFollowKey,
  loadingPrevious = false,
  onLoadPrevious,
  preserveScrollKey,
  resetKey,
  scrollButtonClassName = "",
}: MessageScrollPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pendingPrependRef = useRef<{
    preserveKey: string | number | null | undefined;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const loadPreviousInFlightRef = useRef(false);
  const loadPreviousRequestSeqRef = useRef(0);
  const preserveScrollKeyRef = useRef(preserveScrollKey);
  const resetKeyRef = useRef(resetKey);
  const restoreAnchorFrameRef = useRef<number | null>(null);
  preserveScrollKeyRef.current = preserveScrollKey;

  const loadPrevious = useCallback(() => {
    const container = containerRef.current;
    if (!container || !onLoadPrevious || loadingPrevious || loadPreviousInFlightRef.current) return;
    loadPreviousInFlightRef.current = true;
    pendingPrependRef.current = {
      preserveKey: preserveScrollKeyRef.current,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };
    const requestSeq = ++loadPreviousRequestSeqRef.current;
    let request: Promise<void>;
    try {
      request = onLoadPrevious();
    } catch {
      if (loadPreviousRequestSeqRef.current === requestSeq) {
        loadPreviousInFlightRef.current = false;
        pendingPrependRef.current = null;
      }
      return;
    }
    void request.catch(() => undefined).finally(() => {
      if (loadPreviousRequestSeqRef.current === requestSeq) loadPreviousInFlightRef.current = false;
    });
  }, [loadingPrevious, onLoadPrevious]);

  const {
    following,
    tailRef,
    scrollHandlers,
    scrollToLatest,
  } = useAutoFollowScroll({
    enabled,
    containerRef,
    contentRef,
    forceFollowKey,
    onNearStart: loadPrevious,
    resetKey,
    suspendAutoFollow: loadingPrevious,
  });

  useLayoutEffect(() => {
    if (Object.is(resetKeyRef.current, resetKey)) return;
    resetKeyRef.current = resetKey;
    loadPreviousRequestSeqRef.current += 1;
    loadPreviousInFlightRef.current = false;
    pendingPrependRef.current = null;
    const container = containerRef.current;
    if (restoreAnchorFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreAnchorFrameRef.current);
      restoreAnchorFrameRef.current = null;
    }
    if (container) container.style.overflowAnchor = "";
  }, [resetKey]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const pending = pendingPrependRef.current;
    if (!container || !pending) return;
    if (Object.is(pending.preserveKey, preserveScrollKey)) {
      if (!loadingPrevious) pendingPrependRef.current = null;
      return;
    }
    pendingPrependRef.current = null;
    container.style.overflowAnchor = "none";
    container.scrollTop = pending.scrollTop + container.scrollHeight - pending.scrollHeight;
    if (restoreAnchorFrameRef.current !== null) window.cancelAnimationFrame(restoreAnchorFrameRef.current);
    restoreAnchorFrameRef.current = window.requestAnimationFrame(() => {
      restoreAnchorFrameRef.current = null;
      if (containerRef.current === container) container.style.overflowAnchor = "";
    });
  }, [loadingPrevious, preserveScrollKey]);

  useEffect(() => {
    if (!onLoadPrevious || loadingPrevious) return;
    const frame = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container && container.scrollHeight <= container.clientHeight + 1) loadPrevious();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadPrevious, loadingPrevious, onLoadPrevious, preserveScrollKey]);

  useEffect(() => {
    return () => {
      loadPreviousRequestSeqRef.current += 1;
      if (restoreAnchorFrameRef.current !== null) window.cancelAnimationFrame(restoreAnchorFrameRef.current);
    };
  }, []);

  return (
    <div className={cx("message-scroll-shell", className)}>
      <div
        ref={containerRef}
        className="message-scroll-viewport"
        aria-label={ariaLabel}
        aria-busy={loadingPrevious}
        tabIndex={0}
        {...scrollHandlers}
      >
        <div ref={contentRef} className={cx("message-scroll-content", contentClassName)}>
          {children(tailRef)}
        </div>
      </div>
      {enabled && !following ? (
        <Button
          className={cx("message-scroll-tail-floating", scrollButtonClassName)}
          icon={<ArrowDown size={16} />}
          theme="solid"
          type="tertiary"
          onClick={scrollToLatest}
          aria-label="Scroll to latest message"
        />
      ) : null}
    </div>
  );
}
