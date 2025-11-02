"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";

type PCIndex = { name: string };

type ManifestMeta = {
  namespace: string;
  video_id?: string;
  video_filename?: string;
  count?: number;
  first_timestamp?: number;
  last_timestamp?: number;
};

type VideoEntry = {
  indexName: string;
  namespace: string;
  videoId: string;
  manifest?: ManifestMeta | null;
};

const blurPanel = "rounded-2xl border border-white/20 bg-white/10 dark:bg-black/20 backdrop-blur-xl shadow-sm";

const STORAGE_KEY = "overview_videos_cache";
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

type CachedData = {
  videos: VideoEntry[];
  timestamp: number;
};

function formatTitle(indexName: string, manifest?: ManifestMeta | null) {
  const candidate = manifest?.video_filename ?? indexName;
  const base = candidate.split("/").pop()?.split(".")[0] ?? candidate;
  return base.replace(/[-_]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatDuration(manifest?: ManifestMeta | null) {
  if (!manifest) return null;
  if (
    typeof manifest.first_timestamp !== "number" ||
    typeof manifest.last_timestamp !== "number"
  ) {
    return null;
  }
  const seconds = Math.max(0, manifest.last_timestamp - manifest.first_timestamp);
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  if (minutes <= 0) return `${seconds.toFixed(1)}s`;
  return `${minutes}m ${remaining.toString().padStart(2, "0")}s`;
}

function getCachedVideos(): VideoEntry[] | null {
  if (typeof window === "undefined") return null;
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (!cached) return null;
    const data: CachedData = JSON.parse(cached);
    const now = Date.now();
    if (now - data.timestamp > CACHE_DURATION) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return data.videos;
  } catch {
    return null;
  }
}

function setCachedVideos(videos: VideoEntry[]) {
  if (typeof window === "undefined") return;
  try {
    const data: CachedData = {
      videos,
      timestamp: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("Failed to cache videos", e);
  }
}

export default function OverviewListPage() {
  const [indexes, setIndexes] = useState<PCIndex[]>([]);
  const [videos, setVideos] = useState<VideoEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/RAG?list=indexes`);
        const data = await res.json();
        if (data?.status === "ok") {
          setIndexes(data.indexes || []);
        }
      } catch (error) {
        console.error("Failed to load indexes", error);
      }
    })();
  }, []);

  useEffect(() => {
    if (!indexes.length) {
      setVideos([]);
      return;
    }

    // Check cache first
    const cached = getCachedVideos();
    if (cached && cached.length > 0) {
      setVideos(cached);
      return;
    }

    setLoading(true);
    (async () => {
      try {
        const results = await Promise.all(
          indexes.map(async ({ name }) => {
            try {
              const res = await fetch(`/api/RAG?manifests=1&indexName=${encodeURIComponent(name)}`);
              const data = await res.json();
              const manifest = (data?.manifests ?? [])[0] as ManifestMeta | undefined;
              if (!manifest) {
                return {
                  indexName: name,
                  namespace: "video-1",
                  videoId: "1",
                  manifest: null,
                } as VideoEntry;
              }
              const videoId = manifest.video_id?.toString() ??
                (manifest.namespace?.startsWith("video-") ? manifest.namespace.slice(6) : "1");
              return {
                indexName: name,
                namespace: manifest.namespace,
                videoId,
                manifest,
              } as VideoEntry;
            } catch (error) {
              console.error(`Failed to load manifest for ${name}`, error);
              return {
                indexName: name,
                namespace: "video-1",
                videoId: "1",
                manifest: null,
              } as VideoEntry;
            }
          })
        );
        const filtered = results.filter(Boolean);
        setVideos(filtered);
        setCachedVideos(filtered);
      } catch (error) {
        console.error("Failed to load manifests", error);
      } finally {
        setLoading(false);
      }
    })();
  }, [indexes]);

  return (
    <main className="w-full py-10 px-6 sm:px-10 lg:px-16">
      <header className="mb-10 flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Video Overview</h1>
        <p className="text-sm opacity-70 max-w-2xl">
          Browse every processed video. Each card represents a Pinecone index that stores the frame
          embeddings and summary for that upload.
        </p>
      </header>

      <section className={`${blurPanel} p-6 sm:p-8`}>
        <div className="flex items-center justify-between gap-4 mb-6">
          <h2 className="text-xl font-semibold">Your Videos</h2>
          {loading && <span className="text-sm opacity-70">Loading…</span>}
        </div>

        {!loading && videos.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/20 p-8 text-center opacity-70">
            No Pinecone indexes found yet. Upload a video to generate one.
          </div>
        )}

        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {videos.map((video) => {
            const title = formatTitle(video.indexName, video.manifest ?? undefined);
            const duration = formatDuration(video.manifest ?? undefined);
            const frameCount = video.manifest?.count;
            return (
              <div
                key={video.indexName}
                className="group relative overflow-hidden rounded-3xl border-2 border-white/30 dark:border-white/20 bg-gradient-to-br from-white/10 via-white/5 to-white/0 dark:from-black/40 dark:via-black/20 dark:to-black/5 p-6 transition-all hover:border-white/40 hover:bg-white/15 dark:hover:bg-black/50 shadow-[0_8px_30px_rgb(0,0,0,0.12)] hover:shadow-[0_20px_60px_rgb(0,0,0,0.3)] dark:shadow-[0_8px_30px_rgb(255,255,255,0.1)] dark:hover:shadow-[0_20px_60px_rgb(255,255,255,0.15)]"
              >
                <div className="relative flex flex-col h-full gap-6">
                  <div className="space-y-2">
                    <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs uppercase tracking-wider opacity-70">
                      <span>Pinecone Index</span>
                      <span className="font-mono text-[11px]">{video.indexName}</span>
                    </div>
                    <h3 className="text-xl font-semibold leading-tight line-clamp-2">
                      {title}
                    </h3>
                    <p className="text-xs opacity-60">Namespace: {video.namespace}</p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {typeof frameCount === "number" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-xs font-medium border border-white/20">
                        {frameCount} frames
                      </span>
                    )}
                    {duration && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-xs font-medium border border-white/20">
                        {duration}
                      </span>
                    )}
                  </div>

                  <div className="mt-auto flex items-center justify-between gap-4 pt-4 border-t border-white/10">
                    <div className="text-xs opacity-60 leading-relaxed">
                      <p>Video ID: {video.videoId}</p>
                      {video.manifest?.video_filename && (
                        <p className="truncate">File: {video.manifest.video_filename}</p>
                      )}
                    </div>
                    <Link
                      href={{
                        pathname: `/overview/${encodeURIComponent(video.indexName)}`,
                        query: {
                          namespace: video.namespace,
                          videoId: video.videoId,
                        },
                      }}
                      className="inline-flex items-center gap-2 rounded-full bg-black text-white px-4 py-2 text-sm font-medium transition hover:bg-neutral-900 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
                    >
                      View Overview
                      <span aria-hidden className="transition-transform group-hover:translate-x-1">→</span>
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

