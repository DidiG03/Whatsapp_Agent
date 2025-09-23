/**
 * Knowledge base service.
 * - Upsert items by title per user
 * - Retrieve naive keyword matches for a query
 */
import { db } from "../db.mjs";

/** Create or update a KB item by title for a specific user. */
export function upsertKbItem(userId, title, content) {
  const existing = db.prepare(`SELECT id FROM kb_items WHERE user_id = ? AND title = ?`).get(userId, title);
  if (existing?.id) {
    db.prepare(`UPDATE kb_items SET content = ?, created_at = created_at WHERE id = ?`).run(content, existing.id);
    return existing.id;
  }
  const info = db.prepare(`INSERT INTO kb_items (title, content, user_id) VALUES (?, ?, ?)`).run(title, content, userId);
  return info.lastInsertRowid;
}

/**
 * Naive keyword retrieval for KB items. Scores documents by term presence
 * in title+content merged text and returns the top N.
 */
export function retrieveKbMatches(query, limit = 3, userId = null, onboardingTranscript = '') {
  console.log("Retrieving KB matches for user:", userId);
  const all = userId
    ? db.prepare(`SELECT id, title, content FROM kb_items WHERE user_id = ? ORDER BY id DESC`).all(userId)
    : db.prepare(`SELECT id, title, content FROM kb_items ORDER BY id DESC`).all();
  const q = (query || "").toLowerCase();
  const ob = (onboardingTranscript || '').toLowerCase();
  const terms = (q + ' ' + ob).split(/[^a-z0-9]+/).filter(Boolean);
  // Intent synonyms for better recall
  const intentMap = [
    { intent: 'hours', keys: ['open', 'opening', 'hours', 'when do you open', 'time'] },
    { intent: 'locations', keys: ['where', 'location', 'address', 'located'] },
    { intent: 'payments', keys: ['pay', 'payment', 'card', 'cash', 'visa', 'mastercard'] },
    { intent: 'appointments', keys: ['appointment', 'book', 'booking', 'reservations', 'walk in'] },
    { intent: 'delivery', keys: ['deliver', 'delivery', 'ship', 'shipping', 'pickup'] },
  ];
  const extra = new Set();
  for (const m of intentMap) {
    if (m.keys.some(k => q.includes(k))) extra.add(m.intent);
  }
  console.log("KB terms:", terms);
  console.log("KB all:", all);
  const scored = all.map((row) => {
    const text = `${row.title || ""} ${row.content}`.toLowerCase();
    let score = terms.reduce((acc, t) => acc + (text.includes(t) ? 1 : 0), 0);
    for (const x of extra) { if (text.includes(x)) score += 2; }
    return { ...row, score };
  });
  
  console.log("KB total rows:", all.length);
  console.log("Top 3 scored:", [...scored].sort((a,b)=>b.score-a.score).slice(0,3));
  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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

  const matched = retrieveKbMatches(question, 6, userId, '');
  for(const m of matched) push(m.title || "");
  for(const t of defaults) {if (picks.length >= max) break; push(t)};
  
  return picks.slice(0, max);
}

