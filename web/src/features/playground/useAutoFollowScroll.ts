import { KeyboardEvent, PointerEvent, RefObject, TouchEvent, WheelEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type UseAutoFollowScrollOptions<T extends HTMLElement> = {
  contentRef?: RefObject<Element | null>;
  enabled?: boolean;
  containerRef: RefObject<T | null>;
  forceFollowKey?: string | number | null;
  onNearStart?: () => void;
  resetKey?: string | number | null;
  suspendAutoFollow?: boolean;
};

const NEAR_START_THRESHOLD_PX = 180;

export function useAutoFollowScroll<T extends HTMLElement = HTMLDivElement>({
  contentRef,
  enabled = true,
  containerRef,
  forceFollowKey,
  onNearStart,
  resetKey,
  suspendAutoFollow = false,
}: UseAutoFollowScrollOptions<T>) {
  const tailRef = useRef<HTMLDivElement | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const followingRef = useRef(true);
  const forceFollowKeyRef = useRef<string | number | null | undefined>(undefined);
  const onNearStartRef = useRef(onNearStart);
  const [following, setFollowingState] = useState(true);

  onNearStartRef.current = onNearStart;

  const setFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowingState(next);
  }, []);

  const getContainer = useCallback(() => {
    return containerRef.current;
  }, [containerRef]);

  const scrollTail = useCallback((behavior: ScrollBehavior) => {
    const container = getContainer();
    if (!container) return;
    const previousBehavior = container.style.scrollBehavior;
    container.style.scrollBehavior = "auto";
    container.scrollTo({ top: container.scrollHeight, behavior });
    container.style.scrollBehavior = previousBehavior;
  }, [getContainer]);

  const scrollToLatest = useCallback(() => {
    setFollowing(true);
    scrollTail("smooth");
  }, [scrollTail, setFollowing]);

  const scheduleTailScroll = useCallback((behavior: ScrollBehavior = "auto") => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (followingRef.current) scrollTail(behavior);
    });
  }, [scrollTail]);

  useLayoutEffect(() => {
    if (resetKey == null) return;
    setFollowing(true);
    touchStartYRef.current = null;
    scrollTail("auto");
  }, [resetKey, scrollTail, setFollowing]);

  useEffect(() => {
    const container = enabled ? getContainer() : null;
    if (!container) return;

    const syncFollowing = () => {
      if (container.scrollTop <= NEAR_START_THRESHOLD_PX) onNearStartRef.current?.();
      if (!suspendAutoFollow && isNearScrollTail(container) && !followingRef.current) {
        setFollowing(true);
      }
    };

    container.addEventListener("scroll", syncFollowing, { passive: true });
    return () => {
      container.removeEventListener("scroll", syncFollowing);
    };
  }, [enabled, getContainer, setFollowing, suspendAutoFollow]);

  useLayoutEffect(() => {
    if (Object.is(forceFollowKeyRef.current, forceFollowKey)) return;
    forceFollowKeyRef.current = forceFollowKey;
    if (!enabled || forceFollowKey == null) return;
    setFollowing(true);
    scrollTail("auto");
  }, [enabled, forceFollowKey, scrollTail, setFollowing]);

  useLayoutEffect(() => {
    if (!enabled || suspendAutoFollow || !followingRef.current) return;
    scheduleTailScroll();
  }, [enabled, following, resetKey, scheduleTailScroll, suspendAutoFollow]);

  useEffect(() => {
    if (!enabled || typeof ResizeObserver === "undefined") return;
    const content = contentRef?.current ?? tailRef.current?.parentElement;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const container = getContainer();
      if (!container || suspendAutoFollow) return;
      if (!hasScrollableOverflow(container) || isNearScrollTail(container)) {
        if (!followingRef.current) setFollowing(true);
      }
      if (followingRef.current) scheduleTailScroll();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [enabled, getContainer, resetKey, scheduleTailScroll, setFollowing, suspendAutoFollow]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const handleWheel = useCallback((event: WheelEvent<T>) => {
    if (event.deltaY < 0 && hasScrollableOverflow(event.currentTarget)) {
      setFollowing(false);
    }
  }, [setFollowing]);

  const handleTouchStart = useCallback((event: TouchEvent<T>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((event: TouchEvent<T>) => {
    const startY = touchStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY == null || currentY == null || Math.abs(currentY - startY) <= 2) return;
    if (currentY > startY && hasScrollableOverflow(event.currentTarget)) {
      setFollowing(false);
    }
  }, [setFollowing]);

  const handlePointerDown = useCallback((event: PointerEvent<T>) => {
    if (isVerticalScrollbarPointer(event) && hasScrollableOverflow(event.currentTarget)) {
      setFollowing(false);
    }
  }, [setFollowing]);

  const handleKeyDown = useCallback((event: KeyboardEvent<T>) => {
    if (event.currentTarget !== event.target) return;
    switch (event.key) {
      case "ArrowUp":
      case "PageUp":
      case "Home":
        if (hasScrollableOverflow(event.currentTarget)) setFollowing(false);
        break;
      case "ArrowDown":
      case "PageDown":
      case "End":
      case " ":
        break;
      default:
        break;
    }
  }, [setFollowing]);

  return {
    following,
    tailRef,
    scrollToLatest,
    scrollHandlers: {
      onWheel: handleWheel,
      onKeyDown: handleKeyDown,
      onPointerDown: handlePointerDown,
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
    },
  };
}

function isNearScrollTail(container: HTMLElement) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 8;
}

function hasScrollableOverflow(container: HTMLElement) {
  return container.scrollHeight > container.clientHeight + 1;
}

function isVerticalScrollbarPointer<T extends HTMLElement>(event: PointerEvent<T>) {
  const container = event.currentTarget;
  const bounds = container.getBoundingClientRect();
  return event.clientX >= bounds.left + container.clientWidth;
}
