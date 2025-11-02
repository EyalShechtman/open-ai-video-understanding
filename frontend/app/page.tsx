"use client";
import React, { useState } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [feedback, setFeedback] = useState("Attach a video to begin.");

  const hasFiles = files.length > 0;
  const isBusy = submitState === "uploading" || submitState === "processing";

  const handleFileUpload = (incoming: File[]) => {
    setFiles(incoming);
    setSubmitState(incoming.length ? "ready" : "idle");
    setFeedback(incoming.length ? "Ready to submit." : "Attach a video to begin.");
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
                videoFilename: uploadData.video_path?.split('/').pop() || uploadData.video_path,
                records: processData.records,
                summary: processData.summary ?? undefined,
              }),
            });
            const ingestData = await ingestResponse.json();
            if (ingestData?.status === "ok") {
              setFeedback(`Done! Indexed ${ingestData.upserted ?? frameCount} vectors to Pinecone.`);
              setSubmitState("success");
              
              // Extract index name and video ID from ingest response
              const indexName = ingestData.index || "video-frames";
              const videoId = ingestData.videoId || "1";
              
              // Clear cache for this video to ensure fresh data
              const cacheKey = `overview_${indexName}_${videoId}`;
              try {
                sessionStorage.removeItem(cacheKey);
              } catch (e) {
                console.warn("Failed to clear cache", e);
              }
              
              // Redirect to overview page
              router.push(`/overview/${encodeURIComponent(indexName)}?videoId=${encodeURIComponent(videoId)}`);
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
    </main>
  );
}
