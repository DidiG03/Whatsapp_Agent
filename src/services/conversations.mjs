
import { Message, Handoff } from "../schemas/mongodb.mjs";
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
      {
        $group: {
          _id: '$contact',
          last_ts: { $max: '$timestamp' },
          last_text: {
            $first: {
              $cond: [
                { $eq: [{ $max: '$timestamp' }, '$timestamp'] },
                '$text_body',
                null
              ]
            }
          }
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
          $or: [
            { 'handoff.is_archived': { $ne: true } },
            { 'handoff.is_archived': { $exists: false } }
          ],
          $or: [
            { 'handoff.deleted_at': { $exists: false } },
            { 'handoff.deleted_at': null }
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

    contacts = contacts.map(row => ({ ...row, contact: cleanContactId(row.contact) }));
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
        out.push({ contact: key, last_ts: m.timestamp || 0, last_text: m.text_body || '' });
        if (out.length >= pageSize) break;
      }
      contacts = out;
    }

    return contacts;
  } catch (error) {
    console.error('Error listing contacts for user:', error);
    return [];
  }
}
function cleanContactId(contactId) {
  if (!contactId) return contactId;
  let cleaned = contactId.toString();
  cleaned = cleaned.replace(/[?&]type=[^&]*/g, '');
  cleaned = cleaned.replace(/[?&]status=[^&]*/g, '');
  cleaned = cleaned.replace(/[?&]state=[^&]*/g, '');
  cleaned = cleaned.replace(/[?&]code=[^&]*/g, '');
  const questionMarkIndex = cleaned.indexOf('?');
  if (questionMarkIndex !== -1) {
    cleaned = cleaned.substring(0, questionMarkIndex);
  }
  const ampersandIndex = cleaned.indexOf('&');
  if (ampersandIndex !== -1) {
    cleaned = cleaned.substring(0, ampersandIndex);
  }
  
  return cleaned;
}
export async function listMessagesForThread(userId, phoneDigits) {
  try {
    const messages = await Message.find({
      user_id: userId,
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
    })
    .select('direction text_body timestamp')
    .sort({ timestamp: 1 });

    return messages.map(msg => ({
      direction: msg.direction,
      text_body: msg.text_body,
      ts: msg.timestamp || 0
    }));
  } catch (error) {
    console.error('Error listing messages for thread:', error);
    return [];
  }
}

