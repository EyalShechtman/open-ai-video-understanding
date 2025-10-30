import { NextRequest, NextResponse } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Keep constants aligned with RAG route
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSION = 768;
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
    });
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
    const context = matches
      .map((m, i) => {
        const meta: any = m.metadata ?? {};
        const ts = typeof meta.timestamp === "number" ? `${meta.timestamp.toFixed(1)}s` : String(meta.timestamp ?? "");
        return `#${i + 1} [t=${ts}] id=${meta.frame_id ?? "?"} ${meta.path ? `(${meta.path})` : ""}\n${meta.description ?? ""}`;
      })
      .join("\n\n");

    const prompt = `You are a helpful assistant. Answer the user question using ONLY the provided frames context. Cite 2-3 most relevant frames by frame_id and timestamp in square brackets at the end. If the answer is unknown or unclear, say you cannot determine from the frames.\n\nQuestion: ${question}\n\nFrames Context:\n${context}`;

    const model = getGenerationModel();
    const resp = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
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
      citations: (matches || []).map((m) => ({ id: m.id, score: m.score, metadata: m.metadata })),
      index: indexName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error occurred.";
    return NextResponse.json({ status: "error", message }, { status: 500 });
  }
}

