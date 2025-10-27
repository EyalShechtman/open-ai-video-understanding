"use client";
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

type PCIndex = { name: string };
type Namespace = string;

type Match = {
  id?: string;
  score?: number;
  metadata?: any;
};

type OverviewFrame = {
  id?: string;
  score?: number;
  frame_id?: number | string;
  timestamp?: number;
  description?: string;
  path?: string;
};

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

function glassPanel(classes = "") {
  return [
    "rounded-2xl border border-white/20 bg-white/10 dark:bg-black/20 backdrop-blur-xl shadow-sm",
    classes,
  ].join(" ");
}

export default function ExplorePage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tabParam = (params.get("tab") || "overview").toLowerCase();
  const activeTab = (tabParam === "search" || tabParam === "analyze") ? (tabParam as any) : "overview";

  const [indexes, setIndexes] = useState<PCIndex[]>([]);
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [indexName, setIndexName] = useState<string>(
    process.env.PINECONE_INDEX || "democrash-mp4"
  );
  const [videoId, setVideoId] = useState<string>("1");
  const namespaceFromVideoId = useMemo(
    () => (videoId ? `video-${videoId}` : "frames"),
    [videoId]
  );

  // Overview state
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [summary, setSummary] = useState<string | undefined>(undefined);
  const [overviewFrames, setOverviewFrames] = useState<OverviewFrame[]>([]);

  // Search state
  const [searchQ, setSearchQ] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchMatches, setSearchMatches] = useState<Match[]>([]);

  // Analyze state
  const [analyzeQ, setAnalyzeQ] = useState("");
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [answer, setAnswer] = useState<string>("");
  const [citations, setCitations] = useState<Match[]>([]);

  // Load indexes on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/RAG?list=indexes`);
        const data = await res.json();
        if (data?.status === "ok") {
          setIndexes(data.indexes || []);
        }
      } catch {}
    })();
  }, []);

  // Load namespaces when index changes
  useEffect(() => {
    (async () => {
      if (!indexName) return;
      try {
        const res = await fetch(
          `/api/RAG?list=namespaces&indexName=${encodeURIComponent(indexName)}`
        );
        const data = await res.json();
        if (data?.status === "ok") {
          setNamespaces(data.namespaces || []);
        }
      } catch {}
    })();
  }, [indexName]);

  const loadOverview = async () => {
    setOverviewLoading(true);
    setSummary(undefined);
    setOverviewFrames([]);
    try {
      const res = await fetch("/api/RAG", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "overview",
          indexName,
          videoId,
          skipEnsure: true,
          topK: 200,
        }),
      });
      const data = await res.json();
      if (data?.status === "ok") {
        setSummary(data.summary || undefined);
        setOverviewFrames(data.frames || []);
      }
    } catch (e) {
      // ignore
    } finally {
      setOverviewLoading(false);
    }
  };

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQ.trim()) return;
    setSearchLoading(true);
    setSearchMatches([]);
    try {
      const res = await fetch("/api/RAG", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "query",
          indexName,
          videoId,
          question: searchQ,
          topK: 3,
          skipEnsure: true,
        }),
      });
      const data = await res.json();
      if (data?.status === "ok") {
        setSearchMatches(data.matches || []);
      }
    } catch {}
    setSearchLoading(false);
  };

  const runAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!analyzeQ.trim()) return;
    setAnalyzeLoading(true);
    setAnswer("");
    setCitations([]);
    try {
      const res = await fetch("/api/RAG", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze",
          indexName,
          videoId,
          question: analyzeQ,
          topK: 10,
          skipEnsure: true,
        }),
      });
      const data = await res.json();
      if (data?.status === "ok") {
        setAnswer(data.answer || "");
        setCitations(data.citations || []);
      }
    } catch {}
    setAnalyzeLoading(false);
  };

  const renderThumb = (path?: string) => {
    if (!path) return null;
    const clean = path.startsWith("/") ? path : `/${path}`;
    const url = `${BACKEND_URL}${clean}`;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={path}
        className="w-24 h-16 object-cover rounded-md border border-white/20"
      />
    );
  };

  return (
    <main className="container py-10 max-w-6xl mx-auto px-4">
      <h1 className="text-3xl font-bold mb-6">Explore</h1>

      {/* Controls */}
      <div className={glassPanel("p-4 mb-6")}>        
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <label className="block text-xs uppercase tracking-wide mb-1 opacity-70">
              Index
            </label>
            <select
              value={indexName}
              onChange={(e) => setIndexName(e.target.value)}
              className="bg-transparent border border-white/20 rounded-md px-3 py-2"
            >
              {[indexName, ...indexes.map((i) => i.name)]
                .filter((v, i, a) => a.indexOf(v) === i)
                .map((name) => (
                  <option key={name} value={name} className="bg-black text-white">
                    {name}
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wide mb-1 opacity-70">
              Namespace (videoId)
            </label>
            <div className="flex items-center gap-2">
              <select
                value={namespaceFromVideoId}
                onChange={(e) => {
                  const ns = e.target.value;
                  const maybeId = ns.startsWith("video-") ? ns.slice(6) : ns;
                  setVideoId(maybeId);
                }}
                className="bg-transparent border border-white/20 rounded-md px-3 py-2"
              >
                {[namespaceFromVideoId, ...namespaces]
                  .filter((v, i, a) => a.indexOf(v) === i)
                  .map((ns) => (
                    <option key={ns} value={ns} className="bg-black text-white">
                      {ns}
                    </option>
                  ))}
              </select>
              <input
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
                className="bg-transparent border border-white/20 rounded-md px-3 py-2 w-28"
                placeholder="1"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Panels */}
      {activeTab === "overview" && (
        <section className={glassPanel("p-6 space-y-6")}>          
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-xl font-semibold">Overview</h2>
            <button
              onClick={loadOverview}
              className="px-4 py-2 rounded-md border bg-black text-white dark:bg-white dark:text-black"
              disabled={overviewLoading}
            >
              {overviewLoading ? "Loading..." : "Load Overview"}
            </button>
          </div>

          {summary && (
            <div className="rounded-xl border border-white/20 p-4 bg-white/5">
              <h3 className="font-semibold mb-2">Video Summary</h3>
              <p className="opacity-90 leading-relaxed">{summary}</p>
            </div>
          )}

          {overviewFrames.length > 0 && (
            <div>
              <h3 className="font-semibold mb-3">Frames ({overviewFrames.length})</h3>
              <div className="grid gap-3">
                {overviewFrames.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-start gap-4 p-3 rounded-lg border border-white/20 bg-white/5"
                  >
                    {renderThumb(f.path)}
                    <div className="min-w-0">
                      <div className="flex items-center gap-3 text-sm mb-1">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white/10 border border-white/20">
                          {typeof f.timestamp === "number" ? `${f.timestamp.toFixed(1)}s` : ""}
                        </span>
                        <span className="opacity-70">frame {String(f.frame_id ?? "")} </span>
                      </div>
                      <p className="opacity-90 whitespace-pre-wrap">{f.description}</p>
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
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {activeTab === "search" && (
        <section className={glassPanel("p-6 space-y-6")}>          
          <h2 className="text-xl font-semibold">Search</h2>
          <form onSubmit={runSearch} className="flex items-center gap-3">
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Ask a question (e.g., what color was the Jeep?)"
              className="flex-1 bg-white/10 border-2 border-white/30 rounded-lg px-4 py-3 text-black dark:text-white placeholder-gray-600 dark:placeholder-gray-400 focus:bg-white/20 focus:border-white/50 focus:ring-2 focus:ring-white/20 transition-all duration-200"
            />
            <button
              type="submit"
              disabled={searchLoading}
              className="px-4 py-2 rounded-md border bg-black text-white dark:bg-white dark:text-black"
            >
              {searchLoading ? "Searching..." : "Search"}
            </button>
          </form>

          {searchMatches.length > 0 && (
            <div className="grid gap-3">
              {searchMatches.map((m, i) => {
                const meta: any = m.metadata || {};
                const ts = typeof meta.timestamp === "number" ? `${meta.timestamp.toFixed(1)}s` : "";
                return (
                  <div key={`${m.id}-${i}`} className="flex items-start gap-4 p-3 rounded-lg border border-white/20 bg-white/5">
                    {renderThumb(meta.path)}
                    <div className="min-w-0">
                      <div className="flex items-center gap-3 text-sm mb-1">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white/10 border border-white/20">
                          {ts}
                        </span>
                        {typeof m.score === "number" && (
                          <span className="opacity-70">score {m.score.toFixed(3)}</span>
                        )}
                      </div>
                      <p className="opacity-90 whitespace-pre-wrap">{meta.description}</p>
                      {meta.path && (
                        <a
                          href={`${BACKEND_URL}/${meta.path.startsWith("/") ? meta.path.slice(1) : meta.path}`}
                          target="_blank"
                          className="text-xs underline opacity-70"
                        >
                          {meta.path}
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === "analyze" && (
        <section className={glassPanel("p-6 space-y-6")}>          
          <h2 className="text-xl font-semibold">Analyze</h2>
          <form onSubmit={runAnalyze} className="grid gap-3">
            <textarea
              value={analyzeQ}
              onChange={(e) => setAnalyzeQ(e.target.value)}
              placeholder="Ask a deeper question. We will answer with citations."
              className="min-h-[120px] bg-transparent border border-white/20 rounded-md px-3 py-2"
            />
            <div>
              <button
                type="submit"
                disabled={analyzeLoading}
                className="px-4 py-2 rounded-md border bg-black text-white dark:bg-white dark:text-black"
              >
                {analyzeLoading ? "Analyzing..." : "Analyze"}
              </button>
            </div>
          </form>

          {answer && (
            <div className="rounded-xl border border-white/20 p-4 bg-white/5">
              <h3 className="font-semibold mb-2">Answer</h3>
              <p className="opacity-90 whitespace-pre-wrap">{answer}</p>
            </div>
          )}

          {citations.length > 0 && (
            <div>
              <h3 className="font-semibold mb-2">Citations</h3>
              <div className="grid gap-3">
                {citations.map((c, i) => {
                  const meta: any = c.metadata || {};
                  const ts = typeof meta.timestamp === "number" ? `${meta.timestamp.toFixed(1)}s` : "";
                  return (
                    <div key={`${c.id}-${i}`} className="flex items-start gap-4 p-3 rounded-lg border border-white/20 bg-white/5">
                      {renderThumb(meta.path)}
                      <div className="min-w-0">
                        <div className="flex items-center gap-3 text-sm mb-1">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white/10 border border-white/20">
                            {ts}
                          </span>
                          {typeof c.score === "number" && (
                            <span className="opacity-70">score {c.score.toFixed(3)}</span>
                          )}
                        </div>
                        <p className="opacity-90 whitespace-pre-wrap">{meta.description}</p>
                        {meta.path && (
                          <a
                            href={`${BACKEND_URL}/${meta.path.startsWith("/") ? meta.path.slice(1) : meta.path}`}
                            target="_blank"
                            className="text-xs underline opacity-70"
                          >
                            {meta.path}
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
      )}
    </main>
  );
}
