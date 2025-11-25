import { isAuthenticated, getSignedInEmail, getCurrentUserId } from "../middleware/auth.mjs";
import { renderTopbar, renderSidebar, getProfessionalHead, escapeHtml } from "../utils.mjs";
import { getPlanStatus, getCurrentUsage, getUsageHistory } from "../services/usage.mjs";
import { generateUsageInsights } from "../services/ai.mjs";

export default function registerHomeRoutes(app) {
  app.get("/", async (req, res) => {
    const signedIn = isAuthenticated(req);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    
    if (signedIn) {
      const userId = getCurrentUserId(req);
      const [{ plan, isUpgraded }, usage, history] = await Promise.all([
        getPlanStatus(userId),
        getCurrentUsage(userId),
        getUsageHistory(userId, 6)
      ]);
      let insights = "";
      try {
        insights = await generateUsageInsights({ plan, usage, history });
      } catch (_) {}
      const fallbackInsights = "As soon as your WhatsApp agent has a bit more activity, this panel will highlight where it is strong and where you can improve.";
      // Escape HTML, then convert simple markdown-style **bold** to <strong> and keep line breaks.
      let safeInsights = escapeHtml(insights || fallbackInsights);
      safeInsights = safeInsights.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      const insightsHtml = safeInsights.replace(/\n/g, "<br/>");
      // Show home page for signed-in users
      const email = await getSignedInEmail(req);
      res.end(`
        <html>${getProfessionalHead('Home')}<body>
          <script src="/toast.js"></script>
          
          <div class="container">
            ${renderTopbar('Home', email)}
          <div class="layout">
            ${renderSidebar('home', { isUpgraded })}
              <main class="main">
                <div class="main-content">
                  <div>
                  <h2>Welcome to WhatsApp Agent</h2>
                  <p>Manage your WhatsApp business conversations and automate customer interactions.</p>
                  
                  <div class="card" style="margin-top:16px; padding:20px; display:flex; gap:16px; align-items:flex-start;">
                    <div style="flex-shrink:0; width:40px; height:40px; border-radius:999px; background:#eff6ff; display:flex; align-items:center; justify-content:center; font-size:22px;">🤖</div>
                    <div style="flex:1; max-height:320px; overflow-y:auto; padding-right:4px;">
                      <div class="small" style="text-transform:uppercase; letter-spacing:.08em; color:#64748b; font-weight:600; margin-bottom:4px;">AI Recap</div>
                      <h3 style="margin:0 0 4px 0;">How your WhatsApp agent is doing</h3>
                      <p class="small" style="margin:0 0 8px 0; color:#64748b;">Insights based on recent message volumes and plan limits.</p>
                      <div style="font-size:14px; line-height:1.6; color:#111827; white-space:pre-line;">${insightsHtml}</div>
                    </div>
                  </div>
                  
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
          <div class="landing-hero" style="margin-bottom: 200px;">
            <div class="landing-copy">
              <h1 class="landing-title">
                <span class="landing-line">Your Vision</span><br/>
                <span class="landing-line landing-accent">Our Expertise</span><br/>
                <span class="landing-line landing-dots">Your Success</span>
              </h1>
              <p class="landing-subtitle">
                Launch WhatsApp support with an AI co‑pilot for replies, routing, bookings and payments.
              </p>
              <div class="landing-actions">
                <a href="/auth" class="btn btn-primary">Sign in / Sign up</a>
                <a href="#features" class="btn-ghost" style="margin-left:12px;">See how it works</a>
                <a href="#pricing" class="btn-ghost" style="margin-left:12px;">Pricing</a>
              </div>
            </div>
            <div class="landing-art">
              <div class="landing-visual">
                <img src="/entry-image.png" alt="WhatsApp Agent" width="510" height="410"/>
              </div>
            </div>
          </div>
          
          <section id="features" class="landing-section" style="margin: 200px 0;">
            <header class="features-header">
              <h2 class="features-title">Build an unforgettable WhatsApp experience</h2>
            </header>
            <div class="feature-showcase">
              <article class="showcase-card">
                <div class="showcase-copy">
                  <h3>Unified Inbox with AI Co‑Pilot</h3>
                  <p class="clamp-2">One place for every chat. AI drafts on‑brand replies; your team approves with one tap.</p>
                  <ul class="ticks">
                    <li>Smart triage and assignment</li>
                    <li>Suggested replies with citations</li>
                    <li>Private notes and tags</li>
                  </ul>
                </div>
              </article>
              <article class="showcase-card">
                <div class="showcase-copy">
                  <h3>Bookings, Payments and Reminders</h3>
                  <p class="clamp-2">Share booking links, collect payments, and send reminders — right inside WhatsApp.</p>
                  <ul class="ticks">
                    <li>Calendar sync and availability</li>
                    <li>Payment links and receipts</li>
                    <li>No‑show prevention with reminders</li>
                  </ul>
                </div>
              </article>
              <article class="showcase-card">
                <div class="showcase-copy">
                  <h3>Campaigns with Guardrails</h3>
                  <p class="clamp-2">Broadcast approved templates, A/B test copy, and track results — safely and at scale.</p>
                  <ul class="ticks">
                    <li>Template management and approvals</li>
                    <li>Audience filters and scheduling</li>
                    <li>Delivery, read and reply analytics</li>
                  </ul>
                </div>
              </article>
            </div>
          </section>
          
          <section class="split-section" data-parallax-section style="margin: 200px 0;">
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
                <div class="how-media">
                <div class="card-ph calendar">
                  <div class="calendar-head">
                    <div class="avatars"></div>
                    <div class="cal-title">Presentation</div>
                    <div class="meta">30 min · Online</div>
                  </div>
                  <div class="calendar-grid">
                    <div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div>
                    <div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div>
                    <div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div>
                  </div>
                </div>
                <div class="photo-ph"></div>
              </div>
            </div>
          </section>          
          <section id="industries" class="industries-section" style="margin: 200px 0;">
            <header class="industries-header">
              <h2 class="features-title">Support for any business type</h2>
            </header>
            <div class="industries-grid">
              <article class="industry-card">
                <div class="industry-accent"></div>
                <h3 class="industry-title">AI</h3>
                <p class="industry-copy">Usage‑based messaging, agent handoff and knowledge routing for AI products and platforms.</p>
                <a class="learn-more" href="#pricing">Learn more</a>
                <div class="logo-row">
                  <span>OpenAI</span><span>Cursor</span><span>ElevenLabs</span>
                </div>
              </article>
              <article class="industry-card">
                <div class="industry-accent"></div>
                <h3 class="industry-title">SaaS</h3>
                <p class="industry-copy">Onboarding, billing reminders and in‑chat support connected to your stack.</p>
                <a class="learn-more" href="#integrations">Learn more</a>
                <div class="logo-row">
                  <span>Slack</span><span>Twilio</span><span>Notion</span>
                </div>
              </article>
              <article class="industry-card">
                <div class="industry-accent"></div>
                <h3 class="industry-title">Marketplace</h3>
                <p class="industry-copy">Multi‑party messaging, bookings and payments with audit trails and analytics.</p>
                <a class="learn-more" href="/plan">Learn more</a>
                <div class="logo-row">
                  <span>Booking</span><span>Shop</span><span>Local</span>
                </div>
              </article>
            </div>
          </section>

          <section class="split-section" style="margin: 200px 0;">
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
              <div class="split-image">
                <img src="/landing-icon.png" alt="CodeOrbit" width="610" height="450"/>
              </div>
            </div>
          </section>

          <section id="integrations" class="integrations-section" style="margin: 200px 0;">
            <header class="features-header">
              <h2 class="features-title">Works with the tools you already use</h2>
            </header>
            <div class="integrations-grid">
              <div class="integration-card">
                <div class="integration-logo stripe">
                  <img src="/stripe-icon.svg" alt="Stripe" width="28" height="28"/>
                </div>
                <div class="integration-copy">
                  <h3>Stripe</h3>
                  <p class="clamp-2">Collect payments in chat with links and receipts.</p>
                </div>
              </div>
              <div class="integration-card">
                <div class="integration-logo google">
                  <img src="/google-calendar-icon.png" alt="Google Calendar" width="28" height="28"/>
                </div>
                <div class="integration-copy">
                  <h3>Google Calendar</h3>
                  <p class="clamp-2">Sync availability and share one‑tap booking links.</p>
                </div>
              </div>
              <div class="integration-card">
                <div class="integration-logo google">
                  <img src="/whatsapp-icon.png" alt="WhatsApp" width="28" height="28"/>
                </div>
                <div class="integration-copy">
                  <h3>WhatsApp</h3>
                  <p class="clamp-2">Connect your WhatsApp business account and start chatting with your customers.</p>
                </div>
              </div>
              <div class="integration-card">
                <div class="integration-logo google">
                  <img src="/meta-icon.png" alt="Meta" width="28" height="28"/>
                </div>
                <div class="integration-copy">
                  <h3>Meta</h3>
                  <p class="clamp-2">Connect your Meta business account and start chatting with your customers.</p>
                </div>
              </div>
            </div>
          </section>

          <section id="pricing" class="pricing-section" style="margin: 200px 0;">
            <header class="features-header">
              <h2 class="features-title">Simple, transparent pricing</h2>
            </header>
            <div class="billing-toggle" style="display:flex; align-items:center; justify-content:center; gap:12px; margin: 16px 0 24px;">
              <div role="group" aria-label="Billing period" style="display:inline-flex; background:#0b1220; border:1px solid #1f2937; border-radius:999px; overflow:hidden;">
                <button type="button" class="billing-btn" data-billing="monthly" style="padding:8px 14px; background:#1f2937; color:#ffffff; border:none; cursor:pointer;">Monthly</button>
                <button type="button" class="billing-btn" data-billing="yearly" style="padding:8px 14px; background:transparent; color:#93c5fd; border:none; cursor:pointer;">Yearly <span style="margin-left:6px; font-size:12px; background:#0ea5e9; color:#0b1220; padding:2px 6px; border-radius:999px;">Save 15%</span></button>
              </div>
            </div>
            <div class="pricing-grid">
              <div class="price-card" style="display:flex; flex-direction:column; min-height: 460px;">
                <div class="price-card-head">
                  <h3>Free</h3>
                  <div class="price"><span id="free-price-number">$0</span><span id="free-price-unit">/mo</span></div>
                </div>
                <ul class="price-features">
                  <li>100 conversations / month</li>
                  <li>Unified inbox</li>
                  <li>Basic AI suggestions</li>
                  <li>Community support</li>
                </ul>
                <a href="/auth" class="btn btn-primary price-cta" style="margin-top:auto;">Get started</a>
              </div>
              <div class="price-card highlighted" style="display:flex; flex-direction:column; min-height: 460px;">
                <div class="price-card-head">
                  <h3>Starter</h3>
                  <div class="price"><span id="starter-price-number">$29</span><span id="starter-price-unit">/mo</span></div>
                  <div id="starter-price-discount" class="small" style="display:none; color:#94a3b8; margin-top:6px;">Billed yearly <span style="color:#e5e7eb;">$299</span> <span style="text-decoration:line-through; margin-left:6px;">$348</span></div>
                </div>
                <ul class="price-features">
                  <li>5,000 conversations / month</li>
                  <li>AI co‑pilot with knowledge</li>
                  <li>Bookings & payments</li>
                  <li>Campaigns & analytics</li>
                  <li>Email support</li>
                </ul>
                <a href="/plan" class="btn btn-primary price-cta" style="margin-top:auto;">Upgrade to Starter</a>
              </div>
            </div>
          </section>
          <script>
            (function () {
              const monthlyBtn = document.querySelector('[data-billing="monthly"]');
              const yearlyBtn = document.querySelector('[data-billing="yearly"]');
              if (!monthlyBtn || !yearlyBtn) return;
              const starterNumber = document.getElementById('starter-price-number');
              const starterUnit = document.getElementById('starter-price-unit');
              const starterDiscount = document.getElementById('starter-price-discount');
              const freeNumber = document.getElementById('free-price-number');
              const freeUnit = document.getElementById('free-price-unit');
              
              function setActive(mode) {
                if (mode === 'yearly') {
                  yearlyBtn.style.background = '#1f2937';
                  yearlyBtn.style.color = '#ffffff';
                  monthlyBtn.style.background = 'transparent';
                  monthlyBtn.style.color = '#93c5fd';
                } else {
                  monthlyBtn.style.background = '#1f2937';
                  monthlyBtn.style.color = '#ffffff';
                  yearlyBtn.style.background = 'transparent';
                  yearlyBtn.style.color = '#93c5fd';
                }
              }
              
              function setBilling(mode) {
                if (mode === 'yearly') {
                  if (starterNumber) starterNumber.textContent = '$299';
                  if (starterUnit) starterUnit.textContent = '/yr';
                  if (starterDiscount) starterDiscount.style.display = 'block';
                  if (freeNumber) freeNumber.textContent = '$0';
                  if (freeUnit) freeUnit.textContent = '/yr';
                } else {
                  if (starterNumber) starterNumber.textContent = '$29';
                  if (starterUnit) starterUnit.textContent = '/mo';
                  if (starterDiscount) starterDiscount.style.display = 'none';
                  if (freeNumber) freeNumber.textContent = '$0';
                  if (freeUnit) freeUnit.textContent = '/mo';
                }
                setActive(mode);
              }
              
              monthlyBtn.addEventListener('click', function(){ setBilling('monthly'); });
              yearlyBtn.addEventListener('click', function(){ setBilling('yearly'); });
              setBilling('monthly');
            })();
          </script>
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

