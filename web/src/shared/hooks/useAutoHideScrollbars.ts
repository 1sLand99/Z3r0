import { useEffect } from "react";

const ACTIVE_ATTRIBUTE = "data-scroll-active";
const HIDE_DELAY_MS = 700;

export function useAutoHideScrollbars() {
  useEffect(() => {
    const activeScrollers = new Map<Element, number>();

    const hideScrollbar = (scroller: Element) => {
      activeScrollers.delete(scroller);
      scroller.removeAttribute(ACTIVE_ATTRIBUTE);
    };

    const handleScroll = (event: Event) => {
      const scroller = resolveScroller(event.target);
      if (!scroller) return;

      const currentTimer = activeScrollers.get(scroller);
      if (currentTimer !== undefined) window.clearTimeout(currentTimer);
      else scroller.setAttribute(ACTIVE_ATTRIBUTE, "");

      const timer = window.setTimeout(() => hideScrollbar(scroller), HIDE_DELAY_MS);
      activeScrollers.set(scroller, timer);
    };

    document.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", handleScroll, true);
      activeScrollers.forEach((timer, scroller) => {
        window.clearTimeout(timer);
        scroller.removeAttribute(ACTIVE_ATTRIBUTE);
      });
      activeScrollers.clear();
    };
  }, []);
}

function resolveScroller(target: EventTarget | null) {
  if (target instanceof Element) return target;
  if (target === document) return document.scrollingElement;
  return null;
}
