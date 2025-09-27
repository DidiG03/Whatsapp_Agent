/**
 * Knowledge base service.
 * - Upsert items by title per user
 * - Retrieve naive keyword matches for a query
 */
import { db } from "../db.mjs";

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
  console.log("Retrieving KB matches for user:", userId);
  const q = String(query || '').trim();
  const ob = String(onboardingTranscript || '').trim();
  const full = [q, ob].filter(Boolean).join(' ');

  // Synonym expansion for better recall
  const synonymPairs = [
    [/\b(open|opening|hours|time)\b/gi, ' hours '],
    [/\b(where|location|address|located)\b/gi, ' locations '],
    [/\b(pay|payment|card|cash|visa|mastercard)\b/gi, ' payments '],
    [/\b(appointment|book|booking|reservation|reservations|walk\s?in|walk-ins)\b/gi, ' appointments reservations '],
    [/\b(deliver|delivery|ship|shipping|pickup)\b/gi, ' delivery shipping pickup '],
  ];
  let expanded = ` ${full} `;
  for (const [re, rep] of synonymPairs) expanded = expanded.replace(re, ` ${rep} `);

  // FTS5 query. Use bm25() ranking; restrict to this user via join.
  // Wrap the query in quotes to avoid FTS syntax errors on symbols like () or :
  const matchQuery = `"${expanded.replace(/"/g, '""').trim()}"`;
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
    // Fallback to LIKE if FTS MATCH fails
    try {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      rows = userId
        ? db.prepare(`SELECT id, title, content, 0 AS rank FROM kb_items WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) LIMIT ?`).all(userId, like, like, limit)
        : db.prepare(`SELECT id, title, content, 0 AS rank FROM kb_items WHERE title LIKE ? OR content LIKE ? LIMIT ?`).all(like, like, limit);
    } catch {}
  }

  // Attach a synthetic score (inverse of rank) for compatibility with callers
  const results = rows.map(r => ({ id: r.id, title: r.title, content: r.content, score: Math.max(1, 1000 - Math.floor(r.rank || 0)) }));
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

  // 2) Fill from user's own KB titles (most recent first)
  try {
    if (picks.length < max && userId) {
      const rows = db.prepare(`
        SELECT title FROM kb_items
        WHERE user_id = ? AND title IS NOT NULL AND TRIM(title) <> ''
        ORDER BY created_at DESC, id DESC
        LIMIT 20
      `).all(userId);
      for (const r of rows) { if (picks.length >= max) break; push(r.title || ""); }
    }
  } catch {}

  // 3) Fallback to sensible defaults if still short
  for(const t of defaults) { if (picks.length >= max) break; push(t) };
  
  return picks.slice(0, max);
}

