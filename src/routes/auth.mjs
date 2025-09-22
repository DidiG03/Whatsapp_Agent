import { CLERK_ENABLED, CLERK_SIGN_IN_URL } from "../config.mjs";
import { getAuth, clerkClient } from "@clerk/express";

export default function registerAuthRoutes(app) {
  app.get("/auth", (_req, res) => {
    const pub = (process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) ? "configured" : "missing publishable key";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css"></head><body>
        <div class="container">
          <h2>Auth</h2>
          <p class="small">Clerk status: ${pub}</p>
          <ul class="list card">
            <li><a href="${process.env.CLERK_SIGN_IN_URL || 'https://accounts.clerk.com/sign-in'}">Sign In</a></li>
            <li><a href="${process.env.CLERK_SIGN_UP_URL || 'https://accounts.clerk.com/sign-up'}">Sign Up</a></li>
            ${CLERK_ENABLED ? '<li><a href="/logout">Sign out</a></li>' : ''}
          </ul>
        </div>
      </body></html>
    `);
  });

  app.get("/auth/status", (req, res) => {
    try {
      const { userId } = getAuth(req) || {};
      return res.json({ signedIn: !!userId });
    } catch {
      return res.json({ signedIn: false });
    }
  });

  app.get("/logout", async (req, res) => {
    if (!CLERK_ENABLED) return res.redirect("/");
    try {
      const { sessionId } = getAuth(req) || {};
      if (sessionId) await clerkClient.sessions.revokeSession(sessionId);
    } catch {}
    return res.redirect(CLERK_SIGN_IN_URL || "/");
  });
}

