"use client";
import React, { useState } from "react";
import { FileUpload } from "@/components/ui/file-upload";

type SubmitState = "idle" | "ready" | "uploading" | "processing" | "success" | "error";

interface FrameRecord {
  frame_id: number;
  timestamp: number;
  description: string;
  path: string;
}

interface ProcessVideoResponse {
  status: string;
  records?: FrameRecord[];
  summary?: string;
  message?: string;
}

export default function Page() {
  const [files, setFiles] = useState<File[]>([]);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [feedback, setFeedback] = useState("Attach a video to begin.");
  const [results, setResults] = useState<ProcessVideoResponse | null>(null);

  const hasFiles = files.length > 0;
  const isBusy = submitState === "uploading" || submitState === "processing";

  const handleFileUpload = (incoming: File[]) => {
    setFiles(incoming);
    setSubmitState(incoming.length ? "ready" : "idle");
    setFeedback(incoming.length ? "Ready to submit." : "Attach a video to begin.");
    setResults(null);
  };

  const buildFormData = () => {
    const formData = new FormData();
    files.forEach((file) => formData.append("file", file));
    return formData;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasFiles) {
      setSubmitState("error");
      setFeedback("Please add at least one file.");
      return;
    }

    setSubmitState("uploading");
    setFeedback("Uploading video...");
    setResults(null);

    try {
      // Step 1: Upload the video
      const formData = buildFormData();
      const uploadResponse = await fetch("http://localhost:4000/upload", {
        method: "POST",
        body: formData,
      });

      const uploadData = await uploadResponse.json();
      
      if (uploadData.status !== "ok") {
        throw new Error(uploadData.message || "Upload failed");
      }

      setFeedback(`Video uploaded! Processing frames (this may take a few minutes)...`);
      setSubmitState("processing");

      // Step 2: Process the video
      const processResponse = await fetch("http://localhost:4000/process-video", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          video_path: uploadData.video_path,
        }),
      });

      const processData: ProcessVideoResponse = await processResponse.json();

      if (processData.status === "ok") {
        setResults(processData);
        const frameCount = processData.records?.length || 0;
        setFeedback(`Processing complete! Analyzed ${frameCount} frames. Indexing...`);

        // Step 3: Ingest records into Pinecone via Next API (RAG)
        if (frameCount > 0) {
          try {
            const ingestResponse = await fetch("/api/RAG", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "ingest_final",
                videoFile: files[0]?.name ?? "video",
                videoId: 1,
                records: processData.records,
                summary: processData.summary ?? undefined,
              }),
            });
            const ingestData = await ingestResponse.json();
            if (ingestData?.status === "ok") {
              setFeedback(`Done! Indexed ${ingestData.upserted ?? frameCount} vectors to Pinecone.`);
              setSubmitState("success");
            } else {
              console.error("Ingest error:", ingestData);
              setFeedback("Frames processed but indexing failed. Check server logs.");
              setSubmitState("error");
            }
          } catch (e) {
            console.error(e);
            setFeedback("Frames processed but indexing failed. Check server logs.");
            setSubmitState("error");
          }
        } else {
          setFeedback("Processing complete, no frames to index.");
          setSubmitState("success");
        }
      } else {
        throw new Error(processData.message || "Processing failed");
      }
    } catch (error) {
      console.error(error);
      setSubmitState("error");
      setFeedback(error instanceof Error ? error.message : "Something went wrong. Please retry.");
    }
  };

  return (
    <main className="container py-12 max-w-6xl mx-auto px-4">
      <h1 className="text-3xl font-bold mb-8">Video Understanding</h1>
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="w-full min-h-64 border border-dashed rounded-lg bg-white dark:bg-black border-gray-300 dark:border-gray-700">
          <FileUpload onChange={handleFileUpload} accept="video/*" multiple={false} />
        </div>

        {files.length > 0 && (
          <div>
            <h2 className="text-lg font-medium mb-2">Selected file</h2>
            <ul className="list-disc pl-5 text-sm text-gray-600 dark:text-gray-300">
              {files.map((f) => (
                <li key={`${f.name}-${f.lastModified}`}>{f.name}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="submit"
            disabled={!hasFiles || isBusy}
            className={[
              "px-6 py-3 rounded-lg text-sm font-semibold",
              "border border-black dark:border-white transition-all",
              hasFiles && !isBusy
                ? "bg-black text-white dark:bg-white dark:text-black hover:opacity-80"
                : "bg-transparent text-gray-400 dark:text-gray-500 cursor-not-allowed",
              isBusy ? "opacity-70 cursor-wait animate-pulse" : "",
            ].join(" ")}
          >
            {submitState === "uploading" && "Uploading..."}
            {submitState === "processing" && "Processing..."}
            {!isBusy && "Process Video"}
          </button>
          <p className="text-sm text-gray-600 dark:text-gray-300">{feedback}</p>
        </div>
      </form>

      {/* Results Section */}
      {results && results.status === "ok" && (
        <div className="mt-12 space-y-8">
          {/* Summary Section */}
          {results.summary && (
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-gray-800 dark:to-gray-900 rounded-xl p-6 border border-blue-200 dark:border-gray-700">
              <h2 className="text-xl font-bold mb-3 text-gray-900 dark:text-white">
                Video Summary
              </h2>
              <p className="text-gray-700 dark:text-gray-200 leading-relaxed">
                {results.summary}
              </p>
            </div>
          )}

          {/* Frame Analysis Section */}
          {results.records && results.records.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Frame Analysis ({results.records.length} frames)
              </h2>
              <div className="grid gap-4">
                {results.records.map((record) => (
                  <div
                    key={record.frame_id}
                    className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start gap-4">
                      <div className="flex-shrink-0">
                        <div className="bg-gradient-to-br from-black to-gray-800 text-white rounded-full w-12 h-12 flex items-center justify-center font-bold text-lg">
                          {record.frame_id}
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                            {record.timestamp.toFixed(1)}s
                          </span>
                        </div>
                        <p className="text-gray-700 dark:text-gray-200 leading-relaxed">
                          {record.description}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Raw JSON Section (Collapsible) */}
          <details className="bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
            <summary className="px-6 py-4 cursor-pointer font-semibold text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
              View Raw JSON
            </summary>
            <div className="px-6 pb-6">
              <pre className="bg-white dark:bg-gray-800 p-4 rounded-lg overflow-x-auto text-xs border border-gray-200 dark:border-gray-700">
                <code className="text-gray-800 dark:text-gray-200">
                  {JSON.stringify(results, null, 2)}
                </code>
              </pre>
            </div>
          </details>
        </div>
      )}
    </main>
  );
}
