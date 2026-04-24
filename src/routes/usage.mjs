import { ensureAuthed, getCurrentUserId } from "../middleware/auth.mjs";
import { getCurrentUsage, getUserPlan, isUsageExceeded } from "../services/usage.mjs";

export default function registerUsageRoutes(app) {
  app.get("/api/usage/status", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const [usage, plan, overLimit] = await Promise.all([
        getCurrentUsage(userId),
        getUserPlan(userId),
        isUsageExceeded(userId)
      ]);
      const used = Number(usage?.inbound_messages || 0) +
        Number(usage?.outbound_messages || 0) +
        Number(usage?.template_messages || 0);
      const limit = Number(plan?.monthly_limit || 0);
      res.json({
        success: true,
        overLimit: !!overLimit,
        used,
        limit,
        plan: String(plan?.plan_name || 'free')
      });
    } catch (error) {
      res.status(500).json({ success: false, error: "Failed to load usage status" });
    }
  });
}

