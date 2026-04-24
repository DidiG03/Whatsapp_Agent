
import { getDB } from "../db-mongodb.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { sendWhatsappButton } from "../services/whatsapp.mjs";

function nowSeconds() { return Math.floor(Date.now() / 1000); }

export function startNotificationsScheduler() {
  const interval = setInterval(async () => {
    try {
      const now = nowSeconds();
      const t24Min = now + 24*3600 - 120;
      const t24Max = now + 24*3600 + 120;
      const t1Min = now + 1*3600 - 120;
      const t1Max = now + 1*3600 + 120;
      const db = getDB();
      const distinctUserIds = await db.collection('appointments').distinct('user_id', { status: 'confirmed', start_ts: { $gte: now - 86400 } });
      for (const uid of distinctUserIds) {
        const cfg = await getSettingsForUser(uid);
        if (!cfg?.bookings_enabled || !cfg?.reminders_enabled) continue;
        let wins = [];
        try { wins = JSON.parse(cfg.reminder_windows || '[]'); } catch {}
        const want24 = wins.includes('1d');
        const want4 = wins.includes('4h');
        const want2 = wins.includes('2h');

        if (want24) {
          const list = await db.collection('appointments').find({ user_id: String(uid), status: 'confirmed', notify_24h_sent: { $ne: true }, start_ts: { $gte: t24Min, $lte: t24Max } }).toArray();
          for (const a of list) {
            const nowDay = new Date().getUTCDate();
            const apptDay = new Date(a.start_ts * 1000).getUTCDate();
            if (nowDay === apptDay) continue;
            await sendReminderWithButtons(a, cfg);
            try { await db.collection('appointments').updateOne({ _id: a._id }, { $set: { notify_24h_sent: true, updatedAt: new Date() } }); } catch {}
          }
        }
        if (want4) {
          const list = await db.collection('appointments').find({ user_id: String(uid), status: 'confirmed', notify_4h_sent: { $ne: true }, start_ts: { $gte: now + 4*3600 - 120, $lte: now + 4*3600 + 120 } }).toArray();
          for (const a of list) {
            const sent = await sendReminderWithButtons(a, cfg);
            if (sent) { try { await db.collection('appointments').updateOne({ _id: a._id }, { $set: { notify_4h_sent: true, updatedAt: new Date() } }); } catch {} }
          }
        }
        if (want2) {
          const list = await db.collection('appointments').find({ user_id: String(uid), status: 'confirmed', notify_2h_sent: { $ne: true }, start_ts: { $gte: now + 2*3600 - 120, $lte: now + 2*3600 + 120 } }).toArray();
          for (const a of list) {
            const sent = await sendReminderWithButtons(a, cfg);
            if (sent) { try { await db.collection('appointments').updateOne({ _id: a._id }, { $set: { notify_2h_sent: true, updatedAt: new Date() } }); } catch {} }
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

