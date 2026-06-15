
import { db } from "../db-mongodb.mjs";
import { KBItem } from "../schemas/mongodb.mjs";
import { getUserPlan, getPlanPricing } from "../services/usage.mjs";
import { cache } from "../scalability/redis.mjs";
import { expandKbSearchQuery, extractKbSearchKeywords, isGeneralBusinessOverviewQuestion, isLikelyFaqQuestion } from "./i18n.mjs";
import { isKbHybridSearchEnabled, queueKbEmbedding } from "./kbEmbeddings.mjs";
import { mergeHybridKbResults, retrieveKbVectorMatches } from "./kbHybridSearch.mjs";

const FAQ_FAST_PATH_MIN_SCORE = 45;
const FAQ_HIGH_SCORE = 75;
const FAQ_TITLE_KEYWORD_MIN_LEN = 3;
const FAQ_SECOND_BEST_MARGIN = 1.4;

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const shouldLogVerbose = LOG_LEVEL === "debug" || LOG_LEVEL === "trace";
const KB_SQ_FULL_CONTEXT_MAX = Number(process.env.KB_SQ_FULL_CONTEXT_MAX || 25);
export async function upsertKbItem(userId, title, content, file = null) {
  const existing = await KBItem.findOne({ user_id: userId, title }).select('_id').lean();
  if (existing?._id) {
    await KBItem.updateOne(
      { _id: existing._id },
      { $set: {
        content,
        ...(file?.url !== undefined ? { file_url: file?.url || null } : {}),
        ...(file?.mime !== undefined ? { file_mime: file?.mime || null } : {}),
        embedding: null,
        embedding_model: null,
        embedding_updated_at: null,
      } }
    );
    queueKbEmbedding(existing._id);
    return String(existing._id);
  }
  try {
    const plan = await getUserPlan(userId);
    const pricing = getPlanPricing();
    const cfg = pricing[plan?.plan_name || 'free'] || pricing.free;
    const stats = await KBItem.aggregate([
      { $match: { user_id: userId } },
      { $group: { _id: null, c: { $sum: 1 }, t: { $sum: { $strLenCP: { $ifNull: [ '$content', '' ] } } } } }
    ]);
    const c = stats?.[0]?.c || 0;
    const t = stats?.[0]?.t || 0;
    if ((cfg.kb_docs_limit && c >= cfg.kb_docs_limit) || (cfg.kb_chars_limit && (t + String(content||'').length) > cfg.kb_chars_limit)) {
      return null;
    }
  } catch {}
  const doc = await KBItem.create({
    title,
    content,
    file_url: file?.url || null,
    file_mime: file?.mime || null,
    user_id: userId
  });
  queueKbEmbedding(doc._id);
  return String(doc._id);
}
const ALBANIAN_STOPWORDS = new Set([
  "kur", "jeni", "jemi", "une", "ti", "ju", "ne", "eshte", "jam", "je",
  "me", "te", "per", "nje", "dhe", "apo", "cfare", "cila", "cili", "si",
  "po", "jo", "nga", "sa", "qe", "ka", "ke", "kam", "dua", "mund",
]);

const ALBANIAN_TITLE_HINTS = [
  { re: /\b(hapur|orar|orari|oraret|punon|pune)\b/i, titles: ["Hours", "Opening", "Schedule", "Business Hours"] },
  { re: /\b(adres|vendndodhje|ku\s+jeni)\b/i, titles: ["Location", "Address", "Locations", "Contact"] },
  { re: /\b(cmim|kushton|pagesa)\b/i, titles: ["Pricing", "Payments", "Price"] },
  { re: /\b(rezerv|termin|takim)\b/i, titles: ["Booking", "Appointments", "Reservations"] },
  { re: /\b(menu|ushqim)\b/i, titles: ["Menu", "Food"] },
  { re: /\b(kontakt|telefon)\b/i, titles: ["Contact"] },
  { re: /\b(emrin|emri|quhet|me\s+ke\s+po\s+flas|kush\s+je|restorant)\b/i, titles: ["Business Name", "What We Do"] },
  { re: /\b(wifi|wi\s*fi|internet)\b/i, titles: ["wi fi", "wifi", "internet"] },
  { re: /\b(karta|krediti|kart|pagesa|pranoni|pranoj)\b/i, titles: ["credit card", "payment", "accept"] },
  { re: /\b(dorezim|delivery)\b/i, titles: ["delivery"] },
  { re: /\b(anglisht|anglis|english)\b/i, titles: ["english menu", "menu"] },
  { re: /\b(diel|sunday)\b/i, titles: ["sunday", "open", "hours"] },
  { re: /\b(cfare\s+(?:mund|me)\s+(?:te\s+)?(?:thuash|tregosh|tregon)|dua\s+te\s+di\s+me\s+shum|me\s+shum\s+rreth|tell me about|what can you tell me|learn more|who are you|what do you do)\b/i, titles: ["About Us", "Google Business Profile", "What We Do", "Hours", "Location", "Contact"] },
];

function stripDiacriticsKb(s) {
  try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch { return String(s || ''); }
}

function normalizeHaystack(text) {
  return stripDiacriticsKb(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
}

function scoreKbItem(item, keywords) {
  const title = normalizeHaystack(item.title);
  const content = normalizeHaystack(item.content);
  const hay = `${title} ${content}`;
  let score = 0;
  for (const kw of keywords) {
    if (!kw || kw.length < 2) continue;
    if (title.includes(kw)) score += kw.length * 5;
    else if (content.includes(kw)) score += kw.length * 2;
  }
  if (/\b(wifi|wi|fi|internet)\b/.test(keywords.join(' '))) {
    if (hay.includes('wi fi') || hay.includes('wifi') || hay.includes('internet')) score += 40;
  }
  if (/\b(credit|card|payment|pay)\b/.test(keywords.join(' '))) {
    if (hay.includes('credit') || hay.includes('payment') || hay.includes('card')) score += 35;
  }
  if (/\b(delivery|deliver)\b/.test(keywords.join(' ')) && hay.includes('deliver')) score += 30;
  return score;
}

function mergeKbResults(primary, secondary, limit) {
  const seen = new Set();
  const out = [];
  for (const item of [...primary, ...secondary]) {
    const key = String(item?.id || item?.title || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

async function retrieveKbByScoring(query, limit, userId, lang) {
  const keywords = extractKbSearchKeywords(query, lang);
  const rows = await KBItem.find({ user_id: String(userId) })
    .select('title content')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  const total = rows.length;
  if (!total) return [];

  const scored = rows.map((r, idx) => ({
    id: String(r._id),
    title: r.title,
    content: r.content,
    score: scoreKbItem(r, keywords) + Math.max(0, 5 - idx),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Small KB: pass the whole FAQ set so the AI can match Albanian → English by meaning.
  if (lang === 'sq' && total <= KB_SQ_FULL_CONTEXT_MAX) {
    return scored.map((item, i) => ({ ...item, score: Math.max(item.score, 120 - i) }));
  }

  const withHits = scored.filter((x) => x.score > 0);
  return (withHits.length ? withHits : scored.slice(0, 3)).slice(0, limit);
}

function countTitleKeywordHits(item, keywords) {
  const title = normalizeHaystack(item.title);
  const hay = `${title} ${normalizeHaystack(item.content)}`;
  let hits = 0;
  for (const kw of keywords) {
    if (!kw || kw.length < FAQ_TITLE_KEYWORD_MIN_LEN) continue;
    if (title.includes(kw)) hits++;
  }
  const keywordBlob = [...keywords].join(" ");
  if (/\b(wifi|wi|fi|internet)\b/.test(keywordBlob) && (/\bwi fi\b/.test(hay) || hay.includes("wifi") || hay.includes("internet"))) {
    hits++;
  }
  if (/\b(credit|card|payment|pay)\b/.test(keywordBlob) && (hay.includes("credit") || hay.includes("payment") || hay.includes("card"))) {
    hits++;
  }
  return hits;
}

function scoreKbMatches(query, matches, lang) {
  if (!Array.isArray(matches) || !matches.length) return [];
  const keywords = extractKbSearchKeywords(query, lang);
  const scored = [];
  for (const m of matches) {
    if (!m?.title || m.title === "Business Settings") continue;
    scored.push({ ...m, topicScore: scoreKbItem(m, keywords) });
  }
  scored.sort((a, b) => b.topicScore - a.topicScore);
  return scored;
}

/** Confidence-gated FAQ match — avoids fast-path on ambiguous/content-only hits. */
export function assessPrimaryKbConfidence(query, matches, lang) {
  const empty = {
    match: null,
    topicScore: 0,
    confidence: 0,
    useFastPath: false,
    reason: "no_match",
    titleHits: 0,
    secondScore: 0,
  };

  if (isGeneralBusinessOverviewQuestion(query)) {
    return { ...empty, reason: "overview_question" };
  }
  if (!isLikelyFaqQuestion(query)) {
    return { ...empty, reason: "not_faq_question" };
  }

  const scored = scoreKbMatches(query, matches, lang);
  const best = scored[0];
  if (!best || best.topicScore < FAQ_FAST_PATH_MIN_SCORE) {
    return {
      ...empty,
      topicScore: best?.topicScore || 0,
      reason: best ? "score_below_threshold" : "no_scored_match",
    };
  }

  const second = scored[1];
  const titleHits = countTitleKeywordHits(best, extractKbSearchKeywords(query, lang));
  const marginOk = !second || best.topicScore >= second.topicScore * FAQ_SECOND_BEST_MARGIN;
  const titleRelevant = titleHits >= 1;
  const highScore = best.topicScore >= FAQ_HIGH_SCORE;
  const confidence = Math.min(0.99, Math.max(0.4, best.topicScore / 100));

  let useFastPath = false;
  let reason = "ambiguous_match";

  if (marginOk && titleRelevant) {
    useFastPath = true;
    reason = "title_match";
  } else if (marginOk && highScore) {
    useFastPath = true;
    reason = "high_score";
  }

  return {
    match: best,
    topicScore: best.topicScore,
    confidence: useFastPath ? Math.max(confidence, reason === "high_score" ? 0.85 : 0.75) : confidence,
    useFastPath,
    reason,
    titleHits,
    secondScore: second?.topicScore || 0,
  };
}

/** Best FAQ doc for this question (ignores Business Settings snippets). */
export function pickPrimaryKbMatch(query, matches, lang) {
  const assessment = assessPrimaryKbConfidence(query, matches, lang);
  return assessment.match && assessment.topicScore >= 35 ? assessment.match : null;
}

export async function retrieveKbMatches(query, limit = 3, userId = null, onboardingTranscript = '', lang = null) {
  if (shouldLogVerbose) console.log("Retrieving KB matches for user:", userId);
  const stripDiacritics = stripDiacriticsKb;
  const collapseRepeats = (s) => String(s || '').replace(/(\p{L})\1{2,}/gu, '$1$1');
  const expandedQuery = expandKbSearchQuery(query, lang);
  const base = [expandedQuery, String(onboardingTranscript || '')].filter(Boolean).join(' ');
  let full = collapseRepeats(stripDiacritics(base));
  const synonymPairs = [
    [/\b(open|opening|hours|time)\b/gi, ' hours '],
    [/\b(where|location|address|located)\b/gi, ' locations '],
    [/\b(pay|payment|card|cash|visa|mastercard)\b/gi, ' payments '],
    [/\b(appointment|book|booking|reservation|reservations|walk\s?in|walk-ins)\b/gi, ' appointments reservations '],
    [/\b(deliver|delivery|ship|shipping|pickup)\b/gi, ' delivery shipping pickup '],
    [/\bhrs\b/gi, ' hours '],
    [/\baddr\b/gi, ' address '],
    [/\binfo\b/gi, ' information '],
    [/\bpls|plz|plss+\b/gi, ' please '],
    [/\bu\b/gi, ' you '],
    [/\bur\b/gi, ' your '],
    [/\br\b/gi, ' are '],
    [/\bopenn?\b/gi, ' open '],
    [/\bclose?d?\b/gi, ' closed '],
    [/\btmrw|tmrw|tomoz\b/gi, ' tomorrow '],
  ];
  let expanded = ` ${full} `;
  for (const [re, rep] of synonymPairs) expanded = expanded.replace(re, ` ${rep} `);
  const cleaned = expanded
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stopwords = new Set([
    'a','an','the','and','or','but','of','for','to','in','on','at','by','with','about','from','into','over','after','before','is','are','was','were','be','can','could','should','would','do','does','did','how','what','when','where','which','who','whom','why','your','you','me','my','we','our','they','their','it','its',
    ...(lang === 'sq' ? ALBANIAN_STOPWORDS : []),
  ]);
  const tokens = Array.from(new Set(cleaned.split(' ')))
    .filter(t => t && t.length >= 3 && !stopwords.has(t))
    .slice(0, 16);
  const booleanQuery = tokens.length ? `(${tokens.join(' OR ')})` : '';
  const matchQuery = booleanQuery || `"${expanded.replace(/"/g, '""').trim()}"`;
  let rows = [];
  try {
    const uidStr = userId != null ? String(userId) : null;
    const uidNum = userId != null && !Number.isNaN(Number(userId)) ? Number(userId) : null;
    const hasBoth = uidStr != null && uidNum != null && String(uidNum) !== uidStr;
    const whereUser = userId
      ? (hasBoth ? '(k.user_id = ? OR k.user_id = ?)' : 'k.user_id = ?')
      : '1=1';
    const params = [];
    if (userId) {
      if (hasBoth) { params.push(uidStr, uidNum); } else { params.push(uidStr); }
    }
    params.push(matchQuery, limit);
    rows = await db.prepare(`
          SELECT k.id AS id, k.title AS title, k.content AS content, 0 AS rank
          FROM kb_items_fts fts
          JOIN kb_items k ON k.id = fts.rowid
          WHERE ${whereUser} AND fts MATCH ?
          LIMIT ?
        `).all(...params);
  } catch (e) {
    if (shouldLogVerbose) console.warn("FTS MATCH failed; falling back to LIKE", e?.message || e);
    try {
      const likeTokens = (tokens.length ? tokens : cleaned.split(' ')).filter(Boolean).slice(0, 8);
      const likes = likeTokens.map(t => `%${t.replace(/[%_]/g, '')}%`);
      const whereLike = likes.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
      const params = likes.flatMap(l => [l, l]);
      if (userId) {
        const uidStr = String(userId);
        const uidNum = !Number.isNaN(Number(userId)) ? Number(userId) : null;
        if (uidNum != null && String(uidNum) !== uidStr) {
          rows = await db.prepare(`SELECT id, title, content, 0 AS rank FROM kb_items WHERE (user_id = ? OR user_id = ?) AND (${whereLike}) LIMIT ?`).all(uidStr, uidNum, ...params, limit);
        } else {
          rows = await db.prepare(`SELECT id, title, content, 0 AS rank FROM kb_items WHERE user_id = ? AND (${whereLike}) LIMIT ?`).all(uidStr, ...params, limit);
        }
      } else {
        rows = await db.prepare(`SELECT id, title, content, 0 AS rank FROM kb_items WHERE ${whereLike} LIMIT ?`).all(...params, limit);
      }
    } catch (e2) {
      console.warn("KB LIKE fallback failed", e2?.message || e2);
    }
  }
  let safeRows = Array.isArray(rows) ? rows : [];

  // Albanian queries often miss English KB docs on the first pass; match by
  // common English doc titles when we can infer the topic from Albanian phrasing.
  if (!safeRows.length && lang === 'sq' && userId) {
    try {
      const qNorm = stripDiacritics(String(query || '')).toLowerCase();
      const titleHints = new Set();
      for (const { re, titles } of ALBANIAN_TITLE_HINTS) {
        if (re.test(qNorm)) for (const t of titles) titleHints.add(t);
      }
      if (titleHints.size) {
        const uidStr = String(userId);
        const or = [...titleHints].map(t => ({
          title: { $regex: t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' },
        }));
        const hinted = await KBItem.find({ user_id: uidStr, $or: or })
          .select('title content')
          .limit(limit)
          .lean();
        safeRows = (hinted || []).map(r => ({
          id: String(r._id),
          title: r.title,
          content: r.content,
          rank: 0,
        }));
      }
    } catch (e) {
      if (shouldLogVerbose) console.warn("KB Albanian title fallback failed", e?.message || e);
    }
  }

  const results = safeRows.map(r => {
    const base = Math.max(1, 1000 - Math.floor(r.rank || 0));
    let hitsTitle = 0, hitsContent = 0;
    try {
      const t = String(r.title || '').toLowerCase();
      const c = String(r.content || '').toLowerCase();
      for (const tok of tokens) {
        if (!tok) continue;
        if (t.includes(tok)) hitsTitle++;
        if (c.includes(tok)) hitsContent++;
      }
    } catch {}
    const boost = hitsTitle * 50 + hitsContent * 10;
    return { id: r.id, title: r.title, content: r.content, score: base + boost };
  });

  let merged = results;
  if (lang === 'sq' && userId) {
    try {
      const scoredLimit = Math.max(limit, 12);
      const scored = await retrieveKbByScoring(query, scoredLimit, userId, lang);
      merged = mergeKbResults(results, scored, scored.length <= KB_SQ_FULL_CONTEXT_MAX ? scored.length : limit);
    } catch (e) {
      if (shouldLogVerbose) console.warn("KB Albanian scoring merge failed", e?.message || e);
    }
  }

  if (isKbHybridSearchEnabled() && userId) {
    try {
      const hybridLimit = Math.max(limit, 12);
      const vectorHits = await retrieveKbVectorMatches(query, userId, hybridLimit, lang);
      merged = mergeHybridKbResults(merged, vectorHits, query, lang, limit);
      if (shouldLogVerbose) {
        console.log("Hybrid KB results:", merged.slice(0, 3).map((item) => ({
          title: item.title,
          score: item.score,
          vectorScore: item.vectorScore,
          keywordScore: item.keywordScore,
        })));
      }
    } catch (e) {
      console.warn("KB hybrid search failed; using keyword results", e?.message || e);
      merged = merged.slice(0, limit);
    }
  } else {
    merged = merged.slice(0, limit);
  }

  if (!isKbHybridSearchEnabled() || !userId) {
    console.log("FTS results:", merged.slice(0, 3));
  }
  return merged;
}

export async function buildKbSuggestions(userId, question, max = 3) {
  const key = userId ? `kb:suggest:${userId}:${Buffer.from(String(question||'').slice(0,80)).toString('base64')}:${max}` : null;
  if (key) {
    try {
      const cached = await cache.get(key);
      if (cached) return cached;
    } catch {}
  }
  const defaults = [
    "Business Name", "What We Do", "Audience", "Hours", "Locations",
    "Products", "Services", "Service Areas", "Appointments", "Booking",
    "Pricing", "Payments", "Delivery", "Shipping", "Returns", "Warranty",
    "Menu", "Reservations", "Pickup", "Dietary Notes", "Insurance",
    "Emergency Policy", "New Patient Intake", "Exchanges", "Contact",
    "Social Links", "Top FAQs"
  ];
  const picks = [];
  const seen = new Set();

  const push = (t) => {
    if(t && !seen.has(t)) {
      seen.add(t);
      picks.push({id: `KB_TITLE_${t}`, title: t});
    }
  }
  const q = String(question || '').trim();
  if (q && q.length > 1 && q.toLowerCase() !== 'hello') {
    const matched = await retrieveKbMatches(q, 6, userId, '');
    for (const m of matched) push(m.title || "");
  }
  try {
    if (picks.length < max && userId) {
      const rows = db.prepare(`
        SELECT title FROM kb_items
        WHERE user_id = ? AND COALESCE(show_in_menu,0) = 1 AND title IS NOT NULL AND TRIM(title) <> ''
        ORDER BY created_at DESC, id DESC
        LIMIT 20
      `).all(userId);
      for (const r of rows) { if (picks.length >= max) break; push(r.title || ""); }
    }
  } catch (e) { if (shouldLogVerbose) console.warn("KB title fill failed", e?.message || e); }
  for(const t of defaults) { if (picks.length >= max) break; push(t) };
  
  const out = picks.slice(0, max);
  if (key) { try { await cache.set(key, out, 120); } catch {} }
  return out;
}

