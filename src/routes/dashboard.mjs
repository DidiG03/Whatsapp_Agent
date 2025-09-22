import { ensureAuthed, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar } from "../utils.mjs";

export default function registerDashboardRoutes(app) {
  app.get("/dashboard", ensureAuthed, async (req, res) => {
    const email = await getSignedInEmail(req);
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
            <div class="crumbs">Home / Dashboard</div>
            <div class="small">${email ? `signed in as ${email}` : ''}</div>
          </div>
          <div class="layout">
            ${renderSidebar('dashboard')}
            <main class="main">
              <div class="card">Welcome! Use the sidebar to navigate.</div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });
}

