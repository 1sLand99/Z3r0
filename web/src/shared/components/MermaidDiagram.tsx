import mermaid from "mermaid";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  suppressErrorRendering: true,
  themeVariables: {
    primaryColor: "#161f2e",
    primaryTextColor: "#f8fafc",
    primaryBorderColor: "#9cc7cb",
    lineColor: "#9fb2c7",
    secondaryColor: "#1d2838",
    tertiaryColor: "#0b1018",
    noteBkgColor: "#2a1720",
    noteTextColor: "#f8fafc",
  },
});

type RenderResult = { svg: string } | { error: string };
type Consumer = (result: RenderResult) => void;
type RenderJob = {
  source: string;
  consumers: Set<Consumer>;
  started: boolean;
};
type CacheEntry = {
  result: RenderResult;
  bytes: number;
};

const SVG_CACHE_BUDGET_BYTES = 3 * 1024 * 1024;
const cache = new Map<string, CacheEntry>();
const jobs = new Map<string, RenderJob>();
const queue: RenderJob[] = [];
let cacheBytes = 0;
let renderSequence = 0;
let running = false;
let idleHandle: number | null = null;

export const MermaidDiagram = memo(function MermaidDiagram({ source }: { source: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reactId = useId();
  const instanceId = useMemo(() => `mermaid-${sanitizeId(reactId)}`, [reactId]);
  const [nearViewport, setNearViewport] = useState(false);
  const [result, setResult] = useState<RenderResult | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNearViewport(true);
      observer.disconnect();
    }, { rootMargin: "700px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [source]);

  useEffect(() => {
    setResult(null);
    if (!nearViewport) return;
    return requestRender(source, setResult);
  }, [nearViewport, source]);

  const svg = useMemo(() => {
    if (!result || !("svg" in result)) return null;
    return namespaceSvg(result.svg, instanceId);
  }, [instanceId, result]);

  if (result && "error" in result) {
    return (
      <div ref={containerRef} className="mermaid-diagram mermaid-diagram-error" title={result.error}>
        <div className="mermaid-error-label">Mermaid render failed</div>
        <pre><code className="language-mermaid">{source}</code></pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-diagram"
      aria-busy={!svg}
      aria-label="Mermaid diagram"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
});

function requestRender(source: string, consumer: Consumer): () => void {
  const cached = cache.get(source);
  if (cached) {
    touchCache(source, cached);
    let active = true;
    queueMicrotask(() => {
      if (active) consumer(cached.result);
    });
    return () => { active = false; };
  }

  let job = jobs.get(source);
  if (!job) {
    job = { source, consumers: new Set(), started: false };
    jobs.set(source, job);
    queue.push(job);
  }
  job.consumers.add(consumer);
  scheduleQueue();
  return () => {
    job?.consumers.delete(consumer);
    if (job && !job.started && job.consumers.size === 0) jobs.delete(source);
  };
}

function scheduleQueue() {
  if (running || idleHandle !== null) return;
  const run = () => {
    idleHandle = null;
    void runNextJob();
  };
  if (typeof window.requestIdleCallback === "function") {
    idleHandle = window.requestIdleCallback(run, { timeout: 800 });
  } else {
    idleHandle = window.setTimeout(run, 32);
  }
}

async function runNextJob() {
  let job = queue.shift();
  while (job && (jobs.get(job.source) !== job || job.consumers.size === 0)) {
    job = queue.shift();
  }
  if (!job) return;
  running = true;
  job.started = true;
  let result: RenderResult;
  try {
    const rendered = await mermaid.render(`mermaid-render-${++renderSequence}`, job.source);
    result = { svg: rendered.svg };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  jobs.delete(job.source);
  if ("svg" in result) putCache(job.source, result);
  for (const consumer of job.consumers) consumer(result);
  running = false;
  scheduleQueue();
}

function putCache(source: string, result: Extract<RenderResult, { svg: string }>) {
  const bytes = result.svg.length * 2;
  const existing = cache.get(source);
  if (existing) cacheBytes -= existing.bytes;
  cache.delete(source);
  cache.set(source, { result, bytes });
  cacheBytes += bytes;
  while (cacheBytes > SVG_CACHE_BUDGET_BYTES && cache.size > 1) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheBytes -= oldest?.bytes ?? 0;
  }
}

function touchCache(source: string, entry: CacheEntry) {
  cache.delete(source);
  cache.set(source, entry);
}

function namespaceSvg(svg: string, namespace: string): string {
  const documentNode = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (documentNode.querySelector("parsererror")) return svg;
  const ids = new Map<string, string>();
  for (const element of documentNode.querySelectorAll("[id]")) {
    const id = element.getAttribute("id");
    if (id) ids.set(id, `${namespace}-${id}`);
  }
  if (!ids.size) return new XMLSerializer().serializeToString(documentNode.documentElement);
  const referencePattern = new RegExp(
    `#(${[...ids.keys()].sort((left, right) => right.length - left.length).map(escapeRegExp).join("|")})(?=[^a-zA-Z0-9_-]|$)`,
    "g",
  );
  const replaceReferences = (value: string) => {
    return value.replace(referencePattern, (_match, id: string) => `#${ids.get(id) ?? id}`);
  };
  for (const element of documentNode.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === "id") {
        element.setAttribute("id", ids.get(attribute.value) ?? attribute.value);
      } else {
        element.setAttribute(attribute.name, replaceReferences(attribute.value));
      }
    }
  }
  for (const style of documentNode.querySelectorAll("style")) {
    if (style.textContent) style.textContent = replaceReferences(style.textContent);
  }
  return new XMLSerializer().serializeToString(documentNode.documentElement);
}

function sanitizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
