import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { db } from "../db.mjs";

export default function registerKbRoutes(app) {
  app.post("/kb", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const { title, content } = req.body || {};
    if (!content || typeof content !== "string") return res.status(400).json({ error: "content required" });
    const stmt = db.prepare(`INSERT INTO kb_items (title, content, user_id) VALUES (?, ?, ?)`);
    const info = stmt.run(title || null, content, userId);
    return res.json({ id: info.lastInsertRowid, title, content, user_id: userId });
  });

  app.get("/kb", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const rows = db.prepare(`
      SELECT id, title, content, created_at FROM kb_items
      WHERE user_id = ?
      ORDER BY id DESC LIMIT 200
    `).all(userId);
    return res.json(rows);
  });
}

