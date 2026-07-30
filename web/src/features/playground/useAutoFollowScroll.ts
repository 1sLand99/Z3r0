import { KeyboardEvent, RefObject, TouchEvent, WheelEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type UseAutoFollowScrollOptions<T extends HTMLElement> = {
  enabled?: boolean;
  containerRef: RefObject<T | null>;
  resetKey?: string | number | null;
  watch?: readonly unknown[];
};

const watchObjectIds = new WeakMap<object, number>();
let watchObjectIdSeq = 0;

export function useAutoFollowScroll<T extends HTMLElement = HTMLDivElement>({
  enabled = true,
  containerRef,
  resetKey,
  watch = [],
}: UseAutoFollowScrollOptions<T>) {
  const tailRef = useRef<HTMLDivElement | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const followingRef = useRef(true);
  const [following, setFollowingState] = useState(true);

  const watchKey = watch.map(watchIdentityKey).join("\u001f");

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
    if (behavior === "auto") lastScrollTopRef.current = container.scrollTop;
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

  useEffect(() => {
    if (resetKey == null) return;
    setFollowing(true);
    lastScrollTopRef.current = 0;
    touchStartYRef.current = null;
  }, [resetKey, setFollowing]);

  useEffect(() => {
    const container = enabled ? getContainer() : null;
    if (!container) return;

    const syncFollowing = () => {
      const scrollingUp = container.scrollTop < lastScrollTopRef.current - 2;
      lastScrollTopRef.current = container.scrollTop;

      if (scrollingUp) {
        setFollowing(false);
        return;
      }

      const atTail = isNearScrollTail(container);
      if (atTail && !followingRef.current) setFollowing(true);
      else if (!atTail && followingRef.current) setFollowing(false);
    };

    container.addEventListener("scroll", syncFollowing, { passive: true });
    return () => {
      container.removeEventListener("scroll", syncFollowing);
    };
  }, [enabled, getContainer, setFollowing]);

  useLayoutEffect(() => {
    if (!enabled || !followingRef.current) return;
    scheduleTailScroll();
  }, [enabled, following, resetKey, scheduleTailScroll, watchKey]);

  useEffect(() => {
    if (!enabled || typeof ResizeObserver === "undefined") return;
    const content = tailRef.current?.parentElement;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scheduleTailScroll();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [enabled, resetKey, scheduleTailScroll]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const handleWheel = useCallback((event: WheelEvent<T>) => {
    if (event.deltaY < 0) {
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
    if (currentY > startY) {
      setFollowing(false);
    }
  }, [setFollowing]);

  const handleKeyDown = useCallback((event: KeyboardEvent<T>) => {
    if (event.currentTarget !== event.target) return;
    switch (event.key) {
      case "ArrowUp":
      case "PageUp":
      case "Home":
        setFollowing(false);
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
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
    },
  };
}

function isNearScrollTail(container: HTMLElement) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 8;
}

function watchIdentityKey(value: unknown) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return String(value);
  }
  const objectValue = value as object;
  let id = watchObjectIds.get(objectValue);
  if (!id) {
    id = ++watchObjectIdSeq;
    watchObjectIds.set(objectValue, id);
  }
  return `ref:${id}`;
}
