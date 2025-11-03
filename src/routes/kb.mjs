import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { KBItem } from "../schemas/mongodb.mjs";
import { getUserPlan, getPlanPricing } from "../services/usage.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { renderSidebar, escapeHtml, renderTopbar } from "../utils.mjs";

export default function registerKbRoutes(app) {
  app.post("/kb", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { title, content, file_url, file_mime } = req.body || {};
    const show_in_menu = req.body?.show_in_menu ? 1 : 0;
    if (!content || typeof content !== "string") return res.status(400).json({ error: "content required" });

    try {
      // Guard: booking-related KB items require bookings to be enabled
      try {
        const settings = await getSettingsForUser(userId);
        const mentionsBooking = /\bbooking(s)?\b/i.test(String(title || "") + " " + String(content || ""));
        if (mentionsBooking && !settings?.bookings_enabled) {
          return res.status(403).json({ error: 'bookings_required', message: 'Enable Bookings in Settings to add booking-related KB items.' });
        }
      } catch {}

      const plan = await getUserPlan(userId);
      const pricing = getPlanPricing();
      const planCfg = pricing[plan?.plan_name || 'free'] || pricing.free;
      const docsLimit = planCfg.kb_docs_limit || Infinity;
      const charsLimit = planCfg.kb_chars_limit || Infinity;
      const existingDocs = await KBItem.find({ user_id: userId }).select('content').lean();
      const itemsCount = existingDocs.length;
      const charsCount = existingDocs.reduce((n, r) => n + String(r.content || '').length, 0);
      const nextDocs = itemsCount + 1;
      const nextChars = charsCount + String(content || '').length;
      if (nextDocs > docsLimit || nextChars > charsLimit) {
        return res.status(403).json({ error: 'kb_limit_reached', message: 'KB plan limit reached. Please upgrade your plan to add more.' });
      }
    } catch {}

    const doc = await KBItem.create({
      title: title || null,
      content,
      file_url: file_url || null,
      file_mime: file_mime || null,
      show_in_menu: !!show_in_menu,
      user_id: userId
    });
    return res.json({ id: String(doc._id), title: doc.title, content: doc.content, file_url: doc.file_url, file_mime: doc.file_mime, show_in_menu: doc.show_in_menu, user_id: doc.user_id });
  });

  // Update an existing KB item (title and/or content)
  app.put("/kb/:id", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: "invalid id" });
    const { title, content, file_url, file_mime } = req.body || {};
    const show_in_menu = req.body?.show_in_menu;
    if (title == null && content == null && file_url == null && file_mime == null && show_in_menu == null) return res.status(400).json({ error: "nothing to update" });
    const update = {};
    if (title !== undefined) update.title = title || null;
    if (content !== undefined) update.content = content;
    if (file_url !== undefined) update.file_url = file_url || null;
    if (file_mime !== undefined) update.file_mime = file_mime || null;
    if (show_in_menu !== undefined) update.show_in_menu = !!show_in_menu;
    try {
      const doc = await KBItem.findOneAndUpdate({ _id: id, user_id: userId }, { $set: update }, { new: true }).lean();
      if (!doc) return res.status(404).json({ error: "not found" });
      return res.json({ id: String(doc._id), title: doc.title, content: doc.content, file_url: doc.file_url, file_mime: doc.file_mime, show_in_menu: doc.show_in_menu, created_at: Math.floor(new Date(doc.createdAt || Date.now()).getTime()/1000) });
    } catch (e) {
      return res.status(409).json({ error: "conflict", message: String(e && e.message || e) });
    }
  });

  // Delete a KB item
  app.delete("/kb/:id", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: "invalid id" });
    const result = await KBItem.deleteOne({ _id: id, user_id: userId });
    if (result.deletedCount > 0) return res.json({ ok: true });
    return res.status(404).json({ error: "not found" });
  });

  app.get("/kb/ui", ensureAuthed, async (req,res) =>{
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    const settings = await getSettingsForUser(userId);
    let rows = await KBItem.find({ user_id: userId }).sort({ _id: -1 }).limit(200).lean();
    let devFallbackNotice = '';
    if (!rows.length && process.env.NODE_ENV !== 'production') {
      try {
        const showAll = String(req.query?.all || '') === '1';
        const q = showAll ? {} : { user_id: { $regex: /^test_user_/ } };
        const alt = await KBItem.find(q).sort({ _id: -1 }).limit(200).lean();
        if (alt && alt.length) {
          rows = alt;
          devFallbackNotice = 'Showing dev KB items (fallback)';
        }
      } catch {}
    }
    const itemsCount = rows.length;
    const charsCount = rows.reduce((n, r) => n + (String(r.content||'').length), 0);
    const plan = await getUserPlan(userId);
    const pricing = getPlanPricing();
    const planCfg = pricing[plan?.plan_name || 'free'] || pricing.free;
    const docsLimit = planCfg.kb_docs_limit || Infinity;
    const charsLimit = planCfg.kb_chars_limit || Infinity;
    const docsPct = Math.min(100, Math.round((itemsCount / (docsLimit || 1)) * 100));
    const atLimit = itemsCount >= docsLimit || charsCount >= charsLimit;
    const html = rows.map(r => {
      const when = new Date(r.createdAt || Date.now()).toLocaleDateString();
      const title = (r.title || 'Untitled');
      const fullContent = escapeHtml(r.content || '');
      const content = fullContent.slice(0, 280);
      const fileUrl = r.file_url || '';
      const fileBadge = fileUrl ? `<span class="small" style="margin-left:8px;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;padding:2px 6px;border-radius:6px;">PDF</span>` : '';
      return `
        <div class="kb-item" data-id="${String(r._id)}" data-text="${escapeHtml((r.title||'') + ' ' + (r.content||''))}" data-title="${escapeHtml(title)}" data-content="${fullContent}" data-file-url="${escapeHtml(fileUrl)}" data-file-mime="${escapeHtml(r.file_mime||'')}" style="background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:20px; margin-bottom:16px; transition:all 0.2s ease; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
            <div style="flex:1;">
              <h3 style="margin:0 0 8px 0; font-size:16px; font-weight:600; color:#111827; display:flex; align-items:center; gap:8px;">
                ${escapeHtml(title)}
                ${fileBadge}
              </h3>
              <div style="background:#f3f4f6; border-radius:8px; padding:12px; margin-bottom:12px; border-left:4px solid #3b82f6;">
                <p style="margin:0; font-size:14px; line-height:1.5; color:#374151;">${content}</p>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:8px; margin-left:16px;">
              <label class="small" style="display:flex; align-items:center; gap:6px; background:#f9fafb; padding:6px 10px; border-radius:6px; border:1px solid #e5e7eb;">
                <input type="checkbox" class="kb-menu-toggle" data-id="${String(r._id)}" ${r.show_in_menu ? 'checked' : ''} style="margin:0;"/>
                Show in menu
              </label>
              ${fileUrl ? `<a class="btn-ghost" href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd; padding:6px 12px; border-radius:6px; font-size:12px;">📄 Preview</a>` : ''}
              <button style="border:none; background:#f3f4f6; padding:8px; border-radius:6px; cursor:pointer;" class="btn-ghost" onclick="editKbItem('${String(r._id)}')" title="Edit">
                <img src="/pencil-icon.svg" alt="Edit" style="width:16px;height:16px;"/>
              </button>
              <button style="border:none; background:#fef2f2; padding:8px; border-radius:6px; cursor:pointer;" class="btn-ghost" onclick="deleteKbItem('${String(r._id)}')" title="Delete">
                <img src="/delete-icon.svg" alt="Delete" style="width:16px;height:16px;"/>
              </button>
            </div>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; padding-top:12px; border-top:1px solid #f3f4f6;">
            <div class="kb-time small" style="color:#6b7280; font-size:12px;">Created ${when}</div>
            <div style="display:flex; gap:4px;">
              <span style="background:#f0f9ff; color:#0369a1; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500;">KB Item</span>
              ${r.show_in_menu ? '<span style="background:#f0fdf4; color:#166534; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500;">Menu</span>' : ''}
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Synthetic, non-deletable informational card for Bookings feature visibility in KB
    const bookingsCard = (() => {
      const enabled = !!(settings?.bookings_enabled);
      const badge = enabled
        ? '<span style="background:#ecfeff; color:#0e7490; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; border:1px solid #a5f3fc;">System</span>'
        : '<span style="background:#fff7ed; color:#9a3412; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; border:1px solid #fed7aa;">Disabled</span>';
      const desc = enabled
        ? 'Bookings are enabled. Customers can pick dates/times. You can add specialized KB items like “Table Bookings” or “Call Bookings” to appear in menus and AI answers.'
        : 'Bookings are currently disabled. Enable Bookings in Settings to let customers book and to add booking-related KB items.';
      return `
        <div class="kb-item" data-id="__system_bookings" style="background:#fff; border:1px dashed #cbd5e1; border-radius:12px; padding:20px; margin-bottom:16px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
            <div style="flex:1;">
              <h3 style="margin:0 0 8px 0; font-size:16px; font-weight:700; color:#0f172a; display:flex; align-items:center; gap:8px;">Bookings ${badge}</h3>
              <div style="background:#f8fafc; border-radius:8px; padding:12px; margin-bottom:12px; border-left:4px solid ${enabled ? '#22c55e' : '#f59e0b'};">
                <p style="margin:0; font-size:14px; line-height:1.5; color:#334155;">${escapeHtml(desc)}</p>
              </div>
              ${enabled ? '<div class="small" style="color:#64748b;">Tip: Use \'Show in menu\' for quick access items.</div>' : '<div class="small" style="color:#64748b;">Go to Settings → Bookings to enable.</div>'}
            </div>
          </div>
        </div>`;
    })();

    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>Code Orbit - KB</title><link rel="stylesheet" href="/styles.css">
        <style>
          .kb-item:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            border-color: #d1d5db;
          }
          .kb-item {
            transition: all 0.2s ease;
          }
          .kb-item button:hover {
            transform: scale(1.05);
          }
          .kb-item a:hover {
            transform: scale(1.05);
          }
        </style>
      </head>
      <body>
        <script src="/toast.js"></script>
        
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return; } }catch(e){ window.location='/auth'; }
          })();
        </script>
        <script>
          window.kbLimitReached = ${JSON.stringify(atLimit)};
          function isPdfLink(u){ try{ const href=String(u||'').toLowerCase(); return href.endsWith('.pdf') || href.includes('.pdf?') || href.includes('.pdf#'); }catch(e){ return false; } }
          function attachKbFilter(){
            const input = document.getElementById('kb-search');
            if(!input) return;
            input.addEventListener('input', function(){
              const q = this.value.toLowerCase();
              document.querySelectorAll('.kb-item').forEach(row => {
                const t = (row.getAttribute('data-text')||'').toLowerCase();
                row.style.display = q && !t.includes(q) ? 'none' : '';
              });
            });
          }
          function addKbItem(){
            if (window.kbLimitReached) { alert('KB limit reached for your plan. Please upgrade to add more.'); return; }
            const title = prompt("Enter a title for the KB item (e.g., Menu (PDF))");
            if (title === null) return;
            const content = prompt("Enter the content/summary (optional)") || '';
            const file_url = prompt("PDF link (optional, must be publicly accessible)") || '';
            const file_mime = file_url && isPdfLink(file_url) ? 'application/pdf' : '';
            fetch("/kb", { 
              method: "POST", 
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, content, file_url: file_url || null, file_mime: file_mime || null, show_in_menu: true }) 
            }).then(() => window.location.reload());
          }
          function editKbItem(id){
            const row = document.querySelector('.kb-item[data-id="' + id + '"]');
            const oldTitle = (row && row.getAttribute('data-title')) || '';
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
          window.addEventListener('DOMContentLoaded', function(){
            attachKbFilter();
            // Toggle show_in_menu
            document.querySelectorAll('.kb-menu-toggle').forEach(function(chk){
              chk.addEventListener('change', function(){
                var id = this.getAttribute('data-id');
                fetch('/kb/' + id, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ show_in_menu: this.checked })
                }).catch(()=>{});
              });
            });
          });
        </script>
        <div class="container">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / KB`, email)}
          <div class="layout">
            ${renderSidebar('kb')}
            <main class="main">
              <div class="main-content">
                <div class="card kb-toolbar" style="margin-bottom:12px; display:flex; gap:8px; align-items:center;">
                  <input id="kb-search" class="settings-field" placeholder="Search knowledge items..."/>
                  <button class="btn-ghost" onclick="addKbItem()" ${atLimit ? 'disabled' : ''} title="${atLimit ? 'KB limit reached' : '+Add'}">${atLimit ? 'Add (Limit Reached)' : 'Add'}</button>
                  ${devFallbackNotice ? `<span class="small" style="color:#6b7280;">${devFallbackNotice}</span>` : ''}
                </div>
                <div class="card" style="margin-bottom:12px;">
                  <div class="small" style="margin-bottom:6px;">Knowledge Base usage</div>
                  <div class="usage-progress" style="width:100%; height:8px; background:#e5e7eb; border-radius:4px; overflow:hidden;">
                    <div class="usage-progress-bar" style="width:${docsPct}%; height:100%; background:${docsPct>90?'#ef4444':docsPct>75?'#f59e0b':'#10b981'};"></div>
                  </div>
                  <div class="small" style="margin-top:6px; color:#6b7280;">${itemsCount} / ${docsLimit} items • ${(charsCount/1024/1024).toFixed(2)} MB / ${(charsLimit/1024/1024).toFixed(0)} MB</div>
                </div>
                <div class="kb-list">${bookingsCard + (html || `
                  <div class="empty-state" style="text-align:center; padding:60px 20px; color:#666;">
                    <div style="font-size:48px; margin-bottom:20px; opacity:0.3;">📚</div>
                    <h3 style="margin:0 0 12px 0; color:#333; font-size:20px; font-weight:500;">No knowledge items yet</h3>
                    <p style="margin:0 0 24px 0; font-size:14px; line-height:1.5; max-width:400px; margin-left:auto; margin-right:auto;">
                      Create your first knowledge base item to help your AI assistant provide better responses to customers.
                    </p>
                    <div style="background:#f8f9fa; border-radius:12px; padding:20px; margin:0 auto; max-width:400px; border:1px solid #e9ecef;">
                      <div style="font-size:13px; color:#666; margin-bottom:12px; font-weight:500;">💡 Getting Started:</div>
                      <ul style="text-align:left; font-size:13px; color:#666; margin:0; padding-left:20px; line-height:1.6;">
                        <li>Click "Add" to create your first knowledge item</li>
                        <li>Add titles and content that customers commonly ask about</li>
                        <li>Upload PDFs for detailed information</li>
                        <li>Toggle "Show in menu" to make items easily accessible</li>
                      </ul>
                    </div>
                  </div>
                `)}</div>
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  app.get("/kb", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const rows = await KBItem.find({ user_id: userId }).sort({ _id: -1 }).limit(200).lean();
    return res.json(rows.map(r => ({ id: String(r._id), title: r.title, content: r.content, created_at: Math.floor(new Date(r.createdAt || Date.now()).getTime() / 1000) })));
  });
}

