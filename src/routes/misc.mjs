import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { getSettingsForUser } from "../services/settings.mjs";

export default function registerMiscRoutes(app) {
  app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => res.sendStatus(204));
  // Friendly routes for legal pages
  app.get('/privacy', (_req, res) => res.sendFile('privacy.html', { root: 'public' }));
  app.get('/data-deletion', (_req, res) => res.sendFile('data-deletion.html', { root: 'public' }));
  app.get('/terms', (_req, res) => res.sendFile('terms.html', { root: 'public' }));
  // ICS: simple calendar invite generator for Apple/Google
  app.get("/ics", (req, res) => {
    try{
      const t = (v) => String(v||'').trim();
      const title = t(req.query.title) || 'Appointment';
      const start = t(req.query.start); // ISO
      const end = t(req.query.end);
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

  // Proxy WhatsApp media through our server so the browser doesn't need a token
  app.get('/wa-media/:userId/:mediaId', ensureAuthed, async (req, res) => {
    try {
      const requester = getCurrentUserId(req);
      const ownerId = String(req.params.userId || '').trim();
      const mediaId = String(req.params.mediaId || '').trim();
      if (!ownerId || !mediaId) return res.sendStatus(400);

      // Only allow fetching media for the signed-in user's own tenant
      if (String(requester) !== ownerId) return res.sendStatus(403);

      const cfg = await getSettingsForUser(ownerId);
      // Fallback: allow a global token for development if tenant token missing
      const token = cfg?.whatsapp_token || process.env.WHATSAPP_TOKEN || null;
      if (!token) {
        // Distinguish configuration vs not found for easier debugging
        return res.status(403).send('WhatsApp not configured for this tenant');
      }

      const fetch = (await import('node-fetch')).default;
      // Step 1: Resolve media URL
      const metaResp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(mediaId)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!metaResp.ok) {
        // Propagate meaningful status when possible (401/403/404)
        const status = metaResp.status || 404;
        return res.sendStatus(status === 401 || status === 403 || status === 404 ? status : 404);
      }
      const metaJson = await metaResp.json();
      const url = metaJson?.url;
      if (!url) return res.sendStatus(404);

      // Step 2: Download binary and stream back
      const binResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!binResp.ok) return res.sendStatus(404);
      // Propagate content-type if provided
      const ctype = binResp.headers.get('content-type') || 'application/octet-stream';
      res.setHeader('Content-Type', ctype);
      // Optionally allow short caching to reduce API calls
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
}

