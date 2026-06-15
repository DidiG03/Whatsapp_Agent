import { isAuthenticated } from "../middleware/auth.mjs";

export default function registerHomeRoutes(app) {
  app.get("/", (req, res) => {
    if (isAuthenticated(req)) {
      return res.redirect(302, "/inbox");
    }
    return res.redirect(302, "/auth/signin");
  });
}
