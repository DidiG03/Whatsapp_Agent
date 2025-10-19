import { isAuthenticated, getSignedInEmail } from "../middleware/auth.mjs";
import { renderTopbar, renderSidebar, getProfessionalHead } from "../utils.mjs";

export default function registerHomeRoutes(app) {
  app.get("/", async (req, res) => {
    const signedIn = isAuthenticated(req);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    
    if (signedIn) {
      // Show home page for signed-in users
      const email = await getSignedInEmail(req);
      res.end(`
        <html>${getProfessionalHead('Home')}<body>
          <div class="container">
            ${renderTopbar('Home', email)}
            <div class="layout">
              ${renderSidebar('home')}
              <main class="main">
                <div class="main-content">
                  <div class="card">
                  <h2>Welcome to WhatsApp Agent</h2>
                  <p>Manage your WhatsApp business conversations and automate customer interactions.</p>
                  
                  <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-top: 24px;">
                    <div class="card" style="text-align: center; padding: 24px;">
                      <h3>📱 Inbox</h3>
                      <p>View and manage your customer conversations</p>
                      <a href="/inbox" class="btn" style="margin-top: 12px; display: inline-block;">Open Inbox</a>
                    </div>
                    
                    <div class="card" style="text-align: center; padding: 24px;">
                      <h3>📊 Dashboard</h3>
                      <p>View analytics and manage appointments</p>
                      <a href="/dashboard" class="btn" style="margin-top: 12px; display: inline-block;">View Dashboard</a>
                    </div>
                    
                    <div class="card" style="text-align: center; padding: 24px;">
                      <h3>⚙️ Settings</h3>
                      <p>Configure your WhatsApp integration and preferences</p>
                      <a href="/settings" class="btn" style="margin-top: 12px; display: inline-block;">Open Settings</a>
                    </div>
                    
                    <div class="card" style="text-align: center; padding: 24px;">
                      <h3>📚 Knowledge Base</h3>
                      <p>Manage your AI assistant's knowledge and responses</p>
                      <a href="/kb" class="btn" style="margin-top: 12px; display: inline-block;">Manage KB</a>
                    </div>
                  </div>
                </div>
                </div>
              </main>
            </div>
          </div>
        </body></html>
      `);
    } else {
      // Show landing page for non-signed-in users
      res.end(`
        <html><head><title>WhatsApp Agent</title><link rel="stylesheet" href="/styles.css"></head><body>
          <div class="container">
            <header><h1>WhatsApp Agent</h1></header>
            <div class="card">
              <h2>Welcome to WhatsApp Agent</h2>
              <p>Automate your WhatsApp business conversations with AI-powered customer service.</p>
              <ul class="list">
                <li><a href="/auth">Sign in / Sign up</a></li>
              </ul>
            </div>
          </div>
        </body></html>
      `);
    }
  });
}

