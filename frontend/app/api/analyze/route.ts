import { NextRequest, NextResponse } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs/promises";
import path from "path";

// Keep constants aligned with RAG route
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSION = 3072; // gemini-embedding-001 supports 768, 1536, or 3072
const GENERATION_MODEL = process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash";
const DEFAULT_INDEX_NAME = process.env.PINECONE_INDEX ?? "video-frames";
const DEFAULT_NAMESPACE = "frames";

const pineconeApiKey = process.env.PINECONE_API_KEY;
const googleApiKey = process.env.GOOGLE_API_KEY;

const pineconeClient = pineconeApiKey ? new Pinecone({ apiKey: pineconeApiKey }) : null;
const geminiClient = googleApiKey ? new GoogleGenerativeAI(googleApiKey) : null;

type EmbeddingModel = ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;
type GenerationModel = ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;

const indexInitPromises = new Map<string, Promise<void>>();

function getNamespace(videoId?: string | number) {
  if (!videoId) return DEFAULT_NAMESPACE;
  return `video-${sanitizeIndexName(videoId)}`;
}

function getPineconeClient(): Pinecone {
  if (!pineconeClient) {
    throw new Error("Missing Pinecone client. Ensure PINECONE_API_KEY is set.");
  }
  return pineconeClient;
}

function getEmbeddingModel(): EmbeddingModel {
  if (!geminiClient) {
    throw new Error("Missing Gemini client. Ensure GOOGLE_API_KEY is set.");
  }
  return geminiClient.getGenerativeModel({ model: EMBEDDING_MODEL });
}

function getGenerationModel(): GenerationModel {
  if (!geminiClient) {
    throw new Error("Missing Gemini client. Ensure GOOGLE_API_KEY is set.");
  }
  return geminiClient.getGenerativeModel({ model: GENERATION_MODEL });
}

function sanitizeIndexName(raw?: string | number | null): string {
  const fallback = DEFAULT_INDEX_NAME;
  const candidate =
    (typeof raw === "number" && Number.isFinite(raw) ? raw.toString() : undefined) ??
    (typeof raw === "string" ? raw : undefined) ??
    fallback;

  const lowered = candidate.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]+/g, "-");
  const collapsed = replaced.replace(/-+/g, "-");
  const trimmed = collapsed.replace(/^-+|-+$/g, "");
  const safe = trimmed || fallback;
  return safe.slice(0, 45);
}

function resolveIndexName(raw?: string | number | null): string {
  return sanitizeIndexName(raw);
}

function checkEmbeddingDimensions(values: number[]) {
  if (values.length !== EMBEDDING_DIMENSION) {
    console.warn(
      `Gemini embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, received ${values.length}.`
    );
  }
}

function normalizeIndexList(indexes: unknown): { name: string }[] {
  if (!indexes) return [];
  if (Array.isArray(indexes)) {
    return indexes
      .map((item) => (typeof item === "string" ? { name: item } : (item as { name?: string })))
      .filter((item): item is { name: string } => Boolean(item?.name));
  }
  if (typeof indexes === "object" && indexes !== null) {
    const maybeIndexes = (indexes as Record<string, unknown>).indexes;
    if (Array.isArray(maybeIndexes)) {
      return normalizeIndexList(maybeIndexes);
    }
  }
  return [];
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) throw new Error("No text provided for embedding.");
  const model = getEmbeddingModel();
  const promises = texts.map(async (text) => {
    const response = await model.embedContent({
      content: { role: "user", parts: [{ text: text ?? "" }] },
      taskType: "RETRIEVAL_QUERY" as any,
      outputDimensionality: EMBEDDING_DIMENSION,
    } as any);
    const values = response.embedding?.values;
    if (!values?.length) throw new Error("Gemini did not return an embedding vector.");
    checkEmbeddingDimensions(values);
    return values;
  });
  return await Promise.all(promises);
}

async function ensureIndexReady(indexName: string): Promise<void> {
  const client = getPineconeClient();
  const existing = indexInitPromises.get(indexName);
  if (existing) {
    await existing;
    return;
  }
  const initializer = (async () => {
    const indexes = normalizeIndexList(await client.listIndexes());
    const exists = indexes.some((index) => index.name === indexName);
    if (!exists) {
      await client.createIndex({
        name: indexName,
        dimension: EMBEDDING_DIMENSION,
        metric: "cosine",
        spec: {
          serverless: {
            cloud: (process.env.PINECONE_CLOUD ?? "aws") as any,
            region: process.env.PINECONE_REGION ?? "us-east-1",
          },
        },
      });
    }
    const maxAttempts = 150;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const description = (await client.describeIndex(indexName)) as any;
        const ready = description?.status?.ready === true || description?.status?.state === "Ready";
        if (ready) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Timed out waiting for Pinecone index "${indexName}" to become ready.`);
  })().catch((error) => {
    indexInitPromises.delete(indexName);
    throw error;
  });
  indexInitPromises.set(indexName, initializer);
  await initializer;
}

function requireClients() {
  if (!pineconeClient) {
    throw new Error("Missing Pinecone client. Ensure PINECONE_API_KEY is set.");
  }
  if (!geminiClient) {
    throw new Error("Missing Gemini client. Ensure GOOGLE_API_KEY is set.");
  }
}

async function loadFrameAsBase64(framePath: string): Promise<string | null> {
  try {
    // If the path already starts with "data/", it's relative to backend directory
    // Otherwise, treat it as relative to backend/data
    let absolutePath: string;
    
    if (path.isAbsolute(framePath)) {
      absolutePath = framePath;
    } else if (framePath.startsWith("data/")) {
      // Path is like "data/frame_027.png", so go to backend directory
      absolutePath = path.join(process.cwd(), "..", "backend", framePath);
    } else {
      // Path is just "frame_027.png", so go to backend/data directory
      absolutePath = path.join(process.cwd(), "..", "backend", "data", framePath);
    }
    
    const imageBuffer = await fs.readFile(absolutePath);
    const base64 = imageBuffer.toString("base64");
    
    // Determine MIME type from file extension
    const ext = path.extname(framePath).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error(`Failed to load frame at ${framePath}:`, error);
    return null;
  }
}

type AnalyzeRequestPayload = {
  // action?: "analyze"; // ignored
  indexName?: string | number | null;
  videoId?: string | number;
  question: string;
  topK?: number;
  skipEnsure?: boolean;
};

export async function POST(request: NextRequest) {
  try {
    requireClients();
    const payload = (await request.json()) as AnalyzeRequestPayload | (AnalyzeRequestPayload & { action?: string });

    const { question, videoId, topK, indexName: requestedIndexName, skipEnsure } = payload ?? ({} as any);
    const indexName = resolveIndexName(requestedIndexName);
    if (!skipEnsure) {
      await ensureIndexReady(indexName);
    }
    if (!question) {
      return NextResponse.json(
        { status: "error", message: "Question is required for analyze." },
        { status: 400 }
      );
    }

    const namespace = getNamespace(videoId);

    const [queryVector] = await embedTexts([question]);
    const top = Math.min(topK ?? 10, 50);
    const result = await getPineconeClient().index(indexName).namespace(namespace).query({
      vector: queryVector,
      topK: top,
      includeMetadata: true,
    });

    const matches = result.matches ?? [];
    console.log(`Found ${matches.length} matches from Pinecone`);
    
    // Sort matches by timestamp to create a chronological timeline
    const sortedMatches = [...matches].sort((a, b) => {
      const tsA = (a.metadata as any)?.timestamp ?? 0;
      const tsB = (b.metadata as any)?.timestamp ?? 0;
      return tsA - tsB;
    });

    // Log first match metadata to debug path issues
    if (sortedMatches.length > 0) {
      console.log('Sample match metadata:', JSON.stringify(sortedMatches[0].metadata, null, 2));
    }

    // Load actual frame images
    const frameImages = await Promise.all(
      sortedMatches.map(async (m, idx) => {
        const meta: any = m.metadata ?? {};
        const framePath = meta.path;
        if (!framePath) {
          console.log(`Frame ${idx} has no path in metadata`);
          return null;
        }
        console.log(`Loading frame ${idx}: ${framePath}`);
        return await loadFrameAsBase64(framePath);
      })
    );
    
    const loadedCount = frameImages.filter(img => img !== null).length;
    console.log(`Successfully loaded ${loadedCount}/${frameImages.length} frame images`);

    // Build text context with frame descriptions
    const context = sortedMatches
      .map((m, i) => {
        const meta: any = m.metadata ?? {};
        const ts =
          typeof meta.timestamp === "number"
            ? `${meta.timestamp.toFixed(1)}s`
            : String(meta.timestamp ?? "");
        return `#${i + 1} [t=${ts}] id=${meta.frame_id ?? "?"} ${
          meta.path ? `(${meta.path})` : ""
        }\n${meta.description ?? ""}`;
      })
      .join("\n\n");

    const prompt = `You are a video analysis assistant. Your task is to answer questions about a video by analyzing frames in CHRONOLOGICAL ORDER.

IMPORTANT INSTRUCTIONS:
1. The frames below are sorted by timestamp - use this to understand the SEQUENCE and TIMELINE of events
2. Connect the frames together to build a coherent narrative of what happened over time
3. Pay close attention to WHEN things happen (timestamps) to understand cause and effect
4. Infer relationships between frames based on their temporal proximity
5. If events happen across multiple frames, explain the progression and timeline
6. Use ONLY the provided frames - do not make up information
7. Cite 2-3 most relevant frames by frame_id and timestamp in square brackets (e.g., [frame 5 at 2.5s])
8. If you cannot determine the answer from the frames, clearly state what information is missing
9. You have access to both the ACTUAL FRAME IMAGES and their text descriptions - use both for comprehensive analysis

Question: ${question}

Frames (in chronological order):
${context}

Remember: Consider how the frames connect temporally to form a complete picture of the events.`;

    // Build the content parts array with interleaved images and descriptions
    const contentParts: any[] = [{ text: prompt }];
    
    // Add each frame image with its context
    sortedMatches.forEach((m, i) => {
      const meta: any = m.metadata ?? {};
      const ts =
        typeof meta.timestamp === "number"
          ? `${meta.timestamp.toFixed(1)}s`
          : String(meta.timestamp ?? "");
      
      if (frameImages[i]) {
        contentParts.push({
          text: `\n\nFrame #${i + 1} at timestamp ${ts} (${meta.frame_id ?? "?"}):`,
        });
        contentParts.push({
          inlineData: {
            mimeType: frameImages[i]!.startsWith("data:image/png") ? "image/png" : "image/jpeg",
            data: frameImages[i]!.split(",")[1], // Remove the data:image/...;base64, prefix
          },
        });
        contentParts.push({
          text: `Description: ${meta.description ?? "No description available"}`,
        });
      }
    });

    const model = getGenerationModel();
    const resp = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: contentParts,
        },
      ],
    });
    const answer =
      (resp as any)?.response?.text?.() ??
      (resp as any)?.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("\n") ??
      "";

    return NextResponse.json({
      status: "ok",
      answer,
      citations: (sortedMatches || []).map((m) => ({ id: m.id, score: m.score, metadata: m.metadata })),
      index: indexName,
    });
  } catch (error) {
    console.error('Analyze endpoint error:', error);
    const message = error instanceof Error ? error.message : "Unexpected error occurred.";
    const stack = error instanceof Error ? error.stack : undefined;
    return NextResponse.json({ 
      status: "error", 
      message,
      ...(process.env.NODE_ENV === 'development' && { stack })
    }, { status: 500 });
  }
}
