export default function registerMiscRoutes(app) {
  app.get("/.well-known/appspecific/com.chrome.devtools.json", (_req, res) => res.sendStatus(204));
}

