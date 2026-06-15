import { getSettingsForUser } from "./settings.mjs";
import { sendWhatsAppGroupText } from "./whatsapp.mjs";

const CONNECT_RE = /^\s*connect\s*$/i;

export function isStaffGroupConnectCommand(text) {
  return CONNECT_RE.test(String(text || "").trim());
}

export function buildStaffBookingAlertMessage(bookingData = {}, cfg = {}) {
  const {
    customerName,
    customerPhone,
    startTime,
    endTime,
    notes,
    appointmentId,
    staffName,
  } = bookingData;
  const businessName = String(cfg?.business_name || "Your business").trim();
  const formattedStart = startTime ? new Date(startTime).toLocaleString() : "TBD";
  const formattedEnd = endTime ? new Date(endTime).toLocaleTimeString() : null;
  const lines = [
    `📅 New reservation at ${businessName}`,
    "",
    `Ref: #${appointmentId || "—"}`,
    `Customer: ${customerName || "Not provided"}`,
    `Phone: ${customerPhone || "—"}`,
    `When: ${formattedStart}${formattedEnd ? ` – ${formattedEnd}` : ""}`,
  ];
  if (staffName) lines.push(`Staff: ${staffName}`);
  const noteText = String(notes || "").trim();
  if (noteText) lines.push(`Notes: ${noteText.slice(0, 400)}`);
  return lines.join("\n").trim();
}

export async function sendStaffGroupBookingNotification(userId, bookingData, cfg = null) {
  const settings = cfg || (await getSettingsForUser(userId));
  if (!settings?.staff_whatsapp_group_enabled) {
    return { success: false, reason: "disabled" };
  }
  const groupId = String(settings?.staff_whatsapp_group_id || "").trim();
  if (!groupId) {
    return { success: false, reason: "no_group" };
  }
  if (!settings?.whatsapp_token || !settings?.phone_number_id) {
    return { success: false, reason: "no_whatsapp_config" };
  }

  const message = buildStaffBookingAlertMessage(bookingData, settings);
  const sendCfg = { ...settings, user_id: userId };
  try {
    await sendWhatsAppGroupText(groupId, message, sendCfg);
    return { success: true };
  } catch (e) {
    console.error("[StaffGroup] Failed to send booking alert:", e?.message || e);
    return { success: false, reason: "send_failed", error: e?.message || String(e) };
  }
}
