
import { Message, Handoff, MessageStatus } from "../schemas/mongodb.mjs";
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

export async function listMessagesForThread(userId, phoneDigits, { limit = 80 } = {}) {
  try {
    const cap = Math.min(200, Math.max(1, parseInt(limit, 10) || 80));
    const messages = await Message.find({
      user_id: userId,
      ...threadPhoneMatch(phoneDigits)
    })
      .select('direction text_body timestamp type')
      .sort({ timestamp: -1 })
      .limit(cap)
      .lean();

    messages.reverse();

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

export async function getContactPreviewForUser(userId, phoneDigits) {
  if (!userId || !phoneDigits) return null;
  const digits = normalizePhone(phoneDigits);
  if (!digits) return null;
  try {
    const msg = await Message.findOne({
      user_id: userId,
      ...threadPhoneMatch(digits),
      type: { $ne: 'system_clear' }
    })
      .sort({ timestamp: -1 })
      .select('direction from_id to_id from_digits to_digits text_body timestamp')
      .lean();
    if (!msg) return null;
    const rawContact = msg.direction === 'inbound'
      ? (msg.from_id || msg.from_digits || digits)
      : (msg.to_id || msg.to_digits || digits);
    return {
      contact: canonicalContactId(rawContact),
      last_ts: msg.timestamp || 0,
      last_text: msg.text_body || ''
    };
  } catch (error) {
    console.error('Error fetching contact preview:', error);
    return null;
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

/** Bounded thread load for inbox SSR/API with latest delivery status per message. */
export async function loadThreadMessagesForDisplay(userId, phoneDigits, { limit = 50 } = {}) {
  const { messages, hasMore, oldestTs } = await listThreadMessagesPage(userId, phoneDigits, { limit });
  if (!messages.length) {
    return { messages: [], hasMore: false, oldestTs: null };
  }

  const messageIds = messages.map((m) => m.id).filter(Boolean);
  const statusByMessageId = new Map();
  if (messageIds.length) {
    try {
      const rows = await MessageStatus.aggregate([
        { $match: { user_id: userId, message_id: { $in: messageIds } } },
        { $sort: { timestamp: -1 } },
        {
          $group: {
            _id: '$message_id',
            status: { $first: '$status' },
            timestamp: { $first: '$timestamp' },
          },
        },
      ]);
      for (const row of rows) {
        statusByMessageId.set(row._id, row);
      }
    } catch (error) {
      console.error('Error loading message statuses for thread:', error);
    }
  }

  const msgs = messages.map((m) => {
    const st = statusByMessageId.get(m.id);
    return {
      id: m.id,
      direction: m.direction,
      type: m.type,
      text_body: m.text_body,
      ts: m.timestamp || 0,
      raw: m.raw,
      delivery_status: m.delivery_status,
      read_status: m.read_status,
      delivery_timestamp: m.delivery_timestamp,
      read_timestamp: m.read_timestamp,
      message_status: st?.status,
      status_timestamp: st?.timestamp,
    };
  });

  return { messages: msgs, hasMore, oldestTs };
}

/** One aggregation round-trip for unread counts on the inbox contact list. */
export async function fetchUnreadCountsForContacts(userId, contacts, lastSeenByContact) {
  const unreadCounts = new Map();
  const pairs = (contacts || []).slice(0, 50).map((c) => {
    const contactId = String(c.contact || '');
    if (!contactId) return null;
    return {
      contactId,
      seenTs: lastSeenByContact.get(contactId) || 0,
      digits: normalizePhone(contactId),
    };
  }).filter(Boolean);

  if (!pairs.length) return unreadCounts;

  const facet = {};
  for (const { contactId, seenTs, digits } of pairs) {
    const matchOr = [{ from_id: contactId }];
    if (digits) matchOr.push({ from_digits: digits });
    facet[contactId] = [
      {
        $match: {
          user_id: userId,
          direction: 'inbound',
          timestamp: { $gt: seenTs },
          $or: matchOr,
        },
      },
      { $count: 'count' },
    ];
  }

  try {
    const [result] = await Message.aggregate([{ $facet: facet }]);
    for (const { contactId } of pairs) {
      const row = result?.[contactId]?.[0];
      unreadCounts.set(contactId, Number(row?.count || 0));
    }
  } catch (error) {
    console.error('fetchUnreadCountsForContacts failed:', error);
  }

  return unreadCounts;
}

