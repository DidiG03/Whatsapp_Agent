export default function registerMiscRoutes(app) {
  app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => res.sendStatus(204));
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
}

