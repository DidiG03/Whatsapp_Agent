import { getCurrentUserId, verifySessionToken } from "../middleware/auth.mjs";
import { ONBOARD_STEPS, getOnboarding, setOnboarding } from "../services/onboarding.mjs";
import { renderTranscriptAsBubbles } from "../utils.mjs";
import { upsertKbItem } from "../services/kb.mjs";
import { upsertSettingsForUser, getSettingsForUser } from "../services/settings.mjs";
import { onboardingCoachReply } from "../services/ai.mjs";
import { db } from "../db.mjs";

export default function registerAssistantRoutes(app) {
  app.get("/assistant", (req, res) => {
    const token = req.query?.token;
    const userId = token ? verifySessionToken(token) : (req.query?.uid || getCurrentUserId(req));
    if (!userId) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(`<html><head><link rel="stylesheet" href=\"/styles.css\"></head><body><div class=\"small\" style=\"padding:12px;\">Please open the dashboard to sign in.</div></body></html>`);
    }
    const state = getOnboarding(userId) || setOnboarding(userId, { step: 0, transcript: '' });
    const chat = renderTranscriptAsBubbles(state.transcript);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css"></head><body>
        <div class="chat-box" style="padding:12px;">
          ${chat}
        </div>
        <form method="post" action="/assistant?token=${encodeURIComponent(String(token||''))}" style="display:grid; grid-template-columns: 1fr auto; gap:8px; padding:12px;">
          <input type="text" name="message" class="settings-field" placeholder="Ask me to add or improve your KB..."/>
          <button type="submit" class="send">Send</button>
        </form>
      </body></html>
    `);
  });

  app.post("/assistant", async (req, res) => {
    const token = req.query?.token || req.body?.token;
    const userId = token ? verifySessionToken(token) : (req.query?.uid || req.body?.uid || getCurrentUserId(req));
    if (!userId) return res.redirect('/auth');
    const userMsg = (req.body?.message || '').toString().trim();
    const state = getOnboarding(userId) || { step: 0, transcript: '' };
    if (!userMsg) return res.redirect("/assistant");
    try {
      const titles = db.prepare(`SELECT title FROM kb_items WHERE user_id = ? AND title IS NOT NULL`).all(userId).map(r => r.title);
      const history = state.transcript || "";
      let coach = await onboardingCoachReply(userMsg, titles, history);
      coach = coach || "Got it.";

      const lines = coach.split('\n');
      const trimmed = lines.map(l => l.trim());
      const addLines = trimmed.filter(l => /^ADD_KB\|/.test(l));
      const askLine = trimmed.find(l => /^ASK_MORE\|/.test(l));
      const setLines = trimmed.filter(l => /^SET\|/.test(l));

      let visible = lines
        .filter(l => { const t = l.trim(); return !/^ADD_KB\|/.test(t) && !/^ASK_MORE\|/.test(t) && !/^SET\|/.test(t) && t !== 'COMPLETE'; })
        .join('\n')
        .trim();

      const savedSummaries = [];
      for (const l of addLines) {
        const m = /^ADD_KB\|(.*)\|(.*)$/.exec(l);
        if (!m) continue;
        const title = (m[1] || '').trim().slice(0, 120) || 'Untitled';
        const content = (m[2] || '').trim();
        if (content) {
          upsertKbItem(userId, title, content);
          savedSummaries.push(`Saved “${title}” to KB.`);
        }
      }

      if (setLines.length) {
        const current = getSettingsForUser(userId) || {};
        const updates = { };
        let entryGreetingVal = '';
        for (const l of setLines) {
          const m = /^SET\|(.*?)\|(.*)$/.exec(l);
          if (!m) continue;
          const key = (m[1] || '').trim();
          const value = (m[2] || '').trim();
          if (key && value) {
            updates[key] = value;
            if (key === 'entry_greeting') entryGreetingVal = value;
          }
        }
        if (Object.keys(updates).length) {
          upsertSettingsForUser(userId, { ...current, ...updates });
          try {
            if (updates.business_name) { upsertKbItem(userId, 'Business Name', updates.business_name); savedSummaries.push('Saved “Business Name” to KB.'); }
            if (updates.website_url) { upsertKbItem(userId, 'Website', updates.website_url); savedSummaries.push('Saved “Website” to KB.'); }
            if (updates.business_phone) { upsertKbItem(userId, 'Contact', updates.business_phone); savedSummaries.push('Saved “Contact” to KB.'); }
          } catch {}
          if (!visible) {
            if (entryGreetingVal) visible = entryGreetingVal; else if (updates.business_name) visible = `Saved business name: ${updates.business_name}`; else visible = 'Saved your settings.';
          }
        }
      }

      // Heuristics for common statements
      try {
        const lower = userMsg.toLowerCase();
        const extractSentence = (text, kw) => { try { const parts = text.split(/[.!?]/); const hit = parts.find(p => p.toLowerCase().includes(kw)); return (hit || '').trim() ? (hit.trim() + '.') : ''; } catch { return ''; } };
        const currentSettings = getSettingsForUser(userId) || {};
        const toUpdate = {};
        const pushSetting = (k,v) => { if (v) toUpdate[k] = v; };
        const bn = /\b(business|company)\s*name\s*(is|:)\s*([\p{L}\p{N} _'"&().-]{2,})/iu.exec(userMsg);
        if (bn && bn[3]) { const raw = bn[3].trim().replace(/^[\'"\s]+|[\'"\s]+$/g, ""); pushSetting('business_name', raw); upsertKbItem(userId, 'Business Name', raw); savedSummaries.push('Saved “Business Name” to KB.'); }
        const ws = /\b(website|site|url)\s*(is|:)\s*(\S+)/i.exec(userMsg); if (ws && ws[3]) pushSetting('website_url', ws[3].trim());
        const ph = /\b(phone|number|contact)\s*(is|:)\s*([+\d][+\d\s().-]{6,})/i.exec(userMsg); if (ph && ph[3]) pushSetting('business_phone', ph[3].trim());
        if (Object.keys(toUpdate).length) { upsertSettingsForUser(userId, { ...currentSettings, ...toUpdate }); if (!visible) visible = 'Saved your settings.'; }
        if (/\bwe\s+are\b|\bwe\s+do\b|\bour\s+business\b|\bwe\s+sell\b|\brestaurant|cafe|salon|clinic|store|shop\b/i.test(userMsg)) { const sentence = extractSentence(userMsg,'we') || userMsg; upsertKbItem(userId,'What We Do', sentence); savedSummaries.push('Saved “What We Do” to KB.'); }
        const hasDay = /(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(userMsg);
        const hasTime = /\b(\d{1,2})([:.][0-5]\d)?\s*(am|pm)?\b.*?-.*?\b(\d{1,2})([:.][0-5]\d)?\s*(am|pm)?\b/i.test(userMsg);
        if (hasDay || hasTime) { const sentence = extractSentence(userMsg,'mon') || extractSentence(userMsg,'sun') || userMsg; upsertKbItem(userId,'Hours', sentence); savedSummaries.push('Saved “Hours” to KB.'); }
        if (/(street|st\.|ave\.|avenue|blvd\.|boulevard|road|rd\.|drive|dr\.|plaza|center|centre|city|town|village|address|located|location|near)/i.test(userMsg)) { const sentence = extractSentence(userMsg,'location') || extractSentence(userMsg,'address') || userMsg; upsertKbItem(userId,'Locations', sentence); savedSummaries.push('Saved “Locations” to KB.'); }
      } catch {}

      const askFollow = askLine ? (askLine.split('|')[1] || '').trim() : '';
      if (!visible && savedSummaries.length) visible = savedSummaries.join(' ');
      let aiReply = visible || (askFollow ? askFollow : '');
      if (!aiReply || !aiReply.trim()) aiReply = 'Got it.';
      if (!askFollow && !addLines.length) {
        const shouldAsk = setLines.length > 0 || savedSummaries.length > 0;
        if (shouldAsk) {
          const lower = userMsg.toLowerCase();
          let nextQ = '';
          if (/business\s*name|name/.test(lower) || /Business Name/.test(savedSummaries.join(' '))) nextQ = 'In one line, what do you sell or do?';
          else if (/What We Do/.test(savedSummaries.join(' '))) nextQ = 'What are your opening hours and locations?';
          if (!nextQ) nextQ = 'What are your opening hours?';
          aiReply = `${aiReply ? aiReply + ' ' : ''}${nextQ}`.trim();
        }
      }

      const newTranscript = `${state.transcript}${state.transcript ? '\n\n' : ''}You: ${userMsg}\nAI: ${aiReply}`;
      setOnboarding(userId, { step: state.step ?? 0, transcript: newTranscript });
    } catch {
      const newTranscript = `${state.transcript}${state.transcript ? '\n\n' : ''}You: ${userMsg}\nAI: Sorry, I hit an error saving. Please try again.`;
      setOnboarding(userId, { step: state.step ?? 0, transcript: newTranscript });
    }
    return res.redirect("/assistant");
  });
}


