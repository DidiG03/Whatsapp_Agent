import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { KBItem } from "../schemas/mongodb.mjs";
import { queueKbEmbedding } from "../services/kbEmbeddings.mjs";
import { getUserPlan, getPlanPricing } from "../services/usage.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { renderSidebar, escapeHtml, renderTopbar, getProfessionalHead, renderPageHeader } from "../utils.mjs";
import multer from 'multer';
import { selectStorage } from '../services/uploads.mjs';
import { wrapAsync } from "../middleware/errors.mjs";

export default function registerKbRoutes(app) {
  const storage = selectStorage('kb');
  const uploadKb = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },    fileFilter: (req, file, cb) => {
      const allowed = /pdf|txt|md|doc|docx|rtf|odt|csv|xls|xlsx/i;
      if (allowed.test(file.mimetype) || allowed.test(path.extname(file.originalname))) return cb(null, true);
      cb(new Error('Unsupported file type'));
    }
  });

  app.post("/kb", ensureAuthed, wrapAsync(async (req, res) => {
    const userId = getCurrentUserId(req);
    const { title, content, file_url, file_mime } = req.body || {};
    const show_in_menu = req.body?.show_in_menu ? 1 : 0;
    if (!content || typeof content !== "string") return res.status(400).json({ error: "content required" });

    try {
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
    queueKbEmbedding(doc._id);
    return res.json({ id: String(doc._id), title: doc.title, content: doc.content, file_url: doc.file_url, file_mime: doc.file_mime, show_in_menu: doc.show_in_menu, user_id: doc.user_id });
  }));
  app.post("/kb/upload", ensureAuthed, uploadKb.single('document'), wrapAsync(async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      if (!req.file) return res.status(400).json({ error: 'file_required' });
      const title = (req.body?.title || req.file.originalname || 'Document').toString().trim().slice(0, 120);
      const summary = (req.body?.summary || '').toString().trim().slice(0, 2000);
      const showInMenu = !!req.body?.show_in_menu;
      const { getDB } = await import('../db-mongodb.mjs');
      const dbNative = getDB();
      const { GridFSBucket, ObjectId } = await import('mongodb');
      const bucket = new GridFSBucket(dbNative, { bucketName: 'kbfiles' });
      const filename = req.file.originalname || 'kb-file';
      const uploadStream = bucket.openUploadStream(filename, {
        contentType: req.file.mimetype || 'application/octet-stream',
        metadata: { user_id: String(userId), title }
      });
      await new Promise((resolve, reject) => {
        if (req.file.buffer) {
          uploadStream.end(req.file.buffer, (err) => err ? reject(err) : resolve());
        } else {
          fs.createReadStream(req.file.path)
            .on('error', reject)
            .pipe(uploadStream)
            .on('error', reject)
            .on('finish', resolve);
        }
      });
      const fileId = uploadStream.id ? uploadStream.id.toString() : null;
      let extracted = '';
      try {
        const mime = (req.file.mimetype || '').toLowerCase();
        if (/^text\//.test(mime) || /csv|markdown|md/.test(mime)) {
          if (req.file.buffer) {
            extracted = req.file.buffer.toString('utf8');
          } else if (req.file.path) {
            extracted = await fs.promises.readFile(req.file.path, 'utf8');
          }
        } else if (/pdf/.test(mime)) {
          try {
            const mod = await import('pdf-parse').catch(()=>null);
            if (mod && req.file.buffer) {
              const out = await mod.default(req.file.buffer);
              extracted = out?.text || '';
            }
          } catch {}
        }
      } catch {}
      const MAX_TEXT = 200000;      const contentForSearch = (summary + '\n\n' + extracted).trim().slice(0, MAX_TEXT) || summary || (title + ' (document)');
      const fileUrl = fileId ? (`/kb/file/${fileId}`) : null;
      const fileMime = req.file.mimetype || '';

      await KBItem.create({
        user_id: userId,
        title,
        content: contentForSearch,
        file_url: fileUrl,
        file_mime: fileMime,
        file_id: fileId,
        file_text: extracted ? extracted.slice(0, MAX_TEXT) : null,
        show_in_menu: showInMenu
      }).then((doc) => queueKbEmbedding(doc._id));
      return res.redirect('/kb/ui');
    } catch (e) {
      console.error('KB upload error:', e?.message || e);
      return res.status(500).json({ error: 'kb_upload_failed' });
    }
  }));
  app.get('/kb/file/:id', ensureAuthed, async (req, res) => {
    try {
      const { getDB } = await import('../db-mongodb.mjs');
      const dbNative = getDB();
      const { GridFSBucket, ObjectId } = await import('mongodb');
      const bucket = new GridFSBucket(dbNative, { bucketName: 'kbfiles' });
      const id = new ObjectId(String(req.params.id));
      try {
        const files = dbNative.collection('kbfiles.files');
        const meta = await files.findOne({ _id: id });
        if (meta?.contentType) res.setHeader('Content-Type', meta.contentType);
      } catch {}
      bucket.openDownloadStream(id).on('error', () => res.status(404).end()).pipe(res);
    } catch (e) {
      return res.status(404).send('Not Found');
    }
  });
  app.put("/kb/:id", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: "invalid id" });
    const { title, content, file_url, file_mime } = req.body || {};
    const show_in_menu = req.body?.show_in_menu;
    if (title == null && content == null && file_url == null && file_mime == null && show_in_menu == null) return res.status(400).json({ error: "nothing to update" });
    const update = {};
    if (content !== undefined) {
      update.content = content;
      update.embedding = null;
      update.embedding_model = null;
      update.embedding_updated_at = null;
    }
    if (title !== undefined) {
      update.title = title || null;
      update.embedding = null;
      update.embedding_model = null;
      update.embedding_updated_at = null;
    }
    if (file_url !== undefined) update.file_url = file_url || null;
    if (file_mime !== undefined) update.file_mime = file_mime || null;
    if (show_in_menu !== undefined) update.show_in_menu = !!show_in_menu;
    try {
      const doc = await KBItem.findOneAndUpdate({ _id: id, user_id: userId }, { $set: update }, { new: true }).lean();
      if (!doc) return res.status(404).json({ error: "not found" });
      if (update.embedding === null) queueKbEmbedding(doc._id);
      return res.json({ id: String(doc._id), title: doc.title, content: doc.content, file_url: doc.file_url, file_mime: doc.file_mime, show_in_menu: doc.show_in_menu, created_at: Math.floor(new Date(doc.createdAt || Date.now()).getTime()/1000) });
    } catch (e) {
      return res.status(409).json({ error: "conflict", message: String(e && e.message || e) });
    }
  });
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
    const plan = await getUserPlan(userId);
    const isUpgraded = (plan?.plan_name || 'free') !== 'free';
    if (!isUpgraded) {
      return res.redirect(303, '/plan');
    }
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
      const fileBadge = fileUrl ? `<span class="kb-badge kb-badge--file">PDF</span>` : '';
      const menuBadge = r.show_in_menu ? `<span class="kb-badge kb-badge--menu">In menu</span>` : '';
      const previewBtn = fileUrl
        ? `<a class="kb-action-btn kb-action-btn--preview" href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener" title="Preview file">PDF</a>`
        : '';
      return `
        <article class="kb-item" data-id="${String(r._id)}" data-text="${escapeHtml((r.title||'') + ' ' + (r.content||''))}" data-title="${escapeHtml(title)}" data-content="${fullContent}" data-file-url="${escapeHtml(fileUrl)}" data-file-mime="${escapeHtml(r.file_mime||'')}">
          <div class="kb-item__body">
            <div class="kb-item__head">
              <h3 class="kb-item__title">${escapeHtml(title)}</h3>
              <div class="kb-item__badges">${fileBadge}${menuBadge}</div>
            </div>
            <p class="kb-item__answer">${content || '<span class="kb-item__empty">No content yet</span>'}</p>
            <div class="kb-item__meta">Created ${when}</div>
          </div>
          <div class="kb-item__aside">
            <label class="kb-item__toggle" title="Show in customer menu">
              <input type="checkbox" class="kb-menu-toggle" data-id="${String(r._id)}" ${r.show_in_menu ? 'checked' : ''} />
              <span>Menu</span>
            </label>
            <div class="kb-item__actions">
              ${previewBtn}
              <button type="button" class="kb-action-btn" onclick="editKbItem('${String(r._id)}')" title="Edit">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button type="button" class="kb-action-btn kb-action-btn--danger" onclick="deleteKbItem('${String(r._id)}')" title="Delete">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
              </button>
            </div>
          </div>
        </article>
      `;
    }).join("");
    const bookingsCard = (() => {
      const enabled = !!(settings?.bookings_enabled);
      const badge = enabled
        ? '<span class="kb-badge kb-badge--system">System</span>'
        : '<span class="kb-badge kb-badge--warn">Disabled</span>';
      const desc = enabled
        ? 'Bookings are enabled. Customers can pick dates/times. Add specialized KB items like “Table Bookings” for menus and AI answers.'
        : 'Bookings are currently disabled. Enable Bookings in Settings to let customers book and add booking-related KB items.';
      const hint = enabled
        ? 'Tip: use Menu on high-priority items for quick customer access.'
        : 'Go to Settings → Bookings to enable.';
      return `
        <article class="kb-item kb-item--system" data-id="__system_bookings">
          <div class="kb-item__body">
            <div class="kb-item__head">
              <h3 class="kb-item__title">Bookings</h3>
              <div class="kb-item__badges">${badge}</div>
            </div>
            <p class="kb-item__answer">${escapeHtml(desc)}</p>
            <div class="kb-item__meta">${escapeHtml(hint)}</div>
          </div>
        </article>`;
    })();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html>${getProfessionalHead("Knowledge Base")}<body>
        <script src="/toast.js"></script>
        
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{
              const r=await fetch('/auth/status',{credentials:'include', headers:{'Accept':'application/json'}});
              const j=await r.json();
              if(j && j.signedIn === false){ window.location='/auth'; return; }
            }catch(e){
              // Don't force a relogin on transient network/auth-status failures.
              console.warn('Auth status check failed (non-fatal):', e);
            }
          })();
        </script>
        <script>
          window.kbLimitReached = ${JSON.stringify(atLimit)};
          function isPdfLink(u){ try{ const href=String(u||'').toLowerCase(); return href.endsWith('.pdf') || href.includes('.pdf?') || href.includes('.pdf#'); }catch(e){ return false; } }
          function toggleKbMenu(show){
            const m = document.getElementById('kb-menu');
            if(!m) return;
            if (typeof show === 'boolean') {
              m.style.display = show ? 'block' : 'none';
            } else {
              m.style.display = (m.style.display === 'block') ? 'none' : 'block';
            }
          }
          function openKbUploadModal(){
            if (window.kbLimitReached) { alert('KB limit reached for your plan. Please upgrade to add more.'); return; }
            const el = document.getElementById('kbUploadModal');
            if (el) el.classList.add('show');
            toggleKbMenu(false);
          }
          function closeKbUploadModal(){
            const el = document.getElementById('kbUploadModal');
            if (el) el.classList.remove('show');
          }
          function openKbAddModal(){
            if (window.kbLimitReached) { alert('KB limit reached for your plan. Please upgrade to add more.'); return; }
            const el = document.getElementById('kbAddModal');
            if (el) el.classList.add('show');
            toggleKbMenu(false);
          }
          function closeKbAddModal(){
            const el = document.getElementById('kbAddModal');
            if (el) el.classList.remove('show');
          }
          async function submitKbAddForm(e){
            if (e && e.preventDefault) e.preventDefault();
            const titleEl = document.getElementById('kbAddTitle');
            const summaryEl = document.getElementById('kbAddSummary');
            const linkEl = document.getElementById('kbAddLink');
            const menuEl = document.getElementById('kbAddShowMenu');
            const title = (titleEl?.value || '').trim();
            if (!title) { alert('Title is required'); return; }
            const content = (summaryEl?.value || '').trim();
            const file_url = (linkEl?.value || '').trim();
            const isPdf = file_url ? isPdfLink(file_url) : false;
            try {
              await fetch('/kb', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  title,
                  content,
                  file_url: file_url || null,
                  file_mime: isPdf ? 'application/pdf' : null,
                  show_in_menu: !!(menuEl?.checked)
                })
              });
              closeKbAddModal();
              window.location.reload();
            } catch (_) {
              alert('Failed to create item');
            }
          }
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
            // KB three-dot menu interactions
            const kbMenuBtn = document.getElementById('kb-menu-btn');
            const kbMenu = document.getElementById('kb-menu');
            if (kbMenuBtn && kbMenu) {
              kbMenuBtn.addEventListener('click', function(e){ e.stopPropagation(); toggleKbMenu(); });
              document.addEventListener('click', function(e){ if (!kbMenu.contains(e.target) && e.target !== kbMenuBtn) toggleKbMenu(false); });
            }
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
            // Nicely show selected file name
            try {
              var f = document.getElementById('kbFile');
              var fn = document.getElementById('kbFileName');
              if (f && fn) {
                f.addEventListener('change', function(){
                  fn.textContent = (this.files && this.files[0]) ? this.files[0].name : 'No file chosen';
                });
              }
              var f2 = document.getElementById('kbFile2');
              var fn2 = document.getElementById('kbFileName2');
              if (f2 && fn2) {
                f2.addEventListener('change', function(){
                  fn2.textContent = (this.files && this.files[0]) ? this.files[0].name : 'No file chosen';
                });
              }
            } catch(_){ }
          });
        </script>
        <div class="container">
          ${renderTopbar("Knowledge Base", email)}
          <div class="layout">
            ${renderSidebar('kb', { showBookings: true, showKb: true })}
            <main class="main">
              <div class="main-content">
                <div class="usage-meter">
                  <div class="usage-meter__label">Knowledge base usage</div>
                  <div class="usage-meter__bar">
                    <div class="usage-meter__fill ${docsPct > 90 ? 'is-danger' : docsPct > 75 ? 'is-warn' : 'is-ok'}" style="width:${docsPct}%;"></div>
                  </div>
                  <div class="usage-meter__meta">${itemsCount} / ${docsLimit} items · ${(charsCount/1024/1024).toFixed(2)} MB / ${(charsLimit/1024/1024).toFixed(0)} MB</div>
                </div>
                <div class="kb-list-shell">
                  <div class="kb-list-shell__toolbar">
                    <input id="kb-search" class="settings-field kb-list-shell__search" placeholder="Search knowledge items..." />
                    <div class="dropdown kb-list-shell__menu">
                      <button type="button" id="kb-menu-btn" class="kb-action-btn" aria-haspopup="true" aria-expanded="false" title="Add knowledge">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                      </button>
                      <div id="kb-menu" class="dropdown-menu kb-dropdown-menu" style="display:none;">
                        <button type="button" class="kb-dropdown-item" onclick="openKbAddModal()">Add item</button>
                        <button type="button" class="kb-dropdown-item" onclick="openKbUploadModal()">Upload file</button>
                      </div>
                    </div>
                    ${devFallbackNotice ? `<span class="kb-list-shell__notice">${devFallbackNotice}</span>` : ''}
                  </div>
                  <div class="kb-list">${bookingsCard + (html || `
                  <div class="empty-state-pro">
                    <h3 class="empty-state-pro__title">No knowledge items yet</h3>
                    <p class="empty-state-pro__copy">
                      Create your first knowledge base item to help the assistant answer customer questions accurately.
                    </p>
                    <div class="empty-state-pro__tips">
                      <div class="empty-state-pro__tips-title">Getting started</div>
                      <ul>
                        <li>Use Add Item to create structured FAQ content</li>
                        <li>Upload PDFs for detailed policies and menus</li>
                        <li>Enable Show in menu for high-priority topics</li>
                        <li>Keep titles concise and content factual</li>
                      </ul>
                    </div>
                  </div>
                `)}</div>
                </div>
              </div>
            </main>
          </div>
        </div>
        <!-- Upload Modal -->
        <div id="kbUploadModal" class="day-modal">
          <div class="day-modal-overlay" onclick="closeKbUploadModal()"></div>
          <div class="day-modal-content">
            <div class="day-modal-header">
              <h3>Upload Knowledge Item</h3>
              <button class="day-modal-close" onclick="closeKbUploadModal()">×</button>
            </div>
            <div class="day-modal-body">
              <form method="post" action="/kb/upload" enctype="multipart/form-data" style="display:flex; flex-direction:column; gap:12px;">
                <div style="display:flex; gap:10px; align-items:center; background:#f9fafb; border:1px solid #e5e7eb; padding:8px 12px; border-radius:10px;">
                  <input id="kbFile2" type="file" name="document" accept=".pdf,.txt,.md,.doc,.docx,.rtf,.odt,.csv,.xls,.xlsx" style="display:none;" />
                  <label for="kbFile2" class="btn btn-ghost" style="border:none; background:#eef2ff; color:#3730a3; padding:8px 12px; border-radius:8px; cursor:pointer;">📄 Select file</label>
                  <span id="kbFileName2" class="small" style="color:#6b7280; max-width:220px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">No file chosen</span>
                </div>
                <input type="text" name="title" class="settings-field" placeholder="Title (optional)" />
                <input type="text" name="summary" class="settings-field" placeholder="Short summary (optional)" />
                <label class="small" style="display:flex; align-items:center; gap:6px; color:#374151;"><input type="checkbox" name="show_in_menu"/> Show in menu</label>
                <div style="display:flex; gap:8px; justify-content:flex-end;">
                  <button type="button" class="btn btn-ghost" onclick="closeKbUploadModal()">Cancel</button>
                  <button type="submit" class="btn btn-primary">Upload</button>
                </div>
              </form>
            </div>
          </div>
        </div>
        <!-- Add Item Modal -->
        <div id="kbAddModal" class="day-modal">
          <div class="day-modal-overlay" onclick="closeKbAddModal()"></div>
          <div class="day-modal-content">
            <div class="day-modal-header">
              <h3>Add Knowledge Item</h3>
              <button class="day-modal-close" onclick="closeKbAddModal()">×</button>
            </div>
            <div class="day-modal-body">
              <form onsubmit="submitKbAddForm(event)" style="display:flex; flex-direction:column; gap:12px;">
                <input id="kbAddTitle" type="text" class="settings-field" placeholder="Title (e.g., Menu (PDF))" required />
                <input id="kbAddSummary" type="text" class="settings-field" placeholder="Short summary (optional)" />
                <input id="kbAddLink" type="url" class="settings-field" placeholder="PDF link (optional)" />
                <label class="small" style="display:flex; align-items:center; gap:6px; color:#374151;"><input id="kbAddShowMenu" type="checkbox" /> Show in menu</label>
                <div style="display:flex; gap:8px; justify-content:flex-end;">
                  <button type="button" class="btn btn-ghost" onclick="closeKbAddModal()">Cancel</button>
                  <button type="submit" class="btn btn-primary">Create</button>
                </div>
              </form>
            </div>
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

