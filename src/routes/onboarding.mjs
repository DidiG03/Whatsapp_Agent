import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { ONBOARD_STEPS, getOnboarding, setOnboarding } from "../services/onboarding.mjs";
import { renderSidebar, renderTranscriptAsBubbles } from "../utils.mjs";
import { upsertKbItem } from "../services/kb.mjs";
import { kbCoachReply, onboardingCoachReply } from "../services/ai.mjs";
import { db } from "../db.mjs";

export default function registerOnboardingRoutes(app) {
  app.get("/onboarding", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const state = getOnboarding(userId) || setOnboarding(userId, { step: 0, transcript: '' });
    const stepDef = ONBOARD_STEPS[state.step];
    const prompt = 'Ask me to add or improve your KB...';
    const chat = renderTranscriptAsBubbles(state.transcript);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css"></head><body>
        <script>
          async function checkAuthThenSubmit(form){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return false;} }catch(e){ return false; }
            return true;
          }
        </script>
        <div class="container">
          <div class="topbar">
            <div class="crumbs"><a href="/dashboard">Dashboard</a> / Onboarding</div>
          </div>
          <div class="layout">
            ${renderSidebar('onboarding')}
            <main class="main">
              <div class="card chat-box">
                <div class="small" style="display:flex; align-items:center; gap:12px;">
                  ${stepDef ? '' : '<span><img src="/onboarding-complete.svg" alt="Onboarding complete" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>Onboarding complete.</span>'}
                  <form method="post" action="/onboarding/reset" style="margin:0;" onsubmit="return checkAuthThenSubmit(this)">
                    <button type="submit" style="background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe">
                      <img src="/restart-onboarding.svg" alt="Restart onboarding" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
                      Restart onboarding
                    </button>
                  </form>
                  <form method="post" action="/onboarding/clear" style="margin:0;" onsubmit="return checkAuthThenSubmit(this)">
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
    // Ignore legacy step prompts; always use AI-driven onboarding

    // AI-driven onboarding/KB coach (single path)
    if (!userMsg) return res.redirect("/onboarding");
    try {
      const titles = db.prepare(`SELECT title FROM kb_items WHERE user_id = ? AND title IS NOT NULL`).all(userId).map(r => r.title);
      const history = state.transcript || "";
      // Use onboarding coach so it can both ask for missing info and save KB entries
      let coach = await onboardingCoachReply(userMsg, titles, history);
      coach = coach || "Got it.";

      const lines = coach.split('\n');
      const trimmed = lines.map(l => l.trim());
      const addLines = trimmed.filter(l => /^ADD_KB\|/.test(l));
      const askLine = trimmed.find(l => /^ASK_MORE\|/.test(l));
      const completeLine = trimmed.find(l => /^COMPLETE$/.test(l));

      // Visible part excludes directives
      let visible = lines.filter(l => !/^ADD_KB\|/.test(l.trim()) && !/^ASK_MORE\|/.test(l.trim())).join('\n');
      visible = visible.trim();

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

      const askFollow = askLine ? (askLine.split('|')[1] || '').trim() : '';
      let aiReply = visible;
      if (savedSummaries.length) {
        aiReply = (aiReply ? aiReply + '\n' : '') + savedSummaries.join('\n');
      }
      if (askFollow) {
        aiReply = (aiReply ? aiReply + '\n' : '') + askFollow;
      }
      if (completeLine) {
        aiReply = (aiReply ? aiReply + '\n' : '') + 'Thank you. The onboarding process is completed.';
      }

      const newTranscript = `${state.transcript}${state.transcript ? '\n\n' : ''}You: ${userMsg}\nAI: ${aiReply}`;
      setOnboarding(userId, { step: state.step ?? 0, transcript: newTranscript });
    } catch (e) {
      const newTranscript = `${state.transcript}${state.transcript ? '\n\n' : ''}You: ${userMsg}\nAI: Sorry, I hit an error saving. Please try again.`;
      setOnboarding(userId, { step: state.step ?? 0, transcript: newTranscript });
    }
    return res.redirect("/onboarding");
  });

  app.post("/onboarding/reset", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      const titles = ONBOARD_STEPS.map(s => s.title);
      const placeholders = titles.map(() => '?').join(',');
      db.prepare(`DELETE FROM kb_items WHERE user_id = ? AND title IN (${placeholders})`).run(userId, ...titles);
      setOnboarding(userId, { step: 0, transcript: '' });
    } catch {}
    return res.redirect("/onboarding");
  });

  // Clear only the transcript (keep step and KB entries)
  app.post("/onboarding/clear", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    try {
      const current = getOnboarding(userId) || { step: 999, transcript: '' };
      setOnboarding(userId, { step: current.step ?? 999, transcript: '' });
    } catch {}
    return res.redirect("/onboarding");
  });
}

