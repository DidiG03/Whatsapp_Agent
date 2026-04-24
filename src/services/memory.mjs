
import { getDB } from "../db-mongodb.mjs";
function toObject(maybe) {
  return maybe && typeof maybe === 'object' && !Array.isArray(maybe) ? maybe : {};
}
export async function getContactMemory(userId, contactId) {
  try {
    const db = getDB();
    const doc = await db.collection('customers').findOne(
      { user_id: String(userId), contact_id: String(contactId) },
      { projection: { custom_fields: 1, display_name: 1, first_name: 1, last_name: 1 } }
    );
    const custom = toObject(doc?.custom_fields);
    return {
      ...custom,
      display_name: doc?.display_name || null,
      first_name: doc?.first_name || null,
      last_name: doc?.last_name || null
    };
  } catch {
    return {};
  }
}
export async function updateContactMemory(userId, contactId, patch) {
  try {
    const db = getDB();
    const existing = await db.collection('customers').findOne(
      { user_id: String(userId), contact_id: String(contactId) },
      { projection: { custom_fields: 1 } }
    );
    const current = toObject(existing?.custom_fields);
    const merged = { ...current, ...toObject(patch) };
    await db.collection('customers').updateOne(
      { user_id: String(userId), contact_id: String(contactId) },
      { $set: { custom_fields: merged, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date(), display_name: contactId } },
      { upsert: true }
    );
    return true;
  } catch {
    return false;
  }
}
export async function buildCustomerProfileSnippet(userId, contactId) {
  try {
    const db = getDB();
    const mem = await getContactMemory(userId, contactId);
    const digits = String(contactId || '').replace(/\D/g, '');
    const nowSec = Math.floor(Date.now() / 1000);
    const upcoming = await db.collection('appointments')
      .aggregate([
        { $match: { user_id: String(userId), status: 'confirmed', $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $gte: nowSec } } },
        { $lookup: { from: 'staff', localField: 'staff_id', foreignField: '_id', as: 'staff_docs' } },
        { $addFields: { staff_name: { $arrayElemAt: ['$staff_docs.name', 0] } } },
        { $sort: { start_ts: 1 } },
        { $limit: 1 },
        { $project: { start_ts: 1, staff_name: 1 } }
      ])
      .toArray()
      .then(arr => arr[0] || null);
    const last = await db.collection('appointments')
      .aggregate([
        { $match: { user_id: String(userId), $or: [ { contact_phone: digits }, { contact_phone: '+' + digits } ], start_ts: { $lt: nowSec } } },
        { $lookup: { from: 'staff', localField: 'staff_id', foreignField: '_id', as: 'staff_docs' } },
        { $addFields: { staff_name: { $arrayElemAt: ['$staff_docs.name', 0] } } },
        { $sort: { start_ts: -1 } },
        { $limit: 1 },
        { $project: { start_ts: 1, staff_name: 1 } }
      ])
      .toArray()
      .then(arr => arr[0] || null);

    const lines = [];
    const name = mem.display_name || [mem.first_name, mem.last_name].filter(Boolean).join(' ').trim();
    if (name) lines.push(`Name: ${name}`);
    if (mem.last_service_name) lines.push(`Last service: ${mem.last_service_name}${mem.last_service_minutes ? ` (${mem.last_service_minutes} min)` : ''}`);
    if (upcoming?.start_ts) lines.push(`Upcoming: ${new Date((upcoming.start_ts||0)*1000).toLocaleString()}${upcoming.staff_name ? ` · ${upcoming.staff_name}` : ''}`);
    if (!upcoming && last?.start_ts) lines.push(`Last appointment: ${new Date((last.start_ts||0)*1000).toLocaleString()}${last.staff_name ? ` · ${last.staff_name}` : ''}`);
    if (mem.last_agent_name) lines.push(`Last agent: ${mem.last_agent_name}`);
    if (Array.isArray(mem.last_answers) && mem.last_answers.length) {
      const brief = mem.last_answers.slice(0, 3).map(p => `${p.q}: ${p.a}`).join(' | ');
      if (brief) lines.push(`Last details: ${brief}`);
    }

    const content = lines.join('\n').trim();
    if (!content) return null;
    return { title: 'Customer Profile', content };
  } catch {
    return null;
  }
}
export async function rememberName(userId, contactId, displayName) {
  try {
    const db = getDB();
    await db.collection('customers').updateOne(
      { user_id: String(userId), contact_id: String(contactId) },
      { $set: { display_name: String(displayName || contactId).slice(0, 120), updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  } catch {}
}

export async function rememberService(userId, contactId, { name, minutes }) {
  await updateContactMemory(userId, contactId, {
    last_service_name: name ? String(name).slice(0, 120) : undefined,
    last_service_minutes: Number(minutes || 0) || undefined
  });
}

export async function rememberAgent(userId, contactId, agentName) {
  await updateContactMemory(userId, contactId, { last_agent_name: agentName ? String(agentName).slice(0, 120) : undefined });
}

export async function rememberAppointment(userId, contactId, { startISO }) {
  try {
    const ts = Math.floor(new Date(String(startISO)).getTime() / 1000);
    if (ts > 0) await updateContactMemory(userId, contactId, { last_appointment_ts: ts });
  } catch {}
}

