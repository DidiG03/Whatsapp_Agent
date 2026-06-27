import { Message, Customer } from "../schemas/mongodb.mjs";

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRouteContact(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return s;
  const digits = s.replace(/\D/g, "");
  return digits ? `+${digits}` : s;
}

function formatTimestampForDisplay(unixTs) {
  const ts = Number(unixTs || 0);
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday);
  startYesterday.setDate(startToday.getDate() - 1);
  const startWeekAgo = new Date(startToday);
  startWeekAgo.setDate(startToday.getDate() - 7);

  if (d >= startToday) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (d >= startYesterday) {
    return "Yesterday";
  }
  if (d >= startWeekAgo) {
    return d.toLocaleDateString([], { weekday: "long" });
  }
  return d.toLocaleDateString();
}

function buildMessageSearchMatch(userId, filters) {
  const { q, messageType, direction, dateFrom, dateTo, contact } = filters;
  const match = { user_id: userId };

  if (messageType) match.type = messageType;
  if (direction) match.direction = direction;

  if (dateFrom || dateTo) {
    match.timestamp = {};
    if (dateFrom) {
      match.timestamp.$gte = Math.floor(new Date(dateFrom).getTime() / 1000);
    }
    if (dateTo) {
      match.timestamp.$lte = Math.floor(new Date(dateTo + "T23:59:59").getTime() / 1000);
    }
  }

  if (contact) {
    const digits = String(contact).replace(/\D/g, "");
    match.$or = [
      { from_digits: digits },
      { to_digits: digits },
      { from_id: contact },
      { to_id: contact },
    ];
  }

  if (q) {
    const regex = escapeRegex(q);
    const textMatch = {
      $or: [
        { text_body: { $regex: regex, $options: "i" } },
        { $expr: { $regexMatch: { input: { $toString: { $ifNull: ["$raw", ""] } }, regex, options: "i" } } },
      ],
    };
    if (match.$or) {
      match.$and = [{ $or: match.$or }, textMatch];
      delete match.$or;
    } else {
      Object.assign(match, textMatch);
    }
  }

  return match;
}

export async function performAdvancedSearch(userId, filters) {
  const match = buildMessageSearchMatch(userId, filters);
  const rows = await Message.aggregate([
    { $match: match },
    {
      $addFields: {
        contact: {
          $cond: [
            { $eq: ["$direction", "inbound"] },
            { $ifNull: ["$from_digits", "$from_id"] },
            { $ifNull: ["$to_digits", "$to_id"] },
          ],
        },
      },
    },
    { $match: { contact: { $nin: [null, ""] } } },
    {
      $group: {
        _id: "$contact",
        last_message_ts: { $max: "$timestamp" },
        message_count: { $sum: 1 },
      },
    },
    { $sort: { last_message_ts: -1 } },
  ]);

  return rows.map((row) => ({
    contact: parseRouteContact(row._id),
    last_message_ts: row.last_message_ts,
    message_count: row.message_count,
  }));
}

export async function performMessageSearch(userId, filters) {
  const { limit = 50, offset = 0 } = filters;
  const match = buildMessageSearchMatch(userId, filters);
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const pageOffset = Math.max(0, parseInt(offset, 10) || 0);

  const [total, messages] = await Promise.all([
    Message.countDocuments(match),
    Message.find(match)
      .sort({ timestamp: -1 })
      .skip(pageOffset)
      .limit(pageSize)
      .lean(),
  ]);

  const contactIds = [...new Set(messages.map((msg) => {
    const id = msg.direction === "inbound"
      ? (msg.from_id || msg.from_digits)
      : (msg.to_id || msg.to_digits);
    return id ? String(id) : "";
  }).filter(Boolean))];

  const customers = contactIds.length
    ? await Customer.find({ user_id: userId, contact_id: { $in: contactIds } })
      .select("contact_id display_name")
      .lean()
    : [];
  const nameByContact = new Map();
  for (const c of customers) {
    const id = String(c.contact_id || "");
    nameByContact.set(id, c.display_name);
    const digits = id.replace(/\D/g, "");
    if (digits) nameByContact.set(digits, c.display_name);
  }

  const formattedMessages = messages.map((msg) => {
    const contact = msg.direction === "inbound"
      ? (msg.from_digits || msg.from_id)
      : (msg.to_digits || msg.to_id);
    const contactKey = String(contact || "");
    return {
      id: msg.id,
      direction: msg.direction,
      type: msg.type,
      text_body: msg.text_body,
      timestamp: msg.timestamp,
      from_digits: msg.from_digits,
      to_digits: msg.to_digits,
      contact_name: nameByContact.get(contactKey)
        || nameByContact.get(contactKey.replace(/\D/g, ""))
        || null,
      contact,
      raw: typeof msg.raw === "object" ? msg.raw : (() => {
        try { return JSON.parse(msg.raw || "{}"); } catch { return null; }
      })(),
      formatted_time: formatTimestampForDisplay(msg.timestamp),
    };
  });

  return {
    messages: formattedMessages,
    total,
    hasMore: pageOffset + pageSize < total,
  };
}
