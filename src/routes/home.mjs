import { isAuthenticated } from "../middleware/auth.mjs";

export default function registerHomeRoutes(app) {
  app.get("/", (req, res) => {
    const signedIn = isAuthenticated(req);
    if (signedIn) return res.redirect("/dashboard");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <html><head><link rel="stylesheet" href="/styles.css"></head><body>
        <div class="container">
          <header><h1>WhatsApp Agent</h1></header>
          <ul class="list card">
            <li><a href="/auth">Sign in / Sign up</a></li>
          </ul>
        </div>
      </body></html>
    `);
  });
}

