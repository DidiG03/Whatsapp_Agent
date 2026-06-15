import OpenAI from "openai";
import { KBItem } from "../schemas/mongodb.mjs";

const MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const pendingEmbeds = new Set();
let openaiClient = null;

function getOpenAIClient() {
  if (!openaiClient && String(process.env.OPENAI_API_KEY || "").trim()) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

export function isKbHybridSearchEnabled() {
  if (process.env.KB_HYBRID_SEARCH === "0") return false;
  return !!String(process.env.OPENAI_API_KEY || "").trim();
}

export function buildKbEmbeddingInput(title, content) {
  const t = String(title || "").trim();
  const c = String(content || "").trim().slice(0, 8000);
  if (!t) return c;
  return `Question: ${t}\nAnswer: ${c}`;
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function createEmbedding(text) {
  if (!isKbHybridSearchEnabled()) return null;
  const input = String(text || "").trim().slice(0, 8000);
  if (!input) return null;
  try {
    const client = getOpenAIClient();
    if (!client) return null;
    const resp = await client.embeddings.create({ model: MODEL, input });
    return resp.data?.[0]?.embedding || null;
  } catch (e) {
    console.warn("[KB embed] createEmbedding failed:", e?.message || e);
    return null;
  }
}

export async function embedKbDocument(item) {
  if (!item?._id) return null;
  const embedding = await createEmbedding(buildKbEmbeddingInput(item.title, item.content));
  if (!embedding) return null;
  await KBItem.updateOne(
    { _id: item._id },
    { $set: { embedding, embedding_model: MODEL, embedding_updated_at: new Date() } }
  );
  return embedding;
}

export async function ensureKbEmbeddings(items, maxBackfill = 5) {
  if (!isKbHybridSearchEnabled() || !Array.isArray(items) || !items.length) return items;
  const limit = Math.max(1, Number(process.env.KB_EMBED_MAX_BACKFILL || maxBackfill));
  const missing = items.filter((item) => !Array.isArray(item.embedding) || !item.embedding.length).slice(0, limit);
  if (!missing.length) return items;

  await Promise.all(missing.map(async (item) => {
    try {
      const embedding = await embedKbDocument(item);
      if (embedding) item.embedding = embedding;
    } catch (e) {
      console.warn("[KB embed] backfill failed:", e?.message || e);
    }
  }));
  return items;
}

export function queueKbEmbedding(itemId) {
  if (!isKbHybridSearchEnabled() || !itemId) return;
  const key = String(itemId);
  if (pendingEmbeds.has(key)) return;
  pendingEmbeds.add(key);
  setImmediate(async () => {
    try {
      const item = await KBItem.findById(key).select("title content").lean();
      if (item) await embedKbDocument(item);
    } catch (e) {
      console.warn("[KB embed queue] failed:", e?.message || e);
    } finally {
      pendingEmbeds.delete(key);
    }
  });
}

/** Backfill missing embeddings for an existing tenant KB (e.g. after enabling hybrid search). */
export async function backfillKbEmbeddingsForUser(userId, limit = 50) {
  if (!isKbHybridSearchEnabled() || !userId) return 0;
  const rows = await KBItem.find({
    user_id: String(userId),
    $or: [{ embedding: { $exists: false } }, { embedding: null }, { embedding: { $size: 0 } }],
  })
    .select("title content")
    .limit(Math.max(1, limit))
    .lean();
  let count = 0;
  for (const row of rows) {
    try {
      const embedding = await embedKbDocument(row);
      if (embedding) count += 1;
    } catch (e) {
      console.warn("[KB embed backfill] failed:", e?.message || e);
    }
  }
  return count;
}

export default {
  isKbHybridSearchEnabled,
  buildKbEmbeddingInput,
  cosineSimilarity,
  createEmbedding,
  embedKbDocument,
  ensureKbEmbeddings,
  queueKbEmbedding,
};
