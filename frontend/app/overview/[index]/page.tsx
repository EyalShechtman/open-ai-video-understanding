"use client";
import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { ShimmerButton } from "@/components/ui/shimmer-button";

type OverviewFrame = {
  id?: string;
  score?: number;
  frame_id?: number | string;
  timestamp?: number;
  description?: string;
  path?: string;
};

type Manifest = {
  namespace: string;
  video_id?: string;
  video_filename?: string;
  count?: number;
  first_timestamp?: number;
  last_timestamp?: number;
};

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

type CachedOverview = {
  summary?: string;
  frames: OverviewFrame[];
  timestamp: number;
};

function glassPanel(classes = "") {
  return [
    "rounded-2xl border border-white/20 bg-white/10 dark:bg-black/20 backdrop-blur-xl shadow-sm",
    classes,
  ].join(" ");
}

function getCacheKey(indexName: string, videoId: string) {
  return `overview_${indexName}_${videoId}`;
}

function getCachedOverview(indexName: string, videoId: string): CachedOverview | null {
  if (typeof window === "undefined") return null;
  try {
    const key = getCacheKey(indexName, videoId);
    const cached = sessionStorage.getItem(key);
    if (!cached) return null;
    const data: CachedOverview = JSON.parse(cached);
    const now = Date.now();
    if (now - data.timestamp > CACHE_DURATION) {
      sessionStorage.removeItem(key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function setCachedOverview(indexName: string, videoId: string, summary: string | undefined, frames: OverviewFrame[]) {
  if (typeof window === "undefined") return;
  try {
    const key = getCacheKey(indexName, videoId);
    const data: CachedOverview = {
      summary,
      frames,
      timestamp: Date.now(),
    };
    sessionStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.warn("Failed to cache overview", e);
  }
}

function ExpandableDescription({ text, maxWords = 14 }: { text: string; maxWords?: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const words = text?.split(" ") ?? [];
  const shouldTruncate = words.length > maxWords;
  const displayText = shouldTruncate && !isExpanded ? words.slice(0, maxWords).join(" ") + "..." : text;
  if (!text) return null;
  if (!shouldTruncate) return <p className="opacity-90 leading-relaxed text-base">{text}</p>;
  return (
    <div>
      <p className="opacity-90 leading-relaxed text-base">{displayText}</p>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="mt-3 flex items-center gap-1.5 text-sm opacity-70 hover:opacity-100 transition-opacity"
      >
        <span>{isExpanded ? "Show less" : "Show more"}</span>
        <svg className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
}

export default function OverviewDetailPage() {
  const { index } = useParams<{ index: string }>();
  const params = useSearchParams();
  const router = useRouter();

  const [namespace, setNamespace] = useState<string>(
    () => params.get("namespace") || "video-1"
  );
  const [videoId, setVideoId] = useState<string>(
    () => params.get("videoId") || (namespace.startsWith("video-") ? namespace.slice(6) : "1")
  );
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [summary, setSummary] = useState<string | undefined>(undefined);
  const [frames, setFrames] = useState<OverviewFrame[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const nextNamespace = params.get("namespace");
    if (nextNamespace && nextNamespace !== namespace) {
      setNamespace(nextNamespace);
    }
    const nextVideoId = params.get("videoId");
    if (nextVideoId) {
      setVideoId(nextVideoId);
    } else if (nextNamespace && nextNamespace.startsWith("video-")) {
      setVideoId(nextNamespace.slice(6));
    }
  }, [params, namespace]);

  useEffect(() => {
    (async () => {
      if (!index) return;
      try {
        const res = await fetch(`/api/RAG?manifest=1&indexName=${encodeURIComponent(index)}&namespace=${encodeURIComponent(namespace)}`);
        const data = await res.json();
        if (data?.status === "ok") {
          const m = data.manifest as any;
          if (m) {
            const manifestNamespace = m.namespace ?? namespace;
            setNamespace(manifestNamespace);
            const manifestVideoId = m.video_id?.toString() ??
              (manifestNamespace?.startsWith("video-") ? manifestNamespace.slice(6) : videoId);
            setVideoId(manifestVideoId || videoId);
            setManifest({ ...(m as any), namespace: manifestNamespace });
          }
        }
      } catch {}
    })();
  }, [index, namespace, videoId]);

  useEffect(() => {
    (async () => {
      if (!index || !videoId) return;

      // Check cache first
      const cached = getCachedOverview(String(index), videoId);
      if (cached) {
        setSummary(cached.summary);
        setFrames(cached.frames);
        return;
      }

      setLoading(true);
      try {
        const res = await fetch("/api/RAG", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "overview",
            indexName: index,
            videoId,
            topK: 200,
            skipEnsure: true,
          }),
        });
        const data = await res.json();
        if (data?.status === "ok") {
          const summaryText = data.summary || undefined;
          setSummary(summaryText);
          const unique: OverviewFrame[] = [];
          const seen = new Set<string>();
          for (const frame of data.frames || []) {
            const key = `${frame.frame_id ?? ""}-${frame.timestamp ?? ""}-${frame.path ?? ""}`;
            if (!seen.has(key)) {
              unique.push(frame);
              seen.add(key);
            }
          }
          unique.sort((a, b) => {
            const tsA = typeof a.timestamp === "number" ? a.timestamp : Number.MAX_VALUE;
            const tsB = typeof b.timestamp === "number" ? b.timestamp : Number.MAX_VALUE;
            return tsA - tsB;
          });
          setFrames(unique);
          setCachedOverview(String(index), videoId, summaryText, unique);
        }
      } catch {}
      setLoading(false);
    })();
  }, [index, videoId]);

  const renderThumb = (path?: string) => {
    if (!path) return null;
    const clean = path.startsWith("/") ? path : `/${path}`;
    const url = `${BACKEND_URL}${clean}`;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={path} className="w-full h-full object-cover" />
    );
  };

  const title = manifest?.video_filename || index || "Overview";

  return (
    <main className="w-full py-10 px-12">
      <div className="flex items-start justify-between mb-6 gap-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl font-bold text-white dark:text-white mb-2">{title}</h1>
          <p className="text-xs opacity-60">{String(index)} / {namespace}</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <ShimmerButton
            onClick={() => router.push(`/explore?tab=search&indexName=${encodeURIComponent(String(index))}&videoId=${encodeURIComponent(videoId)}`)}
            background="rgba(0, 0, 0, 1)"
            shimmerColor="#ffffff"
            className="text-sm"
          >
            Moments
          </ShimmerButton>
          <ShimmerButton
            onClick={() => router.push(`/explore?tab=analyze&indexName=${encodeURIComponent(String(index))}&videoId=${encodeURIComponent(videoId)}`)}
            background="rgba(0, 0, 0, 1)"
            shimmerColor="#ffffff"
            className="text-sm"
          >
            Analyze
          </ShimmerButton>
        </div>
      </div>

      <section className={glassPanel("p-6 space-y-6")}>          
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">Overview</h2>
          {loading && <span className="text-sm opacity-70">Loading…</span>}
        </div>

        {summary && (
          <div className="rounded-xl bg-white dark:bg-gray-900 p-6 space-y-4 shadow-lg max-w-4xl mx-auto">
            <div className="flex items-center gap-3 pb-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-bold text-black dark:text-white">Video Summary</h3>
            </div>
            <div className="bg-white dark:bg-gray-900 rounded-lg">
              <p className="text-base leading-relaxed text-black dark:text-white font-normal">{summary}</p>
            </div>
          </div>
        )}

        {frames.length > 0 && (
          <div className="space-y-3">
            <h3 className="font-semibold">Frames ({frames.length})</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
              {frames.map((f) => {
                const tsDisplay = typeof f.timestamp === "number" ? `${f.timestamp.toFixed(1)}s` : "";
                return (
                  <div key={f.id || `${f.frame_id}-${f.timestamp}`} className="rounded-xl border border-white/20 bg-white/5 overflow-hidden hover:border-white/30 transition-all duration-200 shadow-lg hover:shadow-xl">
                    <div className="relative w-full aspect-video bg-black/20 border-b border-white/10">
                      {renderThumb(f.path)}
                    </div>
                    <div className="px-6 py-4 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-white/10 border border-white/20">⏱️ {tsDisplay}</span>
                        {f.frame_id !== undefined && (
                          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs bg-white/10 border border-white/20">Frame {String(f.frame_id)}</span>
                        )}
                      </div>
                      {f.description && <ExpandableDescription text={f.description} maxWords={18} />}
                      {f.path && (
                        <a
                          href={`${BACKEND_URL}/${f.path.startsWith("/") ? f.path.slice(1) : f.path}`}
                          target="_blank"
                          className="text-xs underline opacity-70"
                        >
                          {f.path}
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}


