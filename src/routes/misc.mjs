import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { getVercelWebAnalyticsSnippet } from "../utils.mjs";
import OpenAI from "openai";

export default function registerMiscRoutes(app) {
  app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => res.sendStatus(204));
  app.get('/privacy', (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Privacy Policy • Code Orbit Agent</title>
        <link rel="icon" href="/favicon.ico">
        <link rel="stylesheet" href="/styles.css">
        ${getVercelWebAnalyticsSnippet()}
        <style>
          body { background:#0b1220; color:#e5e7eb; }
          .doc { max-width: 920px; margin: 48px auto; padding: 24px; }
          .doc h1 { margin: 0 0 12px 0; }
          .doc h2 { margin: 22px 0 10px 0; font-size: 18px; color:#e5e7eb; }
          .doc p, .doc li { color:#cbd5e1; line-height:1.7; }
          .muted { color:#94a3b8; font-size: 14px; }
          .cardish { background:#0f172a; border:1px solid #1f2937; border-radius:12px; padding:24px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
          a { color:#60a5fa; } a:hover { color:#93c5fd; }
          .site-footer { max-width: 920px; margin: 0 auto 32px; padding: 16px 24px; color:#94a3b8; }
          .site-footer .inner { border-top:1px solid #1f2937; padding-top:16px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
          .site-footer nav a { color:#93c5fd; text-decoration:none; margin-right:12px; }
          .site-footer nav a:hover { color:#bfdbfe; }
        </style>
      </head>
      <body>
        <main class="doc">
          <div class="cardish">
            <h1>Privacy Policy</h1>
            <p class="muted">Last updated: <script>document.write(new Date().toLocaleDateString())</script></p>
            <p>Code Orbit Agent (“we”, “us”, or “our”) provides a WhatsApp Business messaging assistant and related tools (“Service”). This Privacy Policy explains how we collect, use, and protect information when you use the Service.</p>
            <h2>Information We Collect</h2>
            <ul>
              <li>Account information (e.g., email) used for authentication and account administration.</li>
              <li>WhatsApp Business messaging data required to deliver the Service (e.g., inbound/outbound message content, status updates, phone numbers, timestamps).</li>
              <li>Configuration data you provide (e.g., knowledge base items, quick replies, booking settings).</li>
              <li>Technical logs/metrics for security, troubleshooting, and performance.</li>
            </ul>
            <h2>How We Use Information</h2>
            <ul>
              <li>Deliver, maintain, and improve the Service and its features.</li>
              <li>Provide customer support and communicate important notices.</li>
              <li>Detect, prevent, and investigate security incidents or abuse.</li>
              <li>Comply with applicable law and platform (Meta/WhatsApp) policies.</li>
            </ul>
            <h2>WhatsApp and Third‑Party Services</h2>
            <p>The Service integrates with WhatsApp Business Cloud API. Message delivery and status events are processed according to WhatsApp’s and Meta’s terms and policies. We only send the minimum data required to deliver messages and receive webhooks from WhatsApp.</p>
            <h2>Data Retention</h2>
            <p>We retain conversation data and configuration data for as long as your account remains active or as needed to provide the Service. You can delete your account data at any time from the application (<em>Settings → Danger → Delete my account data</em>).</p>
            <h2>Data Deletion</h2>
            <p>You can find instructions at <a href="/data-deletion">/data-deletion</a>. You may also contact us to request deletion; we will respond within a reasonable timeframe.</p>
            <h2>Security</h2>
            <p>We apply administrative, technical, and organizational measures designed to protect your data. No method of transmission or storage is 100% secure; we continuously improve our safeguards.</p>
            <h2>Your Rights</h2>
            <p>Depending on your region, you may have rights to access, correct, export, or delete your personal data. Contact us to exercise these rights.</p>
            <h2>Changes</h2>
            <p>We may update this Privacy Policy. We will post the updated version here and update the “Last updated” date.</p>
            <h2>Contact</h2>
            <p>For questions, please contact: <a href="mailto:support@codeorbit.tech">support@codeorbit.tech</a></p>
          </div>
        </main>
        <footer class="site-footer">
          <div class="inner">
            <div>© <script>document.write(new Date().getFullYear())</script> Code Orbit</div>
            <nav>
              <a href="/">Home</a>
              <a href="/privacy">Privacy</a>
              <a href="/terms">Terms</a>
              <a href="/data-deletion">Data Deletion</a>
            </nav>
          </div>
        </footer>
      </body>
      </html>
    `);
  });
  app.get('/data-deletion', (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <!DOCTYPE html><html lang="en"><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Data Deletion Instructions • Code Orbit Agent</title>
        <link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/styles.css">${getVercelWebAnalyticsSnippet()}
        <style>
          body { background:#0b1220; color:#e5e7eb; }
          .doc { max-width: 920px; margin: 48px auto; padding: 24px; }
          .doc h1 { margin: 0 0 12px 0; }
          .doc h2 { margin: 18px 0 8px 0; font-size: 18px; color:#e5e7eb; }
          .doc p, .doc li { color:#cbd5e1; line-height:1.7; }
          .cardish { background:#0f172a; border:1px solid #1f2937; border-radius:12px; padding:24px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
          a { color:#60a5fa; } a:hover { color:#93c5fd; }
          .site-footer { max-width: 920px; margin: 0 auto 32px; padding: 16px 24px; color:#94a3b8; }
          .site-footer .inner { border-top:1px solid #1f2937; padding-top:16px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
          .site-footer nav a { color:#93c5fd; text-decoration:none; margin-right:12px; }
          .site-footer nav a:hover { color:#bfdbfe; }
        </style>
      </head><body>
        <main class="doc">
          <div class="cardish">
            <h1>Data Deletion Instructions</h1>
            <p>You can delete your account and associated data directly from the application at any time:</p>
            <ol>
              <li>Sign in to your account.</li>
              <li>Go to <strong>Settings</strong>.</li>
              <li>Scroll to the <strong>Danger</strong> section and click <strong>Delete my account data</strong>.</li>
              <li>Confirm the action. This permanently removes your data from our systems.</li>
            </ol>
            <p>If you are unable to access your account, email <a href="mailto:support@codeorbit.tech">support@codeorbit.tech</a> from the email address associated with the account and include “Data Deletion Request” in the subject. We will verify ownership and process the deletion.</p>
            <p>For additional privacy details, see our <a href="/privacy">Privacy Policy</a>.</p>
          </div>
        </main>
        <footer class="site-footer">
          <div class="inner">
            <div>© <script>document.write(new Date().getFullYear())</script> Code Orbit</div>
            <nav>
              <a href="/">Home</a>
              <a href="/privacy">Privacy</a>
              <a href="/terms">Terms</a>
              <a href="/data-deletion">Data Deletion</a>
            </nav>
          </div>
        </footer>
      </body></html>
    `);
  });
  app.get('/terms', (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <!DOCTYPE html><html lang="en"><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Terms of Service • Code Orbit Agent</title>
        <link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/styles.css">${getVercelWebAnalyticsSnippet()}
        <style>
          body { background:#0b1220; color:#e5e7eb; }
          .doc { max-width: 920px; margin: 48px auto; padding: 24px; }
          .doc h1 { margin: 0 0 12px 0; }
          .doc h2 { margin: 22px 0 10px 0; font-size: 18px; color:#e5e7eb; }
          .doc p, .doc li { color:#cbd5e1; line-height:1.7; }
          .muted { color:#94a3b8; font-size: 14px; }
          .cardish { background:#0f172a; border:1px solid #1f2937; border-radius:12px; padding:24px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
          a { color:#60a5fa; } a:hover { color:#93c5fd; }
          .site-footer { max-width: 920px; margin: 0 auto 32px; padding: 16px 24px; color:#94a3b8; }
          .site-footer .inner { border-top:1px solid #1f2937; padding-top:16px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
          .site-footer nav a { color:#93c5fd; text-decoration:none; margin-right:12px; }
          .site-footer nav a:hover { color:#bfdbfe; }
        </style>
      </head><body>
        <main class="doc">
          <div class="cardish">
            <h1>Terms of Service</h1>
            <p class="muted">Effective: <script>document.write(new Date().toLocaleDateString())</script></p>
            <p>Welcome to Code Orbit Agent. By accessing or using the Service, you agree to these Terms.</p>
            <h2>Use of Service</h2>
            <ul>
              <li>You must comply with all applicable laws and WhatsApp/Meta policies.</li>
              <li>You are responsible for content sent via your WhatsApp Business account.</li>
              <li>We may suspend or terminate accounts for abuse, security risks, or policy violations.</li>
            </ul>
            <h2>Accounts and Billing</h2>
            <ul>
              <li>You must provide accurate registration information.</li>
              <li>Paid plans renew per your subscription terms; fees are non‑refundable except as required by law.</li>
            </ul>
            <h2>Data and Privacy</h2>
            <p>See our <a href="/privacy">Privacy Policy</a> for how we handle data.</p>
            <h2>Disclaimers</h2>
            <p>The Service is provided “as is” without warranties. We do not guarantee uninterrupted or error‑free operation.</p>
            <h2>Limitation of Liability</h2>
            <p>To the fullest extent permitted by law, our total liability is limited to the amounts you paid in the 12 months preceding the claim.</p>
            <h2>Changes</h2>
            <p>We may update these Terms. Continued use of the Service after updates constitutes acceptance.</p>
            <h2>Contact</h2>
            <p>Questions about these Terms? Email <a href="mailto:support@codeorbit.tech">support@codeorbit.tech</a>.</p>
          </div>
        </main>
        <footer class="site-footer">
          <div class="inner">
            <div>© <script>document.write(new Date().getFullYear())</script> Code Orbit</div>
            <nav>
              <a href="/">Home</a>
              <a href="/privacy">Privacy</a>
              <a href="/terms">Terms</a>
              <a href="/data-deletion">Data Deletion</a>
            </nav>
          </div>
        </footer>
      </body></html>
    `);
  });
  app.get("/ics", (req, res) => {
    try{
      const t = (v) => String(v||'').trim();
      const title = t(req.query.title) || 'Appointment';
      const start = t(req.query.start);      const end = t(req.query.end);
      const desc = t(req.query.desc) || '';
      const loc = t(req.query.loc) || '';
      if(!start || !end){ return res.status(400).send('Missing start/end'); }
      const toCal = (iso) => {
        const d = new Date(iso);
        const pad = (n)=>String(n).padStart(2,'0');
        return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
      };
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@wa-agent`;
      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//WA Agent//Calendar//EN',
        'CALSCALE:GREGORIAN',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${toCal(new Date().toISOString())}`,
        `DTSTART:${toCal(start)}`,
        `DTEND:${toCal(end)}`,
        `SUMMARY:${title.replace(/\n/g,' ')}`,
        `DESCRIPTION:${desc.replace(/\n/g,' ')}`,
        `LOCATION:${loc.replace(/\n/g,' ')}`,
        'END:VEVENT',
        'END:VCALENDAR'
      ];
      res.setHeader('Content-Type','text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="invite.ics"`);
      return res.end(lines.join('\r\n'));
    }catch(_){ return res.sendStatus(500); }
  });
  app.get('/wa-media/:userId/:mediaId', ensureAuthed, async (req, res) => {
    try {
      const requester = getCurrentUserId(req);
      const ownerId = String(req.params.userId || '').trim();
      const mediaId = String(req.params.mediaId || '').trim();
      if (!ownerId || !mediaId) return res.sendStatus(400);
      if (String(requester) !== ownerId) return res.sendStatus(403);

      const cfg = await getSettingsForUser(ownerId);
      const token = cfg?.whatsapp_token || process.env.WHATSAPP_TOKEN || null;
      if (!token) {
        return res.status(403).send('WhatsApp not configured for this tenant');
      }

      const fetch = (await import('node-fetch')).default;
      const metaResp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(mediaId)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!metaResp.ok) {
        const status = metaResp.status || 404;
        return res.sendStatus(status === 401 || status === 403 || status === 404 ? status : 404);
      }
      const metaJson = await metaResp.json();
      const url = metaJson?.url;
      if (!url) return res.sendStatus(404);
      const binResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!binResp.ok) return res.sendStatus(404);
      const ctype = binResp.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', ctype);
      res.setHeader('Cache-Control', 'private, max-age=300');
      await new Promise((resolve, reject) => {
        binResp.body.on('error', reject);
        binResp.body.on('end', resolve);
        binResp.body.pipe(res);
      });
    } catch (e) {
      try { res.sendStatus(500); } catch {}
    }
  });
  app.get('/api/diag/openai', async (req, res) => {
    try {
      const provided = String(req.query.key || req.headers['x-diag-key'] || '').trim();
      const expected = String(process.env.DIAG_SECRET || process.env.WEBHOOK_VERIFY_TOKEN || '').trim();
      if (!expected || provided !== expected) return res.status(401).json({ error: 'unauthorized' });

      const rawKey = String(process.env.OPENAI_API_KEY || '');
      const keyMeta = {
        present: !!rawKey,
        length: rawKey.length,
        startsWithSk: rawKey.startsWith('sk-'),
        startsWithQuote: /^["']/.test(rawKey),
        endsWithQuote: /["']$/.test(rawKey),
        hasWhitespace: /\s/.test(rawKey),
        tail: rawKey.slice(-4)
      };

      let openaiResult;
      try {
        const client = new OpenAI({ apiKey: rawKey });
        const resp = await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
          temperature: 0
        });
        openaiResult = {
          ok: true,
          content: resp?.choices?.[0]?.message?.content || '',
          model: resp?.model || null
        };
      } catch (err) {
        openaiResult = {
          ok: false,
          status: err?.status || err?.response?.status || null,
          code: err?.code || err?.error?.code || null,
          type: err?.type || err?.error?.type || null,
          message: err?.message || String(err)
        };
      }

      return res.json({ keyMeta, openai: openaiResult });
    } catch (e) {
      return res.status(500).json({ error: 'diag_failed', message: e?.message || String(e) });
    }
  });
}

