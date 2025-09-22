import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { ONBOARD_STEPS, getOnboarding, setOnboarding } from "../services/onboarding.mjs";
import { renderSidebar, renderTranscriptAsBubbles } from "../utils.mjs";
import { upsertKbItem } from "../services/kb.mjs";
import { db } from "../db.mjs";

export default function registerOnboardingRoutes(app) {
  app.get("/onboarding", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const state = getOnboarding(userId) || setOnboarding(userId, { step: 0, transcript: '' });
    const stepDef = ONBOARD_STEPS[state.step];
    const prompt = stepDef ? stepDef.prompt : 'All set! You can go to your Inbox.';
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
              <div class="card chat-box">${chat}</div>
              <div class="spacer"></div>
              ${stepDef ? `
              <form style="display:flex;" method="post" action="/onboarding" class="section" onsubmit="return checkAuthThenSubmit(this)">
                <input type="text" name="message" placeholder="${prompt}"/>
                <button type="submit" class="send">Send</button>
              </form>` : `
              <div class="section small" style="display:flex; align-items:center; gap:12px;">
                <span>Onboarding complete.</span>
                <a href="/inbox">Go to Inbox</a>
                <form method="post" action="/onboarding/reset" style="margin:0;" onsubmit="return checkAuthThenSubmit(this)">
                  <button type="submit" style="background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe">Restart onboarding</button>
                </form>
              </div>
              `}
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  app.post("/onboarding", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const userMsg = (req.body?.message || '').toString().trim();
    const state = getOnboarding(userId) || { step: 0, transcript: '' };
    const stepDef = ONBOARD_STEPS[state.step];
    if (!stepDef) {
      return res.redirect("/onboarding");
    }
    if (userMsg) {
      upsertKbItem(userId, stepDef.title, userMsg);
    }
    const newTranscript = `${state.transcript}${state.transcript ? '\n\n' : ''}You: ${userMsg}\nAI: Saved to ${stepDef.title}.`;
    const nextStep = state.step + 1;
    setOnboarding(userId, { step: nextStep >= ONBOARD_STEPS.length ? 999 : nextStep, transcript: newTranscript });
    if (nextStep >= ONBOARD_STEPS.length) {
      return res.redirect("/inbox");
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
}

