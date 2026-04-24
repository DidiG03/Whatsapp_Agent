import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { ONBOARD_STEPS, getOnboarding, setOnboarding } from "../services/onboarding.mjs";
import { renderSidebar, renderTranscriptAsBubbles, renderTopbar, getVercelWebAnalyticsSnippet } from "../utils.mjs";
import { upsertKbItem } from "../services/kb.mjs";
import { upsertSettingsForUser, getSettingsForUser } from "../services/settings.mjs";
import { onboardingCoachReply } from "../services/ai.mjs";
import { KBItem } from "../schemas/mongodb.mjs";
import { parseDirectives, applyDirectives } from "../services/coachDirectives.mjs";
import { getPlanStatus } from "../services/usage.mjs";

export default function registerOnboardingRoutes(app) {
  app.get("/onboarding", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const email = await getSignedInEmail(req);
    const { isUpgraded } = await getPlanStatus(userId);
    const state = getOnboarding(userId) || setOnboarding(userId, { step: 0, transcript: '' });
    const stepDef = ONBOARD_STEPS[state.step];
    const prompt = 'Ask me to add or improve your KB...';
    const chat = renderTranscriptAsBubbles(state.transcript);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css">${getVercelWebAnalyticsSnippet()}</head><body>
        <script src="/auth-utils.js"></script>
        <script>
          // Enhanced authentication check on page load
          (async function checkAuthOnLoad(){
            await window.authManager.checkAuthOnLoad();
          })();
          
          // Enhanced auth check for form submission
          async function checkAuthThenSubmit(form){
            return window.authManager.submitFormWithAuth(form);
          }
        </script>
        <div class="container">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / Onboarding`, email)}
          <div class="layout">
            ${renderSidebar('onboarding', { isUpgraded })}
            <main class="main">
              <div class="card chat-box">
                <div class="small" style="display:flex; align-items:center; gap:12px;">
                  ${stepDef ? '' : '<span><img src="/onboarding-complete.svg" alt="Onboarding complete" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>Onboarding complete.</span>'}
                  <form method="post" action="/onboarding/reset" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;" style="margin:0;">
                    <button type="submit" style="background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe">
                      <img src="/restart-onboarding.svg" alt="Restart onboarding" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
                      Restart onboarding
                    </button>
                  </form>
                  <form method="post" action="/onboarding/clear" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;" style="margin:0;">
                    <button type="submit" style="background:#f3f4f6;color:#111827;border:1px solid #e5e7eb">
                      <img src="/clear-chat-icon.svg" alt="Clear chat" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
                      Clear chat
                    </button>
                  </form>
                </div>
                ${chat}
              </div>
              <div class="spacer"></div>
              ${`
              <form style="display:flex;" method="post" action="/onboarding" class="section" onsubmit="return checkAuthThenSubmit(this)">
                <input type="text" name="message" placeholder="${prompt}"/>
                <button type="submit" class="send">Send</button>
              </form>
              `}
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  app.post("/onboarding", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const userMsg = (req.body?.message || '').toString().trim();
    const state = getOnboarding(userId) || { step: 0, transcript: '' };
    const stepDef = ONBOARD_STEPS[state.step];
    if (!userMsg) return res.redirect("/onboarding");
    try {
      const titles = (await KBItem.find({ user_id: userId, title: { $ne: null } }).select('title').lean()).map(r => r.title);
      const history = state.transcript || "";
      const prefs = await getSettingsForUser(userId);
      let coach = await onboardingCoachReply(userMsg, titles, history, {
        tone: prefs?.ai_tone,
        style: prefs?.ai_style,
        blockedTopics: prefs?.ai_blocked_topics
      });
      coach = coach || "Got it.";

      const directives = parseDirectives(coach);
      const lines = coach.split('\n');
      const trimmed = lines.map(l => l.trim());
      const askLine = trimmed.find(l => /^ASK_MORE\|/.test(l));
      const setLines = trimmed.filter(l => /^SET\|/.test(l));
      const completeLine = trimmed.find(l => /^COMPLETE$/.test(l));
      const { summaries: savedSummaries, visible: appliedVisible } = await applyDirectives(userId, directives);
      let visible = appliedVisible;
      if (setLines.length) {
        const current = getSettingsForUser(userId) || {};
        const updates = { };
        const updatedKeys = [];
        let entryGreetingVal = '';
        for (const l of setLines) {
          const m = /^SET\|(.*?)\|(.*)$/.exec(l);
          if (!m) continue;
          const key = (m[1] || '').trim();
          const value = (m[2] || '').trim();
          if (key && value) {
            updates[key] = value;
            updatedKeys.push(key);
            if (key === 'entry_greeting') entryGreetingVal = value;
          }
        }
        if (Object.keys(updates).length) {
          upsertSettingsForUser(userId, { ...current, ...updates });
          try {
            if (updates.business_name) {
              await upsertKbItem(userId, 'Business Name', updates.business_name);
              savedSummaries.push('Saved “Business Name” to KB.');
            }
            if (updates.website_url) {
              await upsertKbItem(userId, 'Website', updates.website_url);
              savedSummaries.push('Saved “Website” to KB.');
            }
            if (updates.business_phone) {
              await upsertKbItem(userId, 'Contact', updates.business_phone);
              savedSummaries.push('Saved “Contact” to KB.');
            }
          } catch {}
          if (!visible) {
            if (entryGreetingVal) {
              visible = entryGreetingVal;
            } else if (updates.business_name) {
              visible = `Saved business name: ${updates.business_name}`;
            } else {
              visible = 'Saved your settings.';
            }
          }
        }
      }
      try {
        const lower = userMsg.toLowerCase();
        const extractSentence = (text, kw) => {
          try {
            const parts = text.split(/[.!?]/);
            const hit = parts.find(p => p.toLowerCase().includes(kw));
            return (hit || '').trim() ? (hit.trim() + '.') : '';
          } catch { return ''; }
        };
        const currentSettings = getSettingsForUser(userId) || {};
        const toUpdate = {};
        const heuristicUpdatedKeys = [];
        const pushSetting = (key, value) => { if (value) { toUpdate[key] = value; heuristicUpdatedKeys.push(key); } };
        const bn = /\b(business|company)\s*name\s*(is|:)\s*([\p{L}\p{N} _'"&().-]{2,})/iu.exec(userMsg);
        if (bn && bn[3]) {
          const raw = bn[3].trim().replace(/^[\'"\s]+|[\'"\s]+$/g, "");
          pushSetting('business_name', raw);
          await upsertKbItem(userId, 'Business Name', raw);
          savedSummaries.push('Saved “Business Name” to KB.');
        }
        const ws = /\b(website|site|url)\s*(is|:)\s*(\S+)/i.exec(userMsg);
        if (ws && ws[3]) pushSetting('website_url', ws[3].trim());
        const ph = /\b(phone|number|contact)\s*(is|:)\s*([+\d][+\d\s().-]{6,})/i.exec(userMsg);
        if (ph && ph[3]) pushSetting('business_phone', ph[3].trim());
        if (Object.keys(toUpdate).length) {
          upsertSettingsForUser(userId, { ...currentSettings, ...toUpdate });
          if (!visible) visible = 'Saved your settings.';
        }
        if (/\bwe\s+are\b|\bwe\s+do\b|\bour\s+business\b|\bwe\s+sell\b|\brestaurant|cafe|salon|clinic|store|shop\b/i.test(userMsg)) {
          const sentence = extractSentence(userMsg, 'we') || userMsg;
          await upsertKbItem(userId, 'What We Do', sentence);
          savedSummaries.push('Saved “What We Do” to KB.');
        }
        const hasDay = /(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(userMsg);
        const hasTime = /\b(\d{1,2})([:.][0-5]\d)?\s*(am|pm)?\b.*?-.*?\b(\d{1,2})([:.][0-5]\d)?\s*(am|pm)?\b/i.test(userMsg);
        if (hasDay || hasTime) {
          const sentence = extractSentence(userMsg, 'mon') || extractSentence(userMsg, 'sun') || userMsg;
          await upsertKbItem(userId, 'Hours', sentence);
          savedSummaries.push('Saved “Hours” to KB.');
        }
        if (/(street|st\.|ave\.|avenue|blvd\.|boulevard|road|rd\.|drive|dr\.|plaza|center|centre|city|town|village|address|located|location|near)/i.test(userMsg)) {
          const sentence = extractSentence(userMsg, 'location') || extractSentence(userMsg, 'address') || userMsg;
          await upsertKbItem(userId, 'Locations', sentence);
          savedSummaries.push('Saved “Locations” to KB.');
        }
        if (/\bcuisine\b/i.test(userMsg)) {
          const sentence = extractSentence(userMsg, 'cuisine') || userMsg;
          await upsertKbItem(userId, 'Cuisine', sentence);
          savedSummaries.push('Saved “Cuisine” to KB.');
        }
        let resText = '';
        const hasBoth = /accepts?\s+both/i.test(lower) || /we\s+accept\s+both/i.test(lower);
        const hasRes = /reservations?/.test(lower);
        const hasWalk = /walk-?ins?/.test(lower);
        if (hasBoth) { resText = 'We accept reservations and walk-ins.'; }
        else if (hasRes || hasWalk) {
          resText = `We accept ${hasRes ? 'reservations' : ''}${hasRes && hasWalk ? ' and ' : ''}${hasWalk ? 'walk-ins' : ''}.`;
        }
        if (resText) {
          await upsertKbItem(userId, 'Reservations', resText);
          savedSummaries.push('Saved “Reservations” to KB.');
        }
      } catch {}

      const askFollow = askLine ? (askLine.split('|')[1] || '').trim() : '';
      if (!visible && savedSummaries.length) {
        visible = savedSummaries.join(' ');
      }
      let aiReply = visible || (askFollow ? askFollow : '');
      if (!aiReply || !aiReply.trim()) aiReply = 'Got it.';
      if (!askFollow && !addLines.length) {
        const madeSettingChange = (typeof updatedKeys !== 'undefined' && updatedKeys.length) || /Saved “Business Name” to KB\./.test(savedSummaries.join(' '));
        const shouldAsk = madeSettingChange || (setLines.length > 0) || savedSummaries.length > 0;
        if (shouldAsk) {
          const lower = userMsg.toLowerCase();
          let nextQ = '';
          if (/business\s*name|name/.test(lower) || /SET\|business_name\|/i.test(setLines.join('\n')) || /Business Name/.test(savedSummaries.join(' '))) {
            nextQ = 'In one line, what do you sell or do?';
          } else if (/What We Do/.test(savedSummaries.join(' '))) {
            nextQ = "What are your opening hours and locations?";
          }
          if (!nextQ) nextQ = 'What are your opening hours?';
          aiReply = `${aiReply ? aiReply + ' ' : ''}${nextQ}`.trim();
        }
      }

      const newTranscript = `${state.transcript}${state.transcript ? '\n\n' : ''}You: ${userMsg}\nAI: ${aiReply}`;
      setOnboarding(userId, { step: state.step ?? 0, transcript: newTranscript });
    } catch (e) {
      const newTranscript = `${state.transcript}${state.transcript ? '\n\n' : ''}You: ${userMsg}\nAI: Sorry, I hit an error saving. Please try again.`;
      setOnboarding(userId, { step: state.step ?? 0, transcript: newTranscript });
    }
    return res.redirect("/onboarding");
  });

  app.post("/onboarding/reset", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      console.log("[ONBOARD][RESET] requested by", { userId });
      const titles = ONBOARD_STEPS.map(s => s.title);
      await KBItem.deleteMany({ user_id: userId, title: { $in: titles } });
      setOnboarding(userId, { step: 0, transcript: '' });
    } catch {}
    return res.redirect("/onboarding");
  });
  app.post("/onboarding/clear", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      console.log("[ONBOARD][CLEAR_CHAT] requested by", { userId });
      const current = getOnboarding(userId) || { step: 999, transcript: '' };
      setOnboarding(userId, { step: current.step ?? 999, transcript: '' });
    } catch {}
    return res.redirect("/onboarding");
  });
}

