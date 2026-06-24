import { isAuthenticated } from "../middleware/auth.mjs";
import { getLandingHead } from "../utils.mjs";

export default function registerHomeRoutes(app) {
  app.get("/", (req, res) => {
    if (isAuthenticated(req)) {
      return res.redirect(302, "/inbox");
    }

    const assetVer = process.env.STATIC_ASSETS_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || "dev";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.end(`
      <html>${getLandingHead("Code Orbit Agent")}<body class="landing-page">
        <header class="landing-header">
          <a href="/" class="landing-brand">Code Orbit</a>
          <nav class="landing-nav">
            <a href="/auth/signin" class="landing-nav__link landing-auth-link">Log in</a>
            <a href="/auth/signup" class="btn btn-primary landing-nav__cta landing-auth-link">Get started</a>
          </nav>
        </header>
        <main class="landing-hero">
          <div class="landing-hero__content">
            <p class="landing-hero__eyebrow">WhatsApp AI for busy teams</p>
            <h1 class="landing-hero__headline">He doesn't have to worry about a busy inbox. Do you?</h1>
            <p class="landing-hero__subcopy">
              Let us handle customer messages on WhatsApp, so you can focus on the work that actually matters.
            </p>
            <div class="landing-hero__actions">
              <a href="/auth/signup" class="btn btn-primary landing-hero__btn landing-auth-link">Start free</a>
              <a href="/auth/signin" class="btn btn-ghost landing-hero__btn landing-auth-link">Log in</a>
            </div>
          </div>
          <figure class="landing-hero__visual">
            <img
              src="/VIDEO/Bear_Image.jpeg?v=${assetVer}"
              alt="A relaxed polar bear with sunglasses — your inbox, handled"
              class="landing-hero__image"
              width="640"
              height="800"
              loading="eager"
              decoding="async"
            />
          </figure>
        </main>
        <script src="/clerk-preload.js?v=${assetVer}" defer></script>
        <script src="/landing-page.js?v=${assetVer}" defer></script>
      </body></html>
    `);
  });
}
