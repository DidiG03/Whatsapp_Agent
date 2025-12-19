import { getCurrentUserId, verifySessionToken } from "../middleware/auth.mjs";
import { ONBOARD_STEPS, getOnboarding, setOnboarding } from "../services/onboarding.mjs";
import { renderTranscriptAsBubbles, getVercelWebAnalyticsSnippet } from "../utils.mjs";
import { upsertKbItem } from "../services/kb.mjs";
import { upsertSettingsForUser, getSettingsForUser } from "../services/settings.mjs";
import { parseDirectives, applyDirectives } from "../services/coachDirectives.mjs";
import { onboardingCoachReply } from "../services/ai.mjs";
import { KBItem } from "../schemas/mongodb.mjs";

export default function registerAssistantRoutes(app) {
  app.get("/assistant", (req, res) => {
    const token = req.query?.token;
    const userId = token ? verifySessionToken(token) : (req.query?.uid || getCurrentUserId(req));
    if (!userId) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(`<html><head><link rel="stylesheet" href="/styles.css">${getVercelWebAnalyticsSnippet()}</head><body><div class="small" style="padding:12px;">Please open the dashboard to sign in.</div></body></html>`);
    }
    const state = getOnboarding(userId) || setOnboarding(userId, { step: 0, transcript: '' });
    const chat = renderTranscriptAsBubbles(state.transcript);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html>
        <head>
          <link rel="stylesheet" href="/styles.css">
          ${getVercelWebAnalyticsSnippet()}
          <style>
            body {
              margin: 0;
              padding: 0;
              height: 100vh;
              display: flex;
              flex-direction: column;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            
            .kb-assistant-container {
              display: flex;
              flex-direction: column;
              height: 100vh;
              background: #f8f9fa;
            }
            
            .kb-assistant-chat {
              flex: 1;
              overflow-y: auto;
              padding: 16px;
              display: flex;
              flex-direction: column;
              gap: 12px;
            }
            
            .kb-assistant-empty {
              flex: 1;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              text-align: center;
              color: #6b7280;
            }
            
            .kb-assistant-empty-icon {
              width: 64px;
              height: 64px;
              background: #e5e7eb;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 16px;
              font-size: 24px;
            }
            
            .kb-assistant-empty-text {
              font-size: 16px;
              font-weight: 500;
              margin-bottom: 8px;
            }
            
            .kb-assistant-empty-subtext {
              font-size: 14px;
              color: #9ca3af;
            }
            
            .kb-assistant-input-container {
              background: white;
              border-top: 1px solid #e5e7eb;
              padding: 16px;
              box-shadow: 0 -1px 3px rgba(0,0,0,0.1);
            }
            
            .kb-assistant-form {
              display: flex;
              gap: 12px;
              align-items: flex-end;
            }
            
            .kb-assistant-input {
              flex: 1;
              border: 1px solid #d1d5db;
              border-radius: 20px;
              padding: 12px 16px;
              font-size: 14px;
              outline: none;
              transition: border-color 0.2s, box-shadow 0.2s;
              resize: none;
              min-height: 20px;
              max-height: 100px;
              font-family: inherit;
            }
            
            .kb-assistant-input:focus {
              border-color: #3b82f6;
              box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
            }
            
            .kb-assistant-input::placeholder {
              color: #9ca3af;
            }
            
            .kb-assistant-send {
              background: #3b82f6;
              color: white;
              border: none;
              border-radius: 20px;
              padding: 12px 20px;
              font-size: 14px;
              font-weight: 500;
              cursor: pointer;
              transition: background-color 0.2s;
              white-space: nowrap;
            }
            
            .kb-assistant-send:hover {
              background: #2563eb;
            }
            
            .kb-assistant-send:disabled {
              background: #9ca3af;
              cursor: not-allowed;
            }
            
            /* Chat bubbles */
            .chat-bubble {
              max-width: 80%;
              padding: 12px 16px;
              border-radius: 18px;
              font-size: 14px;
              line-height: 1.4;
              word-wrap: break-word;
            }
            
            .chat-bubble.user {
              background: #3b82f6;
              color: white;
              align-self: flex-end;
              border-bottom-right-radius: 4px;
            }
            
            .chat-bubble.assistant {
              background: white;
              color: #111827;
              border: 1px solid #e5e7eb;
              align-self: flex-start;
              border-bottom-left-radius: 4px;
            }
          </style>
        </head>
        <body>
          <div class="kb-assistant-container">
            <div class="kb-assistant-chat">
              ${chat || `
                <div class="kb-assistant-empty">
                  <div class="kb-assistant-empty-icon">💬</div>
                  <div class="kb-assistant-empty-text">How can I improve your KB?</div>
                  <div class="kb-assistant-empty-subtext">Ask me to add or improve your knowledge base</div>
                </div>
              `}
            </div>
            
            <div class="kb-assistant-input-container">
              <form method="post" action="/assistant?token=${encodeURIComponent(String(token||''))}" class="kb-assistant-form">
                <textarea 
                  name="message" 
                  class="kb-assistant-input" 
                  placeholder="Ask me to add or improve your KB..."
                  rows="1"
                  required
                ></textarea>
                <button type="submit" class="kb-assistant-send">Send</button>
              </form>
            </div>
          </div>
          
          <script>
            // Auto-resize textarea
            const textarea = document.querySelector('.kb-assistant-input');
            textarea.addEventListener('input', function() {
              this.style.height = 'auto';
              this.style.height = Math.min(this.scrollHeight, 100) + 'px';
            });
            
            // Auto-focus input
            textarea.focus();
            
            // Scroll to bottom on load
            const chat = document.querySelector('.kb-assistant-chat');
            chat.scrollTop = chat.scrollHeight;
          </script>
        </body>
      </html>
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
      const titles = (await KBItem.find({ user_id: userId, title: { $ne: null } }).select('title').lean()).map(r => r.title);
      const history = state.transcript || "";
      // Apply AI preferences from settings
      const prefs = await getSettingsForUser(userId);
      let coach = await onboardingCoachReply(userMsg, titles, history, {
        tone: prefs?.ai_tone,
        style: prefs?.ai_style,
        blockedTopics: prefs?.ai_blocked_topics
      });
      coach = coach || "Got it.";

      const directives = parseDirectives(coach);
      // Preserve askLine and setLines for follow-up logic below
      const lines = coach.split('\n');
      const trimmed = lines.map(l => l.trim());
      const askLine = trimmed.find(l => /^ASK_MORE\|/.test(l));
      const setLines = trimmed.filter(l => /^SET\|/.test(l));
      const { summaries: savedSummaries, visible: appliedVisible } = await applyDirectives(userId, directives);
      let visible = appliedVisible;

      // Heuristics for common statements
      try {
        const lower = userMsg.toLowerCase();
        const extractSentence = (text, kw) => { try { const parts = text.split(/[.!?]/); const hit = parts.find(p => p.toLowerCase().includes(kw)); return (hit || '').trim() ? (hit.trim() + '.') : ''; } catch { return ''; } };
        const currentSettings = getSettingsForUser(userId) || {};
        const toUpdate = {};
        const pushSetting = (k,v) => { if (v) toUpdate[k] = v; };
        const bn = /\b(business|company)\s*name\s*(is|:)\s*([\p{L}\p{N} _'"&().-]{2,})/iu.exec(userMsg);
        if (bn && bn[3]) { const raw = bn[3].trim().replace(/^[\'"\s]+|[\'"\s]+$/g, ""); pushSetting('business_name', raw); await upsertKbItem(userId, 'Business Name', raw); savedSummaries.push('Saved “Business Name” to KB.'); }
        const ws = /\b(website|site|url)\s*(is|:)\s*(\S+)/i.exec(userMsg); if (ws && ws[3]) pushSetting('website_url', ws[3].trim());
        const ph = /\b(phone|number|contact)\s*(is|:)\s*([+\d][+\d\s().-]{6,})/i.exec(userMsg); if (ph && ph[3]) pushSetting('business_phone', ph[3].trim());
        if (Object.keys(toUpdate).length) { upsertSettingsForUser(userId, { ...currentSettings, ...toUpdate }); if (!visible) visible = 'Saved your settings.'; }
        if (/\bwe\s+are\b|\bwe\s+do\b|\bour\s+business\b|\bwe\s+sell\b|\brestaurant|cafe|salon|clinic|store|shop\b/i.test(userMsg)) { const sentence = extractSentence(userMsg,'we') || userMsg; await upsertKbItem(userId,'What We Do', sentence); savedSummaries.push('Saved “What We Do” to KB.'); }
        const hasDay = /(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(userMsg);
        const hasTime = /\b(\d{1,2})([:.][0-5]\d)?\s*(am|pm)?\b.*?-.*?\b(\d{1,2})([:.][0-5]\d)?\s*(am|pm)?\b/i.test(userMsg);
        if (hasDay || hasTime) { const sentence = extractSentence(userMsg,'mon') || extractSentence(userMsg,'sun') || userMsg; await upsertKbItem(userId,'Hours', sentence); savedSummaries.push('Saved “Hours” to KB.'); }
        if (/(street|st\.|ave\.|avenue|blvd\.|boulevard|road|rd\.|drive|dr\.|plaza|center|centre|city|town|village|address|located|location|near)/i.test(userMsg)) { const sentence = extractSentence(userMsg,'location') || extractSentence(userMsg,'address') || userMsg; await upsertKbItem(userId,'Locations', sentence); savedSummaries.push('Saved “Locations” to KB.'); }
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


