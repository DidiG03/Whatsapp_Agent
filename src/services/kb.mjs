/**
 * Knowledge base service.
 * - Upsert items by title per user
 * - Retrieve naive keyword matches for a query
 */
import { db } from "../db-mongodb.mjs";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const shouldLogVerbose = LOG_LEVEL === "debug" || LOG_LEVEL === "trace";

/** Create or update a KB item by title for a specific user. */
export function upsertKbItem(userId, title, content, file = null) {
  const existing = db.prepare(`SELECT id FROM kb_items WHERE user_id = ? AND title = ?`).get(userId, title);
  if (existing?.id) {
    db.prepare(`UPDATE kb_items SET content = ?, file_url = COALESCE(?, file_url), file_mime = COALESCE(?, file_mime), created_at = created_at WHERE id = ?`).run(content, file?.url || null, file?.mime || null, existing.id);
    return existing.id;
  }
  const info = db.prepare(`INSERT INTO kb_items (title, content, file_url, file_mime, user_id) VALUES (?, ?, ?, ?, ?)`).run(title, content, file?.url || null, file?.mime || null, userId);
  return info.lastInsertRowid;
}

/**
 * Naive keyword retrieval for KB items. Scores documents by term presence
 * in title+content merged text and returns the top N.
 */
export function retrieveKbMatches(query, limit = 3, userId = null, onboardingTranscript = '') {
  if (shouldLogVerbose) console.log("Retrieving KB matches for user:", userId);
  // Normalize inputs: strip diacritics, collapse repeated letters, standardize slang
  const stripDiacritics = (s) => {
    try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch { return String(s || ''); }
  };
  const collapseRepeats = (s) => String(s || '').replace(/(\p{L})\1{2,}/gu, '$1$1');
  const base = [String(query || ''), String(onboardingTranscript || '')].filter(Boolean).join(' ');
  let full = collapseRepeats(stripDiacritics(base));

  // Synonym + slang expansion for better recall
  const synonymPairs = [
    [/\b(open|opening|hours|time)\b/gi, ' hours '],
    [/\b(where|location|address|located)\b/gi, ' locations '],
    [/\b(pay|payment|card|cash|visa|mastercard)\b/gi, ' payments '],
    [/\b(appointment|book|booking|reservation|reservations|walk\s?in|walk-ins)\b/gi, ' appointments reservations '],
    [/\b(deliver|delivery|ship|shipping|pickup)\b/gi, ' delivery shipping pickup '],
    // common slang/misspellings
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

  // Build token-based boolean query for FTS (more flexible than a quoted phrase)
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
    rows = userId
      ? db.prepare(`
          SELECT k.id, k.title, k.content, bm25(kb_items_fts) AS rank
          FROM kb_items_fts
          JOIN kb_items k ON k.id = kb_items_fts.rowid
          WHERE k.user_id = ? AND kb_items_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(userId, matchQuery, limit)
      : db.prepare(`
          SELECT k.id, k.title, k.content, bm25(kb_items_fts) AS rank
          FROM kb_items_fts
          JOIN kb_items k ON k.id = kb_items_fts.rowid
          WHERE kb_items_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(matchQuery, limit);
  } catch (e) {
    if (shouldLogVerbose) console.warn("FTS MATCH failed; falling back to LIKE", e?.message || e);
    try {
      // LIKE fallback using multiple token patterns for better recall
      const likeTokens = (tokens.length ? tokens : cleaned.split(' ')).filter(Boolean).slice(0, 8);
      const likes = likeTokens.map(t => `%${t.replace(/[%_]/g, '')}%`);
      const whereLike = likes.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
      const params = likes.flatMap(l => [l, l]);
      rows = userId
        ? db.prepare(`SELECT id, title, content, 0 AS rank FROM kb_items WHERE user_id = ? AND (${whereLike}) LIMIT ?`).all(userId, ...params, limit)
        : db.prepare(`SELECT id, title, content, 0 AS rank FROM kb_items WHERE ${whereLike} LIMIT ?`).all(...params, limit);
    } catch (e2) {
      console.warn("KB LIKE fallback failed", e2?.message || e2);
    }
  }

  // Attach a synthetic score: inverse of rank + token hit boosts (title > content)
  const results = rows.map(r => {
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

export function buildKbSuggestions(userId, question, max = 3) {
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

  // 1) Try semantic matches when there is a meaningful question
  const q = String(question || '').trim();
  if (q && q.length > 1 && q.toLowerCase() !== 'hello') {
    const matched = retrieveKbMatches(q, 6, userId, '');
    for(const m of matched) push(m.title || "");
  }

  // 2) Fill from user's own KB titles that are marked show_in_menu (most recent first)
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

  // 3) Fallback to sensible defaults if still short
  for(const t of defaults) { if (picks.length >= max) break; push(t) };
  
  return picks.slice(0, max);
}

