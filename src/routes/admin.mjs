/**
 * Admin routes for system administration and management.
 */

export default function registerAdminRoutes(app) {
  // Admin routes would go here
  // For now, just a placeholder to prevent import errors
  
  app.get("/admin", (req, res) => {
    res.json({ message: "Admin panel - coming soon" });
  });
}
