import { NextRequest, NextResponse } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSION = 3072; // gemini-embedding-001 supports 768, 1536, or 3072
const GENERATION_MODEL = process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash";
const DEFAULT_INDEX_NAME = process.env.PINECONE_INDEX ?? "video-frames";
const DEFAULT_NAMESPACE = "frames";

const pineconeApiKey = process.env.PINECONE_API_KEY;
const googleApiKey = process.env.GOOGLE_API_KEY;

const pineconeClient = pineconeApiKey
  ? new Pinecone({ apiKey: pineconeApiKey })
  : null;
const geminiClient = googleApiKey
  ? new GoogleGenerativeAI(googleApiKey)
  : null;

type EmbeddingModel = ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;
type GenerationModel = ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;

const indexInitPromises = new Map<string, Promise<void>>();

function getNamespace(videoId?: string | number) {
  if (!videoId) {
    return DEFAULT_NAMESPACE;
  }
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
      .map((item) =>
        typeof item === "string" ? { name: item } : (item as { name?: string })
      )
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
  if (!texts.length) {
    throw new Error("No text provided for embedding.");
  }

  const model = getEmbeddingModel();

  // Process embeddings in parallel
  const promises = texts.map(async (text) => {
    const response = await model.embedContent({
      content: {
        role: "user",
        parts: [{ text: text ?? "" }],
      },
      taskType: "RETRIEVAL_DOCUMENT" as any,
      outputDimensionality: EMBEDDING_DIMENSION,
    } as any);
    const values = response.embedding?.values;
    if (!values?.length) {
      throw new Error("Gemini did not return an embedding vector.");
    }
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

    // Pinecone indexes take a moment to become queryable; poll for readiness.
    const maxAttempts = 150; // wait up to ~5 minutes
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const description = (await client.describeIndex(indexName)) as any;
        const ready =
          description?.status?.ready === true ||
          description?.status?.state === "Ready";
        if (ready) {
          return;
        }
      } catch (error) {
        // The index may not be immediately available; retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      `Timed out waiting for Pinecone index "${indexName}" to become ready.`
    );
  })().catch((error) => {
    indexInitPromises.delete(indexName);
    throw error;
  });

  indexInitPromises.set(indexName, initializer);
  await initializer;
}

type IngestRequestPayload = {
  action: "ingest";
  indexName?: string | number | null;
  videoId?: string | number;
  skipEnsure?: boolean;
  frames: Array<{
    frameId: string | number;
    timestamp: number;
    description: string;
    path: string;
  }>;
};

type QueryRequestPayload = {
  action: "query";
  indexName?: string | number | null;
  videoId?: string | number;
  question: string;
  topK?: number;
  skipEnsure?: boolean;
};

type RoutePayload = IngestRequestPayload | QueryRequestPayload;

type RustFrameRecord = {
  frame_id: number | string;
  timestamp: number;
  description: string;
  path: string;
};

type FinalIngestRequest = {
  action: "ingest_final";
  indexName?: string | number | null;
  videoFile?: string | null;
  videoId?: string | number;
  videoFilename?: string | null;
  summary?: string | null;
  skipEnsure?: boolean;
  records?: RustFrameRecord[];
  frames?: IngestRequestPayload["frames"];
};

type AnalyzeRequestPayload = {
  action: "analyze";
  indexName?: string | number | null;
  videoId?: string | number;
  question: string;
  topK?: number;
  skipEnsure?: boolean;
};

type OverviewRequestPayload = {
  action: "overview";
  indexName?: string | number | null;
  videoId?: string | number;
  topK?: number; // fallback strategy
  skipEnsure?: boolean;
};

function isFinalIngestPayload(payload: RoutePayload | FinalIngestRequest | AnalyzeRequestPayload | OverviewRequestPayload): payload is FinalIngestRequest {
  return (payload as any)?.action === "ingest_final";
}

function isIngestPayload(payload: RoutePayload | AnalyzeRequestPayload | OverviewRequestPayload): payload is IngestRequestPayload {
  return (payload as any)?.action === "ingest";
}

function isQueryPayload(payload: RoutePayload | any): payload is QueryRequestPayload {
  return payload.action === "query";
}

function isAnalyzePayload(payload: any): payload is AnalyzeRequestPayload {
  return payload?.action === "analyze";
}

function isOverviewPayload(payload: any): payload is OverviewRequestPayload {
  return payload?.action === "overview";
}

function requireClients() {
  if (!pineconeClient) {
    throw new Error("Missing Pinecone client. Ensure PINECONE_API_KEY is set.");
  }
  if (!geminiClient) {
    throw new Error("Missing Gemini client. Ensure GOOGLE_API_KEY is set.");
  }
}

export async function GET(request: NextRequest) {
  try {
    requireClients();
    const list = request.nextUrl.searchParams.get("list");
    const requestedIndexName = request.nextUrl.searchParams.get("indexName");

    // List available indexes
    if (list === "indexes") {
      const client = getPineconeClient();
      const indexes = normalizeIndexList(await client.listIndexes());
      return NextResponse.json({ status: "ok", indexes });
    }

    // List namespaces for a given index
    if (list === "namespaces") {
      if (!requestedIndexName) {
        return NextResponse.json(
          { status: "error", message: "indexName is required to list namespaces" },
          { status: 400 }
        );
      }
      const indexName = resolveIndexName(requestedIndexName);
      const client = getPineconeClient();
      // Do not try to create here; assume the index exists
      const stats: any = await client.index(indexName).describeIndexStats();
      const namespaces = Object.keys(stats?.namespaces ?? {});
      return NextResponse.json({ status: "ok", index: indexName, namespaces });
    }

    // Default readiness probe for a specific index
    const indexName = resolveIndexName(requestedIndexName);
    await ensureIndexReady(indexName);
    return NextResponse.json({
      status: "ok",
      index: indexName,
      dimension: EMBEDDING_DIMENSION,
      embeddingModel: EMBEDDING_MODEL,
      generationModel: GENERATION_MODEL,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error occurred.";
    return NextResponse.json(
      { status: "error", message },
      {
        status: 500,
      }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    requireClients();
    const requestedIndexName = request.nextUrl.searchParams.get("indexName");
    
    if (!requestedIndexName) {
      return NextResponse.json(
        { status: "error", message: "indexName is required to delete an index" },
        { status: 400 }
      );
    }
    
    const indexName = resolveIndexName(requestedIndexName);
    const client = getPineconeClient();
    
    console.log(`Deleting Pinecone index: ${indexName}`);
    await client.deleteIndex(indexName);
    
    // Clear from cache
    indexInitPromises.delete(indexName);
    
    return NextResponse.json({
      status: "ok",
      message: `Index "${indexName}" deleted successfully`,
      deletedIndex: indexName,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error occurred.";
    console.error('Delete index error:', error);
    return NextResponse.json(
      { status: "error", message },
      {
        status: 500,
      }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    requireClients();
    const payload = (await request.json()) as
      | RoutePayload
      | FinalIngestRequest
      | AnalyzeRequestPayload
      | OverviewRequestPayload;

    // Handle final ingestion: accept records (JSON) and optional summary
    if (isFinalIngestPayload(payload)) {
      const { indexName: requestedIndexName, videoFile, videoId, videoFilename, summary, skipEnsure } = payload;
      const indexName = resolveIndexName(requestedIndexName ?? videoFile ?? undefined);
      console.log(`[ingest_final] indexName="${indexName}", skipEnsure=${skipEnsure}`);
      if (!skipEnsure) {
        console.log(`[ingest_final] Calling ensureIndexReady for "${indexName}"`);
        await ensureIndexReady(indexName);
      } else {
        console.log(`[ingest_final] Skipping ensureIndexReady for "${indexName}"`);
      }

      // Prefer explicit frames if present; otherwise map Rust-shaped records
      const frames: IngestRequestPayload["frames"] =
        payload.frames && payload.frames.length > 0
          ? payload.frames
          : (payload.records || []).map((r) => ({
              frameId: r.frame_id as any,
              timestamp: r.timestamp,
              description: r.description,
              path: r.path,
            }));

      if (!Array.isArray(frames) || frames.length === 0) {
        return NextResponse.json(
          { status: "error", message: "No frames/records provided for final ingestion." },
          { status: 400 }
        );
      }

      const namespace = getNamespace(videoId);

      // Embed and upsert frame descriptions
      const descriptions = frames.map((f) => f.description ?? "");
      const embeddings = await embedTexts(descriptions);
      const vectors = frames.map((frame, index) => ({
        id: `${getNamespace(videoId)}::${frame.frameId}`,
        values: embeddings[index],
        metadata: {
          video_id: videoId?.toString() ?? "1",
          frame_id: frame.frameId,
          timestamp: frame.timestamp,
          description: frame.description,
          path: frame.path,
          ...(videoFilename ? { video_filename: videoFilename } : {}),
        },
      }));

      // Summary is optional; include if provided
      const extraVectors: typeof vectors = [];
      if (summary && summary.trim().length > 0) {
        const [sumVec] = await embedTexts([summary]);
        extraVectors.push({
          id: `${getNamespace(videoId)}::summary`,
          values: sumVec,
          metadata: {
            video_id: videoId?.toString() ?? "1",
            summary: true,
            text: summary,
          },
        } as any);
      }

      // Optional manifest metadata for quick overview lookups
      // Note: Pinecone metadata only supports strings, numbers, booleans, and arrays of strings
      try {
        const manifestMeta = {
          video_id: videoId?.toString() ?? "1",
          manifest: true,
          count: frames.length,
          first_timestamp: frames[0]?.timestamp ?? 0,
          last_timestamp: frames[frames.length - 1]?.timestamp ?? 0,
          ...(videoFilename ? { video_filename: videoFilename } : {}),
        } as any;
        const [manVec] = await embedTexts([`manifest video ${videoId ?? "1"}`]);
        extraVectors.push({
          id: `${getNamespace(videoId)}::manifest`,
          values: manVec,
          metadata: manifestMeta,
        } as any);
      } catch (e) {
        console.warn("Failed to add manifest vector:", e);
      }

      await getPineconeClient().index(indexName).namespace(namespace).upsert([...vectors, ...extraVectors]);

      return NextResponse.json({
        status: "ok",
        upserted: vectors.length + extraVectors.length,
        namespace,
        index: indexName,
        includedSummary: Boolean(extraVectors.length),
      });
    }

    if (isIngestPayload(payload)) {
      const { frames, videoId, indexName: requestedIndexName, skipEnsure } = payload;
      const indexName = resolveIndexName(requestedIndexName);
      if (!skipEnsure) {
        await ensureIndexReady(indexName);
      }
      if (!Array.isArray(frames) || frames.length === 0) {
        return NextResponse.json(
          { status: "error", message: "No frames provided for ingestion." },
          { status: 400 }
        );
      }

      const namespace = getNamespace(videoId);
      const descriptions = frames.map((frame) => frame.description ?? "");

      const embeddings = await embedTexts(descriptions);

      const vectors = frames.map((frame, index) => {
        const embedding = embeddings[index];
        if (!embedding) {
          throw new Error(
            `Failed to create embedding for frame ${frame.frameId}.`
          );
        }
        return {
          id: `${getNamespace(videoId)}::${frame.frameId}`,
          values: embedding,
          metadata: {
            video_id: videoId?.toString() ?? "1",
            frame_id: frame.frameId,
            timestamp: frame.timestamp,
            description: frame.description,
            path: frame.path,
          },
        };
      });

      await getPineconeClient().index(indexName).namespace(namespace).upsert(vectors);

      return NextResponse.json({
        status: "ok",
        upserted: vectors.length,
        namespace,
        index: indexName,
      });
    }

    if (isQueryPayload(payload)) {
      const { question, videoId, topK, indexName: requestedIndexName, skipEnsure } = payload;
      const indexName = resolveIndexName(requestedIndexName);
      if (!skipEnsure) {
        await ensureIndexReady(indexName);
      }
      if (!question) {
        return NextResponse.json(
          { status: "error", message: "Question is required for query." },
          { status: 400 }
        );
      }

      const namespace = getNamespace(videoId);

      const [queryVector] = await embedTexts([question]);
      if (!queryVector) {
        throw new Error("Failed to generate embedding for the query.");
      }

      const result = await getPineconeClient().index(indexName).namespace(namespace).query({
        vector: queryVector,
        topK: Math.min(topK ?? 3, 50),
        includeMetadata: true,
      });

      return NextResponse.json({
        status: "ok",
        matches: result.matches ?? [],
        index: indexName,
      });
    }

    if (isAnalyzePayload(payload)) {
      const { question, videoId, topK, indexName: requestedIndexName, skipEnsure } = payload;
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
      
      // Sort matches by timestamp to create a chronological timeline
      const sortedMatches = [...matches].sort((a, b) => {
        const tsA = (a.metadata as any)?.timestamp ?? 0;
        const tsB = (b.metadata as any)?.timestamp ?? 0;
        return tsA - tsB;
      });
      
      const context = sortedMatches
        .map((m, i) => {
          const meta: any = m.metadata ?? {};
          const ts = typeof meta.timestamp === "number" ? `${meta.timestamp.toFixed(1)}s` : String(meta.timestamp ?? "");
          return `#${i + 1} [t=${ts}] id=${meta.frame_id ?? "?"} ${meta.path ? `(${meta.path})` : ""}\n${meta.description ?? ""}`;
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

Question: ${question}

Frames (in chronological order):
${context}

Remember: Consider how the frames connect temporally to form a complete picture of the events.`;

      const model = getGenerationModel();
      const resp = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      });
      const answer = (resp as any)?.response?.text?.() ?? (resp as any)?.response?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("\n") ?? "";

      return NextResponse.json({
        status: "ok",
        answer,
        citations: (sortedMatches || []).map((m) => ({
          id: m.id,
          score: m.score,
          metadata: m.metadata,
        })),
        index: indexName,
      });
    }

    if (isOverviewPayload(payload)) {
      const { videoId, indexName: requestedIndexName, topK, skipEnsure } = payload;
      const indexName = resolveIndexName(requestedIndexName);
      if (!skipEnsure) {
        await ensureIndexReady(indexName);
      }
      const namespace = getNamespace(videoId);

      // Try fetch summary vector
      let summary: string | undefined = undefined;
      try {
        const fetchRes: any = await getPineconeClient().index(indexName).namespace(namespace).fetch([`${namespace}::summary`]);
        const rec = (fetchRes?.records ?? fetchRes?.vectors ?? fetchRes)?.[`${namespace}::summary`];
        summary = rec?.metadata?.text ?? rec?.metadata?.summary ?? undefined;
      } catch {}

      // Fallback: query a generic embedding to retrieve frames
      const [vec] = await embedTexts(["overview of this video frames"]);
      const result = await getPineconeClient().index(indexName).namespace(namespace).query({
        vector: vec,
        topK: Math.min(topK ?? 200, 1000),
        includeMetadata: true,
      });
      const frames = (result.matches ?? [])
        .map((m) => ({
          id: m.id,
          score: m.score,
          frame_id: (m.metadata as any)?.frame_id,
          timestamp: (m.metadata as any)?.timestamp,
          description: (m.metadata as any)?.description,
          path: (m.metadata as any)?.path,
        }))
        .filter((f) => typeof f.timestamp === "number")
        .sort((a, b) => (a.timestamp as number) - (b.timestamp as number));

      return NextResponse.json({ status: "ok", summary, frames, index: indexName, namespace });
    }

    return NextResponse.json(
      { status: "error", message: "Unsupported action requested." },
      { status: 400 }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error occurred.";
    return NextResponse.json(
      { status: "error", message },
      {
        status: 500,
      }
    );
  }
}
