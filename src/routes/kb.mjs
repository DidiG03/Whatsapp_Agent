import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { db } from "../db.mjs";
import { renderSidebar, escapeHtml } from "../utils.mjs";

export default function registerKbRoutes(app) {
  app.post("/kb", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const { title, content, file_url, file_mime } = req.body || {};
    if (!content || typeof content !== "string") return res.status(400).json({ error: "content required" });
    const stmt = db.prepare(`INSERT INTO kb_items (title, content, file_url, file_mime, user_id) VALUES (?, ?, ?, ?, ?)`);
    const info = stmt.run(title || null, content, file_url || null, file_mime || null, userId);
    return res.json({ id: info.lastInsertRowid, title, content, file_url, file_mime, user_id: userId });
  });

  // Update an existing KB item (title and/or content)
  app.put("/kb/:id", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid id" });
    const { title, content, file_url, file_mime } = req.body || {};
    if (title == null && content == null && file_url == null && file_mime == null) return res.status(400).json({ error: "nothing to update" });
    const existing = db.prepare(`SELECT id, title, content, file_url, file_mime FROM kb_items WHERE id = ? AND user_id = ?`).get(id, userId);
    if (!existing) return res.status(404).json({ error: "not found" });
    const newTitle = title !== undefined ? (title || null) : existing.title;
    const newContent = content !== undefined ? content : existing.content;
    const newFileUrl = file_url !== undefined ? (file_url || null) : existing.file_url;
    const newFileMime = file_mime !== undefined ? (file_mime || null) : existing.file_mime;
    try {
      db.prepare(`UPDATE kb_items SET title = ?, content = ?, file_url = ?, file_mime = ?, created_at = created_at WHERE id = ? AND user_id = ?`).run(newTitle, newContent, newFileUrl, newFileMime, id, userId);
      const row = db.prepare(`SELECT id, title, content, file_url, file_mime, created_at FROM kb_items WHERE id = ?`).get(id);
      return res.json(row);
    } catch (e) {
      // Likely uniqueness violation on (user_id, title)
      return res.status(409).json({ error: "conflict", message: String(e && e.message || e) });
    }
  });

  // Delete a KB item
  app.delete("/kb/:id", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid id" });
    const info = db.prepare(`DELETE FROM kb_items WHERE id = ? AND user_id = ?`).run(id, userId);
    if (info.changes > 0) return res.json({ ok: true });
    return res.status(404).json({ error: "not found" });
  });

  app.get("/kb/ui", ensureAuthed, (req,res) =>{
    const userId = getCurrentUserId(req);
    const rows = db.prepare(`
      SELECT id, title, content, file_url, file_mime, created_at FROM kb_items
      WHERE user_id = ?
      ORDER BY id DESC LIMIT 200
    `).all(userId);
    const html = rows.map(r => {
      const when = new Date((r.created_at||0) * 1000).toLocaleString();
      const title = (r.title || 'Untitled');
      const fullContent = escapeHtml(r.content || '');
      const content = fullContent.slice(0, 280);
      const fileUrl = r.file_url || '';
      const fileBadge = fileUrl ? `<span class="small" style="margin-left:8px;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;padding:2px 6px;border-radius:6px;">PDF</span>` : '';
      return `
        <div class="kb-row" data-id="${r.id}" data-text="${escapeHtml((r.title||'') + ' ' + (r.content||''))}" data-content="${fullContent}" data-file-url="${escapeHtml(fileUrl)}" data-file-mime="${escapeHtml(r.file_mime||'')}">
          <div class="kb-time small">${when}</div>
          <div class="kb-title-pill">${escapeHtml(title)}${fileBadge}</div>
          <div class="kb-content">${content}</div>
          <div style="margin-left:auto; display:flex; gap:8px;">
            ${fileUrl ? `<a class="btn-ghost" href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener">Preview</a>` : ''}
            <button class="btn-ghost" onclick="editKbItem(${r.id})">Edit</button>
            <button class="btn-ghost" onclick="deleteKbItem(${r.id})">Delete</button>
          </div>
        </div>
      `;
    }).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><title>KB</title><link rel="stylesheet" href="/styles.css"></head>
      <body>
        <script>
          function isPdfLink(u){ try{ const href=String(u||'').toLowerCase(); return href.endsWith('.pdf') || href.includes('.pdf?') || href.includes('.pdf#'); }catch(e){ return false; } }
          function attachKbFilter(){
            const input = document.getElementById('kb-search');
            if(!input) return;
            input.addEventListener('input', function(){
              const q = this.value.toLowerCase();
              document.querySelectorAll('.kb-row').forEach(row => {
                const t = (row.getAttribute('data-text')||'').toLowerCase();
                row.style.display = q && !t.includes(q) ? 'none' : '';
              });
            });
          }
          function addKbItem(){
            const title = prompt("Enter a title for the KB item (e.g., Menu (PDF))");
            if (title === null) return;
            const content = prompt("Enter the content/summary (optional)") || '';
            const file_url = prompt("PDF link (optional, must be publicly accessible)") || '';
            const file_mime = file_url && isPdfLink(file_url) ? 'application/pdf' : '';
            fetch("/kb", { 
              method: "POST", 
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, content, file_url: file_url || null, file_mime: file_mime || null }) 
            }).then(() => window.location.reload());
          }
          function editKbItem(id){
            const row = document.querySelector('.kb-row[data-id="' + id + '"]');
            const oldTitle = (row && row.querySelector('.kb-title-pill') ? row.querySelector('.kb-title-pill').textContent.trim() : '') || '';
            const oldContent = (row && row.getAttribute('data-content')) || '';
            const oldFileUrl = (row && row.getAttribute('data-file-url')) || '';
            const oldFileMime = (row && row.getAttribute('data-file-mime')) || '';
            const title = prompt("Edit title", oldTitle);
            if (title === null) return; // cancelled
            const content = prompt("Edit content", oldContent);
            if (content === null) return; // cancelled
            const file_url = prompt("Edit PDF link (leave blank to remove)", oldFileUrl);
            if (file_url === null) return; // cancelled
            const file_mime = file_url ? (isPdfLink(file_url) ? 'application/pdf' : (oldFileMime||'')) : null;
            const body = { };
            if (title !== oldTitle) body.title = title;
            if (content !== oldContent) body.content = content;
            if (file_url !== oldFileUrl) body.file_url = file_url || null;
            if ((body.file_url !== undefined) || (file_mime !== oldFileMime)) body.file_mime = file_mime || null;
            if (Object.keys(body).length === 0) return; // nothing changed
            fetch('/kb/' + id, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            }).then(r => { if (!r.ok) { return r.json().then(j => { alert(j.message || j.error || 'Update failed'); }); } else { window.location.reload(); } });
          }
          function deleteKbItem(id){
            if(!confirm('Delete this KB item?')) return;
            fetch('/kb/' + id, { method: 'DELETE' }).then(() => window.location.reload());
          }
          window.addEventListener('DOMContentLoaded', attachKbFilter);
        </script>
        <div class="container">
          <div class="topbar">
            <div class="crumbs"><a href="/dashboard">Dashboard</a> / KB</div>
          </div>
          <div class="layout">
            ${renderSidebar('kb')}
            <main class="main">
              <div class="card kb-toolbar" style="margin-bottom:12px; display:flex; gap:8px; align-items:center;">
                <input id="kb-search" class="settings-field" placeholder="Search by title or content"/>
                <button class="btn-ghost" onclick="addKbItem()">Add</button>
              </div>
              <div class="card kb-list">${html || '<div class="small" style="margin-top:16px;">No KB items yet</div>'}</div>
            </main>
          </div>
        </div>
      </body></html>
    `);
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

