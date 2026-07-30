import { Button } from "@douyinfe/semi-ui";
import { ArrowDown } from "lucide-react";
import { ReactNode, RefObject, useRef } from "react";
import { cx } from "../../shared/lib/className";
import { useAutoFollowScroll } from "./useAutoFollowScroll";

type MessageScrollPanelProps = {
  ariaLabel: string;
  children: (tailRef: RefObject<HTMLDivElement | null>) => ReactNode;
  className?: string;
  contentClassName?: string;
  enabled?: boolean;
  resetKey?: string | number | null;
  scrollButtonClassName?: string;
  watch?: readonly unknown[];
};

export function MessageScrollPanel({
  ariaLabel,
  children,
  className = "",
  contentClassName = "",
  enabled = true,
  resetKey,
  scrollButtonClassName = "",
  watch = [],
}: MessageScrollPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const {
    following,
    tailRef,
    scrollHandlers,
    scrollToLatest,
  } = useAutoFollowScroll({
    enabled,
    containerRef,
    resetKey,
    watch,
  });

  return (
    <div className={cx("message-scroll-shell", className)}>
      <div
        ref={containerRef}
        className="message-scroll-viewport"
        aria-label={ariaLabel}
        tabIndex={0}
        {...scrollHandlers}
      >
        <div className={cx("message-scroll-content", contentClassName)}>
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
