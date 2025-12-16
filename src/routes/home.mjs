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
        getUsageHistory(userId, 6),
      ]);

      let insights = "";
      try {
        insights = await generateUsageInsights({ plan, usage, history });
      } catch (_) {}

      const fallbackInsights =
        "As soon as your WhatsApp agent has a bit more activity, this panel will highlight where it is strong and where you can improve.";

      let safeInsights = escapeHtml(insights || fallbackInsights);
      safeInsights = safeInsights.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      const insightsHtml = safeInsights.replace(/\n/g, "<br/>");

      const email = await getSignedInEmail(req);

      res.end(`
        <html class="home-clean-html">${getProfessionalHead("Home")}
          <body class="home-clean home-app">
            <script src="/toast.js"></script>

            <div class="container">
              ${renderTopbar("Home", email)}
              <div class="layout">
                ${renderSidebar("home", { isUpgraded })}
                <main class="main">
                  <div class="main-content">
                    <h2 class="home-app-title">Home</h2>
                    <p class="home-app-subtitle">
                      Monitor usage, manage conversations, and improve your WhatsApp agent.
                    </p>

                    <div class="card home-app-recap">
                      <div class="home-app-recap-icon">🤖</div>
                      <div class="home-app-recap-body">
                        <div class="eyebrow">AI Recap</div>
                        <div class="home-app-recap-title">How your WhatsApp agent is doing</div>
                        <div class="home-app-recap-meta">
                          Insights based on recent message volumes and plan limits.
                        </div>
                        <div class="home-app-recap-insights">${insightsHtml}</div>
                      </div>
                    </div>

                    <div class="grid-4 home-app-shortcuts">
                      <div class="card home-app-shortcut">
                        <div class="home-app-shortcut-title">📱 Inbox</div>
                        <div class="feat-copy">View and manage customer conversations.</div>
                        <a href="/inbox" class="btn btn-primary home-app-shortcut-link">Open Inbox</a>
                      </div>
                      <div class="card home-app-shortcut">
                        <div class="home-app-shortcut-title">📊 Dashboard</div>
                        <div class="feat-copy">Analytics, appointments, and outcomes.</div>
                        <a href="/dashboard" class="btn btn-primary home-app-shortcut-link">View Dashboard</a>
                      </div>
                      <div class="card home-app-shortcut">
                        <div class="home-app-shortcut-title">⚙️ Settings</div>
                        <div class="feat-copy">Connect WhatsApp and set preferences.</div>
                        <a href="/settings" class="btn btn-primary home-app-shortcut-link">Open Settings</a>
                      </div>
                      <div class="card home-app-shortcut">
                        <div class="home-app-shortcut-title">📚 Knowledge Base</div>
                        <div class="feat-copy">Teach the assistant your policies and FAQs.</div>
                        <a href="/kb" class="btn btn-primary home-app-shortcut-link">Manage KB</a>
                      </div>
                    </div>

                  </div>
                </main>
              </div>
            </div>

            <footer class="m-footer">
              <div class="wrap m-footer-inner">
                <div>© <script>document.write(new Date().getFullYear())</script> Code Orbit</div>
                <nav class="footer-nav">
                  <a href="/">Home</a>
                  <a href="/privacy">Privacy</a>
                  <a href="/terms">Terms</a>
                  <a href="/data-deletion">Data Deletion</a>
                </nav>
              </div>
            </footer>
          </body>
        </html>
      `);
      return;
    }

    // LANDING (clean, white, clear message)
    res.end(`
      <html class="home-clean-html">${getProfessionalHead("Welcome")}
        <body class="home-clean home-landing">
          <header class="m-header">
            <div class="wrap m-header-inner">
              <a class="brand" href="/">
                <img src="/logo-icon.png" alt="Code Orbit" style="width:20px;height:27px;margin-bottom:8px;"/>
                <span>Code Orbit Agent</span>
              </a>
              <nav class="m-nav">
                <a href="#features">Features</a>
                <a href="#integrations">Integrations</a>
                <a href="#pricing">Pricing</a>
                <a href="/auth" class="btn btn-primary">Sign in</a>
              </nav>
              <a href="/auth" class="btn btn-primary" id="mobile-cta">Sign in</a>
            </div>
          </header>

          <main class="wrap">
            <section class="hero hero-z">
              <div class="hero-center">
                <div class="eyebrow">WHATSAPP-FIRST CUSTOMER OPS</div>
                <h1>Run support, bookings, and sales from <span class="headline-accent">WhatsApp</span>.</h1>
                <p>
                  One inbox for every chat. AI drafts replies, routes conversations, books appointments,
                  and shares payment links — with guardrails your team can trust.
                </p>
                <div class="hero-microcopy">Fast setup. Human control. Built for real businesses.</div>
                <form class="hero-form" action="/auth" method="get">
                  <label class="sr-only" for="work-email">Work email</label>
                  <input id="work-email" name="email" type="email" placeholder="Enter work email" autocomplete="email" />
                  <button type="submit" class="btn btn-primary">Try it for free</button>
                </form>
                <div class="hero-actions hero-actions-secondary">
                  <a href="#use-cases" class="btn btn-ghost">See use cases</a>
                  <a href="#pricing" class="btn btn-ghost">Pricing</a>
                </div>
              </div>
            </section>

            <section class="ai-globe" aria-label="Conversational AI, multilingual">
              <div class="ai-left">
                <div class="eyebrow">CONVERSATIONAL AI, FOR BUSINESS</div>
                <h2>AI that feels natural — at scale</h2>
                <p class="lead">
                  Human-like conversations, guided by your policies and knowledge base, so replies stay accurate and on-brand.
                </p>

                <div class="ai-points" role="list">
                  <div class="ai-point is-active" role="listitem">
                    <div class="ai-point-title">Low latency, real flow</div>
                    <div class="ai-point-copy">Fast replies that keep chats fluid — no robotic pauses.</div>
                  </div>
                  <div class="ai-point" role="listitem">
                    <div class="ai-point-title">Multilingual by default</div>
                    <div class="ai-point-copy">Handle customers in their language with consistent tone and rules.</div>
                  </div>
                  <div class="ai-point" role="listitem">
                    <div class="ai-point-title">Guardrails you control</div>
                    <div class="ai-point-copy">Approve templates, restrict claims, and keep audit-ready history.</div>
                  </div>
                </div>
              </div>

              <div class="ai-right" aria-hidden="true">
                <div class="globe-stage">
                  <svg class="globe-svg" viewBox="0 0 520 520" width="520" height="520" focusable="false" aria-hidden="true">
                    <defs>
                      <radialGradient id="glow" cx="50%" cy="40%" r="60%">
                        <stop offset="0%" stop-color="rgba(99,102,241,.35)"/>
                        <stop offset="60%" stop-color="rgba(99,102,241,.12)"/>
                        <stop offset="100%" stop-color="rgba(99,102,241,0)"/>
                      </radialGradient>
                      <linearGradient id="sphere" x1="30%" y1="20%" x2="70%" y2="80%">
                        <stop offset="0%" stop-color="rgba(99,102,241,.18)"/>
                        <stop offset="55%" stop-color="rgba(79,70,229,.10)"/>
                        <stop offset="100%" stop-color="rgba(79,70,229,.06)"/>
                      </linearGradient>
                    </defs>

                    <circle cx="260" cy="260" r="210" fill="url(#sphere)" />
                    <circle cx="260" cy="260" r="210" fill="url(#glow)" />
                    <circle cx="260" cy="260" r="210" fill="none" stroke="rgba(11,16,32,.18)" stroke-width="2"/>

                    <!-- latitude lines (stay fixed) -->
                    <ellipse cx="260" cy="170" rx="210" ry="60" fill="none" stroke="rgba(11,16,32,.10)" stroke-width="2"/>
                    <ellipse cx="260" cy="260" rx="210" ry="70" fill="none" stroke="rgba(11,16,32,.12)" stroke-width="2"/>
                    <ellipse cx="260" cy="350" rx="210" ry="60" fill="none" stroke="rgba(11,16,32,.10)" stroke-width="2"/>

                    <!-- longitude layer (drifts to simulate rotation around vertical axis) -->
                    <g class="globe-drift">
                      <ellipse cx="260" cy="260" rx="70" ry="210" fill="none" stroke="rgba(11,16,32,.12)" stroke-width="2"/>
                      <ellipse cx="260" cy="260" rx="140" ry="210" fill="none" stroke="rgba(11,16,32,.10)" stroke-width="2"/>
                      <ellipse cx="260" cy="260" rx="195" ry="210" fill="none" stroke="rgba(11,16,32,.08)" stroke-width="2"/>

                      <!-- subtle “nodes” so motion is readable -->
                      <circle cx="180" cy="210" r="3" fill="rgba(79,70,229,.35)"/>
                      <circle cx="335" cy="195" r="2.6" fill="rgba(99,102,241,.28)"/>
                      <circle cx="310" cy="320" r="3.2" fill="rgba(79,70,229,.30)"/>
                      <circle cx="215" cy="345" r="2.8" fill="rgba(99,102,241,.24)"/>
                      <circle cx="260" cy="150" r="2.4" fill="rgba(79,70,229,.28)"/>
                      <circle cx="390" cy="290" r="2.6" fill="rgba(99,102,241,.22)"/>
                    </g>
                  </svg>

                  <div class="lang-chip chip-fr"><span class="flag">🇫🇷</span><span>French</span></div>
                  <div class="lang-chip chip-es"><span class="flag">🇪🇸</span><span>Spanish</span></div>
                  <div class="lang-chip chip-pt"><span class="flag">🇵🇹</span><span>Portuguese</span></div>

                  <div class="lang-panel">
                    <div class="lang-row"><span class="flag">🇺🇸</span><span>English</span></div>
                    <div class="lang-row"><span class="flag">🇫🇷</span><span>French</span></div>
                    <div class="lang-row"><span class="flag">🇩🇪</span><span>German</span></div>
                    <div class="lang-row"><span class="flag">🇮🇳</span><span>Hindi</span></div>
                    <div class="lang-row"><span class="flag">🇪🇸</span><span>Spanish</span></div>
                    <div class="lang-row lang-more">View 30+ supported languages</div>
                  </div>
                </div>
              </div>
            </section>

            <section class="trust-bar" aria-label="Trusted by">
              <div class="trust-title">Trusted by teams who sell and support on WhatsApp</div>
              <div class="trust-logos" aria-hidden="true">
                <span>Retail</span>
                <span>Restaurants</span>
                <span>Clinics</span>
                <span>Agencies</span>
                <span>Services</span>
                <span>E-commerce</span>
              </div>
            </section>

            <section class="proof-strip" aria-label="Recognition">
              <div class="proof-left">
                <div class="eyebrow">OUR PLATFORM</div>
                <h2>More than replies — a full WhatsApp workflow system.</h2>
                <p class="lead">
                  Centralize chats, automate the repetitive parts, and keep the human touch where it matters — with audit-friendly guardrails.
                </p>
              </div>
              <div class="proof-badges" aria-hidden="true">
                <div class="badge-card">
                  <div class="badge-top">INBOX</div>
                  <div class="badge-title">One place for every chat</div>
                  <div class="badge-sub">Assign, tag, and collaborate</div>
                </div>
                <div class="badge-card">
                  <div class="badge-top">AI CO-PILOT</div>
                  <div class="badge-title">Drafts with guardrails</div>
                  <div class="badge-sub">Approve before sending</div>
                </div>
                <div class="badge-card">
                  <div class="badge-top">WORKFLOWS</div>
                  <div class="badge-title">Bookings + payments</div>
                  <div class="badge-sub">Close the loop in chat</div>
                </div>
              </div>
            </section>

            <section id="use-cases" class="use-cases" aria-label="Use cases">
              <div class="use-head">
                <div class="eyebrow">USE CASES</div>
                <h2>Designed for high-intent WhatsApp conversations</h2>
                <p class="lead">
                  Whether you’re handling support, taking bookings, or closing sales — the workflow stays clean.
                </p>
              </div>

              <div class="use-grid">
                <article class="use-card">
                  <div class="use-icon">🧭</div>
                  <h3>Support + triage</h3>
                  <p>Route chats to the right teammate with context, tags, and AI-drafted replies.</p>
                  <ul>
                    <li>Assignment + notes</li>
                    <li>Suggested replies</li>
                    <li>Knowledge answers</li>
                  </ul>
                </article>
                <article class="use-card">
                  <div class="use-icon">📅</div>
                  <h3>Bookings + reminders</h3>
                  <p>Turn “Are you available?” into confirmed appointments with fewer no‑shows.</p>
                  <ul>
                    <li>Calendar-friendly flow</li>
                    <li>Automated reminders</li>
                    <li>Reschedule in chat</li>
                  </ul>
                </article>
                <article class="use-card">
                  <div class="use-icon">💳</div>
                  <h3>Sales + payments</h3>
                  <p>Send quotes, follow up automatically, and share payment links when ready.</p>
                  <ul>
                    <li>Follow-up templates</li>
                    <li>Payment links</li>
                    <li>Conversion tracking</li>
                  </ul>
                </article>
              </div>
            </section>

            <section id="features" class="section">
              <div class="section-head">
                <div class="eyebrow">FEATURES</div>
                <h2>Everything you need to reply faster and convert more</h2>
                <p class="lead">
                  This isn’t “another chatbot”. It’s a WhatsApp workflow system: humans + AI, with guardrails.
                </p>
              </div>

              <div class="feature-layout">
                <div class="feature-text">
                  <p class="feature-paragraph">
                    Your customers already live in WhatsApp. This gives you a proper inbox, a safe AI assistant,
                    and the workflows to turn chats into outcomes — without losing control.
                  </p>
                  <p class="feature-paragraph">
                    Use AI to draft responses, route conversations, answer from your knowledge base, and follow up
                    with approved templates. Your team stays in the loop with clear guardrails.
                  </p>
                  <p class="feature-paragraph">
                    When you’re ready, add bookings + payments so you can close the loop directly in chat.
                  </p>
                </div>

                <aside class="card feature-card">
                  <div class="feat-title">What you get</div>
                  <p class="feat-copy">The essentials to run support and bookings from WhatsApp.</p>
                  <ul class="checklist">
                    <li>Unified inbox with assignment, tags, and notes</li>
                    <li>AI co-pilot with tone control + suggested replies</li>
                    <li>Knowledge base answers (FAQs, policies, docs)</li>
                    <li>Bookings + reminders to reduce no-shows</li>
                    <li>Payment links + receipts inside the chat</li>
                    <li>Campaign templates with tracking and guardrails</li>
                  </ul>
                </aside>
              </div>
            </section>

            <section class="story" aria-label="Customer story">
              <div class="story-media">
                <div class="story-photo">
                  <img class="story-photo-img" src="/entry-image.png" alt="WhatsApp Agent preview" width="980" height="520" />
                </div>
              </div>
              <div class="story-quote">
                <div class="eyebrow">CUSTOMER STORY</div>
                <blockquote>
                  “We finally run WhatsApp like a real channel. Faster replies, cleaner handoffs, and more bookings — with control.”
                </blockquote>
                <div class="story-byline">
                  <strong>Operations Lead</strong>
                  <span>Local services business</span>
                </div>
                <a href="#pricing" class="btn btn-ghost story-cta">See pricing</a>
              </div>
            </section>

            <section class="section">
              <div class="section-head">
                <div class="eyebrow">HOW IT WORKS</div>
                <h2>Connect → Train → Start replying</h2>
                <p class="lead">
                  Plug in WhatsApp Cloud API, add your FAQs/knowledge, set guardrails, and go live in minutes.
                </p>
              </div>

              <ol class="steps">
                <li>
                  <div class="step-title">Connect WhatsApp</div>
                  <div class="step-copy">Add your Cloud API credentials, verify your sender, and start receiving messages.</div>
                </li>
                <li>
                  <div class="step-title">Train the agent</div>
                  <div class="step-copy">Upload your FAQs and policies so replies stay accurate and on-brand.</div>
                </li>
                <li>
                  <div class="step-title">Operate with control</div>
                  <div class="step-copy">AI drafts, humans approve, analytics highlight what to improve.</div>
                </li>
              </ol>
            </section>

            <section id="integrations" class="section">
              <div class="section-head">
                <div class="eyebrow">INTEGRATIONS</div>
                <h2>Works with the tools you already use</h2>
                <p class="lead">Payments, scheduling, and messaging — connected.</p>
              </div>

              <ul class="integrations-list">
                <li>
                  <div class="integration-name">Stripe</div>
                  <div class="integration-copy">Collect payments in chat with links and receipts.</div>
                </li>
                <li>
                  <div class="integration-name">Google Calendar</div>
                  <div class="integration-copy">Sync availability and share booking links.</div>
                </li>
                <li>
                  <div class="integration-name">WhatsApp Cloud API</div>
                  <div class="integration-copy">Connect your business number and start replying.</div>
                </li>
                <li>
                  <div class="integration-name">Meta</div>
                  <div class="integration-copy">Official tooling and compliance-friendly scaling.</div>
                </li>
              </ul>
            </section>

            <section class="roi" aria-label="Return on investment">
              <div class="roi-inner">
                <div class="roi-top">
                  <div class="roi-left">
                    <div class="eyebrow">RETURN ON TIME</div>
                    <h2>Make WhatsApp a predictable channel.</h2>
                    <p class="lead">
                      Stop losing leads in DMs. Reduce response time, automate the repetitive parts, and keep the human touch where it matters.
                    </p>
                    <a href="/auth" class="btn btn-primary roi-cta">Try it for free</a>
                  </div>
                  <div class="roi-right">
                    <ul class="roi-bullets">
                      <li><strong>Improve time-to-value</strong><span>Works out of the box with clear setup steps.</span></li>
                      <li><strong>Reduce effort per conversation</strong><span>AI drafts and knowledge answers cut repetitive replies.</span></li>
                      <li><strong>Keep ops clean</strong><span>Bookings, payments, and templates keep everything in one place.</span></li>
                    </ul>
                  </div>
                </div>
                <div class="roi-stats" aria-hidden="true">
                  <div class="roi-stat">
                    <div class="roi-number">45%</div>
                    <div class="roi-label">Faster replies</div>
                  </div>
                  <div class="roi-stat">
                    <div class="roi-number">25%</div>
                    <div class="roi-label">Fewer no-shows</div>
                  </div>
                  <div class="roi-stat">
                    <div class="roi-number">2×</div>
                    <div class="roi-label">More conversions</div>
                  </div>
                </div>
              </div>
            </section>

            <section id="pricing" class="section">
              <div class="section-head">
                <div class="eyebrow">PRICING</div>
                <h2>Simple pricing that scales with usage</h2>
                <p class="lead">Start free. Upgrade when you have volume.</p>
              </div>

              <div class="billing-toggle">
                <div class="billing-group" role="group" aria-label="Billing period">
                  <button type="button" class="billing-btn is-active" data-billing="monthly">Monthly</button>
                  <button type="button" class="billing-btn" data-billing="yearly">
                    Yearly <span class="pill">Save 15%</span>
                  </button>
                </div>
              </div>

              <div class="pricing-grid">
                <div class="card price-card">
                  <div class="price-top">
                    <h3>Free</h3>
                    <div class="price"><span id="free-price-number">$0</span> <small id="free-price-unit">/mo</small></div>
                  </div>
                  <ul class="price-features">
                    <li>100 conversations / month</li>
                    <li>Unified inbox</li>
                    <li>Basic AI suggestions</li>
                    <li>Community support</li>
                  </ul>
                  <a href="/auth" class="btn btn-primary">Get started</a>
                </div>

                <div class="card price-card is-featured">
                  <div class="price-top">
                    <h3>Starter</h3>
                    <div class="price"><span id="starter-price-number">$29</span> <small id="starter-price-unit">/mo</small></div>
                  </div>
                  <div id="starter-price-discount" class="fineprint" style="display:none;">
                    Billed yearly: <strong>$299</strong> <span class="price-strike">$348</span>
                  </div>
                  <ul class="price-features">
                    <li>5,000 conversations / month</li>
                    <li>AI co-pilot with knowledge</li>
                    <li>Bookings & payments</li>
                    <li>Campaigns & analytics</li>
                    <li>Email support</li>
                  </ul>
                  <a href="/plan" class="btn btn-primary">Upgrade to Starter</a>
                </div>
              </div>
            </section>

            <section class="cta-band" aria-label="Call to action">
              <div class="cta-band-inner">
                <div class="cta-copy">
                  <h3>Make WhatsApp your fastest channel.</h3>
                  <p>Start free. Upgrade when you have volume.</p>
                </div>
                <div class="cta-actions">
                  <a href="/auth" class="btn btn-primary">Try it for free</a>
                  <a href="/auth" class="btn btn-ghost">Sign in</a>
                </div>
              </div>
            </section>
          </main>

          <footer class="m-footer">
            <div class="wrap m-footer-inner">
              <div>© <script>document.write(new Date().getFullYear())</script> Code Orbit</div>
              <nav class="footer-nav">
                <a href="/">Home</a>
                <a href="/privacy">Privacy</a>
                <a href="/terms">Terms</a>
                <a href="/data-deletion">Data Deletion</a>
              </nav>
            </div>
          </footer>

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
                monthlyBtn.classList.toggle('is-active', mode === 'monthly');
                yearlyBtn.classList.toggle('is-active', mode === 'yearly');
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
        </body>
      </html>
    `);
  });
}
