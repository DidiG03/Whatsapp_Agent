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
          <script src="/toast.js"></script>
          
          <div class="container">
            ${renderTopbar('Home', email)}
          <div class="layout">
            ${renderSidebar('home', { showKb: true })}
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
          <footer style="max-width: 1200px; margin: 0 auto 32px; padding: 16px 24px; color:#94a3b8;">
            <div style="border-top:1px solid #1f2937; padding-top:16px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between;">
              <div>© <script>document.write(new Date().getFullYear())</script> Code Orbit</div>
              <nav>
                <a href="/" style="color:#93c5fd; text-decoration:none; margin-right:12px;">Home</a>
                <a href="/privacy" style="color:#93c5fd; text-decoration:none; margin-right:12px;">Privacy</a>
                <a href="/terms" style="color:#93c5fd; text-decoration:none; margin-right:12px;">Terms</a>
                <a href="/data-deletion" style="color:#93c5fd; text-decoration:none;">Data Deletion</a>
              </nav>
            </div>
          </footer>
        </body></html>
      `);
    } else {
      // Show landing page for non-signed-in users
      res.end(`
        <html>${getProfessionalHead('Welcome')}<body class="landing-body">
          <div class="landing-hero">
            <div class="landing-copy">
              <h1 class="landing-title">
                <span class="landing-line">Your Vision</span><br/>
                <span class="landing-line landing-accent">Our Expertise</span><br/>
                <span class="landing-line landing-dots">Your Success</span>
              </h1>
              <p class="landing-subtitle">
                Automate your WhatsApp business conversations with AI‑powered customer service.
                Faster replies, smarter triage, and effortless bookings — all in one place.
              </p>
              <div class="landing-actions">
                <a href="/auth" class="btn btn-primary">Sign in / Sign up</a>
                <a href="#features" class="btn-ghost" style="margin-left:12px;">Learn more</a>
              </div>
            </div>
            <div class="landing-art">
              <div class="landing-visual">
                <img src="/entry-image.png" alt="WhatsApp Agent" width="510" height="410"/>
              </div>
            </div>
          </div>
          
          <section id="features" class="landing-section">
            <header class="features-header">
              <h2 class="features-title">Everything you need to run WhatsApp at scale</h2>
            </header>
            <div class="features-grid">
              <div class="feature-card">
                <div class="feature-icon">💬</div>
                <h3 class="feature-title">Unified Inbox</h3>
                <p class="feature-text">All customer conversations in one place with search, tags and quick triage.</p>
              </div>
              <div class="feature-card">
                <div class="feature-icon">🤖</div>
                <h3 class="feature-title">AI Replies</h3>
                <p class="feature-text">Smart suggestions and automated answers trained on your knowledge base.</p>
              </div>
              <div class="feature-card">
                <div class="feature-icon">📅</div>
                <h3 class="feature-title">Bookings</h3>
                <p class="feature-text">Share one‑tap booking links and manage appointments right from the inbox.</p>
              </div>
              <div class="feature-card">
                <div class="feature-icon">📣</div>
                <h3 class="feature-title">Campaigns</h3>
                <p class="feature-text">Send templates and broadcasts with delivery insights and guardrails.</p>
              </div>
              <div class="feature-card">
                <div class="feature-icon">📈</div>
                <h3 class="feature-title">Analytics</h3>
                <p class="feature-text">Track response time, CSAT, message trends and team performance.</p>
              </div>
              <div class="feature-card">
                <div class="feature-icon">🔐</div>
                <h3 class="feature-title">Secure & Scalable</h3>
                <p class="feature-text">Enterprise‑grade security, auditability and rate‑limited APIs out of the box.</p>
              </div>
            </div>
          </section>
          
          <section class="split-section" data-parallax-section>
            <div class="split-copy">
              <div class="eyebrow">HOW IT WORKS</div>
              <h2 class="giant-heading">
                <span class="landing-line">Connect WhatsApp</span>
                <span class="landing-line landing-accent">Train the Agent</span>
                <span class="landing-line landing-dots">Start Replying</span>
              </h2>
              <p class="split-text">Plug in your WhatsApp Cloud API credentials, add your FAQs and internal knowledge, set tone and guardrails, and go live in minutes. The unified inbox keeps your team in control while the agent drafts high‑quality replies, books appointments, and logs outcomes automatically.</p>
            </div>
            <div class="split-media">
              <div class="parallax-card" data-parallax-speed="0.25">
                <img src="/meta-whatsapp-image.png" alt="WhatsApp Agent" class="" width="510" height="410"/>

              </div>
            </div>
          </section>
          
          <section class="split-section reverse" data-parallax-section>
            <div class="split-copy">
              <div class="eyebrow">PRODUCT FEATURES</div>
              <h2 class="giant-heading">
                <span class="landing-line">Campaigns & Bookings</span>
                <span class="landing-line landing-accent">Analytics & CSAT</span>
                <span class="landing-line landing-dots">Security by Default.</span>
              </h2>
              <p class="split-text">Send template broadcasts with delivery guardrails, share one‑tap booking links, and track response time, volume, and CSAT on a real‑time dashboard. Role‑based access, signed media links and rate‑limited APIs are built‑in so you can scale safely.</p>
            </div>
            <div class="split-media">
              <div class="parallax-card glow" data-parallax-speed="0.35">
                <img src="/bot-last-image.png" alt="CodeOrbit" width="510" height="410"/>
              </div>
            </div>
          </section>
          <footer style="max-width: 1200px; margin: 0 auto 32px; padding: 16px 24px; color:#94a3b8;">
            <div style="border-top:1px solid #1f2937; padding-top:16px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between;">
              <div>© <script>document.write(new Date().getFullYear())</script> Code Orbit</div>
              <nav>
                <a href="/" style="color:#93c5fd; text-decoration:none; margin-right:12px;">Home</a>
                <a href="/privacy" style="color:#93c5fd; text-decoration:none; margin-right:12px;">Privacy</a>
                <a href="/terms" style="color:#93c5fd; text-decoration:none; margin-right:12px;">Terms</a>
                <a href="/data-deletion" style="color:#93c5fd; text-decoration:none;">Data Deletion</a>
              </nav>
            </div>
          </footer>
        </body></html>
      `);
    }
  });
}

