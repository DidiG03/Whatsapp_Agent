import { SettingsAudit } from "../schemas/mongodb.mjs";
import { logHelpers } from "../monitoring/logger.mjs";

export async function recordSettingsAudit(entry) {
  try {
    await SettingsAudit.create({
      user_id: entry.userId,
      actor_id: entry.actorId,
      actor_email: entry.actorEmail,
      ip: entry.ip,
      user_agent: entry.userAgent,
      denied_fields: entry.deniedFields || [],
      changes: entry.changes || []
    });
  } catch (error) {
    logHelpers.logError(error, { component: "settings_audit", operation: "create" });
  }
}

export default {
  recordSettingsAudit
};

