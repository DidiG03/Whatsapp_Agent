
import { db } from "../db-mongodb.mjs";
import { KBItem } from "../schemas/mongodb.mjs";
import { getUserPlan, getPlanPricing } from "../services/usage.mjs";
import { cache } from "../scalability/redis.mjs";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const shouldLogVerbose = LOG_LEVEL === "debug" || LOG_LEVEL === "trace";
export async function upsertKbItem(userId, title, content, file = null) {
  const existing = await KBItem.findOne({ user_id: userId, title }).select('_id').lean();
  if (existing?._id) {
    await KBItem.updateOne(
      { _id: existing._id },
      { $set: {
        content,
        ...(file?.url !== undefined ? { file_url: file?.url || null } : {}),
        ...(file?.mime !== undefined ? { file_mime: file?.mime || null } : {})
      } }
    );
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
  return String(doc._id);
}
export async function retrieveKbMatches(query, limit = 3, userId = null, onboardingTranscript = '') {
  if (shouldLogVerbose) console.log("Retrieving KB matches for user:", userId);
  const stripDiacritics = (s) => {
    try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch { return String(s || ''); }
  };
  const collapseRepeats = (s) => String(s || '').replace(/(\p{L})\1{2,}/gu, '$1$1');
  const base = [String(query || ''), String(onboardingTranscript || '')].filter(Boolean).join(' ');
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
    'a','an','the','and','or','but','of','for','to','in','on','at','by','with','about','from','into','over','after','before','is','are','was','were','be','can','could','should','would','do','does','did','how','what','when','where','which','who','whom','why','your','you','me','my','we','our','they','their','it','its'
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
  const safeRows = Array.isArray(rows) ? rows : [];
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
  console.log("FTS results:", results.slice(0,3));
  return results;
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

