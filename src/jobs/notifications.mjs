/**
 * Notifications job: scans upcoming appointments and sends WhatsApp reminders.
 * - Looks for T-24h and T-1h windows.
 * - Uses sendWhatsAppText; records status via existing webhook/status table.
 */
import { db } from "../db.mjs";
import { sendWhatsAppText } from "../services/whatsapp.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { sendWhatsappButton } from "../services/whatsapp.mjs";

function nowSeconds() { return Math.floor(Date.now() / 1000); }

async function sendReminder(appt, cfg, whenLabel) {
  const to = (appt.contact_phone || '').replace(/[^0-9+]/g, '');
  if (!to) return false;
  const ts = new Date(appt.start_ts * 1000).toLocaleString();
  const message = `Reminder: your appointment is at ${ts}. Reply if you need to reschedule.`;
  try {
    await sendWhatsAppText(to, message, cfg);
    const col = whenLabel === '24h' ? 'notify_24h_sent' : 'notify_1h_sent';
    db.prepare(`UPDATE appointments SET ${col} = 1, updated_at = strftime('%s','now') WHERE id = ?`).run(appt.id);
    return true;
  } catch {
    return false;
  }
}

export function startNotificationsScheduler() {
  // Run every 60 seconds; lightweight checks
  const interval = setInterval(async () => {
    try {
      const now = nowSeconds();
      // 24h window: between 24h and 23h 58m from now (avoid double sends)
      const t24Min = now + 24*3600 - 120;
      const t24Max = now + 24*3600 + 120;
      const t1Min = now + 1*3600 - 120;
      const t1Max = now + 1*3600 + 120;

      // Per-tenant windows
      const rows = db.prepare(`SELECT DISTINCT user_id FROM appointments WHERE status = 'confirmed' AND start_ts >= strftime('%s','now')-86400`).all();
      for (const r of rows) {
        const cfg = getSettingsForUser(r.user_id);
        if (!cfg?.bookings_enabled || !cfg?.reminders_enabled) continue;
        let wins = [];
        try { wins = JSON.parse(cfg.reminder_windows || '[]'); } catch {}
        const want24 = wins.includes('1d');
        const want4 = wins.includes('4h');
        const want2 = wins.includes('2h');

        if (want24) {
          const list = db.prepare(`SELECT * FROM appointments WHERE user_id = ? AND status='confirmed' AND notify_24h_sent = 0 AND start_ts BETWEEN ? AND ?`).all(r.user_id, t24Min, t24Max);
          for (const a of list) {
            // Skip 1D if appointment is within the same calendar day as now
            const nowDay = new Date().getUTCDate();
            const apptDay = new Date(a.start_ts * 1000).getUTCDate();
            if (nowDay === apptDay) continue;
            await sendReminderWithButtons(a, cfg);
            try { db.prepare(`UPDATE appointments SET notify_24h_sent = 1 WHERE id = ?`).run(a.id); } catch {}
          }
        }
        if (want4) {
          const list = db.prepare(`SELECT * FROM appointments WHERE user_id = ? AND status='confirmed' AND start_ts BETWEEN ? AND ?`).all(r.user_id, now + 4*3600 - 120, now + 4*3600 + 120);
          for (const a of list) {
            await sendReminderWithButtons(a, cfg);
          }
        }
        if (want2) {
          const list = db.prepare(`SELECT * FROM appointments WHERE user_id = ? AND status='confirmed' AND start_ts BETWEEN ? AND ?`).all(r.user_id, now + 2*3600 - 120, now + 2*3600 + 120);
          for (const a of list) {
            await sendReminderWithButtons(a, cfg);
          }
        }
      }
    } catch {}
  }, 60000);
  return () => clearInterval(interval);
}

async function sendReminderWithButtons(appt, cfg) {
  const to = (appt.contact_phone || '').replace(/[^0-9+]/g, '');
  if (!to) return false;
  const when = new Date(appt.start_ts * 1000).toLocaleString();
  try {
    await sendWhatsappButton(to, `Reminder: your appointment is at ${when}. Is this still correct?`, [
      { id: `REM_OK_${appt.id}`, title: 'Correct' },
      { id: `REM_CANCEL_${appt.id}`, title: 'Cancel' },
      { id: `REM_RESCHED_${appt.id}`, title: 'Reschedule' }
    ], cfg);
    return true;
  } catch { return false; }
}


