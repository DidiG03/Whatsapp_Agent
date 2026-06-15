import { KBItem } from "../schemas/mongodb.mjs";
import { extractKbSearchKeywords } from "./i18n.mjs";
import {
  buildKbEmbeddingInput,
  cosineSimilarity,
  createEmbedding,
  ensureKbEmbeddings,
  isKbHybridSearchEnabled,
} from "./kbEmbeddings.mjs";

const KEYWORD_WEIGHT = Number(process.env.KB_HYBRID_KEYWORD_WEIGHT || 0.45);
const VECTOR_WEIGHT = Number(process.env.KB_HYBRID_VECTOR_WEIGHT || 0.55);
const TOPIC_WEIGHT = Number(process.env.KB_HYBRID_TOPIC_WEIGHT || 0.15);
const VECTOR_MIN_SIM = Number(process.env.KB_VECTOR_MIN_SIM || 0.18);

function normalizeKeywordScore(score, maxScore) {
  if (!maxScore) return 0;
  return Math.max(0, Math.min(1, Number(score || 0) / maxScore));
}

export function topicScoreForItem(item, keywords) {
  const title = String(item.title || "").toLowerCase();
  const content = String(item.content || "").toLowerCase();
  const hay = `${title} ${content}`;
  let score = 0;
  for (const kw of keywords) {
    if (!kw || kw.length < 2) continue;
    if (title.includes(kw)) score += kw.length * 5;
    else if (content.includes(kw)) score += kw.length * 2;
  }
  if (/\b(wifi|wi|fi|internet)\b/.test(keywords.join(" "))) {
    if (hay.includes("wi fi") || hay.includes("wifi") || hay.includes("internet")) score += 40;
  }
  if (/\b(credit|card|payment|pay)\b/.test(keywords.join(" "))) {
    if (hay.includes("credit") || hay.includes("payment") || hay.includes("card")) score += 35;
  }
  if (/\b(delivery|deliver)\b/.test(keywords.join(" ")) && hay.includes("deliver")) score += 30;
  return score;
}

export function mergeHybridKbResults(keywordHits, vectorHits, query, lang, limit = 3) {
  const keywords = extractKbSearchKeywords(query, lang);
  const byId = new Map();
  const maxKeyword = Math.max(1, ...(keywordHits || []).map((item) => Number(item.score || 0)));

  for (const item of keywordHits || []) {
    const id = String(item.id || item.title || "");
    if (!id) continue;
    byId.set(id, {
      id: item.id,
      title: item.title,
      content: item.content,
      keywordScore: normalizeKeywordScore(item.score, maxKeyword),
      vectorScore: 0,
    });
  }

  for (const item of vectorHits || []) {
    const id = String(item.id || item.title || "");
    if (!id) continue;
    const existing = byId.get(id) || {
      id: item.id,
      title: item.title,
      content: item.content,
      keywordScore: 0,
      vectorScore: 0,
    };
    existing.vectorScore = Math.max(existing.vectorScore, Number(item.vectorScore || item.score || 0));
    byId.set(id, existing);
  }

  const merged = [...byId.values()].map((item) => {
    const topicNorm = Math.min(1, topicScoreForItem(item, keywords) / 100);
    const hybridScore =
      KEYWORD_WEIGHT * item.keywordScore
      + VECTOR_WEIGHT * item.vectorScore
      + TOPIC_WEIGHT * topicNorm;
    return {
      id: item.id,
      title: item.title,
      content: item.content,
      score: Math.round(hybridScore * 1000),
      hybridScore,
      keywordScore: item.keywordScore,
      vectorScore: item.vectorScore,
    };
  });

  merged.sort((a, b) => b.hybridScore - a.hybridScore || b.score - a.score);
  return merged.slice(0, limit);
}

export async function retrieveKbVectorMatches(query, userId, limit = 8, lang = "en") {
  if (!isKbHybridSearchEnabled() || !userId) return [];

  const expandedQuery = extractKbSearchKeywords(query, lang).slice(0, 12).join(" ") || String(query || "");
  const queryEmbedding = await createEmbedding(buildKbEmbeddingInput("", expandedQuery));
  if (!queryEmbedding) return [];

  let rows = await KBItem.find({ user_id: String(userId) })
    .select("title content embedding embedding_model")
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();
  if (!rows.length) return [];

  rows = await ensureKbEmbeddings(rows);

  const scored = rows
    .map((row) => {
      const vectorScore = cosineSimilarity(queryEmbedding, row.embedding || []);
      return {
        id: String(row._id),
        title: row.title,
        content: row.content,
        vectorScore,
        score: vectorScore,
      };
    })
    .filter((item) => item.vectorScore >= VECTOR_MIN_SIM);

  scored.sort((a, b) => b.vectorScore - a.vectorScore);
  return scored.slice(0, limit);
}

export default {
  mergeHybridKbResults,
  retrieveKbVectorMatches,
  topicScoreForItem,
};