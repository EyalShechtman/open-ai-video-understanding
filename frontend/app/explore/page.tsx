"use client";
import React, { useEffect, useMemo, useState, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Search, Send } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { ResponseStream } from "@/components/ui/response-stream";

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

// Search Input Component
function SearchInput({ 
  value, 
  onChange, 
  onSubmit, 
  isLoading,
  placeholder = "Ask a question (e.g., what color was the Jeep?)"
}: { 
  value: string; 
  onChange: (value: string) => void; 
  onSubmit: () => void;
  isLoading: boolean;
  placeholder?: string;
}) {
  const [isActive, setIsActive] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        if (!value) setIsActive(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [value]);

  const handleActivate = () => setIsActive(true);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="w-full flex justify-center" ref={wrapperRef}>
      <motion.div
        className="w-full max-w-3xl bg-white dark:bg-gray-900 rounded-3xl shadow-lg"
        animate={{
          boxShadow: isActive || value 
            ? "0 8px 32px 0 rgba(0,0,0,0.16)" 
            : "0 2px 8px 0 rgba(0,0,0,0.08)"
        }}
        transition={{ type: "spring", stiffness: 120, damping: 18 }}
        onClick={handleActivate}
      >
        <div className="flex items-center gap-2 p-3">
          <button
            className="p-3 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            title="Search"
            type="button"
            tabIndex={-1}
          >
            <Search size={20} className="text-gray-600 dark:text-gray-400" />
          </button>

          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 border-0 outline-0 rounded-md py-2 px-2 text-base bg-transparent text-black dark:text-white placeholder-gray-400"
            onFocus={handleActivate}
          />

          <button
            onClick={(e) => {
              e.stopPropagation();
              onSubmit();
            }}
            disabled={isLoading || !value.trim()}
            className="flex items-center gap-1 bg-black hover:bg-zinc-700 dark:bg-white dark:hover:bg-gray-200 text-white dark:text-black p-3 rounded-full font-medium justify-center disabled:opacity-50 disabled:cursor-not-allowed transition"
            title="Send"
            type="button"
          >
            {isLoading ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
              >
                <Search size={18} />
              </motion.div>
            ) : (
              <Send size={18} />
            )}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// Component for expandable description
function ExpandableDescription({ text, maxWords = 10 }: { text: string; maxWords?: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const words = text.split(' ');
  const shouldTruncate = words.length > maxWords;
  const displayText = shouldTruncate && !isExpanded 
    ? words.slice(0, maxWords).join(' ') + '...'
    : text;

  if (!shouldTruncate) {
    return <p className="opacity-90 leading-relaxed text-base">{text}</p>;
  }

  return (
    <div>
      <p className="opacity-90 leading-relaxed text-base">{displayText}</p>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="mt-3 flex items-center gap-1.5 text-sm opacity-70 hover:opacity-100 transition-opacity"
      >
        <span>{isExpanded ? 'Show less' : 'Show more'}</span>
        <svg
          className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
}

// Component for video result card
function VideoResultCard({ 
  match, 
  index, 
  indexName, 
  indexToVideoMap,
  renderVideoPlayer,
  renderThumb
}: any) {
  const meta: any = match.metadata || {};
  const ts = typeof meta.timestamp === "number" ? meta.timestamp : 0;
  const tsDisplay = typeof meta.timestamp === "number" ? `${meta.timestamp.toFixed(1)}s` : "";
  const videoFilename = meta.video_filename;
  const actualVideoFilename = videoFilename || indexToVideoMap[indexName.toLowerCase()];
  
  return (
    <div className="rounded-xl border border-white/20 bg-white/5 overflow-hidden hover:border-white/30 transition-all duration-200 shadow-lg hover:shadow-xl">
      {/* Video Section - Make this the dominant element */}
      <div className="relative">
        {actualVideoFilename ? (
          <div className="p-8 pb-6">
            {renderVideoPlayer(videoFilename, ts)}
          </div>
        ) : (
          <div className="flex items-center justify-center aspect-video bg-black/20 border-b border-white/10">
            <div className="text-center">
              {renderThumb(meta.path)}
              <p className="text-xs opacity-50 mt-2">Video not available</p>
            </div>
          </div>
        )}
      </div>
      
      {/* Info Section - Compact metadata */}
      <div className="px-8 pb-6 pt-2 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center px-4 py-2 rounded-full text-base font-semibold bg-white/10 border border-white/20">
            ⏱️ {tsDisplay}
          </span>
          {typeof match.score === "number" && (
            <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium bg-white/10 border border-white/20">
              Score: {match.score.toFixed(3)}
            </span>
          )}
          {meta.frame_id && (
            <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm bg-white/10 border border-white/20">
              Frame {meta.frame_id}
            </span>
          )}
        </div>
        
        <div>
          <h4 className="text-xs font-semibold mb-2 opacity-50 uppercase tracking-wide">Description</h4>
          <ExpandableDescription text={meta.description || "No description available"} maxWords={10} />
        </div>
      </div>
    </div>
  );
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
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // action: "analyze", // no longer required; kept for compatibility if needed
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

  // Map index names to video files (fallback for data uploaded before video_filename was added)
  // Each index corresponds to one video
  const indexToVideoMap: Record<string, string> = {
    'democrash-mp4': '1761553398785_DemoCrash.mp4',
    'crashdemo-mp4': '1761542252139_crashDemo.mp4',
    'video-frames': 'video.mp4',
    // Add more mappings as needed for existing indexes
  };

  const renderVideoPlayer = (videoFilename?: string, timestamp?: number) => {
    // Use video_filename from metadata if available, otherwise fall back to index mapping
    const actualFilename = videoFilename || indexToVideoMap[indexName.toLowerCase()];
    
    if (!actualFilename) {
      // No video available for this index
      return null;
    }
    
    const videoUrl = `${BACKEND_URL}/data/${actualFilename}`;
    
    return (
      <div className="w-full aspect-video bg-black rounded-lg overflow-hidden border border-white/20">
        <video
          controls
          preload="metadata"
          className="w-full h-full"
          onLoadedMetadata={(e) => {
            const video = e.currentTarget;
            if (timestamp !== undefined) {
              video.currentTime = timestamp;
            }
          }}
        >
          <source src={videoUrl} type="video/mp4" />
          Your browser does not support the video tag.
        </video>
      </div>
    );
  };

  return (
    <main className="w-full py-10 px-12">
      <h1 className="text-3xl font-bold mb-6 text-white dark:text-white">Explore</h1>

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
          <div className="text-center space-y-2 mb-6">
            <h2 className="text-3xl font-bold">Moments</h2>
            <p className="text-sm opacity-60 max-w-2xl mx-auto mt-2">
              Search for specific scenes, objects, or actions by describing what you're looking for. 
              For example, try searching for "red Jeep" or "car crash" to find relevant moments.
            </p>
          </div>
          <SearchInput
            value={searchQ}
            onChange={setSearchQ}
            onSubmit={() => {
              if (searchQ.trim()) {
                runSearch({ preventDefault: () => {} } as React.FormEvent);
              }
            }}
            isLoading={searchLoading}
          />

          {searchMatches.length > 0 && (
            <div className="grid grid-cols-3 gap-8">
              {searchMatches.map((m, i) => (
                <VideoResultCard
                  key={`${m.id}-${i}`}
                  match={m}
                  index={i}
                  indexName={indexName}
                  indexToVideoMap={indexToVideoMap}
                  renderVideoPlayer={renderVideoPlayer}
                  renderThumb={renderThumb}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === "analyze" && (
        <section className={glassPanel("p-6 space-y-6")}>          
          <div className="text-center space-y-2 mb-6">
            <h2 className="text-3xl font-bold">Ask Questions</h2>
            <p className="text-sm opacity-60 max-w-2xl mx-auto mt-2">
              Ask questions about the video content and get comprehensive answers with relevant video citations.
            </p>
          </div>
          
          <SearchInput
            value={analyzeQ}
            onChange={setAnalyzeQ}
            onSubmit={() => {
              if (analyzeQ.trim()) {
                runAnalyze({ preventDefault: () => {} } as React.FormEvent);
              }
            }}
            isLoading={analyzeLoading}
            placeholder="Ask a question (e.g., What sequence of events led to the crash?)"
          />

          {answer && (
            <div className="rounded-xl bg-white p-6 space-y-4 shadow-lg max-w-4xl mx-auto">
              <div className="flex items-center gap-3 pb-3 border-b border-gray-200">
                <h3 className="text-lg font-bold text-black">Answer</h3>
              </div>
              <div className="bg-white rounded-lg p-6">
                <ResponseStream
                  textStream={answer}
                  mode="fade"
                  speed={80}
                  className="text-base leading-relaxed whitespace-pre-wrap text-black font-normal"
                />
              </div>
            </div>
          )}

          {citations.length > 0 && (
            <div className="space-y-6">
              <div className="flex items-center gap-3 pb-3 border-b-2 border-white">
                <h3 className="text-2xl font-bold text-white">Video Citations ({citations.length})</h3>
              </div>
              <div className="grid grid-cols-3 gap-8">
                {citations.map((c, i) => (
                  <VideoResultCard
                    key={`${c.id}-${i}`}
                    match={c}
                    index={i}
                    indexName={indexName}
                    indexToVideoMap={indexToVideoMap}
                    renderVideoPlayer={renderVideoPlayer}
                    renderThumb={renderThumb}
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
