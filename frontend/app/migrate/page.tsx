"use client";
import React, { useState } from "react";

type FrameRecord = {
  frame_id: number | string;
  timestamp: number;
  description: string;
  path: string;
};

export default function MigratePage() {
  const [jsonText, setJsonText] = useState<string>(`\n{\n  "status": "ok",\n  "summary": "",\n  "records": []\n}\n`);
  const [videoFile, setVideoFile] = useState<string>("democrash-mp4");
  const [videoId, setVideoId] = useState<string>("1");
  const [loading, setLoading] = useState<boolean>(false);
  const [indexNameOverride, setIndexNameOverride] = useState<string>("democrash-mp4");
  const [skipEnsure, setSkipEnsure] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<string>("Paste JSON from video processing and click Index.");

  const handleIndex = async () => {
    setLoading(true);
    setFeedback("Parsing JSON...");
    try {
      const parsed = JSON.parse(jsonText) as {
        records?: FrameRecord[];
        summary?: string | null;
      };
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      const summary = parsed.summary ?? undefined;

      if (records.length === 0) {
        setFeedback("No records found in JSON.");
        setLoading(false);
        return;
      }

      setFeedback(`Indexing ${records.length} records...`);
      const payload = {
        action: "ingest_final",
        videoFile: videoFile || "video",
        indexName: indexNameOverride || undefined,
        videoId: videoId || undefined,
        skipEnsure,
        records,
        summary,
      };
      console.log("Sending payload to /api/RAG:", payload);
      
      const res = await fetch("/api/RAG", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      console.log("Response status:", res.status, res.statusText);
      const data = await res.json();
      console.log("Response data:", data);
      
      if (data?.status === "ok") {
        setFeedback(`Success! Upserted ${data.upserted ?? records.length} vectors into index "${data.index}" (ns=${data.namespace}).`);
      } else {
        setFeedback(`Failed: ${data?.message ?? "Unknown error"}`);
      }
    } catch (e: any) {
      setFeedback(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="container py-8 max-w-4xl mx-auto px-4">
      <h1 className="text-2xl font-bold mb-4">Migrate Records to Pinecone</h1>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Paste the JSON containing <code>records</code> (and optional <code>summary</code>) from your video processing. 
        The index name is pre-filled to match your existing Pinecone index. Check the browser console for detailed logs.
      </p>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <label className="text-sm font-medium">Video file (used for index name)</label>
          <input
            value={videoFile}
            onChange={(e) => setVideoFile(e.target.value)}
            className="border rounded p-2 bg-white dark:bg-gray-900"
            placeholder="my-video.mp4"
          />
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-medium">Index name override (optional)</label>
          <input
            value={indexNameOverride}
            onChange={(e) => setIndexNameOverride(e.target.value)}
            className="border rounded p-2 bg-white dark:bg-gray-900"
            placeholder="existing-index-name"
          />
          <p className="text-xs text-gray-500">If set, the data will be upserted into this index.</p>
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-medium">Video ID (namespace; optional)</label>
          <input
            value={videoId}
            onChange={(e) => setVideoId(e.target.value)}
            className="border rounded p-2 bg-white dark:bg-gray-900"
            placeholder="1"
          />
        </div>
        <div className="flex items-center gap-2">
          <input id="skipEnsure" type="checkbox" checked={skipEnsure} onChange={(e) => setSkipEnsure(e.target.checked)} />
          <label htmlFor="skipEnsure" className="text-sm">Skip index creation/readiness (assumes index already exists)</label>
        </div>
        <div className="grid gap-2">
          <label className="text-sm font-medium">JSON</label>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            className="border rounded p-2 min-h-[280px] font-mono text-sm bg-white dark:bg-gray-900"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleIndex}
            disabled={loading}
            className={[
              "px-5 py-2 rounded border",
              loading
                ? "opacity-60 cursor-wait"
                : "bg-black text-white dark:bg-white dark:text-black",
            ].join(" ")}
          >
            {loading ? "Indexing..." : "Index Records"}
          </button>
          <span className="text-sm text-gray-600 dark:text-gray-300">{feedback}</span>
        </div>
      </div>
    </main>
  );
}
