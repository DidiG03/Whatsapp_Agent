
import { Message, Handoff } from "../schemas/mongodb.mjs";
import { canonicalContactId } from "./handoff.mjs";
import { normalizePhone } from "../utils.mjs";
export async function listContactsForUser(userId, opts = {}) {
  try {
    const page = Math.max(1, parseInt(opts.page||1,10));
    const pageSize = Math.min(50, Math.max(10, parseInt(opts.pageSize||20,10)));
    let contacts = await Message.aggregate([
      {
        $match: {
          user_id: userId,
          $or: [
            { direction: 'inbound', from_id: { $exists: true, $ne: null, $ne: '' } },
            { direction: 'outbound', to_id: { $exists: true, $ne: null, $ne: '' } }
          ]
        }
      },
      {
        $addFields: {
          contact: {
            $cond: [
              { $eq: ['$direction', 'inbound'] },
              '$from_id',
              '$to_id'
            ]
          }
        }
      },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$contact',
          last_ts: { $max: '$timestamp' },
          last_text: { $first: '$text_body' },
        }
      },
      {
        $lookup: {
          from: 'handoff',
          let: { contact_id: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$contact_id', '$$contact_id'] },
                    { $eq: ['$user_id', userId] }
                  ]
                }
              }
            }
          ],
          as: 'handoff'
        }
      },
      {
        $match: {
          $and: [
            {
              $or: [
                { 'handoff.is_archived': { $ne: true } },
                { 'handoff.is_archived': { $exists: false } }
              ]
            },
            {
              $or: [
                { 'handoff.deleted_at': { $exists: false } },
                { 'handoff.deleted_at': null }
              ]
            }
          ]
        }
      },
      { $sort: { last_ts: -1 } },
      { $skip: (page-1)*pageSize },
      { $limit: pageSize },
      {
        $project: {
          contact: '$_id',
          last_ts: 1,
          last_text: 1,
          _id: 0
        }
      }
    ]);

    contacts = mergeContactsByDigits(contacts.map(row => ({ ...row, contact: canonicalContactId(row.contact) })));
    if (!contacts.length) {
      const recent = await Message.find({ user_id: userId })
        .select('direction from_id to_id from_digits to_digits text_body timestamp')
        .sort({ timestamp: -1 })
        .limit(100)
        .lean();
      const seen = new Set();
      const out = [];
      for (const m of recent) {
        const contact = m.direction === 'inbound'
          ? (m.from_digits || (m.from_id || '').replace(/[^0-9+]/g, ''))
          : (m.to_digits || (m.to_id || '').replace(/[^0-9+]/g, ''));
        const key = String(contact || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ contact: canonicalContactId(key), last_ts: m.timestamp || 0, last_text: m.text_body || '' });
        if (out.length >= pageSize) break;
      }
      contacts = mergeContactsByDigits(out);
    }

    return contacts;
  } catch (error) {
    console.error('Error listing contacts for user:', error);
    return [];
  }
}
function mergeContactsByDigits(contacts) {
  const byDigits = new Map();
  for (const row of contacts || []) {
    const contact = canonicalContactId(row.contact);
    const key = normalizePhone(contact) || contact;
    if (!key) continue;
    const existing = byDigits.get(key);
    if (!existing || Number(row.last_ts || 0) >= Number(existing.last_ts || 0)) {
      byDigits.set(key, { ...row, contact });
    }
  }
  return [...byDigits.values()].sort((a, b) => Number(b.last_ts || 0) - Number(a.last_ts || 0));
}
function threadPhoneMatch(phoneDigits) {
  return {
    $or: [
      {
        $and: [
          { direction: 'inbound' },
          {
            $or: [
              { from_digits: phoneDigits },
              {
                $and: [
                  { from_digits: { $exists: false } },
                  { from_id: { $regex: phoneDigits.replace(/[+ -]/g, ''), $options: 'i' } }
                ]
              }
            ]
          }
        ]
      },
      {
        $and: [
          { direction: 'outbound' },
          {
            $or: [
              { to_digits: phoneDigits },
              {
                $and: [
                  { to_digits: { $exists: false } },
                  { to_id: { $regex: phoneDigits.replace(/[+ -]/g, ''), $options: 'i' } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

export async function clearMessagesForThread(userId, phoneDigits) {
  if (!userId || !phoneDigits) return 0;
  try {
    const res = await Message.deleteMany({
      user_id: userId,
      ...threadPhoneMatch(phoneDigits),
    });
    return res?.deletedCount || 0;
  } catch (error) {
    console.error("Error clearing messages for thread:", error);
    return 0;
  }
}

export async function listMessagesForThread(userId, phoneDigits) {
  try {
    const messages = await Message.find({
      user_id: userId,
      ...threadPhoneMatch(phoneDigits)
    })
      .select('direction text_body timestamp type')
      .sort({ timestamp: 1 });

    return messages.map(msg => ({
      direction: msg.direction,
      text_body: msg.text_body,
      type: msg.type || 'text',
      ts: msg.timestamp || 0
    }));
  } catch (error) {
    console.error('Error listing messages for thread:', error);
    return [];
  }
}

export async function listThreadMessagesPage(userId, phoneDigits, { beforeTs = null, limit = 50 } = {}) {
  const pageSize = Math.min(80, Math.max(10, parseInt(limit, 10) || 50));
  const match = {
    user_id: userId,
    ...threadPhoneMatch(phoneDigits),
    type: { $ne: 'system_clear' }
  };
  if (beforeTs) {
    match.timestamp = { $lt: Number(beforeTs) };
  }

  const docs = await Message.find(match)
    .sort({ timestamp: -1 })
    .limit(pageSize + 1)
    .lean();

  const hasMore = docs.length > pageSize;
  const slice = hasMore ? docs.slice(0, pageSize) : docs;
  slice.reverse();

  return {
    messages: slice,
    hasMore,
    oldestTs: slice.length ? Number(slice[0].timestamp || 0) : null
  };
}

