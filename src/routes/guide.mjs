import { renderSidebar, renderTopbar, escapeHtml, getVercelWebAnalyticsSnippet } from "../utils.mjs";
import { getSignedInEmail, ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { Guide } from "../schemas/mongodb.mjs";
import { getPlanStatus } from "../services/usage.mjs";

const DEFAULT_GUIDES = [
  {
    slug: "meta-developers-values-whatsapp-setup",
    title: "How to get Meta (Facebook) Developer values for WhatsApp Setup",
    summary: "Find Phone Number ID, WABA ID, WhatsApp Token, App Secret, and set your Verify Token + Callback URL.",
    content: [
      "# How to get Meta (Facebook) Developer values for WhatsApp Setup",
      "",
      "This guide shows where to find the values inside Meta for Developers and exactly where to paste them in Code Orbit → Settings → WhatsApp Setup.",
      "",
      "Meta for Developers:",
      "https://developers.facebook.com",
      "",
      "# What you will fill in (Code Orbit → Settings → WhatsApp Setup)",
      "",
      "- Phone Number ID → Settings field: Phone Number ID",
      "- WABA ID → Settings field: WABA ID",
      "- WhatsApp Token → Settings field: WhatsApp Token",
      "- App Secret → Settings field: App Secret",
      "- Verify Token → Settings field: Verify Token",
      "",
      "# Step 1 — Create/Select your Meta App and add WhatsApp",
      "",
      "- Go to Meta for Developers and open your app (or create a new app).",
      "- In your app dashboard, add the **WhatsApp** product.",
      "",
      "# Step 2 — Get Phone Number ID and WABA ID (from WhatsApp → API Setup)",
      "",
      "- Open your Meta App → WhatsApp → **API Setup**.",
      "- Copy these values and paste them into Code Orbit → Settings → WhatsApp Setup:",
      "- **Phone Number ID** → paste into **Phone Number ID**",
      "- **WhatsApp Business Account ID (WABA ID)** → paste into **WABA ID**",
      "",
      "# Step 3 — Get a WhatsApp Token (Temporary for testing, Permanent for production)",
      "",
      "- In Meta App → WhatsApp → **API Setup**, copy the **Temporary access token** (good for initial testing).",
      "- Paste it into Code Orbit → Settings → WhatsApp Setup → **WhatsApp Token**.",
      "",
      "**Important:** Temporary tokens expire. For production, generate a permanent token (System User / long-lived token) and update the **WhatsApp Token** in Settings.",
      "",
      "# Step 4 — Get your App Secret (used to verify webhook signature)",
      "",
      "- In Meta App dashboard → **App Settings** → **Basic**.",
      "- Reveal/copy **App Secret**.",
      "- Paste it into Code Orbit → Settings → WhatsApp Setup → **App Secret**.",
      "",
      "# Step 5 — Choose your Verify Token (you generate this value)",
      "",
      "The Verify Token is a secret string you choose. It must match in both places:",
      "",
      "- Code Orbit → Settings → WhatsApp Setup → **Verify Token**",
      "- Meta App → WhatsApp → **Configuration** (Webhooks) → **Verify token**",
      "",
      "Recommendation: use a long random string (store it like a password).",
      "",
      "# Step 6 — Set Webhook Callback URL in Meta",
      "",
      "Your callback URL is your public base domain + `/webhook`.",
      "",
      "- Callback URL: `https://YOUR-DOMAIN.com/webhook`",
      "",
      "If you are testing locally, use a public tunnel URL (example: your NGROK public URL) + `/webhook`.",
      "",
      "# Step 7 — Subscribe to WhatsApp webhook events",
      "",
      "- In Meta App → WhatsApp → Configuration, subscribe your webhook to the needed fields (at minimum **messages**).",
      "",
      "# Quick checklist (common mistakes)",
      "",
      "- **Wrong endpoint**: callback must be `/webhook` (not `/api/...`).",
      "- **Verify Token mismatch**: Meta Verify Token must equal Code Orbit Verify Token.",
      "- **Missing App Secret**: required for signature verification in production.",
      "- **Expired token**: temporary access token expires; replace with a permanent one for production.",
      "- **Wrong Phone Number ID**: must be the Cloud API phone number id, not the phone number itself.",
      "",
      "# Done",
      "",
      "Save Settings. Then send a WhatsApp message to your business number — it should appear in your Inbox once Meta is pointing to your `/webhook` endpoint and the token/IDs are correct."
    ].join("\n")
  }
];

async function ensureDefaultGuides() {
  for (const g of DEFAULT_GUIDES) {
    if (!g?.slug) continue;
    const exists = await Guide.findOne({ slug: g.slug }).select("_id").lean();
    if (exists) continue;
    try {
      await Guide.create({
        slug: g.slug,
        title: g.title,
        summary: g.summary,
        content: g.content
      });
    } catch (e) {
      // Ignore duplicate key errors (race between parallel requests).
      const msg = String(e?.message || "");
      if (!/E11000 duplicate key/i.test(msg)) throw e;
    }
  }
}

export default function registerGuideRoutes(app) {
  // Guides index
  app.get("/guide", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    await ensureDefaultGuides();
    const guides = await Guide.find({}).select('slug title summary createdAt').sort({ createdAt: -1 }).lean();
    const { isUpgraded } = await getPlanStatus(userId);
    const cards = (guides || []).map(g => `
      <a class="guide-card" href="/guide/${encodeURIComponent(g.slug)}">
        <div class="guide-card-date">${new Date(g.createdAt || Date.now()).toLocaleDateString()}</div>
        <div class="guide-card-header">${escapeHtml(g.title)}</div>
        <div class="guide-card-body">${escapeHtml(g.summary || '')}</div>
        <div class="guide-card-cta">Read more →</div>
      </a>
    `).join('');
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>Code Orbit - Guide</title><link rel="stylesheet" href="/styles.css">${getVercelWebAnalyticsSnippet()}</head>
        <body>
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
            <div class="container">
                ${renderTopbar("Dashboard / Guide", email)}
            <div class="layout">
                    ${renderSidebar("guide", { isUpgraded })}
                    <main class="main">
                        <div class="main-content">
                          <div>
                        <div class="hero">
                            <div>
                            <h3>Help Center</h3>
                            <div class="desc">Learn how to set up and grow your WhatsApp Agent.</div>
                            </div>
                        </div>
                        <div class="separator" style="margin:12px 0;"></div>
                        <div class="guide-grid">${cards || '<div class="small">No articles yet.</div>'}</div>
                        <div class="separator"></div>
                        <div class="guide-extra">
                          <div class="guide-tips card">
                            <h3>Quick tips</h3>
                            <ul class="tip-list">
                              <li>Keep KB entries short and specific.</li>
                              <li>Use clear titles like Payments, Returns, Delivery.</li>
                              <li>Upload PDFs to let customers receive files instantly.</li>
                            </ul>
                          </div>
                          <div class="guide-cta card">
                            <div class="cta-title">Need help structuring your KB?</div>
                            <div class="cta-sub">Open the Knowledge Base and add Top FAQs to start fast.</div>
                            <a class="btn btn-primary" href="/kb/ui">Open Knowledge Base →</a>
                          </div>
                        </div>
                        </div>
                          </div>
                    </main>
                </div>
            </div>
        </body>
      </html>
    `);
  });

  // Guide detail by slug
  app.get("/guide/:slug", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    const slug = String(req.params.slug || '').trim();
    await ensureDefaultGuides();
    const g = await Guide.findOne({ slug }).lean();
    if (!g) return res.redirect('/guide');
    const others = await Guide.find({ slug: { $ne: slug } }).select('slug title summary createdAt').sort({ createdAt: -1 }).limit(6).lean();
    const related = (others || []).map(o => `
      <li class="related-item">
        <a href="/guide/${encodeURIComponent(o.slug)}">
          <div class="related-title">${escapeHtml(o.title)}</div>
          <div class="related-summary">${escapeHtml(o.summary || '')}</div>
          <div class="related-date">${new Date(o.createdAt || Date.now()).toLocaleDateString()}</div>
        </a>
      </li>
    `).join('');
    // naive markdown-ish to HTML: headers and lists
    const lines = String(g.content||'').split('\n');
    const html = [];
    for (const line of lines) {
      if (/^#\s+/.test(line)) { html.push(`<h1>${escapeHtml(line.replace(/^#\s+/, ''))}</h1>`); continue; }
      if (/^\d+\)\s+/.test(line)) { html.push(`<p>${escapeHtml(line)}</p>`); continue; }
      if (/^\-\s+/.test(line)) { html.push(`<ul><li>${escapeHtml(line.replace(/^\-\s+/, ''))}</li></ul>`); continue; }
      if (/^https?:\/\/.+/.test(line)) { html.push(`<a href="${line}">${escapeHtml(line)}</a>`); continue; }
      if (line.trim() === '') { html.push('<p></p>'); continue; }
      if (/^!\[.*\]\(.*\)$/.test(line)) {
        // Handle images: ![alt](url)
        const match = line.match(/^!\[(.*)\]\((.*)\)$/);
        if (match) {
          const alt = escapeHtml(match[1]);
          const url = escapeHtml(match[2]);
          html.push(`<div style="text-align: center; margin: 16px 0;"><img src="${url}" alt="${alt}" style="max-width: 100%; height: auto;" /></div>`);
          continue;
        }
      }
      const inline = escapeHtml(line)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1<\/strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1<\/em>');
      html.push(`<p>${inline}</p>`);
    }
    const body = html.join('');
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    const { isUpgraded } = await getPlanStatus(userId);
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css">${getVercelWebAnalyticsSnippet()}<script>
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
        </script><style>
        .guide-detail{ display:grid; grid-template-columns: minmax(0,1fr) 320px; gap:16px; }
        .related .related-heading{ font-weight:700; margin-bottom:8px; }
        .related-list{ list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:10px; }
        .related-item a{ display:block; border:1px solid var(--border); border-radius:10px; padding:10px; background:#fff; text-decoration:none; transition: box-shadow .2s, transform .2s; }
        .related-item a:hover{ box-shadow:0 6px 16px rgba(0,0,0,.08); transform: translateY(-2px); }
        .related-title{ font-weight:600; color:#111827; margin-bottom:4px; }
        .related-summary{ color:#4b5563; font-size:13px; }
        .related-date{ color:#6b7280; font-size:12px; margin-top:6px; }
        @media (max-width: 1000px){ .guide-detail{ grid-template-columns: 1fr; } }
      </style></head><body>
        <div class="container">
          ${renderTopbar("Dashboard / Guide", email)}
            <div class="layout">
              ${renderSidebar("guide", { isUpgraded })}
            <main class="main">
              <div class="main-content">
                <div class="guide-detail">
                  <div class="card article">
                    <a href="/guide" class="back">← Back to Guides</a>
                    <div class="title">${escapeHtml(g.title)}</div>
                    <div class="meta">Published ${new Date(g.createdAt || Date.now()).toLocaleDateString()}</div>
                    <div class="separator" style="margin:8px 0;"></div>
                    <div class="prose">${body}</div>
                  </div>
                  <aside class="related">
                    <div class="card">
                      <div class="related-heading">More articles</div>
                      <ul class="related-list">${related || '<div class="small">No other articles yet.</div>'}</ul>
                    </div>
                  </aside>
                </div>
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });
}