import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, normalizePhone, escapeHtml, renderTopbar, getProfessionalHead, renderPageHeader, renderVoiceMessageHtml } from "../utils.mjs";
import { listContactsForUser, listMessagesForThread, listThreadMessagesPage } from "../services/conversations.mjs";
import { db, getDB } from "../db-mongodb.mjs";
import { Customer, Handoff, Message, MessageStatus } from '../schemas/mongodb.mjs';
import { getSettingsForUser, upsertSettingsForUser } from "../services/settings.mjs";
import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsappImage, sendWhatsappReaction, sendWhatsappList } from "../services/whatsapp.mjs";
import {
  extractTemplateBodyAndVars,
  fetchMetaTemplateLanguages,
  findWaTemplateDoc,
  sendResolvedWhatsAppTemplate,
  summarizeWhatsAppError,
} from "../services/waTemplates.mjs";
import { getQuickReplies } from "../services/quickReplies.mjs";
import { getMessageReactions, toggleReaction, removeReaction, getMessagesReactions, getUserReactionsForMessages } from "../services/reactions.mjs";
import { createReply, getMessagesReplies, getReplyOriginals } from "../services/replies.mjs";
import { getUserPlan, getPlanStatus, isPlanUpgraded, isUsageExceeded } from "../services/usage.mjs";
import { updateContactActivity } from "../services/contacts.mjs";
import { canonicalContactId, contactIdVariants, findHandoffForContact, resolveHumanMode, upsertHandoffForContact } from "../services/handoff.mjs";
import { recordOutboundMessage } from "../services/messages.mjs";
import { getContactMemory } from "../services/memory.mjs";
import { detectLanguage, t as tr } from "../services/i18n.mjs";
import { renderThreadMessagesHtml } from "./inboxThreadMessages.mjs";
import { 
  getConversationStatus, 
  updateConversationStatus, 
  getConversationsWithStatus,
  getConversationStatusStats,
  CONVERSATION_STATUSES,
  STATUS_DISPLAY_NAMES,
  STATUS_COLORS
} from "../services/conversationStatus.mjs";
import { 
  MESSAGE_STATUS, 
  READ_STATUS, 
  getMessageStatus, 
  markConversationAsRead,
  simulateDeliveryStatusUpdate,
  markMessageAsFailed,
  retryFailedMessage
} from "../services/messageStatus.mjs";
import { broadcastReaction, broadcastMessageStatus } from "./realtime.mjs";
import multer from 'multer';
import path from 'path';
import { selectStorage } from '../services/uploads.mjs';
function parseRouteContact(raw) {
  return canonicalContactId(raw);
}

const THREAD_MESSAGES_PAGE_SIZE = 50;

async function getReplyOriginalMeta(userId, replyTo) {
  const id = String(replyTo || "").trim();
  if (!id) return null;
  try {
    const doc = await getDB().collection("messages").findOne(
      { id, user_id: String(userId) },
      { projection: { id: 1, direction: 1, text_body: 1 } }
    );
    if (!doc?.id) return null;
    return {
      original_message_id: doc.id,
      direction: doc.direction,
      text_body: doc.text_body
    };
  } catch {
    return null;
  }
}

async function resolveReplyMessageId(userId, replyTo) {
  const meta = await getReplyOriginalMeta(userId, replyTo);
  return meta?.original_message_id || null;
}

async function sendReopenTemplateMessage({ userId, cfg, to, formValues = {} }) {
  const tname = String(cfg?.wa_template_name || "").trim();
  const preferredLang = String(cfg?.wa_template_language || "en_US").trim() || "en_US";
  if (!tname) throw new Error("No default template configured");

  const cust = await Customer.findOne({ user_id: userId, contact_id: to }).select("display_name").lean();
  const defaults = {
    1: String(cust?.display_name || "").trim() || "there",
    2: "a while",
  };

  const result = await sendResolvedWhatsAppTemplate({
    db: getDB(),
    userId,
    cfg,
    to,
    templateName: tname,
    preferredLang,
    formValues,
    defaults,
    sendTemplate: sendWhatsAppTemplate,
  });

  if (result.language && result.language !== preferredLang) {
    try {
      await upsertSettingsForUser(userId, {
        wa_template_name: tname,
        wa_template_language: result.language,
      });
    } catch {}
  }

  return {
    resp: result.resp,
    displayText: result.displayText || "",
    language: result.language || preferredLang,
    templateName: tname,
  };
}

const TOAST_SEVERITIES = new Set(['success', 'error', 'warning', 'info']);

function parseInboxMessageTypeFilter(query = {}) {
  const raw = (query.type || '').toString().trim();
  const hasToast = !!(query.toast || '').toString().trim();
  const toastType = (query.toast_type || '').toString().trim();
  if (toastType || (hasToast && TOAST_SEVERITIES.has(raw.toLowerCase()))) return '';
  return raw;
}

function redirectToInbox(res, { toast, type } = {}) {
  const params = new URLSearchParams();
  if (toast) params.set('toast', toast);
  if (type) params.set('toast_type', type);
  const qs = params.toString();
  return res.redirect(303, qs ? `/inbox?${qs}` : '/inbox');
}
function formatTimestampForDisplay(unixTs){
  const ts = Number(unixTs || 0);
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday);
  startYesterday.setDate(startToday.getDate() - 1);
  const startWeekAgo = new Date(startToday);
  startWeekAgo.setDate(startToday.getDate() - 7);

  if (d >= startToday) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (d >= startYesterday) {
    return 'Yesterday';
  }
  if (d >= startWeekAgo) {
    return d.toLocaleDateString([], { weekday: 'long' });
  }
  return d.toLocaleDateString();
}
function formatPhoneLabel(contact) {
  if (!contact) return '';
  return `+${String(contact).replace(/^\+/, '')}`;
}
function contactInitials(displayName, contact) {
  const name = String(displayName || '').trim();
  if (name && !name.startsWith('+') && !/^\d+$/.test(name.replace(/\s/g, ''))) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (parts[0]?.length >= 2) return parts[0].slice(0, 2).toUpperCase();
    if (parts[0]?.length === 1) return parts[0].toUpperCase();
  }
  const digits = String(contact || '').replace(/\D/g, '');
  return digits.slice(-2) || '??';
}

function renderInboxContactListItems(contacts, ctx = {}) {
  const {
    showArchived = false,
    customerNameByContact = new Map(),
    lastSeenByContact = new Map(),
    statusByContact = new Map(),
    escalationByContact = new Map(),
    liveByContact = new Map(),
    unreadCounts = new Map(),
  } = ctx;

  return (contacts || []).map((c) => {
    const lastTs = Number(c.last_ts || 0);
    const ts = formatTimestampForDisplay(lastTs);
    const rawPreview = (c.last_text || '').toString();
    const shortened = rawPreview.length > 60 ? rawPreview.slice(0, 57) + '...' : rawPreview;
    const preview = shortened.replace(/</g, '&lt;');
    const phoneLabel = formatPhoneLabel(c.contact);
    const savedName = customerNameByContact.get(String(c.contact));
    const displayName = savedName || phoneLabel;
    const initials = contactInitials(savedName, c.contact);
    const phoneSubline = savedName
      ? `<div class="inbox-item__phone">${escapeHtml(phoneLabel)}</div>`
      : '';
    const seenTs = lastSeenByContact.get(String(c.contact)) || 0;
    const hasNew = lastTs > seenTs;
    const isLive = c.isLive ?? liveByContact.has(String(c.contact));
    const unreadCount = (c.unreadCount ?? unreadCounts.get(String(c.contact))) || 0;
    const conversationStatus = c.conversationStatus || statusByContact.get(String(c.contact)) || CONVERSATION_STATUSES.NEW;
    const statusDisplay = STATUS_DISPLAY_NAMES[conversationStatus];
    const statusColor = STATUS_COLORS[conversationStatus];
    const dropdownId = `menu_${c.contact}`;
    const menu = `
        <div class="inbox-dropdown">
          <button type="button" class="inbox-dropdown__trigger" aria-label="Conversation actions" onclick="return toggleMenu('${dropdownId}', event)">
            <svg class="inbox-dropdown__trigger-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M7 4c0-.139 0-.209.008-.267a.85.85 0 0 1 .724-.724c.059-.008.128-.008.267-.008s.21 0 .267.008a.85.85 0 0 1 .724.724c.008.058.008.128.008.267s0 .209-.008.267a.85.85 0 0 1-.724.724c-.058.008-.128.008-.267.008s-.209 0-.267-.008a.85.85 0 0 1-.724-.724C7 4.209 7 4.139 7 4m0 4c0-.139 0-.209.008-.267a.85.85 0 0 1 .724-.724c.059-.008.128-.008.267-.008s.21 0 .267.008a.85.85 0 0 1 .724.724c.008.058.008.128.008.267s0 .209-.008.267a.85.85 0 0 1-.724.724c-.058.008-.128.008-.267.008s-.209 0-.267-.008a.85.85 0 0 1-.724-.724C7 8.209 7 8.139 7 8m0 4c0-.139 0-.209.008-.267a.85.85 0 0 1 .724-.724c.059-.008.128-.008.267-.008s.21 0 .267.008a.85.85 0 0 1 .724.724c.008.058.008.128.008.267s0 .209-.008.268a.85.85 0 0 1-.724.724C8.208 13 8.138 13 8 13s-.209 0-.267-.008a.85.85 0 0 1-.724-.724C7 12.21 7 12.14 7 12"/></svg>
          </button>
          <div id="${dropdownId}" class="inbox-dropdown-menu" onclick="event.stopPropagation()">
            ${showArchived ? `
            <form method="post" action="/inbox/${encodeURIComponent(c.contact)}/unarchive" onsubmit="event.preventDefault(); if (window.checkAuthThenSubmit) { checkAuthThenSubmit(this).then(valid => { if (valid) this.submit(); }); } else { this.submit(); } return false;">
              <button type="submit" class="inbox-dropdown-item">
                <img src="/archive-icon.svg" alt="" class="inbox-dropdown-item__icon" aria-hidden="true" /> Unarchive
              </button>
            </form>` : `
            <form method="post" action="/inbox/${encodeURIComponent(c.contact)}/archive" onsubmit="event.preventDefault(); if (window.checkAuthThenSubmit) { checkAuthThenSubmit(this).then(valid => { if (valid) this.submit(); }); } else { this.submit(); } return false;">
              <button type="submit" class="inbox-dropdown-item">
                <img src="/archive-icon.svg" alt="" class="inbox-dropdown-item__icon" aria-hidden="true" /> Archive
              </button>
            </form>`}
            <button type="button" class="inbox-dropdown-item" onclick="openNameModal('${encodeURIComponent(c.contact)}'); return false;">
              <span class="inbox-dropdown-item__emoji" aria-hidden="true">✏️</span> Name customer
            </button>
            <div class="inbox-dropdown-divider" role="separator"></div>
            <form method="post" action="/inbox/${encodeURIComponent(c.contact)}/clear" onsubmit="event.preventDefault(); if (window.checkAuthThenSubmit) { checkAuthThenSubmit(this).then(valid => { if (valid) this.submit(); }); } else { this.submit(); } return false;">
              <button type="submit" class="inbox-dropdown-item">
                <img src="/clear-icon.svg" alt="" class="inbox-dropdown-item__icon" aria-hidden="true" /> Clear chat
              </button>
            </form>
            <div class="inbox-dropdown-divider" role="separator"></div>
            <form method="post" action="/inbox/${encodeURIComponent(c.contact)}/block24h" onsubmit="event.preventDefault(); if (window.checkAuthThenSubmit) { checkAuthThenSubmit(this).then(valid => { if (valid) this.submit(); }); } else { this.submit(); } return false;">
              <button type="submit" class="inbox-dropdown-item">
                <span class="inbox-dropdown-item__emoji" aria-hidden="true">⛔</span> Block 24h
              </button>
            </form>
            <form method="post" action="/inbox/${encodeURIComponent(c.contact)}/delete" onsubmit="return deleteInboxConversation(this, event);">
              <button type="submit" class="inbox-dropdown-item inbox-dropdown-item--danger">
                <img src="/delete-icon.svg" alt="" class="inbox-dropdown-item__icon" aria-hidden="true" /> Delete
              </button>
            </form>
          </div>
        </div>
      `;
    const unreadBadge = unreadCount > 0
      ? `<span class="inbox-item__unread">${unreadCount > 99 ? '99+' : unreadCount}</span>`
      : (hasNew ? '<span class="inbox-item__dot" aria-label="Unread"></span>' : '');
    const chips = [
      isLive ? '<span class="live-chip">Live</span>' : '',
      conversationStatus !== CONVERSATION_STATUSES.NEW
        ? `<span class="status-chip" style="background-color:${statusColor}">${statusDisplay}</span>`
        : '',
    ].filter(Boolean).join('');
    const metaHtml = chips ? `<div class="inbox-item__meta">${chips}</div>` : '';
    return `
        <li class="inbox-item${hasNew || unreadCount > 0 ? ' inbox-item--unread' : ''}">
          <a class="inbox-item__link" href="/inbox/${encodeURIComponent(c.contact)}">
            <div class="inbox-item__avatar" aria-hidden="true">${escapeHtml(initials)}</div>
            <div class="inbox-item__body">
              <div class="inbox-item__header">
                <div class="inbox-item__title">
                  <span class="inbox-item__name">${escapeHtml(displayName || '')}</span>
                  ${unreadBadge}
                </div>
                <time class="inbox-item__time">${ts}</time>
              </div>
              ${phoneSubline}
              ${metaHtml}
              <p class="inbox-item__preview">${preview || '<span class="inbox-item__preview-empty">No messages yet</span>'}</p>
            </div>
          </a>
          <div class="inbox-item__actions">
            ${menu}
          </div>
        </li>
      `;
  }).join('');
}

async function enrichInboxContacts(userId, contacts) {
  const customers = await Customer.find({ user_id: userId }).select('contact_id display_name');
  const customerNameByContact = new Map(customers.map(r => [String(r.contact_id), r.display_name]));
  const lastSeenRows = await Handoff.find({ user_id: userId }).select('contact_id last_seen_ts');
  const lastSeenByContact = new Map(lastSeenRows.map(r => [String(r.contact_id), Number(r.last_seen_ts || 0)]));
  const unreadCounts = new Map();
  try {
    await Promise.all((contacts || []).slice(0, 50).map(async (c) => {
      try {
        const contactId = String(c.contact || '');
        if (!contactId) return;
        const seenTs = lastSeenByContact.get(contactId) || 0;
        const digits = normalizePhone(contactId);
        const cnt = await Message.countDocuments({
          user_id: userId,
          direction: 'inbound',
          timestamp: { $gt: seenTs },
          $or: [
            { from_id: contactId },
            { from_digits: digits }
          ]
        });
        unreadCounts.set(contactId, Number(cnt || 0));
      } catch (_) {}
    }));
  } catch (_) {}
  const statusRows = await Handoff.find({ user_id: userId }).select('contact_id conversation_status');
  const statusByContact = new Map(statusRows.map(r => [String(r.contact_id), r.conversation_status || CONVERSATION_STATUSES.NEW]));
  const now = Math.floor(Date.now() / 1000);
  const escalationRows = await Handoff.find({
    user_id: userId,
    escalation_reason: { $exists: true, $ne: null }
  }).select('contact_id escalation_reason updatedAt is_human human_expires_ts');
  const liveRows = await Handoff.find({
    user_id: userId,
    is_human: true,
    human_expires_ts: { $gt: now }
  }).select('contact_id');
  const escalationByContact = new Map();
  const liveByContact = new Map(liveRows.map((row) => [String(row.contact_id), true]));
  escalationRows.forEach((row) => {
    const contactId = String(row.contact_id);
    const isHuman = Number(row.is_human || 0);
    const humanExpiresTs = Number(row.human_expires_ts || 0);
    if (isHuman && humanExpiresTs > now) {
      escalationByContact.set(contactId, row.escalation_reason);
    }
  });

  const enrichedContacts = (contacts || []).map((c) => {
    const contactId = String(c.contact || '');
    const seenTs = lastSeenByContact.get(contactId) || 0;
    const lastTs = Number(c.last_ts || 0);
    const unreadCount = unreadCounts.get(contactId) || 0;
    const hasNew = lastTs > seenTs;
    const hasEscalation = escalationByContact.has(contactId);
    const isLive = liveByContact.has(contactId);
    return {
      ...c,
      unreadCount,
      hasNew,
      hasEscalation,
      isLive,
      conversationStatus: statusByContact.get(contactId) || CONVERSATION_STATUSES.NEW,
    };
  });

  return {
    enrichedContacts,
    customerNameByContact,
    lastSeenByContact,
    statusByContact,
    escalationByContact,
    liveByContact,
    unreadCounts,
  };
}

function buildInboxQuery(params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== '' && value !== false) qs.set(key, String(value));
  });
  const out = qs.toString();
  return out ? `?${out}` : '';
}
const CHAT_HEADER_SVG = {
  back: '<svg class="chat-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  bot: '<svg class="chat-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M9 13v2M15 13v2"/><path d="M9 17h6"/></svg>',
  hand: '<svg class="chat-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11V6a2 2 0 1 1 4 0v3"/><path d="M11 10V5a2 2 0 1 1 4 0v6"/><path d="M15 11V7a2 2 0 1 1 4 0v8a8 8 0 0 1-16 0v-5a2 2 0 1 1 4 0"/></svg>',
  renew: '<svg class="chat-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  archive: '<svg class="chat-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>',
  clear: '<svg class="chat-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg class="chat-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  chevron: '<svg class="chat-header-icon chat-header-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
};
function chatHeaderIcon(key) {
  return CHAT_HEADER_SVG[key] || '';
}
const storage = selectStorage('inbox');
const uploadImage = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});
const uploadDocument = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 },  fileFilter: (req, file, cb) => {
    const allowedExtensions = /\.(pdf|doc|docx|txt|rtf|odt|ppt|pptx|xls|xlsx|csv|zip|rar)$/i;
    const allowedMimeTypes = /^(application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|rtf|vnd\.oasis\.opendocument\.text|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml\.presentation|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|zip|x-rar-compressed)|text\/(plain|csv))$/;
    
    const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedMimeTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only document files are allowed! Supported formats: PDF, DOC, DOCX, TXT, RTF, ODT, PPT, PPTX, XLS, XLSX, CSV, ZIP, RAR'));
    }
  }
});
async function performAdvancedSearch(userId, filters) {
  const { q, messageType, direction, dateFrom, dateTo } = filters;
  let whereConditions = ['m.user_id = ?'];
  let queryParams = [userId];
  if (q) {
    whereConditions.push(`(m.text_body LIKE ? OR m.raw LIKE ?)`);
    const searchTerm = `%${q}%`;
    queryParams.push(searchTerm, searchTerm);
  }
  if (messageType) {
    whereConditions.push('m.type = ?');
    queryParams.push(messageType);
  }
  if (direction) {
    whereConditions.push('m.direction = ?');
    queryParams.push(direction);
  }
  if (dateFrom) {
    whereConditions.push('m.timestamp >= ?');
    queryParams.push(Math.floor(new Date(dateFrom).getTime() / 1000));
  }
  
  if (dateTo) {
    whereConditions.push('m.timestamp <= ?');
    queryParams.push(Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000));
  }
  const searchQuery = `
    SELECT DISTINCT 
      CASE 
        WHEN m.direction = 'inbound' THEN m.from_digits
        WHEN m.direction = 'outbound' THEN m.to_digits
      END as contact,
      MAX(m.timestamp) as last_message_ts,
      COUNT(*) as message_count
    FROM messages m
    WHERE ${whereConditions.join(' AND ')}
    GROUP BY contact
    ORDER BY last_message_ts DESC
  `;
  
  const searchResults = await db.prepare(searchQuery).all(...queryParams);
  return (Array.isArray(searchResults) ? searchResults : []).map(result => ({
    contact: parseRouteContact(result.contact),
    last_message_ts: result.last_message_ts,
    message_count: result.message_count
  }));
}
async function performMessageSearch(userId, filters) {
  const { q, messageType, direction, dateFrom, dateTo, contact, limit, offset } = filters;
  let whereConditions = ['m.user_id = ?'];
  let queryParams = [userId];
  if (q) {
    whereConditions.push(`(m.text_body LIKE ? OR m.raw LIKE ?)`);
    const searchTerm = `%${q}%`;
    queryParams.push(searchTerm, searchTerm);
  }
  if (messageType) {
    whereConditions.push('m.type = ?');
    queryParams.push(messageType);
  }
  if (direction) {
    whereConditions.push('m.direction = ?');
    queryParams.push(direction);
  }
  if (contact) {
    whereConditions.push('(m.from_digits = ? OR m.to_digits = ?)');
    queryParams.push(contact, contact);
  }
  if (dateFrom) {
    whereConditions.push('m.timestamp >= ?');
    queryParams.push(Math.floor(new Date(dateFrom).getTime() / 1000));
  }
  
  if (dateTo) {
    whereConditions.push('m.timestamp <= ?');
    queryParams.push(Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000));
  }
  const countQuery = `
    SELECT COUNT(*) as total
    FROM messages m
    WHERE ${whereConditions.join(' AND ')}
  `;
  const totalResult = await db.prepare(countQuery).get(...queryParams);
  const total = totalResult?.total || 0;
  const messagesQuery = `
    SELECT 
      m.id,
      m.direction,
      m.type,
      m.text_body,
      m.timestamp,
      m.from_digits,
      m.to_digits,
      m.raw,
      c.display_name as contact_name
    FROM messages m
    LEFT JOIN customers c ON (
      (m.direction = 'inbound' AND c.contact_id = m.from_digits) OR
      (m.direction = 'outbound' AND c.contact_id = m.to_digits)
    ) AND c.user_id = ?
    WHERE ${whereConditions.join(' AND ')}
    ORDER BY m.timestamp DESC
    LIMIT ? OFFSET ?
  `;
  
  const messages = await db.prepare(messagesQuery).all(userId, ...queryParams, limit, offset);
  const formattedMessages = (Array.isArray(messages) ? messages : []).map(msg => ({
    id: msg.id,
    direction: msg.direction,
    type: msg.type,
    text_body: msg.text_body,
    timestamp: msg.timestamp,
    from_digits: msg.from_digits,
    to_digits: msg.to_digits,
    contact_name: msg.contact_name,
    contact: msg.direction === 'inbound' ? msg.from_digits : msg.to_digits,
    raw: msg.raw ? JSON.parse(msg.raw) : null,
    formatted_time: formatTimestampForDisplay(msg.timestamp)
  }));
  
  return {
    messages: formattedMessages,
    total: total,
    hasMore: (offset + limit) < total
  };
}
async function ensureInProgressIfHuman(userId, phone) {
  try {
    const handoff = await findHandoffForContact(userId, phone, 'is_human human_expires_ts');
    if (!resolveHumanMode(handoff).isHuman) return;
    const current = await getConversationStatus(userId, phone);
    if (current !== CONVERSATION_STATUSES.IN_PROGRESS && current !== CONVERSATION_STATUSES.RESOLVED) {
      await updateConversationStatus(userId, phone, CONVERSATION_STATUSES.IN_PROGRESS, 'agent_first_message');
    }
  } catch {}
}
async function listArchivedContacts(userId, { page = 1, pageSize = 20 } = {}) {
  try {
    const rows = await Handoff.find({ user_id: userId, is_archived: true, $or: [ { deleted_at: { $exists: false } }, { deleted_at: null } ] }).select('contact_id');
    const archivedIds = rows.map(r => String(r.contact_id)).filter(Boolean);
    if (!archivedIds.length) return [];
    const contacts = await Message.aggregate([
      {
        $match: {
          user_id: userId,
          $or: [
            { direction: 'inbound', from_id: { $exists: true, $ne: null, $ne: '' } },
            { direction: 'outbound', to_id: { $exists: true, $ne: null, $ne: '' } }
          ]
        }
      },
      { $addFields: { contact: { $cond: [ { $eq: ['$direction', 'inbound'] }, '$from_id', '$to_id' ] } } },
      { $match: { contact: { $in: archivedIds } } },
      { $sort: { timestamp: -1 } },
      { $group: { _id: '$contact', last_ts: { $max: '$timestamp' }, last_text: { $first: '$text_body' } } },
      { $sort: { last_ts: -1 } },
      { $skip: (Math.max(1, parseInt(page,10))-1) * Math.max(10, Math.min(50, parseInt(pageSize,10))) },
      { $limit: Math.max(10, Math.min(50, parseInt(pageSize,10))) },
      { $project: { _id: 0, contact: '$_id', last_ts: 1, last_text: 1 } }
    ]);
    return contacts.map(c => ({ ...c, contact: parseRouteContact(c.contact) }));
  } catch (e) {
    console.error('Archived list error:', e);
    return [];
  }
}

export default function registerInboxRoutes(app) {
  app.get("/inbox", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const q = (req.query.q || "").toString().trim();
    const messageType = parseInboxMessageTypeFilter(req.query);
    const direction = (req.query.direction || "").toString().trim();
    const dateFrom = (req.query.date_from || "").toString().trim();
    const dateTo = (req.query.date_to || "").toString().trim();
    const showArchived = ['1','true','yes'].includes(String(req.query.archived||'').toLowerCase());
    const inboxFilter = ['all', 'unread', 'live'].includes(String(req.query.filter || 'all'))
      ? String(req.query.filter || 'all')
      : 'all';
    const page = Math.max(1, parseInt(req.query.page||'1', 10) || 1);
    const pageSize = Math.min(50, Math.max(10, parseInt(req.query.page_size||'20', 10) || 20));
    const isSearchMode = !showArchived && (q || messageType || direction || dateFrom || dateTo);
    let contacts;
    if (isSearchMode) {
      contacts = await performAdvancedSearch(userId, { q, messageType, direction, dateFrom, dateTo });
    } else {
      contacts = showArchived
        ? await listArchivedContacts(userId, { page, pageSize })
        : await listContactsForUser(userId, { page, pageSize });
    }
    const email = await getSignedInEmail(req);
    const s = await getSettingsForUser(userId);
    const plan = await getUserPlan(userId);
    const isUpgraded = isPlanUpgraded(plan);
    const assetVer = process.env.STATIC_ASSETS_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'dev';
    if (!showArchived) {
      try {
        const archivedRows = await Handoff.find({ user_id: userId, is_archived: true }).select('contact_id');
        const archivedSet = new Set(archivedRows.map(r => String(r.contact_id)));
        contacts = (contacts||[]).filter(c => !archivedSet.has(String(c.contact)));
      } catch(_) { }
    }
    try {
      const viewKey = ['1','true','yes'].includes(String(req.query.archived||'').toLowerCase()) ? 'archived' : 'inbox';
      const etagBase = `${viewKey}:${contacts.length}:${contacts.slice(0, 50).map(c => `${c.contact}:${c.last_ts||0}`).join('|')}`;
      const etag = 'W/"'+Buffer.from(etagBase).toString('base64').slice(0, 32)+'"';
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('ETag', etag);
    } catch {}
    const {
      enrichedContacts,
      customerNameByContact,
      lastSeenByContact,
      statusByContact,
      escalationByContact,
      liveByContact,
      unreadCounts,
    } = await enrichInboxContacts(userId, contacts);
    const filteredContacts = enrichedContacts.filter((c) => {
      if (inboxFilter === 'unread') return (c.unreadCount || 0) > 0 || c.hasNew;
      if (inboxFilter === 'live') return c.isLive;
      return true;
    });
    const filterCounts = {
      all: enrichedContacts.length,
      unread: enrichedContacts.filter((c) => (c.unreadCount || 0) > 0 || c.hasNew).length,
      live: enrichedContacts.filter((c) => c.isLive).length,
    };
    const list = renderInboxContactListItems(filteredContacts, {
      showArchived,
      customerNameByContact,
      lastSeenByContact,
      statusByContact,
      escalationByContact,
      liveByContact,
      unreadCounts,
    });
    const searchResultsCount = isSearchMode ?
      `<div class="search-result-count">Found ${filteredContacts.length} conversation${filteredContacts.length !== 1 ? 's' : ''} matching your search criteria</div>` : '';
    const filterBase = {
      archived: showArchived ? '1' : '',
      q: q || '',
      type: messageType || '',
      direction: direction || '',
      date_from: dateFrom || '',
      date_to: dateTo || '',
    };
    const inboxTabHref = (filterValue) => {
      const params = { ...filterBase };
      if (filterValue && filterValue !== 'all') params.filter = filterValue;
      return `/inbox${buildInboxQuery(params)}`;
    };
    const filterTabs = showArchived ? '' : `
      <div class="inbox-filter-tabs" role="tablist" aria-label="Filter conversations">
        <a class="inbox-filter-tab${inboxFilter === 'all' ? ' is-active' : ''}" href="${inboxTabHref('all')}">All<span class="inbox-filter-tab__count">${filterCounts.all}</span></a>
        <a class="inbox-filter-tab${inboxFilter === 'unread' ? ' is-active' : ''}" href="${inboxTabHref('unread')}">Unread<span class="inbox-filter-tab__count">${filterCounts.unread}</span></a>
        <a class="inbox-filter-tab${inboxFilter === 'live' ? ' is-active' : ''}" href="${inboxTabHref('live')}">Live<span class="inbox-filter-tab__count">${filterCounts.live}</span></a>
      </div>`;
    const hasMoreContacts = !isSearchMode && (contacts || []).length >= pageSize;
    const paginationNav = '';
    const listContent = list || (inboxFilter !== 'all' && enrichedContacts.length > 0 ? `
                  <li style="border:0;">
                    <div class="empty-state-pro">
                      <h3 class="empty-state-pro__title">No ${inboxFilter === 'live' ? 'live' : inboxFilter} conversations here</h3>
                      <p class="empty-state-pro__copy">Nothing on this page matches the filter. Try another tab or <a href="/inbox${buildInboxQuery(filterBase)}">view all conversations</a>.</p>
                    </div>
                  </li>
                ` : `
                  <li style="border:0;">
                  <div class="empty-state-pro">
                    <h3 class="empty-state-pro__title">No conversations yet</h3>
                    <p class="empty-state-pro__copy">
                      WhatsApp conversations will appear here once customers message your business number.
                    </p>
                    <div class="empty-state-pro__tips">
                      <div class="empty-state-pro__tips-title">Getting started</div>
                      <ul>
                        <li>Share your WhatsApp Business number with customers</li>
                        <li>Customers can start conversations by sending any message</li>
                        <li>The assistant responds automatically from your knowledge base</li>
                        <li>Your team can take over anytime for human support</li>
                      </ul>
                    </div>
                  </div>
                  </li>
                `);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html>${getProfessionalHead('Inbox')}<body>
        <script src="/toast.js"></script>
        <script src="/inbox-page.js?v=${assetVer}"></script>
        <div class="container">
          ${renderTopbar('Inbox', email)}
          <div class="layout">
            ${renderSidebar('inbox', { showBookings: !!isUpgraded, isUpgraded })}
            <main class="main">
              <div class="main-content">
                <div class="inbox-workspace">
                <div class="inbox-toolbar">
                  <form method="get" action="/inbox" class="search-form">
                    <div class="inbox-toolbar__row">
                      ${filterTabs}
                      <div class="inbox-toolbar__links">
                        ${showArchived ? `
                          <a href="/inbox" class="btn btn-ghost btn-sm inbox-toolbar__link-btn" title="Back to Inbox">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 12H2"/><path d="M9 5l-7 7 7 7"/></svg>
                            Inbox
                          </a>
                        ` : `
                          <a href="/inbox?archived=1" class="btn btn-ghost btn-sm inbox-toolbar__link-btn" title="View archived">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
                            Archived
                          </a>
                        `}
                      </div>
                      <div class="search-input-group">
                        <input class="search-input" type="text" name="q" placeholder="Search conversations..." value="${escapeHtml(q)}"/>
                        <button type="button" class="btn btn-ghost inbox-filters-toggle" onclick="toggleSearchFilters()" title="Advanced filters">Filters</button>
                        <button type="submit" class="btn btn-primary" aria-label="Search">
                          <img src="/search-icon.svg" alt="" width="18" height="18">
                        </button>
                      </div>
                    </div>
                    <div class="search-filters" id="searchFilters" style="display: ${(messageType || direction || dateFrom || dateTo) ? 'flex' : 'none'};">
                      <div class="filter-group">
                        <label>Message Type:</label>
                        <select name="type" class="filter-select">
                          <option value="">All Types</option>
                          <option value="text" ${req.query.type === 'text' ? 'selected' : ''}>Text</option>
                          <option value="image" ${req.query.type === 'image' ? 'selected' : ''}>Images</option>
                          <option value="document" ${req.query.type === 'document' ? 'selected' : ''}>Documents</option>
                          <option value="interactive" ${req.query.type === 'interactive' ? 'selected' : ''}>Interactive</option>
                        </select>
                      </div>
                      <div class="filter-group">
                        <label>Direction:</label>
                        <select name="direction" class="filter-select">
                          <option value="">All Messages</option>
                          <option value="inbound" ${req.query.direction === 'inbound' ? 'selected' : ''}>Incoming</option>
                          <option value="outbound" ${req.query.direction === 'outbound' ? 'selected' : ''}>Outgoing</option>
                        </select>
                      </div>
                      <div class="filter-group">
                        <label>Date Range:</label>
                        <input type="date" name="date_from" class="filter-date" value="${req.query.date_from || ''}" placeholder="From"/>
                        <input type="date" name="date_to" class="filter-date" value="${req.query.date_to || ''}" placeholder="To"/>
                      </div>
                      <div class="filter-actions">
                        <button type="button" onclick="clearFilters()" class="btn btn-ghost">Clear</button>
                        <button type="submit" class="btn btn-primary">Search</button>
                      </div>
                    </div>
                  </form>
                </div>
              <div id="nameModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:1000; align-items:center; justify-content:center;">
                <div class="card" style="width:420px; max-width:95vw;">
                  <div class="small" style="margin-bottom:8px;">Name Customer</div>
                  <form id="nameForm" method="post" action="" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;" style="display:grid; gap:8px;">
                    <input class="settings-field" type="text" name="display_name" placeholder="Customer name" required />
                    <textarea class="settings-field" name="notes" rows="3" placeholder="Notes (optional)"></textarea>
                    <div style="display:flex; gap:8px; justify-content:flex-end;">
                      <button type="button" class="btn btn-ghost" onclick="closeNameModal()">Cancel</button>
                      <button type="submit" class="btn btn-primary">Save</button>
                    </div>
                  </form>
                  
                  
                </div>
              </div>
                <!-- WhatsApp Token Modal -->
                <div id="waTokenModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:1100; align-items:center; justify-content:center;">
                  <div class="card" style="width:480px; max-width:95vw;">
                    <div class="small" style="margin-bottom:8px;">WhatsApp Configuration</div>
                    <div id="waTokenMsg" class="small" style="margin-bottom:8px; color:#92400e; background:#fffbeb; border:1px solid #fcd34d; padding:8px; border-radius:6px;">Your WhatsApp token appears to be invalid or expired. Please enter a new token.</div>
                    <label>New WhatsApp Token
                      <input id="waTokenInput" type="password" placeholder="E***************" class="settings-field" />
                    </label>
                    <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:8px;">
                        <button type="button" class="btn btn-ghost" onclick="closeWaTokenModal()">Cancel</button>
                        <button type="button" id="waTokenSave" class="btn btn-primary" onclick="saveWaToken()">Save Token</button>
                    </div>
                  </div>
                </div>
                <div class="conversation-list-shell" id="inboxConversationList"
                  data-infinite-scroll="${isSearchMode ? '' : '1'}"
                  data-page="${page}"
                  data-has-more="${hasMoreContacts ? '1' : '0'}"
                  data-page-size="${pageSize}"
                  data-filter="${escapeHtml(inboxFilter)}"
                  data-archived="${showArchived ? '1' : '0'}"
                  data-q="${escapeHtml(q)}"
                  data-type="${escapeHtml(messageType || '')}"
                  data-direction="${escapeHtml(direction)}"
                  data-date-from="${escapeHtml(dateFrom)}"
                  data-date-to="${escapeHtml(dateTo)}">
                <ul class="list" id="inboxConversationListItems">${searchResultsCount}${listContent}</ul>
                <div class="inbox-list-status" id="inboxListStatus"${hasMoreContacts ? '' : ' hidden'}>
                  <span class="inbox-list-status__text" id="inboxListStatusText">Scroll for more conversations</span>
                </div>
                ${paginationNav}
                </div>
                </div>
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  app.get("/api/inbox/contacts", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const showArchived = ['1', 'true', 'yes'].includes(String(req.query.archived || '').toLowerCase());
    const inboxFilter = ['all', 'unread', 'live'].includes(String(req.query.filter || 'all'))
      ? String(req.query.filter || 'all')
      : 'all';
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.min(50, Math.max(10, parseInt(req.query.page_size || '20', 10) || 20));
    const q = (req.query.q || '').toString().trim();
    const messageType = parseInboxMessageTypeFilter(req.query);
    const direction = (req.query.direction || '').toString().trim();
    const dateFrom = (req.query.date_from || '').toString().trim();
    const dateTo = (req.query.date_to || '').toString().trim();
    const isSearchMode = !showArchived && (q || messageType || direction || dateFrom || dateTo);

    if (isSearchMode) {
      return res.json({ success: false, error: 'Infinite scroll is not available in search mode' });
    }

    let contacts = showArchived
      ? await listArchivedContacts(userId, { page, pageSize })
      : await listContactsForUser(userId, { page, pageSize });

    if (!showArchived) {
      try {
        const archivedRows = await Handoff.find({ user_id: userId, is_archived: true }).select('contact_id');
        const archivedSet = new Set(archivedRows.map(r => String(r.contact_id)));
        contacts = (contacts || []).filter(c => !archivedSet.has(String(c.contact)));
      } catch (_) {}
    }

    const {
      enrichedContacts,
      customerNameByContact,
      lastSeenByContact,
      statusByContact,
      escalationByContact,
      liveByContact,
      unreadCounts,
    } = await enrichInboxContacts(userId, contacts);

    const filteredContacts = enrichedContacts.filter((c) => {
      if (inboxFilter === 'unread') return (c.unreadCount || 0) > 0 || c.hasNew;
      if (inboxFilter === 'live') return c.isLive;
      return true;
    });

    const html = renderInboxContactListItems(filteredContacts, {
      showArchived,
      customerNameByContact,
      lastSeenByContact,
      statusByContact,
      escalationByContact,
      liveByContact,
      unreadCounts,
    });

    return res.json({
      success: true,
      html,
      page,
      hasMore: (contacts || []).length >= pageSize,
      count: filteredContacts.length,
    });
  });

  app.get("/api/inbox/:phone/messages", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const phoneDigits = normalizePhone(phone);
    const beforeTs = parseInt(String(req.query.before_ts || ''), 10) || null;

    if (!beforeTs) {
      return res.status(400).json({ success: false, error: 'before_ts is required' });
    }

    try {
      const { messages, hasMore, oldestTs } = await listThreadMessagesPage(userId, phoneDigits, {
        beforeTs,
        limit: THREAD_MESSAGES_PAGE_SIZE,
      });

      const msgs = messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        text_body: m.text_body,
        ts: m.timestamp || 0,
        raw: m.raw,
        delivery_status: m.delivery_status,
        read_status: m.read_status,
      }));

      const messageIds = msgs.map((m) => m.id);
      const [
        reactionsByMessage,
        userReactionsByMessage,
        replyOriginals,
        planStatus,
      ] = await Promise.all([
        getMessagesReactions(messageIds),
        getUserReactionsForMessages(messageIds, userId),
        getReplyOriginals(messageIds),
        getPlanStatus(userId),
      ]);

      const templatePreviewByKey = new Map();
      try {
        const tplRows = await getDB().collection('wa_templates').find({ user_id: String(userId) })
          .project({ name: 1, language: 1, body: 1, components: 1 })
          .toArray();
        for (const row of tplRows) {
          const { bodyText } = extractTemplateBodyAndVars(row);
          if (bodyText) templatePreviewByKey.set(`${row.name}::${row.language}`, bodyText);
        }
      } catch {}

      const html = renderThreadMessagesHtml(msgs, {
        userId,
        req,
        isUpgraded: !!planStatus?.isUpgraded,
        reactionsByMessage,
        userReactionsByMessage,
        replyOriginals,
        templatePreviewByKey,
      });

      return res.json({ success: true, html, hasMore, oldestTs });
    } catch (error) {
      console.error('Thread messages API error:', error);
      return res.status(500).json({ success: false, error: 'Failed to load messages' });
    }
  });

  app.get("/api/search", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const q = (req.query.q || "").toString().trim();
    const messageType = parseInboxMessageTypeFilter(req.query);
    const direction = (req.query.direction || "").toString().trim();
    const dateFrom = (req.query.date_from || "").toString().trim();
    const dateTo = (req.query.date_to || "").toString().trim();
    const contact = (req.query.contact || "").toString().trim();
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    if (!q && !messageType && !direction && !dateFrom && !dateTo && !contact) {
      return res.json({ 
        success: false, 
        error: "At least one search parameter is required" 
      });
    }
    
    try {
      const results = await performMessageSearch(userId, {
        q, messageType, direction, dateFrom, dateTo, contact, limit, offset
      });
      
      res.json({
        success: true,
        results: results.messages,
        total: results.total,
        hasMore: results.hasMore
      });
    } catch (error) {
      console.error('Search API error:', error);
      res.status(500).json({
        success: false,
        error: "Search failed"
      });
    }
  });
  app.get("/search", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const q = (req.query.q || "").toString().trim();
    const messageType = parseInboxMessageTypeFilter(req.query);
    const direction = (req.query.direction || "").toString().trim();
    const dateFrom = (req.query.date_from || "").toString().trim();
    const dateTo = (req.query.date_to || "").toString().trim();
    const contact = (req.query.contact || "").toString().trim();
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    
    const email = await getSignedInEmail(req);
    
    let searchResults = { messages: [], total: 0, hasMore: false };
    
    if (q || messageType || direction || dateFrom || dateTo || contact) {
      try {
        searchResults = await performMessageSearch(userId, {
          q, messageType, direction, dateFrom, dateTo, contact, limit, offset
        });
      } catch (error) {
        console.error('Search error:', error);
      }
    }
    const resultsHtml = searchResults.messages.map(msg => {
      const contactName = msg.contact_name || `+${msg.contact.replace(/^\+/, '')}`;
      const directionIcon = msg.direction === 'inbound' ? '←' : '→';
      const typeIcon = msg.type === 'image' ? '🖼️' : msg.type === 'document' ? '📄' : msg.type === 'interactive' ? '🔘' : '💬';
      let highlightedText = msg.text_body || '';
      if (q) {
        const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        highlightedText = highlightedText.replace(regex, '<span class="search-highlight">$1</span>');
      }
      
      return `
        <div class="search-result-item">
          <div class="search-result-header">
            <div class="search-result-contact">
              <span class="direction-icon">${directionIcon}</span>
              <span class="contact-name">${contactName}</span>
              <span class="message-type">${typeIcon}</span>
            </div>
            <div class="search-result-time">${msg.formatted_time}</div>
          </div>
          <div class="search-result-content">
            <div class="search-result-text">${highlightedText}</div>
            <div class="search-result-actions">
              <a href="/inbox/${msg.contact}" class="btn-primary">Open Chat</a>
            </div>
          </div>
        </div>
      `;
    }).join('');
    
    const paginationHtml = searchResults.total > limit ? `
      <div class="pagination">
        ${page > 1 ? `<a href="/search?${new URLSearchParams({...req.query, page: page - 1})}" class="btn btn-ghost">← Previous</a>` : ''}
        <span class="pagination-info">Page ${page} of ${Math.ceil(searchResults.total / limit)}</span>
        ${searchResults.hasMore ? `<a href="/search?${new URLSearchParams({...req.query, page: page + 1})}" class="btn btn-ghost">Next →</a>` : ''}
      </div>
    ` : '';
    
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html>${getProfessionalHead('Search Results')}<body>
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{
              const r=await fetch('/auth/status',{credentials:'include', headers:{'Accept':'application/json'}});
              const j=await r.json();
              if(!j.signedIn){ window.location='/auth'; return; }
            }catch(e){
              // Don't force a relogin on transient network/auth-status failures.
              console.warn('Auth status check failed (non-fatal):', e);
            }
          })();
        </script>
        <div class="container">
          ${renderTopbar(`<a href="/inbox">Inbox</a> / Search Results`, email)}
          <div class="layout">
            ${renderSidebar('inbox', { showBookings: !!isUpgraded, isUpgraded })}
            <main class="main">
              <div class="search-container">
                <form method="get" action="/search" class="search-form">
                  <div class="search-input-group">
                    <input class="search-input" type="text" name="q" placeholder='Search messages...' value="${q}"/>
                    <button type="submit" class="btn btn-primary">
                      <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                        <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                      </svg>
                    </button>
                  </div>
                  <div class="search-filters" id="searchFilters" style="display: none;">
                    <div class="filter-group">
                      <label>Message Type:</label>
                      <select name="type" class="filter-select">
                        <option value="">All Types</option>
                        <option value="text" ${messageType === 'text' ? 'selected' : ''}>Text</option>
                        <option value="image" ${messageType === 'image' ? 'selected' : ''}>Images</option>
                        <option value="document" ${messageType === 'document' ? 'selected' : ''}>Documents</option>
                        <option value="interactive" ${messageType === 'interactive' ? 'selected' : ''}>Interactive</option>
                      </select>
                    </div>
                    <div class="filter-group">
                      <label>Direction:</label>
                      <select name="direction" class="filter-select">
                        <option value="">All Messages</option>
                        <option value="inbound" ${direction === 'inbound' ? 'selected' : ''}>Incoming</option>
                        <option value="outbound" ${direction === 'outbound' ? 'selected' : ''}>Outgoing</option>
                      </select>
                    </div>
                    <div class="filter-group">
                      <label>Contact:</label>
                      <input type="text" name="contact" class="filter-select" value="${contact}" placeholder="Phone number"/>
                    </div>
                    <div class="filter-group">
                      <label>Date Range:</label>
                      <input type="date" name="date_from" class="filter-date" value="${dateFrom}" placeholder="From"/>
                      <input type="date" name="date_to" class="filter-date" value="${dateTo}" placeholder="To"/>
                    </div>
                    <div class="filter-actions">
                      <button type="button" onclick="clearFilters()" class="btn btn-ghost">Clear</button>
                      <button type="submit" class="btn btn-primary">Search</button>
                    </div>
                  </div>
                  <button type="button" onclick="toggleSearchFilters()" class="btn btn-ghost">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                      <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
                    </svg>
                    Filters
                  </button>
                </form>
              </div>
              
              ${searchResults.total > 0 ? `
                <div class="search-result-count">Found ${searchResults.total} message${searchResults.total !== 1 ? 's' : ''} matching your search criteria</div>
                <div class="search-results">
                  ${resultsHtml}
                </div>
                ${paginationHtml}
              ` : q || messageType || direction || dateFrom || dateTo || contact ? `
                <div class="search-result-count">No messages found matching your search criteria</div>
              ` : `
                <div class="search-result-count">Enter search terms to find messages</div>
              `}
            </main>
          </div>
        </div>
        <script>
          function toggleSearchFilters(){
            var filters = document.getElementById('searchFilters');
            if (filters.style.display === 'none') {
              filters.style.display = 'block';
            } else {
              filters.style.display = 'none';
            }
          }
          function clearFilters(){
            document.querySelector('input[name="q"]').value = '';
            document.querySelector('select[name="type"]').value = '';
            document.querySelector('select[name="direction"]').value = '';
            document.querySelector('input[name="contact"]').value = '';
            document.querySelector('input[name="date_from"]').value = '';
            document.querySelector('input[name="date_to"]').value = '';
          }
        </script>
      </body></html>
    `);
  });

  app.get("/inbox/:phone/delete", ensureAuthed, (_req, res) => {
    return redirectToInbox(res, { toast: 'Conversation deleted', type: 'success' });
  });

  app.get("/inbox/:phone", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);    const userId = getCurrentUserId(req);
    try {
      const variants = contactIdVariants(phone);
      const digits = normalizePhone(phone);
      const deletedHandoff = await Handoff.findOne({
        user_id: userId,
        contact_id: { $in: variants },
        deleted_at: { $exists: true, $ne: null }
      }).select('deleted_at').lean();
      if (deletedHandoff?.deleted_at) {
        return redirectToInbox(res);
      }
      const [custRow, handoffRow, msgRow] = await Promise.all([
        Customer.findOne({ user_id: userId, contact_id: { $in: variants } }).select('_id'),
        Handoff.findOne({
          user_id: userId,
          contact_id: { $in: variants },
          $or: [{ deleted_at: { $exists: false } }, { deleted_at: null }]
        }).select('_id'),
        Message.findOne({
          user_id: userId,
          $or: [
            { from_digits: digits },
            { to_digits: digits },
            { from_id: { $in: variants } },
            { to_id: { $in: variants } }
          ]
        }).select('_id')
      ]);
      if (!custRow && !handoffRow && !msgRow) {
        const email404 = await getSignedInEmail(req);
        const { isUpgraded: isUpgraded404 } = await getPlanStatus(userId);
        res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(`
          <html>${getProfessionalHead('Not Found')}<body>
            <div class="container">
              ${renderTopbar(`<a href="/inbox">Inbox</a>`, email404)}
              <div class="layout">
                ${renderSidebar('inbox', { showBookings: !!isUpgraded404, isUpgraded: !!isUpgraded404 })}
                <main class="main">
                  <div class="main-content">
                    <div class="card" style="max-width:720px;margin:20px auto;">
                      <div style="font-size:64px; line-height:1; font-weight:800; color:#111827; letter-spacing:-1px; margin:0 0 10px 0;">404</div>
                      <h3 style="margin:0 0 6px 0;">Page not found</h3>
                      <p class="small" style="color:#6b7280; margin:0 0 10px 0;">
                        We couldn’t find a conversation for <strong>+${String(phone).replace(/^\\+?/, '')}</strong>.
                      </p>
                      <div style="display:flex; gap:8px; flex-wrap:wrap;">
                        <a class="btn btn-primary" href="/inbox">Back to Inbox</a>
                        <a class="btn btn-ghost" href="/inbox">Go to Inbox</a>
                      </div>
                    </div>
                  </div>
                </main>
              </div>
            </div>
          </body></html>
        `);
      }
    } catch {}
    const [sidebarSettings, { isUpgraded }] = await Promise.all([
      getSettingsForUser(userId),
      getPlanStatus(userId)
    ]);
    const defaultTemplateName = (sidebarSettings?.wa_template_name || '').toString().trim();
    const defaultTemplateLang = (sidebarSettings?.wa_template_language || 'en_US').toString().trim() || 'en_US';
    let templateBody = '';
    let templateVars = [];
    let defaultTemplateOnMeta = false;
    if (defaultTemplateName) {
      try {
        const dbNative = getDB();
        const { doc: tplDoc } = await findWaTemplateDoc(
          dbNative,
          userId,
          defaultTemplateName,
          defaultTemplateLang
        );
        const parsed = extractTemplateBodyAndVars(tplDoc);
        templateBody = parsed.bodyText || '';
        templateVars = parsed.indices || [];
        const metaLangs = await fetchMetaTemplateLanguages(sidebarSettings, defaultTemplateName);
        defaultTemplateOnMeta = metaLangs.length > 0
          && String(tplDoc?.status || '').toUpperCase() !== 'NOT_ON_META';
      } catch (e) {
        console.warn('[Inbox][TemplateBanner] Failed to load template details:', e?.message || e);
      }
    }
    const phoneDigits = normalizePhone(phone);
    try {
      const nowSec = Math.floor(Date.now()/1000);
      await upsertHandoffForContact(userId, phone, { last_seen_ts: nowSec });
    } catch {}
    const cust = await Customer.findOne({ user_id: userId, contact_id: phone }).select('display_name');
    const headerName = cust?.display_name || ('+' + String(phone).replace(/^\+/, ''));
    const headerInitials = contactInitials(cust?.display_name, phone);
    let msgs = await Message.aggregate([
      {
        $match: {
          user_id: userId,
          $or: [
            { $and: [ { direction: 'inbound' }, { $or: [ { from_digits: phoneDigits }, { $and: [ { from_digits: { $in: [null, undefined] } }, { $expr: { $eq: [ { $replaceAll: { input: { $replaceAll: { input: { $replaceAll: { input: { $ifNull: ['$from_id', ''] }, find: '+', replacement: '' } }, find: ' ', replacement: '' } }, find: '-', replacement: '' } }, phoneDigits ] } } ] } ] } ] },
            { $and: [ { direction: 'outbound' }, { $or: [ { to_digits: phoneDigits }, { $and: [ { to_digits: { $in: [null, undefined] } }, { $expr: { $eq: [ { $replaceAll: { input: { $replaceAll: { input: { $replaceAll: { input: { $ifNull: ['$to_id', ''] }, find: '+', replacement: '' } }, find: ' ', replacement: '' } }, find: '-', replacement: '' } }, phoneDigits ] } } ] } ] } ] }
          ]
        }
      },
      { $sort: { timestamp: 1 } },
      { $group: { _id: null, items: { $push: '$$ROOT' } } },
      { $project: { items: { $slice: ['$items', -THREAD_MESSAGES_PAGE_SIZE] } } },
      { $unwind: '$items' },
      { $replaceRoot: { newRoot: '$items' } },
      {
        $lookup: {
          from: 'message_statuses',
          let: { mid: '$id', uid: '$user_id' },
          pipeline: [
            { $match: { $expr: { $and: [ { $eq: ['$message_id', '$$mid'] }, { $eq: ['$user_id', '$$uid'] } ] } } },
            { $sort: { timestamp: -1 } },
            { $limit: 1 }
          ],
          as: 'last_status'
        }
      },
      {
        $project: {
          id: 1,
          direction: 1,
          type: 1,
          text_body: 1,
          ts: { $ifNull: ['$timestamp', 0] },
          raw: 1,
          delivery_status: 1,
          read_status: 1,
          delivery_timestamp: 1,
          read_timestamp: 1,
          message_status: { $arrayElemAt: ['$last_status.status', 0] },
          status_timestamp: { $arrayElemAt: ['$last_status.timestamp', 0] }
        }
      }
    ]);
    try { msgs = msgs.filter(m => m?.type !== 'system_clear'); } catch {}
    const hasMoreThreadMessages = msgs.length >= THREAD_MESSAGES_PAGE_SIZE;
    const oldestThreadTs = msgs.length ? Number(msgs[0]?.ts || 0) : 0;
    const messageIds = msgs.map(m => m.id);
    const reactionsByMessage = await getMessagesReactions(messageIds);
    const userReactionsByMessage = await getUserReactionsForMessages(messageIds, userId);
    const repliesByMessage = await getMessagesReplies(messageIds);
    const replyOriginals = await getReplyOriginals(messageIds);
    const status = await findHandoffForContact(userId, phone, 'is_human human_expires_ts');
    const humanMode = resolveHumanMode(status);
    let isHuman = humanMode.isHuman;
    const expTs = humanMode.expTs;
    const nowSec = Math.floor(Date.now()/1000);
    const remain = humanMode.remain;
    let lastInboundTs = 0;
    try {
      for (const m of msgs) {
        if (m?.direction === 'inbound') {
          const ts = Number(m?.ts || 0);
          if (ts > lastInboundTs) lastInboundTs = ts;
        }
      }
    } catch {}
    const over24h = lastInboundTs && (nowSec - lastInboundTs) > 24*3600;
    if (humanMode.expired) {
      isHuman = false;
      try {
        await upsertHandoffForContact(userId, phone, { is_human: false, human_expires_ts: 0 });
      } catch {}
    }
    const conversationStatus = await getConversationStatus(userId, phone);
    const statusKey = conversationStatus || 'new';
    const statusDisplay = STATUS_DISPLAY_NAMES[statusKey] || 'New';
    const statusColor = STATUS_COLORS[statusKey] || STATUS_COLORS['new'];
    const statusLocked = conversationStatus === CONVERSATION_STATUSES.RESOLVED;
    
    const email = await getSignedInEmail(req);
    const quickReplies = await getQuickReplies(userId);
    const templatePreviewByKey = new Map();
    try {
      const tplRows = await getDB().collection("wa_templates").find({ user_id: String(userId) })
        .project({ name: 1, language: 1, body: 1, components: 1 })
        .toArray();
      for (const row of tplRows) {
        const { bodyText } = extractTemplateBodyAndVars(row);
        if (bodyText) templatePreviewByKey.set(`${row.name}::${row.language}`, bodyText);
      }
    } catch {}
    try {
      const etagBase = `${userId}:${phone}:${msgs.length}:${msgs[msgs.length-1]?.id||''}`;
      const etag = 'W/"'+Buffer.from(etagBase).toString('base64').slice(0, 32)+'"';
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('ETag', etag);
    } catch {}

    const items = renderThreadMessagesHtml(msgs, {
      userId,
      req,
      isUpgraded,
      reactionsByMessage,
      userReactionsByMessage,
      replyOriginals,
      templatePreviewByKey,
    });
    const assetVer = process.env.STATIC_ASSETS_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'dev';
    const toastMsg = (req.query?.toast || '').toString();
    const toastType = (req.query?.type || '').toString();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html>${getProfessionalHead(`Chat +${String(phone).replace(/^\+/, '')}`)}<body>
          <script src="/toast.js"></script>
          <script src="/inbox-chat-pagination.js?v=${assetVer}"></script>
          <script>
            (async function checkAuthOnLoad(){
              await window.authManager.checkAuthOnLoad();
            })();

            let realtimeManager = null;
            const phone = '${phone}'.split('?')[0]; // Clean phone number to remove query parameters
            const phoneDigits = phone.replace(/\D/g, ''); // Normalize to digits for realtime rooms/APIs
            const userId = '${userId}';

            window.addEventListener('pageshow', function(e) {
              if (e.persisted) {
                window.location.replace('/inbox');
              }
            });
            
            // Debug: Log only when DEBUG_LOGS is enabled
            if (window?.ENV?.DEBUG_LOGS === '1') console.log('🔍 Debug - userId from template:', userId);

            // Initialize real-time features
            document.addEventListener('DOMContentLoaded', async () => {
              // Wait for realtime manager to be available
              const checkRealtime = async () => {
                if (window.realtimeManager) {
                  realtimeManager = window.realtimeManager;
                  
                  // Ensure we have a valid userId
                  let finalUserId = userId;
                  if (!finalUserId || finalUserId === 'undefined' || finalUserId === 'null') {
                    // Try to get userId from auth manager as fallback
                    if (window.authManager && window.authManager.getCurrentUserId) {
                      finalUserId = await window.authManager.getCurrentUserId();
                      if (window?.ENV?.DEBUG_LOGS === '1') console.log('🔍 Debug - userId from auth manager:', finalUserId);
                    }
                  }
                  
                  // Set the userId for the realtime manager
                  realtimeManager.userId = finalUserId;
                  if (window?.ENV?.DEBUG_LOGS === '1') console.log('🔍 Debug - Setting realtimeManager.userId to:', finalUserId);
                  // Connect to Socket.IO
                  await realtimeManager.connect();
                  realtimeManager.joinChat(phoneDigits);
                  setupRealtimeFeatures();
                } else {
                  setTimeout(checkRealtime, 100);
                }
              };
              checkRealtime();
            });
            function setupRealtimeFeatures() {
              if (!realtimeManager) return;
              
              // Set up typing detection
              const messageInput = document.getElementById('messageInput');
              if (messageInput) {
                let typingTimer = null;
                
                messageInput.addEventListener('input', () => {
                  if (realtimeManager.isConnected) {
                    realtimeManager.startTyping(phoneDigits);
                    
                    // Clear existing timer
                    if (typingTimer) clearTimeout(typingTimer);
                    
                    // Stop typing after 1 second of inactivity
                    typingTimer = setTimeout(() => {
                      realtimeManager.stopTyping(phoneDigits);
                    }, 1000);
                  }
                });
                
                messageInput.addEventListener('blur', () => {
                  if (realtimeManager.isConnected) {
                    realtimeManager.stopTyping(phoneDigits);
                  }
                });
              }
              
              // Override form submission to use real-time messaging
              const messageForm = document.querySelector('form[action*="/inbox/' + phone + '/send"]');
              if (messageForm) {
                messageForm.addEventListener('submit', (e) => {
                  e.preventDefault();
                  // Use the central handler which ensures realtime and avoids page reloads
                  handleFormSubmit(e);
                  return false;
                });
              }
            }
            function applyHandoffUi(isHumanMode) {
              const handoffBtn = document.getElementById('handoffToggleBtn');
              if (handoffBtn) {
                handoffBtn.classList.toggle('is-human', isHumanMode);
                handoffBtn.setAttribute('data-is-human', isHumanMode ? 'true' : 'false');
                handoffBtn.title = isHumanMode ? 'Switch to AI' : 'Take over conversation';
                const hiddenInput = handoffBtn.closest('form')?.querySelector('input[name="is_live"]');
                if (hiddenInput) {
                  hiddenInput.value = isHumanMode ? '0' : '1';
                }
              }
              const modePill = document.querySelector('.wa-chat-header__mode');
              if (modePill) {
                modePill.classList.toggle('is-human', isHumanMode);
                modePill.classList.toggle('is-ai', !isHumanMode);
                modePill.textContent = isHumanMode ? 'Human' : 'AI';
              }
              applyComposerLiveMode(isHumanMode);
            }

            function applyComposerLiveMode(isHumanMode) {
              try {
                const sendButton = document.getElementById('sendButton');
                const messageInput = document.getElementById('messageInput');
                const attachBtn = document.querySelector('.wa-attach-btn');
                const emojiBtn = document.querySelector('.wa-emoji-btn');

                if (sendButton) {
                  if (isHumanMode) {
                    sendButton.setAttribute('data-original-disabled', 'false');
                  } else {
                    sendButton.setAttribute('data-original-disabled', 'true');
                    sendButton.disabled = true;
                  }
                }
                if (messageInput) {
                  messageInput.disabled = !isHumanMode;
                }
                if (attachBtn) {
                  attachBtn.disabled = !isHumanMode;
                }
                if (emojiBtn) {
                  emojiBtn.disabled = !isHumanMode;
                }
                if (typeof updateSendButtonState === 'function') {
                  updateSendButtonState();
                }
              } catch (_) {}
            }
            window.applyComposerLiveMode = applyComposerLiveMode;

            async function prepareHandoffToggle() {
              const form = document.getElementById('handoffToggleForm');
              const btn = document.getElementById('handoffToggleBtn');

              if (!form || !btn || btn.disabled || btn.dataset.busy === '1') return;

              const isHuman = btn.getAttribute('data-is-human') === 'true';
              const isLive = !isHuman;
              btn.dataset.busy = '1';

              try {
                const body = new URLSearchParams();
                body.set('is_live', isLive ? '1' : '0');

                const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                const timeoutId = controller ? setTimeout(function() { controller.abort(); }, 15000) : null;

                const resp = await fetch(form.action, {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json'
                  },
                  body: body.toString(),
                  signal: controller ? controller.signal : undefined
                });

                if (timeoutId) clearTimeout(timeoutId);

                let data = {};
                try { data = await resp.json(); } catch (_) {}

                if (!resp.ok || data?.error) {
                  const msg = data?.error || 'Failed to update live mode';
                  if (window.Toast?.error) window.Toast.error(msg);
                  else if (window.Toast?.show) window.Toast.show(msg, 'error');
                  return;
                }

                window.location.href = '/inbox/' + encodeURIComponent(phone);
              } catch (err) {
                const msg = (err && err.name === 'AbortError')
                  ? 'Live mode request timed out. Please try again.'
                  : (err?.message || 'Failed to update live mode');
                if (window.Toast?.error) window.Toast.error(msg);
                else if (window.Toast?.show) window.Toast.show(msg, 'error');
              } finally {
                btn.dataset.busy = '0';
              }
            }
            window.prepareHandoffToggle = prepareHandoffToggle;

            function setupComposer(){
              const ta=document.querySelector('#messageInput');
              if(!ta) return; 
              
              ta.addEventListener('keydown', function(e){
                if(e.key==='Enter' && !e.shiftKey){
                  e.preventDefault();
                  // Trigger the form's submit handler without bypassing listeners
                  if (this.form && typeof this.form.requestSubmit === 'function') {
                    this.form.requestSubmit();
                  } else if (this.form) {
                    this.form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
                  }
                }
                // Open Quick Replies on '/' shortcut
                if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  e.preventDefault();
                  showQuickReplies();
                }
              });
              
              // Auto-resize textarea and update send button state
              ta.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 100) + 'px';
                updateSendButtonState();
              });
              
              // Initial button state check
              updateSendButtonState();
            }

            function updateSendButtonState() {
              const sendButton = document.getElementById('sendButton');
              const messageInput = document.getElementById('messageInput');
              const imagePreview = document.getElementById('imagePreview');
              
              if (!sendButton || !messageInput) return;
              
              const hasText = messageInput.value.trim().length > 0;
              const hasImage = imagePreview && imagePreview.style.display !== 'none';
              const isHuman = sendButton.getAttribute('data-original-disabled') !== 'true';
              
              // Enable send button only if user is human AND (has text OR has image)
              if (isHuman && (hasText || hasImage)) {
                sendButton.disabled = false;
              } else {
                sendButton.disabled = true;
              }
            }
            
            function scrollToBottom() {
              const chatContainer = document.querySelector('.chat-thread-messages') || document.querySelector('.chat-thread');
              if (chatContainer) {
                chatContainer.scrollTop = chatContainer.scrollHeight;
                // Force a reflow to ensure scroll happens
                chatContainer.offsetHeight;
              }
            }

            function scrollToBottomAfterImages() {
              // Wait for all images to load before scrolling
              const images = document.querySelectorAll('.chat-thread-messages img, .chat-thread img');
              let loadedImages = 0;
              
              if (images.length === 0) {
                // No images, scroll immediately
                scrollToBottom();
                return;
              }
              
              images.forEach(img => {
                if (img.complete) {
                  loadedImages++;
                } else {
                  img.addEventListener('load', () => {
                    loadedImages++;
                    if (loadedImages === images.length) {
                      setTimeout(scrollToBottom, 100);
                    }
                  });
                  img.addEventListener('error', () => {
                    loadedImages++;
                    if (loadedImages === images.length) {
                      setTimeout(scrollToBottom, 100);
                    }
                  });
                }
              });
              
              if (loadedImages === images.length) {
                setTimeout(scrollToBottom, 100);
              }
            }
            
            function toggleQuickReplies() {
              const container = document.getElementById('quickRepliesContainer');
              const grid = document.getElementById('quickRepliesGrid');
              const toggle = document.getElementById('quickRepliesToggle');
              
              if (container && grid && toggle) {
                if (grid.style.display === 'none') {
                  grid.style.display = 'grid';
                  toggle.style.transform = 'rotate(0deg)';
                  container.classList.remove('collapsed');
                } else {
                  grid.style.display = 'none';
                  toggle.style.transform = 'rotate(180deg)';
                  container.classList.add('collapsed');
                }
              }
            }
            function showQuickReplies() {
              const container = document.getElementById('quickRepliesContainer');
              const grid = document.getElementById('quickRepliesGrid');
              const toggle = document.getElementById('quickRepliesToggle');
              if (!container || !grid) return;
              grid.style.display = 'grid';
              if (toggle) toggle.style.transform = 'rotate(0deg)';
              container.classList.remove('collapsed');
              try { container.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
            }
            
            function selectQuickReply(text) {
              const messageInput = document.getElementById('messageInput');
              if (messageInput) {
                messageInput.value = text;
                messageInput.focus();
                updateSendButtonState();
                // Auto-scroll to bottom after selecting quick reply
                setTimeout(scrollToBottom, 100);
              }
            }
            
            function initTypingIndicator() {
              const phone = '${phone}'.split('?')[0]; // Clean phone number
              const userId = '${userId}';
              
              // Typing indicators are now handled by Socket.IO in realtime.js
              if (window?.ENV?.DEBUG_LOGS === '1') console.log('Typing indicators initialized via Socket.IO');
            }
            
            function showTypingIndicator() {
              const indicator = document.getElementById('typingIndicator');
              if (indicator) {
                indicator.style.display = 'block';
                scrollToBottom();
              }
            }
            
            function hideTypingIndicator() {
              const indicator = document.getElementById('typingIndicator');
              if (indicator) {
                indicator.style.display = 'none';
              }
            }
            
            // Test functions for typing indicators
            function testTypingStart() {
              const phone = '${phone}'.split('?')[0]; // Clean phone number
              const userId = '${userId}';
              fetch('/api/typing/' + phone + '/start', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ userId: userId })
              }).then(response => response.json())
                .then(data => {
                  if (window?.ENV?.DEBUG_LOGS === '1') console.log('Typing start test:', data);
                })
                .catch(error => {
                  console.error('Error testing typing start:', error);
                });
            }
            
            function testTypingStop() {
              const phone = '${phone}'.split('?')[0]; // Clean phone number
              const userId = '${userId}';
              fetch('/api/typing/' + phone + '/stop', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ userId: userId })
              }).then(response => response.json())
                .then(data => {
                  if (window?.ENV?.DEBUG_LOGS === '1') console.log('Typing stop test:', data);
                })
                .catch(error => {
                  console.error('Error testing typing stop:', error);
                });
            }
            
            // Reaction and Reply functions
            let currentMessageId = null;
            let currentReplyToMessageId = null;
            
            function showReactionPicker(messageId) {
              currentMessageId = messageId;
              const picker = document.getElementById('reactionPicker');
              if (picker) {
                picker.style.display = 'block';
                picker.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }
            }
            
            function hideReactionPicker() {
              const picker = document.getElementById('reactionPicker');
              if (picker) {
                picker.style.display = 'none';
              }
              currentMessageId = null;
            }
            
            function addReaction(emoji) {
              if (!currentMessageId) return;
              
              const phone = '${phone}'.split('?')[0]; // Clean phone number
              fetch('/api/reactions/' + currentMessageId, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                credentials: 'include',
                body: JSON.stringify({ emoji: emoji, phone: phone })
              }).then(async response => {
                  let data;
                  try { data = await response.json(); }
                  catch { const text = await response.text(); throw new Error(text || 'Non-JSON response'); }
                  return data;
                }).then(data => {
                  if (data.success) {
                    // Reload the page to show updated reactions
                    window.location.reload();
                  } else {
                    console.error('Failed to add reaction:', data.error);
                  }
                })
                .catch(error => {
                  console.error('Error adding reaction:', error);
                });
              
              hideReactionPicker();
            }
            
            function toggleReaction(messageId, emoji) {
              const phone = '${phone}'.split('?')[0]; // Clean phone number
              fetch('/api/reactions/' + messageId, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                credentials: 'include',
                body: JSON.stringify({ emoji: emoji, phone: phone })
              }).then(async response => {
                  let data;
                  try { data = await response.json(); }
                  catch { const text = await response.text(); throw new Error(text || 'Non-JSON response'); }
                  return data;
                }).then(data => {
                  if (data.success) {
                    // Reload the page to show updated reactions
                    window.location.reload();
                  } else {
                    console.error('Failed to toggle reaction:', data.error);
                  }
                })
                .catch(error => {
                  console.error('Error toggling reaction:', error);
                });
            }
            function retryMessage(messageId) {
              if (window?.ENV?.DEBUG_LOGS === '1') console.log('🔄 Retrying message (raw id):', messageId);
              // Normalize id (handle accidental spaces)
              const cleanId = String(messageId || '').trim().replace(/\s+/g, '_');
              if (window?.ENV?.DEBUG_LOGS === '1') console.log('🔄 Retrying message (normalized id):', cleanId);
              
              // Show loading state on the retry button
              const retryButton = document.querySelector('[data-message-id="' + cleanId + '"]');
              if (retryButton) {
                retryButton.disabled = true;
                retryButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
                retryButton.style.opacity = '0.6';
              }
              
              fetch('/retry-message/' + encodeURIComponent(cleanId), {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                }
              }).then(response => response.json())
                .then(data => {
                  if (data.success) {
                    if (window?.ENV?.DEBUG_LOGS === '1') console.log('✅ Message retried successfully:', data.newMessageId);
                    // Show success toast
                    if (typeof showToast === 'function') {
                      showToast('Message sent successfully!', 'success');
                    }
                    // No need to reload if real-time broadcast works; fallback reload
                    setTimeout(() => {
                      try {
                        if (window.realtimeManager && window.realtimeManager.isConnected) return;
                      } catch {}
                      window.location.reload();
                    }, 800);
                  } else {
                    console.error('❌ Failed to retry message:', data.error);
                    // Show error toast
                    if (typeof showToast === 'function') {
                      showToast('Retry failed: ' + data.error, 'error');
                    }
                    // Reset button state
                    if (retryButton) {
                      retryButton.disabled = false;
                      retryButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>';
                      retryButton.style.opacity = '1';
                    }
                  }
                })
                .catch(error => {
                  console.error('❌ Error retrying message:', error);
                  // Show error toast
                  if (typeof showToast === 'function') {
                    showToast('Retry failed: ' + error.message, 'error');
                  }
                  // Reset button state
                  if (retryButton) {
                    retryButton.disabled = false;
                    retryButton.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>';
                    retryButton.style.opacity = '1';
                  }
                });
            }
            // Reply functions
            function replyToMessage(messageId) {
              currentReplyToMessageId = messageId;
              const messageElement = document.getElementById('message-' + messageId);
              
              if (messageElement) {
                // Highlight the message being replied to
                messageElement.classList.add('replying-to');
                
                // Show reply indicator in input
                showReplyIndicator(messageId);
                
                // Focus the message input
                const messageInput = document.getElementById('messageInput');
                if (messageInput) {
                  messageInput.focus();
                }
              }
            }

            function showReplyIndicator(messageId) {
              const messageElement = document.getElementById('message-' + messageId);
              const messageText = messageElement ? messageElement.querySelector('.bubble')?.textContent?.trim() : 'Message';
              const truncatedText = messageText.length > 35 ? messageText.substring(0, 35) + '...' : messageText;

              // Determine if it's a customer or agent message
              const isCustomerMessage = messageElement && messageElement.classList.contains('msg-in');
              const authorName = isCustomerMessage ? 'Customer' : 'You';

              // Create or update reply indicator
              let replyIndicator = document.getElementById('replyIndicator');
              if (!replyIndicator) {
                replyIndicator = document.createElement('div');
                replyIndicator.id = 'replyIndicator';
                replyIndicator.className = 'reply-indicator';

                // Combine everything under a single parent element
                replyIndicator.innerHTML = [
                  '<div class="reply-indicator-content">',
                    '<div class="reply-indicator-text"><strong>' + authorName + '</strong><br>' + truncatedText + '</div>',
                    '<button class="reply-indicator-close" onclick="clearReply()">×</button>',
                  '</div>'
                ].join('');

                // Insert before the input container
                const inputContainer = document.querySelector('.wa-input-container');
                if (inputContainer) {
                  inputContainer.parentNode.insertBefore(replyIndicator, inputContainer);
                }
              } else {
                replyIndicator.querySelector('.reply-indicator-text').innerHTML =
                  '<strong>' + authorName + '</strong><br>' + truncatedText;
              }
            }

            function clearReply() {
              currentReplyToMessageId = null;
              
              // Remove highlight from message
              document.querySelectorAll('.replying-to').forEach(el => {
                el.classList.remove('replying-to');
              });
              
              // Remove reply indicator
              const replyIndicator = document.getElementById('replyIndicator');
              if (replyIndicator) {
                replyIndicator.remove();
              }
            }
            
            function scrollToMessage(messageId) {
              const messageElement = document.getElementById('message-' + messageId);
              if (messageElement) {
                messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Temporarily highlight the message
                messageElement.classList.add('highlighted');
                setTimeout(() => {
                  messageElement.classList.remove('highlighted');
                }, 2000);
              }
            }
            
            function toggleAttachmentMenu() {
              const menu = document.getElementById('attachMenu');
              if (menu.style.display === 'none') {
                menu.style.display = 'flex';
                // Close menu when clicking outside
                setTimeout(() => {
                  document.addEventListener('click', function closeMenu(e) {
                    if (!menu.contains(e.target) && !e.target.closest('.wa-attach-btn')) {
                      menu.style.display = 'none';
                      document.removeEventListener('click', closeMenu);
                    }
                  });
                }, 100);
              } else {
                menu.style.display = 'none';
              }
            }
            function handleDocumentSelect(event) {
              const file = event.target.files[0];
              if (!file) return;
              
              // Validate file size (max 100MB)
              const maxSize = 100 * 1024 * 1024; // 100MB
              if (file.size > maxSize) {
                try {
                  if (window.Toast && typeof window.Toast.error === 'function') {
                    window.Toast.error('File size must be less than 100MB');
                  }
                } catch(_) {}
                event.target.value = '';
                return;
              }
              
              // Validate file type
              const allowedTypes = ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.zip', '.rar'];
              const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
              if (!allowedTypes.includes(fileExtension)) {
                try {
                  if (window.Toast && typeof window.Toast.error === 'function') {
                    window.Toast.error('File type not supported. Please select a supported document format.');
                  }
                } catch(_) {}
                event.target.value = '';
                return;
              }
              
              showDocumentPreview(file);
            }

            function showDocumentPreview(file) {
              // Hide attachment menu
              document.getElementById('attachMenu').style.display = 'none';

              // Create document preview
              const preview = document.createElement('div');
              preview.id = 'documentPreview';
              preview.className = 'document-preview';

              const fileExtension = file.name.split('.').pop().toUpperCase();
              const fileSize = formatFileSize(file.size);

              // Ensure all content is wrapped in a single parent <div>
              preview.innerHTML = [
                '<div class="document-icon">' + fileExtension + '</div>',
                '<div class="document-info">',
                  '<div class="document-name">' + escapeHtml(file.name) + '</div>',
                  '<div class="document-size">' + fileSize + '</div>',
                '</div>',
                '<button type="button" class="document-remove" onclick="clearDocumentPreview()">Remove</button>'
              ].join('');

              // Insert before the input container
              const inputContainer = document.querySelector('.wa-input-container');
              inputContainer.parentNode.insertBefore(preview, inputContainer);
            }

            function clearDocumentPreview() {
              const preview = document.getElementById('documentPreview');
              if (preview) {
                preview.remove();
              }
              document.getElementById('documentFileInput').value = '';
            }
            
            function formatFileSize(bytes) {
              if (bytes === 0) return '0 Bytes';
              const k = 1024;
              const sizes = ['Bytes', 'KB', 'MB', 'GB'];
              const i = Math.floor(Math.log(bytes) / Math.log(k));
              return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
            }
            
            function escapeHtml(text) {
              const div = document.createElement('div');
              div.textContent = text;
              return div.innerHTML;
            }
            
            function toggleEmojiPicker() {
              const picker = document.getElementById('emojiPicker');
              if (picker.classList.contains('show')) {
                picker.classList.remove('show');
              } else {
                picker.classList.add('show');
                loadEmojiCategory('smileys');
              }
            }

            function startVoiceRecording() {
              try {
                if (window.Toast && typeof window.Toast.info === 'function') {
                  window.Toast.info('Voice recording feature coming soon!');
                }
              } catch(_) {}
            }
            // Emoji data
            const emojiCategories = {
              smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓'],
              people: ['👋', '🤚', '🖐', '✋', '🖖', '👌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🦷', '🦴', '👀', '👁', '👅', '👄'],
              animals: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🦍', '🦧', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🦄', '🐎', '🦓', '🦌', '🐂', '🐃', '🐄', '🐪', '🐫', '🦙', '🦒', '🐘', '🦏', '🦛', '🐐', '🐑', '🐏', '🐚', '🐌', '🦋', '🐛', '🐜', '🐝', '🐞', '🦗', '🕷', '🕸', '🦂', '🦟', '🦠'],
              food: ['🍕', '🍔', '🍟', '🌭', '🥪', '🌮', '🌯', '🥙', '🥚', '🍳', '🥘', '🍲', '🥗', '🍿', '🧈', '🧀', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌽', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶', '🫑', '🌶️', '🫒', '🥕', '🌽', '🫐', '🍇', '🍈', '🍉', '🍊', '🍋', '🍌', '🍍', '🥭', '🍎', '🍏', '🍐', '🍑', '🍒', '🍓', '🫐', '🥝', '🍅', '🥥', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕'],
              travel: ['✈️', '🛫', '🛬', '🛩', '💺', '🛰', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥', '🛳', '⛴', '🚢', '⚓', '🚧', '⛽', '🚏', '🚦', '🚥', '🗺', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟', '🎡', '🎢', '🎠', '⛲', '⛱', '🏖', '🏝', '🏔', '⛰', '🌋', '🗻', '🏕', '⛺', '🏠', '🏡', '🏘', '🏚', '🏗', '🏭', '🏢', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '🏩', '💒', '🏛', '⛪', '🕌', '🕍', '🕋', '⛩', '🛤', '🛣', '🗾', '🎑', '🏞', '🌅', '🌄', '🌠', '🎇', '🎆', '🌇', '🌆', '🏙', '🌃', '🌌', '🌉', '🌁'],
              objects: ['📱', '📲', '💻', '⌨️', '🖥', '🖨', '🖱', '🖲', '🕹', '🗜', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽', '🎞', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙', '🎚', '🎛', '🧭', '⏱', '⏲', '⏰', '🕰', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯', '🪔', '🧯', '🛢', '💸', '💵', '💴', '💶', '💷', '💰', '💳', '💎', '⚖', '🧰', '🔧', '🔨', '⚒', '🛠', '⛏', '🔩', '⚙', '🪚', '🧱', '⛓', '🧲', '🔫', '💣', '🧨', '🪓', '🔪', '🗡', '⚔', '🛡', '🚬', '⚰', '🪦', '⚱', '🏺', '🔮', '📿', '🧿', '💈', '⚗', '🔭', '🔬', '🕳', '🩹', '🩺', '💊', '💉', '🧬', '🦠', '🧫', '🧪', '🌡', '🧹', '🧺', '🧻', '🚽', '🚰', '🚿', '🛁', '🛀', '🧴', '🧷', '🧸', '🧵', '🧶', '🪡', '🪢', '🪣', '🪤', '🪥', '🪦', '🪧', '🪨', '🪩', '🪪', '🪫', '🪬', '🪭', '🪮', '🪯', '🪰', '🪱', '🪲', '🪳', '🪴', '🪵', '🪶', '🪷', '🪸', '🪹', '🪺', '🪻', '🪼', '🪽', '🪾', '🪿', '🫀', '🫁', '🫂', '🫃', '🫄', '🫅', '🫆', '🫇', '🫈', '🫉', '🫊', '🫋', '🫌', '🫍', '🫎', '🫏', '🫐', '🫑', '🫒', '🫓', '🫔', '🫕', '🫖', '🫗', '🫘', '🫙', '🫚', '🫛', '🫜', '🫝', '🫞', '🫟', '🫠', '🫡', '🫢', '🫣', '🫤', '🫥', '🫦', '🫧', '🫨', '🫩', '🫪', '🫫', '🫬', '🫭', '🫮', '🫯', '🫰', '🫱', '🫲', '🫳', '🫴', '🫵', '🫶', '🫷', '🫸', '🫹', '🫺', '🫻', '🫼', '🫽', '🫾', '🫿', '🬀', '🬁', '🬂', '🬃', '🬄', '🬅', '🬆', '🬇', '🬈', '🬉', '🬊', '🬋', '🬌', '🬍', '🬎', '🬏', '🬐', '🬑', '🬒', '🬓', '🬔', '🬕', '🬖', '🬗', '🬘', '🬙', '🬚', '🬛', '🬜', '🬝', '🬞', '🬟', '🬠', '🬡', '🬢', '🬣', '🬤', '🬥', '🬦', '🬧', '🬨', '🬩', '🬪', '🬫', '🬬', '🬭', '🬮', '🬯', '🬰', '🬱', '🬲', '🬳', '🬴', '🬵', '🬶', '🬷', '🬸', '🬹', '🬺', '🬻', '🬼', '🬽', '🬾', '🬿', '🭀', '🭁', '🭂', '🭃', '🭄', '🭅', '🭆', '🭇', '🭈', '🭉', '🭊', '🭋', '🭌', '🭍', '🭎', '🭏', '🭐', '🭑', '🭒', '🭓', '🭔', '🭕', '🭖', '🭗', '🭘', '🭙', '🭚', '🭛', '🭜', '🭝', '🭞', '🭟', '🭠', '🭡', '🭢', '🭣', '🭤', '🭥', '🭦', '🭧', '🭨', '🭩', '🭪', '🭫', '🭬', '🭭', '🭮', '🭯', '🭰', '🭱', '🭲', '🭳', '🭴', '🭵', '🭶', '🭷', '🭸', '🭹', '🭺', '🭻', '🭼', '🭽', '🭾', '🭿', '🮀', '🮁', '🮂', '🮃', '🮄', '🮅', '🮆', '🮇', '🮈', '🮉', '🮊', '🮋', '🮌', '🮍', '🮎', '🮏', '🮐', '🮑', '🮒', '🮓', '🮔', '🮕', '🮖', '🮗', '🮘', '🮙', '🮚', '🮛', '🮜', '🮝', '🮞', '🮟', '🮠', '🮡', '🮢', '🮣', '🮤', '🮥', '🮦', '🮧', '🮨', '🮩', '🮪', '🮫', '🮬', '🮭', '🮮', '🮯', '🮰', '🮱', '🮲', '🮳', '🮴', '🮵', '🮶', '🮷', '🮸', '🮹', '🮺', '🮻', '🮼', '🮽', '🮾', '🮿', '🯀', '🯁', '🯂', '🯃', '🯄', '🯅', '🯆', '🯇', '🯈', '🯉', '🯊', '🯋', '🯌', '🯍', '🯎', '🯏', '🯐', '🯑', '🯒', '🯓', '🯔', '🯕', '🯖', '🯗', '🯘', '🯙', '🯚', '🯛', '🯜', '🯝', '🯞', '🯟', '🯠', '🯡', '🯢', '🯣', '🯤', '🯥', '🯦', '🯧', '🯨', '🯩', '🯪', '🯫', '🯬', '🯭', '🯮', '🯯', '🯰', '🯱', '🯲', '🯳', '🯴', '🯵', '🯶', '🯷', '🯸', '🯹', '🯺', '🯻', '🯼', '🯽', '🯾', '🯿', '🰀', '🰁', '🰂', '🰃', '🰄', '🰅', '🰆', '🰇', '🰈', '🰉', '🰊', '🰋', '🰌', '🰍', '🰎', '🰏', '🰐', '🰑', '🰒', '🰓', '🰔', '🰕', '🰖', '🰗', '🰘', '🰙', '🰚', '🰛', '🰜', '🰝', '🰞', '🰟', '🰠', '🰡', '🰢', '🰣', '🰤', '🰥', '🰦', '🰧', '🰨', '🰩', '🰪', '🰫', '🰬', '🰭', '🰮', '🰯', '🰰', '🰱', '🰲', '🰳', '🰴', '🰵', '🰶', '🰷', '🰸', '🰹', '🰺', '🰻', '🰼', '🰽', '🰾', '🰿', '🱀', '🱁', '🱂', '🱃', '🱄', '🱅', '🱆', '🱇', '🱈', '🱉', '🱊', '🱋', '🱌', '🱍', '🱎', '🱏', '🱐', '🱑', '🱒', '🱓', '🱔', '🱕', '🱖', '🱗', '🱘', '🱙', '🱚', '🱛', '🱜', '🱝', '🱞', '🱟', '🱠', '🱡', '🱢', '🱣', '🱤', '🱥', '🱦', '🱧', '🱨', '🱩', '🱪', '🱫', '🱬', '🱭', '🱮', '🱯', '🱰', '🱱', '🱲', '🱳', '🱴', '🱵', '🱶', '🱷', '🱸', '🱹', '🱺', '🱻', '🱼', '🱽', '🱾', '🱿', '🲀', '🲁', '🲂', '🲃', '🲄', '🲅', '🲆', '🲇', '🲈', '🲉', '🲊', '🲋', '🲌', '🲍', '🲎', '🲏', '🲐', '🲑', '🲒', '🲓', '🲔', '🲕', '🲖', '🲗', '🲘', '🲙', '🲚', '🲛', '🲜', '🲝', '🲞', '🲟', '🲠', '🲡', '🲢', '🲣', '🲤', '🲥', '🲦', '🲧', '🲨', '🲩', '🲪', '🲫', '🲬', '🲭', '🲮', '🲯', '🲰', '🲱', '🲲', '🲳', '🲴', '🲵', '🲶', '🲷', '🲸', '🲹', '🲺', '🲻', '🲼', '🲽', '🲾', '🲿', '🳀', '🳁', '🳂', '🳃', '🳄', '🳅', '🳆', '🳇', '🳈', '🳉', '🳊', '🳋', '🳌', '🳍', '🳎', '🳏', '🳐', '🳑', '🳒', '🳓', '🳔', '🳕', '🳖', '🳗', '🳘', '🳙', '🳚', '🳛', '🳜', '🳝', '🳞', '🳟', '🳠', '🳡', '🳢', '🳣', '🳤', '🳥', '🳦', '🳧', '🳨', '🳩', '🳪', '🳫', '🳬', '🳭', '🳮', '🳯', '🳰', '🳱', '🳲', '🳳', '🳴', '🳵', '🳶', '🳷', '🳸', '🳹', '🳺', '🳻', '🳼', '🳽', '🳾', '🳿', '🴀', '🴁', '🴂', '🴃', '🴄', '🴅', '🴆', '🴇', '🴈', '🴉', '🴊', '🴋', '🴌', '🴍', '🴎', '🴏', '🴐', '🴑', '🴒', '🴓', '🴔', '🴕', '🴖', '🴗', '🴘', '🴙', '🴚', '🴛', '🴜', '🴝', '🴞', '🴟', '🴠', '🴡', '🴢', '🴣', '🴤', '🴥', '🴦', '🴧', '🴨', '🴩', '🴪', '🴫', '🴬', '🴭', '🴮', '🴯', '🴰', '🴱', '🴲', '🴳', '🴴', '🴵', '🴶', '🴷', '🴸', '🴹', '🴺', '🴻', '🴼', '🴽', '🴾', '🴿', '🵀', '🵁', '🵂', '🵃', '🵄', '🵅', '🵆', '🵇', '🵈', '🵉', '🵊', '🵋', '🵌', '🵍', '🵎', '🵏', '🵐', '🵑', '🵒', '🵓', '🵔', '🵕', '🵖', '🵗', '🵘', '🵙', '🵚', '🵛', '🵜', '🵝', '🵞', '🵟', '🵠', '🵡', '🵢', '🵣', '🵤', '🵥', '🵦', '🵧', '🵨', '🵩', '🵪', '🵫', '🵬', '🵭', '🵮', '🵯', '🵰', '🵱', '🵲', '🵳', '🵴', '🵵', '🵶', '🵷', '🵸', '🵹', '🵺', '🵻', '🵼', '🵽', '🵾', '🵿', '🶀', '🶁', '🶂', '🶃', '🶄', '🶅', '🶆', '🶇', '🶈', '🶉', '🶊', '🶋', '🶌', '🶍', '🶎', '🶏', '🶐', '🶑', '🶒', '🶓', '🶔', '🶕', '🶖', '🶗', '🶘', '🶙', '🶚', '🶛', '🶜', '🶝', '🶞', '🶟', '🶠', '🶡', '🶢', '🶣', '🶤', '🶥', '🶦', '🶧', '🶨', '🶩', '🶪', '🶫', '🶬', '🶭', '🶮', '🶯', '🶰', '🶱', '🶲', '🶳', '🶴', '🶵', '🶶', '🶷', '🶸', '🶹', '🶺', '🶻', '🶼', '🶽', '🶾', '🶿', '🷀', '🷁', '🷂', '🷃', '🷄', '🷅', '🷆', '🷇', '🷈', '🷉', '🷊', '🷋', '🷌', '🷍', '🷎', '🷏', '🷐', '🷑', '🷒', '🷓', '🷔', '🷕', '🷖', '🷗', '🷘', '🷙', '🷚', '🷛', '🷜', '🷝', '🷞', '🷟', '🷠', '🷡', '🷢', '🷣', '🷤', '🷥', '🷦', '🷧', '🷨', '🷩', '🷪', '🷫', '🷬', '🷭', '🷮', '🷯', '🷰', '🷱', '🷲', '🷳', '🷴', '🷵', '🷶', '🷷', '🷸', '🷹', '🷺', '🷻', '🷼', '🷽', '🷾', '🷿', '🸀', '🸁', '🸂', '🸃', '🸄', '🸅', '🸆', '🸇', '🸈', '🸉', '🸊', '🸋', '🸌', '🸍', '🸎', '🸏', '🸐', '🸑', '🸒', '🸓', '🸔', '🸕', '🸖', '🸗', '🸘', '🸙', '🸚', '🸛', '🸜', '🸝', '🸞', '🸟', '🸠', '🸡', '🸢', '🸣', '🸤', '🸥', '🸦', '🸧', '🸨', '🸩', '🸪', '🸫', '🸬', '🸭', '🸮', '🸯', '🸰', '🸱', '🸲', '🸳', '🸴', '🸵', '🸶', '🸷', '🸸', '🸹', '🸺', '🸻', '🸼', '🸽', '🸾', '🸿', '🹀', '🹁', '🹂', '🹃', '🹄', '🹅', '🹆', '🹇', '🹈', '🹉', '🹊', '🹋', '🹌', '🹍', '🹎', '🹏', '🹐', '🹑', '🹒', '🹓', '🹔', '🹕', '🹖', '🹗', '🹘', '🹙', '🹚', '🹛', '🹜', '🹝', '🹞', '🹟', '🹠', '🹡', '🹢', '🹣', '🹤', '🹥', '🹦', '🹧', '🹨', '🹩', '🹪', '🹫', '🹬', '🹭', '🹮', '🹯', '🹰', '🹱', '🹲', '🹳', '🹴', '🹵', '🹶', '🹷', '🹸', '🹹', '🹺', '🹻', '🹼', '🹽', '🹾', '🹿', '🺀', '🺁', '🺂', '🺃', '🺄', '🺅', '🺆', '🺇', '🺈', '🺉', '🺊', '🺋', '🺌', '🺍', '🺎', '🺏', '🺐', '🺑', '🺒', '🺓', '🺔', '🺕', '🺖', '🺗', '🺘', '🺙', '🺚', '🺛', '🺜', '🺝', '🺞', '🺟', '🺠', '🺡', '🺢', '🺣', '🺤', '🺥', '🺦', '🺧', '🺨', '🺩', '🺪', '🺫', '🺬', '🺭', '🺮', '🺯', '🺰', '🺱', '🺲', '🺳', '🺴', '🺵', '🺶', '🺷', '🺸', '🺹', '🺺', '🺻', '🺼', '🺽', '🺾', '🺿', '🻀', '🻁', '🻂', '🻃', '🻄', '🻅', '🻆', '🻇', '🻈', '🻉', '🻊', '🻋', '🻌', '🻍', '🻎', '🻏', '🻐', '🻑', '🻒', '🻓', '🻔', '🻕', '🻖', '🻗', '🻘', '🻙', '🻚', '🻛', '🻜', '🻝', '🻞', '🻟', '🻠', '🻡', '🻢', '🻣', '🻤', '🻥', '🻦', '🻧', '🻨', '🻩', '🻪', '🻫', '🻬', '🻭', '🻮', '🻯', '🻰', '🻱', '🻲', '🻳', '🻴', '🻵', '🻶', '🻷', '🻸', '🻹', '🻺', '🻻', '🻼', '🻽', '🻾', '🻿', '🼀', '🼁', '🼂', '🼃', '🼄', '🼅', '🼆', '🼇', '🼈', '🼉', '🼊', '🼋', '🼌', '🼍', '🼎', '🼏', '🼐', '🼑', '🼒', '🼓', '🼔', '🼕', '🼖', '🼗', '🼘', '🼙', '🼚', '🼛', '🼜', '🼝', '🼞', '🼟', '🼠', '🼡', '🼢', '🼣', '🼤', '🼥', '🼦', '🼧', '🼨', '🼩', '🼪', '🼫', '🼬', '🼭', '🼮', '🼯', '🼰', '🼱', '🼲', '🼳', '🼴', '🼵', '🼶', '🼷', '🼸', '🼹', '🼺', '🼻', '🼼', '🼽', '🼾', '🼿', '🽀', '🽁', '🽂', '🽃', '🽄', '🽅', '🽆', '🽇', '🽈', '🽉', '🽊', '🽋', '🽌', '🽍', '🽎', '🽏', '🽐', '🽑', '🽒', '🽓', '🽔', '🽕', '🽖', '🽗', '🽘', '🽙', '🽚', '🽛', '🽜', '🽝', '🽞', '🽟', '🽠', '🽡', '🽢', '🽣', '🽤', '🽥', '🽦', '🽧', '🽨', '🽩', '🽪', '🽫', '🽬', '🽭', '🽮', '🽯', '🽰', '🽱', '🽲', '🽳', '🽴', '🽵', '🽶', '🽷', '🽸', '🽹', '🽺', '🽻', '🽼', '🽽', '🽾', '🽿', '🾀', '🾁', '🾂', '🾃', '🾄', '🾅', '🾆', '🾇', '🾈', '🾉', '🾊', '🾋', '🾌', '🾍', '🾎', '🾏', '🾐', '🾑', '🾒', '🾓', '🾔', '🾕', '🾖', '🾗', '🾘', '🾙', '🾚', '🾛', '🾜', '🾝', '🾞', '🾟', '🾠', '🾡', '🾢', '🾣', '🾤', '🾥', '🾦', '🾧', '🾨', '🾩', '🾪', '🾫', '🾬', '🾭', '🾮', '🾯', '🾰', '🾱', '🾲', '🾳', '🾴', '🾵', '🾶', '🾷', '🾸', '🾹', '🾺', '🾻', '🾼', '🾽', '🾾', '🾿', '🿀', '🿁', '🿂', '🿃', '🿄', '🿅', '🿆', '🿇', '🿈', '🿉', '🿊', '🿋', '🿌', '🿍', '🿎', '🿏', '🿐', '🿑', '🿒', '🿓', '🿔', '🿕', '🿖', '🿗', '🿘', '🿙', '🿚', '🿛', '🿜', '🿝', '🿞', '🿟', '🿠', '🿡', '🿢', '🿣', '🿤', '🿥', '🿦', '🿧', '🿨', '🿩', '🿪', '🿫', '🿬', '🿭', '🿮', '🿯', '🿰', '🿱', '🿲', '🿳', '🿴', '🿵', '🿶', '🿷', '🿸', '🿹', '🿺', '🿻', '🿼', '🿽', '🿾', '🿿'],
              symbols: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️', '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️', '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕', '❓', '❔', '‼️', '⁉️', '🔅', '🔆', '〽️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐', '💠', 'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🈳', '🈂️', '🛂', '🛃', '🛄', '🛅', '🚹', '🚺', '🚼', '⚧', '🚻', '🚮', '🎦', '📶', '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗', '🆙', '🆒', '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']
            };
            
            function loadEmojiCategory(category) {
              const grid = document.getElementById('emojiGrid');
              const emojis = emojiCategories[category] || [];
              
              grid.innerHTML = '';
              emojis.forEach(emoji => {
                const item = document.createElement('div');
                item.className = 'wa-emoji-item';
                item.textContent = emoji;
                item.onclick = () => selectEmoji(emoji);
                grid.appendChild(item);
              });
            }
            
            function selectEmoji(emoji) {
              const ta = document.getElementById('messageInput');
              ta.value += emoji;
              ta.focus();
              document.getElementById('emojiPicker').classList.remove('show');
              updateSendButtonState(); // Update send button when emoji is added
            }
            function handleImageSelect(event){
              const file = event.target.files[0];
              if (!file) return;
              
              const reader = new FileReader();
              reader.onload = function(e) {
                const previewImg = document.getElementById('previewImg');
                const imagePreview = document.getElementById('imagePreview');
                if (previewImg && imagePreview) {
                  previewImg.src = e.target.result;
                  imagePreview.style.display = 'block';
                  updateSendButtonState(); // Update send button when image is selected
                }
              };
              reader.readAsDataURL(file);
            }
            function clearImagePreview(){
              const imagePreview = document.getElementById('imagePreview');
              const imageFileInput = document.getElementById('imageFileInput');
              const mainTextarea = document.getElementById('messageInput');
              if (imagePreview) imagePreview.style.display = 'none';
              if (imageFileInput) imageFileInput.value = '';
              if (mainTextarea) mainTextarea.value = '';
              updateSendButtonState(); // Update send button when image is cleared
            }
            function sendImageWithCaption(){
              const mainTextarea = document.getElementById('messageInput');
              const caption = mainTextarea ? mainTextarea.value : '';
              const hiddenCaption = document.getElementById('hiddenCaption');
              if (hiddenCaption) hiddenCaption.value = caption;
              document.getElementById('imageUploadForm').submit();
            }

            function handleFormSubmit(event){
              const imagePreview = document.getElementById('imagePreview');
              const documentPreview = document.getElementById('documentPreview');
              const sendButton = document.getElementById('sendButton');
              const messageInput = document.getElementById('messageInput');
              const inHumanMode = sendButton && sendButton.getAttribute('data-original-disabled') !== 'true';

              if (!inHumanMode || (sendButton && sendButton.disabled)) {
                return false;
              }
              
              if (imagePreview && imagePreview.style.display !== 'none') {
                // If image preview is visible, send the image
                const mainTextarea = document.getElementById('messageInput');
                const caption = mainTextarea ? mainTextarea.value : '';
                const hiddenCaption = document.getElementById('hiddenCaption');
                if (hiddenCaption) hiddenCaption.value = caption;

                // Add reply information if replying to a message
                const imageForm = document.getElementById('imageUploadForm');
                if (currentReplyToMessageId) {
                  const replyInput = document.createElement('input');
                  replyInput.type = 'hidden';
                  replyInput.name = 'replyTo';
                  replyInput.value = currentReplyToMessageId;
                  imageForm.appendChild(replyInput);
                }

                // Use enhanced auth for image form submission
                window.authManager.submitFormWithAuth(imageForm).then(success => {
                  if (success) {
                    // Scroll to bottom after image is sent
                    setTimeout(scrollToBottom, 500);
                    clearReply(); // Clear reply state
                  }
                });
              } else if (documentPreview) {
                // If document preview is visible, send the document
                const mainTextarea = document.getElementById('messageInput');
                const caption = mainTextarea ? mainTextarea.value : '';
                const hiddenCaption = document.getElementById('hiddenDocumentCaption');
                if (hiddenCaption) hiddenCaption.value = caption;

                // Add reply information if replying to a message
                const documentForm = document.getElementById('documentUploadForm');
                if (currentReplyToMessageId) {
                  const replyInput = document.createElement('input');
                  replyInput.type = 'hidden';
                  replyInput.name = 'replyTo';
                  replyInput.value = currentReplyToMessageId;
                  documentForm.appendChild(replyInput);
                }

                // Use enhanced auth for document form submission
                window.authManager.submitFormWithAuth(documentForm).then(success => {
                  if (success) {
                    // Scroll to bottom after document is sent
                    setTimeout(scrollToBottom, 500);
                    clearReply(); // Clear reply state
                  }
                });
              } else {
                const textarea = messageInput || document.getElementById('messageInput');
                const message = textarea ? textarea.value.trim() : '';
                
                if (!message) {
                  return false;
                }

                const mgr = window.realtimeManager || realtimeManager;
                (async () => {
                  try {
                    if (!mgr || typeof mgr.sendMessage !== 'function') {
                      throw new Error('Messaging is not ready yet. Please refresh and try again.');
                    }
                    const success = await mgr.sendMessage(phoneDigits, message, 'text', currentReplyToMessageId);
                    if (success) {
                      textarea.value = '';
                      textarea.style.height = 'auto';
                      updateSendButtonState();
                      clearReply();
                      setTimeout(scrollToBottom, 100);
                    }
                  } catch (err) {
                    console.error('Failed to send message:', err);
                  }
                })();
              }
              return false;
            }
            window.handleFormSubmit = handleFormSubmit;

            window.addEventListener('DOMContentLoaded', function() {
              setupComposer();
              
              // Setup attachment menu
              const attachDocumentBtn = document.getElementById('attachDocumentBtn');
              const attachImageBtn = document.getElementById('attachImageBtn');
              if (attachDocumentBtn) {
                attachDocumentBtn.addEventListener('click', function() {
                  document.getElementById('documentFileInput')?.click();
                  const menu = document.getElementById('attachMenu');
                  if (menu) menu.style.display = 'none';
                });
              }
              if (attachImageBtn) {
                attachImageBtn.addEventListener('click', function() {
                  document.getElementById('imageFileInput')?.click();
                  const menu = document.getElementById('attachMenu');
                  if (menu) menu.style.display = 'none';
                });
              }
              
              // Auto-scroll to bottom on page load with multiple attempts
              setTimeout(scrollToBottom, 100);
              setTimeout(scrollToBottom, 500);
              setTimeout(scrollToBottomAfterImages, 1000);
              
              // Also scroll when window loads completely
              window.addEventListener('load', function() {
                setTimeout(scrollToBottomAfterImages, 100);
              });
              
              // Initialize typing indicator
              initTypingIndicator();
              
              // Setup emoji category buttons
              document.querySelectorAll('.wa-emoji-category').forEach(btn => {
                btn.addEventListener('click', function() {
                  // Remove active class from all buttons
                  document.querySelectorAll('.wa-emoji-category').forEach(b => b.classList.remove('active'));
                  // Add active class to clicked button
                  this.classList.add('active');
                  // Load the category
                  loadEmojiCategory(this.dataset.category);
                });
              });
              
              // Close emoji picker when clicking outside
              document.addEventListener('click', function(e) {
                const picker = document.getElementById('emojiPicker');
                const emojiBtn = document.querySelector('.wa-emoji-btn');
                if (picker && !picker.contains(e.target) && !emojiBtn.contains(e.target)) {
                  picker.classList.remove('show');
                }
              });
            });
            
            // Status Management Functions
            function toggleStatusDropdown() {
              const dropdown = document.getElementById('statusDropdown');
              const trigger = document.querySelector('.chat-header-status');
              if (!dropdown) return;
              document.querySelectorAll('.status-dropdown-menu.is-open').forEach(el => {
                if (el !== dropdown) el.classList.remove('is-open');
              });
              const open = !dropdown.classList.contains('is-open');
              dropdown.classList.toggle('is-open', open);
              if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
            
            function updateConversationStatus(status) {
              const statusLabel = document.querySelector('.chat-header-status__label');
              const statusDot = document.querySelector('.chat-header-status__dot');
              const prevText = statusLabel ? statusLabel.textContent : null;
              const prevBg = statusDot ? statusDot.style.backgroundColor : null;

              const statusDisplay = getStatusDisplayName(status);
              const statusColor = getStatusColor(status);
              
              if (statusLabel) statusLabel.textContent = statusDisplay;
              if (statusDot) statusDot.style.backgroundColor = statusColor;
              
              const dropdown = document.getElementById('statusDropdown');
              if (dropdown) dropdown.classList.remove('is-open');
              const trigger = document.querySelector('.chat-header-status');
              if (trigger) trigger.setAttribute('aria-expanded', 'false');
              
              // Submit status update via fetch API
              const encodedPhone = encodeURIComponent(phone);
              fetch('/inbox/' + encodedPhone + '/status', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: 'status=' + encodeURIComponent(status)
              })
              .then(response => {
                if (response.ok) {
                  // Show success message
                  const nextUrl = new URL('/inbox/' + encodedPhone, window.location.origin);
                  nextUrl.searchParams.set('toast', 'Status updated to ' + statusDisplay);
                  nextUrl.searchParams.set('type', 'success');
                  window.location.href = nextUrl.toString();
                } else {
                  throw new Error('Status update failed');
                }
              })
              .catch(error => {
                console.error('Status update failed:', error);
                try {
                  if (window.Toast && typeof window.Toast.error === 'function') {
                    window.Toast.error('Failed to update status. Please try again.');
                  } else {
                    console.warn('Toast not available; falling back to console only.');
                  }
                } catch (_) {}
                // Revert UI changes on error
                if (statusLabel) {
                  if (prevText != null) statusLabel.textContent = prevText;
                }
                if (statusDot && prevBg != null) statusDot.style.backgroundColor = prevBg;
              });
            }
            
            function getStatusDisplayName(status) {
              const statusNames = {
                'new': 'New',
                'in_progress': 'In Progress', 
                'resolved': 'Resolved',
              };
              return statusNames[status] || status;
            }
            
            function getStatusColor(status) {
              const statusColors = {
                'new': '#3b82f6',
                'in_progress': '#f59e0b',
                'resolved': '#10b981', 
              };
              return statusColors[status] || '#6b7280';
            }

            // Close status dropdown when clicking outside
            document.addEventListener('click', function(e) {
              const statusDropdown = document.getElementById('statusDropdown');
              const statusButton = document.querySelector('.chat-header-status');
              
              if (statusDropdown && statusButton && 
                  !statusDropdown.contains(e.target) && 
                  !statusButton.contains(e.target)) {
                statusDropdown.classList.remove('is-open');
                statusButton.setAttribute('aria-expanded', 'false');
              }
            });
          </script>
          <script>
            (function(){
              try{
                var secs = ${remain};
                if(!secs) return;
                function fmt(s){ var m = Math.floor(s/60), r = s%60; return (''+m)+":"+(''+r).padStart(2,'0'); }
                function tick(){ var el = document.getElementById('exp_remain'); if(el){ el.textContent = fmt(secs); } if(secs>0){ secs--; setTimeout(tick,1000);} }
                tick();
              }catch(_){ }
            })();
          </script>
        <script>
          // Expose plan capability so realtime appends can mirror server-rendered actions
          window.IS_UPGRADED = ${isUpgraded ? 'true' : 'false'};
        </script>
          <div class="container">
            ${renderTopbar(`<a href="/inbox">Inbox</a> / +${String(phone).replace(/^\+/, '')}`, email)}
            <div class="layout">
              ${renderSidebar('inbox', { showBookings: !!isUpgraded, isUpgraded })}
              <main class="main">
                <div class="main-content chat-view">
                  <div class="wa-chat-header">
                    <div class="wa-chat-header__lead">
                      <a href="/inbox" class="chat-header-btn chat-header-btn--back" aria-label="Back to inbox">${chatHeaderIcon('back')}</a>
                      <div class="wa-avatar wa-chat-header__avatar" aria-hidden="true">${escapeHtml(headerInitials)}</div>
                      <div class="wa-chat-header__identity">
                        <div class="wa-name">${escapeHtml(headerName)}</div>
                        <div class="wa-chat-header__status">
                          <span class="wa-chat-header__mode ${isHuman ? 'is-human' : 'is-ai'}">${isHuman ? 'Human' : 'AI'}</span>
                          ${over24h ? '<span class="wa-chat-header__flag">24h expired</span>' : ''}
                          ${isHuman && remain ? '<span class="wa-chat-header__timer"><span id="exp_remain"></span> left</span>' : ''}
                        </div>
                      </div>
                    </div>
                    <div class="wa-chat-header__actions">
                      ${over24h ? `
                        <button type="button" class="chat-header-btn chat-header-btn--handoff" id="handoffToggleBtn" disabled title="Live mode disabled after 24h">
                          ${chatHeaderIcon('bot')}
                        </button>
                      ` : `
                        <form method="post" action="/inbox/${phone}/handoff" class="chat-header-form" id="handoffToggleForm" onsubmit="event.preventDefault(); prepareHandoffToggle(); return false;">
                          <input type="hidden" name="is_live" value="${isHuman ? '0' : '1'}"/>
                          <button type="submit" class="chat-header-btn chat-header-btn--handoff${isHuman ? ' is-human' : ''}" id="handoffToggleBtn" data-is-human="${isHuman ? 'true' : 'false'}" title="${isHuman ? 'Switch to AI' : 'Take over conversation'}">
                            <span class="chat-header-btn__icon chat-header-btn__icon--bot">${chatHeaderIcon('bot')}</span>
                            <span class="chat-header-btn__icon chat-header-btn__icon--hand">${chatHeaderIcon('hand')}</span>
                          </button>
                        </form>
                      `}
                      ${isHuman ? `
                        <form method="post" action="/inbox/${phone}/renew" class="chat-header-form" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;">
                          <button type="submit" class="chat-header-btn" title="Renew 5 minutes">${chatHeaderIcon('renew')}</button>
                        </form>
                      ` : ''}
                      <span class="wa-chat-header__divider" aria-hidden="true"></span>
                      <form method="post" action="/inbox/${phone}/archive" class="chat-header-form" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;">
                        <button type="submit" class="chat-header-btn" title="Archive conversation">${chatHeaderIcon('archive')}</button>
                      </form>
                      <form method="post" action="/inbox/${phone}/clear" class="chat-header-form" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;">
                        <button type="submit" class="chat-header-btn" title="Clear chat">${chatHeaderIcon('clear')}</button>
                      </form>
                      <form method="post" action="/inbox/${encodeURIComponent(phone)}/delete" class="chat-header-form" onsubmit="return deleteInboxConversation(this, event);">
                        <button type="submit" class="chat-header-btn chat-header-btn--danger" title="Delete conversation">${chatHeaderIcon('trash')}</button>
                      </form>
                      <div class="status-dropdown wa-chat-header__status-menu">
                        <button type="button" class="chat-header-status" onclick="toggleStatusDropdown()" aria-haspopup="true" aria-expanded="false">
                          <span class="chat-header-status__dot" style="background-color:${statusColor};"></span>
                          <span class="chat-header-status__label">${statusDisplay}</span>
                          ${chatHeaderIcon('chevron')}
                        </button>
                        <div id="statusDropdown" class="status-dropdown-menu">
                          <div class="status-dropdown-menu__title">Change status</div>
                          ${Object.entries(CONVERSATION_STATUSES).map(([key, value]) => {
                            const isActive = conversationStatus === value;
                            const disableOption = statusLocked && value !== CONVERSATION_STATUSES.RESOLVED;
                            const disabledAttr = disableOption ? 'disabled' : '';
                            return `
                          <button type="button" class="status-option ${isActive ? 'active' : ''}" ${disabledAttr} onclick="${disableOption ? 'return false;' : `updateConversationStatus('${value}')`}">
                            <span class="status-option__dot" style="background-color: ${STATUS_COLORS[value]};"></span>
                            ${STATUS_DISPLAY_NAMES[value]}
                            ${conversationStatus === value ? '✓' : ''}
                          </button>
                        `;
                          }).join('')}
                        </div>
                      </div>
                    </div>
                  </div>
                  ${(() => {
                    if (!over24h) return '';
                    const tname = defaultTemplateName;
                    const tlang = defaultTemplateLang;
                    if (!tname) {
                      return `
                        <div class="template-reopen-banner">
                          <div class="template-reopen-banner__bar">
                            <div class="template-reopen-banner__lead">
                              <span class="template-reopen-banner__icon" aria-hidden="true">⏰</span>
                              <span class="template-reopen-banner__label">24h expired</span>
                            </div>
                            <p class="template-reopen-banner__desc">Choose a default template on <a href="/campaigns">Campaigns</a>, then refresh.</p>
                            <div class="template-reopen-banner__actions">
                              <a href="/campaigns" class="btn-primary">Set up template</a>
                            </div>
                          </div>
                        </div>
                      `;
                    }
                    if (!defaultTemplateOnMeta) {
                      return `
                        <div class="template-reopen-banner template-reopen-banner--error">
                          <div class="template-reopen-banner__bar">
                            <div class="template-reopen-banner__lead">
                              <span class="template-reopen-banner__icon" aria-hidden="true">⏰</span>
                              <span class="template-reopen-banner__label">Template not on account</span>
                              <span class="template-reopen-banner__chip">${escapeHtml(tname)}</span>
                            </div>
                            <p class="template-reopen-banner__desc">Sync from Meta on Campaigns and pick an approved template.</p>
                            <div class="template-reopen-banner__actions">
                              <a href="/campaigns" class="btn-primary">Fix on Campaigns</a>
                            </div>
                          </div>
                        </div>
                      `;
                    }
                    const hasVars = Array.isArray(templateVars) && templateVars.length > 0;
                    const safeBody = templateBody ? escapeHtml(templateBody).replace(/\\n/g, ' ') : '';
                    const previewBody = safeBody ? (safeBody.length > 120 ? safeBody.slice(0, 120) + '…' : safeBody) : '';
                    const inputsHtml = hasVars
                      ? `<div class="template-reopen-banner__vars">
                          ${templateVars.map((idx) => `
                            <input class="settings-field"
                                   name="var${idx}"
                                   placeholder="{{${idx}}} optional" />
                          `).join('')}
                        </div>`
                      : '';
                    const hintHtml = hasVars
                      ? `<p class="template-reopen-banner__hint">Optional placeholders — leave blank for defaults.</p>`
                      : '';
                    const bubbleHtml = previewBody
                      ? `<div class="template-reopen-banner__bubble" title="${previewBody}">${previewBody}</div>`
                      : '';
                    return `
                      <div class="template-reopen-banner">
                        <form method="post" action="/inbox/${phone}/send-template" data-auth-enhanced class="template-reopen-banner__form">
                          <div class="template-reopen-banner__lead">
                            <span class="template-reopen-banner__icon" aria-hidden="true">⏰</span>
                            <span class="template-reopen-banner__label">24h expired</span>
                            <span class="template-reopen-banner__chip">${escapeHtml(tname)}</span>
                            <span class="template-reopen-banner__chip">${escapeHtml(tlang)}</span>
                          </div>
                          ${bubbleHtml}
                          ${inputsHtml}
                          ${hintHtml}
                          <div class="template-reopen-banner__actions">
                            <button class="btn-primary" type="submit">Send template</button>
                            <a href="/campaigns" class="btn-ghost">Change template</a>
                          </div>
                        </form>
                      </div>
                    `;
                  })()}
                  <div class="chat-thread">
                    <div class="chat-thread-messages" id="chatThreadMessages"
                      data-phone="${escapeHtml(String(phone))}"
                      data-oldest-ts="${oldestThreadTs}"
                      data-has-more="${hasMoreThreadMessages ? '1' : '0'}">
                      <div class="chat-thread-load-older" id="chatThreadLoadOlder"${hasMoreThreadMessages ? '' : ' hidden'}>
                        <button type="button" class="btn btn-ghost btn-sm" id="chatLoadOlderBtn">Load older messages</button>
                      </div>
                      ${items || '<div class="chat-empty-state">No messages</div>'}
                      <div data-thread-anchor="true"></div>
                    </div>
                    <div class="chat-composer">
                      <div id="imagePreview" style="display:none; margin-bottom:8px; padding:8px; background:#f0f0f0; border-radius:8px;">
                        <div style="display:flex; gap:8px; align-items:center;">
                          <img id="previewImg" style="width:60px; height:60px; object-fit:cover; border-radius:8px;" />
                          <div style="font-size:12px; color:#666;">Selected image</div>
                          <div style="flex:1;"></div>
                          <button type="button" onclick="clearImagePreview()" class="btn-danger" style="border-radius:4px; padding:4px 8px; font-size:12px;">Remove</button>
                        </div>
                      </div>
                      <form id="imageUploadForm" method="post" action="/upload-image/${phone}" enctype="multipart/form-data" data-auth-enhanced style="display:none;">
                          <input type="file" name="image" accept="image/*" id="imageFileInput" onchange="handleImageSelect(event)" />
                          <textarea name="caption" id="hiddenCaption" style="display:none;"></textarea>
                      </form>
                      
                      <form id="documentUploadForm" method="post" action="/upload-document/${phone}" enctype="multipart/form-data" data-auth-enhanced style="display:none;">
                        <input type="file" name="document" accept=".pdf,.doc,.docx,.txt,.rtf,.odt,.ppt,.pptx,.xls,.xlsx,.csv,.zip,.rar" id="documentFileInput" onchange="handleDocumentSelect(event)" />
                        <textarea name="caption" id="hiddenDocumentCaption" style="display:none;"></textarea>
                      </form>

                      <div id="emojiPicker" class="wa-emoji-picker">
                        <div class="wa-emoji-categories">
                          <button type="button" class="wa-emoji-category active" data-category="smileys">😀</button>
                          <button type="button" class="wa-emoji-category" data-category="people">👋</button>
                          <button type="button" class="wa-emoji-category" data-category="animals">🐶</button>
                          <button type="button" class="wa-emoji-category" data-category="food">🍕</button>
                          <button type="button" class="wa-emoji-category" data-category="travel">✈️</button>
                          <button type="button" class="wa-emoji-category" data-category="objects">📱</button>
                          <button type="button" class="wa-emoji-category" data-category="symbols">❤️</button>
                        </div>
                        <div id="emojiGrid" class="wa-emoji-grid">
                          <!-- Emojis will be populated by JavaScript -->
                        </div>
                      </div>
                      <div id="reactionPicker" class="reaction-picker" style="display:none;">
                        <div class="reaction-picker-header">
                          <span class="reaction-picker-title">React to message</span>
                          <button type="button" class="reaction-picker-close" onclick="hideReactionPicker()">×</button>
                        </div>
                        <div class="reaction-picker-grid">
                          <button type="button" class="reaction-option" onclick="addReaction('😀')">😀</button>
                          <button type="button" class="reaction-option" onclick="addReaction('😂')">😂</button>
                          <button type="button" class="reaction-option" onclick="addReaction('😍')">😍</button>
                          <button type="button" class="reaction-option" onclick="addReaction('😮')">😮</button>
                          <button type="button" class="reaction-option" onclick="addReaction('😢')">😢</button>
                          <button type="button" class="reaction-option" onclick="addReaction('😡')">😡</button>
                          <button type="button" class="reaction-option" onclick="addReaction('👍')">👍</button>
                          <button type="button" class="reaction-option" onclick="addReaction('👎')">👎</button>
                          <button type="button" class="reaction-option" onclick="addReaction('❤️')">❤️</button>
                          <button type="button" class="reaction-option" onclick="addReaction('🎉')">🎉</button>
                          <button type="button" class="reaction-option" onclick="addReaction('🔥')">🔥</button>
                          <button type="button" class="reaction-option" onclick="addReaction('👏')">👏</button>
                        </div>
                      </div>
                  <form method="post" action="/send/${phone}" onsubmit="event.preventDefault(); handleFormSubmit(event); return false;">
                    <div class="wa-attach-menu" id="attachMenu" style="display: none;">
                      <button type="button" class="wa-attach-option" id="attachDocumentBtn" title="Send document">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                          <polyline points="14,2 14,8 20,8"></polyline>
                          <line x1="16" y1="13" x2="8" y2="13"></line>
                          <line x1="16" y1="17" x2="8" y2="17"></line>
                          <polyline points="10,9 9,9 8,9"></polyline>
                        </svg>
                        <span>Document</span>
                      </button>
                      <button type="button" class="wa-attach-option" id="attachImageBtn" title="Send photo">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                          <circle cx="8.5" cy="8.5" r="1.5"></circle>
                          <polyline points="21,15 16,10 5,21"></polyline>
                        </svg>
                        <span>Photo</span>
                      </button>
                    </div>
                    
                    <div class="wa-input-container">
                      <button type="button" ${!isHuman ? 'disabled' : ''} onclick="toggleAttachmentMenu()" class="wa-attach-btn" title="Attach">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
                        </svg>
                      </button>
                      
                      <div class="wa-input-wrapper">
                        <textarea ${!isHuman ? 'disabled' : ''} rows="1" name="text" placeholder="Type a message" id="messageInput"></textarea>
                      </div>
                      
                      <button type="button" ${!isHuman ? 'disabled' : ''} onclick="toggleEmojiPicker()" class="wa-emoji-btn" title="Emoji">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
                          <path d="M8.5 10c-.83 0-1.5-.67-1.5-1.5S7.67 7 8.5 7s1.5.67 1.5 1.5S9.33 10 8.5 10zm7 0c-.83 0-1.5-.67-1.5-1.5S14.67 7 15.5 7s1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm-3.5 6c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/>
                        </svg>
                      </button>
                    
                      <button type="submit" id="sendButton" class="wa-send-btn" title="Send" ${!isHuman ? 'disabled data-original-disabled="true"' : ''}>
                        <img src="/send-whatsapp-icon.svg" alt="Send" style="width:22px; height:22px; vertical-align:middle;" />
                      </button>
                    </div>
                  </form>
                  ${quickReplies.length > 0 ? `
                  <div class="quick-replies-container" id="quickRepliesContainer" style="margin-top:8px;">
                    <div class="quick-replies-header">
                      <span class="quick-replies-title">Quick Replies</span>
                      <button type="button" class="quick-replies-toggle" onclick="toggleQuickReplies()" id="quickRepliesToggle">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                        </svg>
                      </button>
                    </div>
                    <div class="quick-replies-grid" id="quickRepliesGrid">
                      ${quickReplies.map(reply => `
                        <button type="button" class="quick-reply-btn" onclick="selectQuickReply('${reply.text.replace(/'/g, "\\'").replace(/\"/g, '&quot;')}')" data-text="${reply.text.replace(/\"/g, '&quot;')}">
                          <span class="quick-reply-text">${escapeHtml(reply.text)}</span>
                          <span class="quick-reply-category">${reply.category || 'General'}</span>
                        </button>
                      `).join('')}
                    </div>
                  </div>
                  ` : ''}
                    </div>
                  </div>
                </div>
              </main>
            </div>  
          </div>
        </body>
      </html>
    `);
  });

  async function resolveContactLang(userId, phone) {
    try {
      const mem = await getContactMemory(userId, phone);
      if (mem?.lang === "sq" || mem?.lang === "en") return mem.lang;
    } catch {}
    try {
      const digits = normalizePhone(phone);
      const recent = await getDB().collection("messages").findOne(
        {
          user_id: String(userId),
          direction: "inbound",
          type: "text",
          text_body: { $exists: true, $nin: ["", null] },
          $or: [
            { from_id: String(phone) },
            ...(digits ? [{ from_digits: digits }] : [])
          ]
        },
        { sort: { timestamp: -1 }, projection: { text_body: 1 } }
      );
      const detected = detectLanguage(recent?.text_body || "");
      if (detected === "sq" || detected === "en") return detected;
    } catch {}
    return "en";
  }

  async function sendLiveModeWelcomeMessage(userId, phone, cfg, agentName) {
    if (!cfg?.whatsapp_token || !cfg?.phone_number_id || !agentName) return;
    try {
      const lang = await resolveContactLang(userId, phone);
      const text = tr("live_agent_connected", lang, { name: agentName });
      const resp = await sendWhatsAppText(phone, text, cfg);
      const outboundId = resp?.messages?.[0]?.id;
      if (!outboundId) return;
      try {
        await recordOutboundMessage({
          messageId: outboundId,
          userId,
          cfg,
          to: phone,
          type: 'text',
          text,
          raw: { to: phone, text, context: 'live_mode_connect' }
        });
      } catch (err) {
        console.warn('Live mode welcome message record failed:', err?.message || err);
      }
      try {
        const { broadcastNewMessage } = await import('../routes/realtime.mjs');
        const nowTs = Math.floor(Date.now() / 1000);
        broadcastNewMessage(userId, String(phone), {
          id: outboundId,
          direction: 'outbound',
          type: 'text',
          text_body: text,
          timestamp: nowTs,
          from_digits: (cfg.business_phone || '').replace(/\D/g, '') || null,
          to_digits: String(phone),
          contact_name: null,
          contact: String(phone),
          formatted_time: formatTimestampForDisplay(nowTs),
          delivery_status: 'sent',
          read_status: 'unread'
        });
      } catch (err) {
        console.warn('Broadcast live mode welcome message failed:', err?.message || err);
      }
    } catch (err) {
      console.warn('Live mode welcome message failed:', err?.message || err);
    }
  }

  async function isConversationOver24h(userId, phone) {
    try {
      const digits = normalizePhone(phone);
      const lastMsg = await Message.findOne({
        user_id: userId,
        direction: 'inbound',
        $or: [{ from_id: phone }, { from_digits: digits }]
      }).sort({ timestamp: -1 }).select('timestamp').lean();
      const lastInbound = Number(lastMsg?.timestamp || 0);
      const now = Math.floor(Date.now() / 1000);
      return !!(lastInbound && (now - lastInbound) > 24 * 3600);
    } catch {
      return false;
    }
  }

  app.post("/inbox/:phone/handoff", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const wantsJson = String(req.headers.accept || '').includes('application/json');
    const raw = req.body?.is_live ?? req.body?.isLive ?? req.body?.is_human;
    const isLive = raw === '1' || raw === 1 || raw === true || raw === 'true';

    const fail = (status, message) => {
      if (wantsJson) return res.status(status).json({ error: message });
      return res.redirect(`/inbox/${encodeURIComponent(phone)}?toast=${encodeURIComponent(message)}&type=error`);
    };

    try {
      if (isLive) {
        if (await isUsageExceeded(userId)) {
          return fail(403, 'You have exceeded your monthly message limit. Please upgrade your plan.');
        }
        if (await isConversationOver24h(userId, phone)) {
          return fail(400, 'Live mode is disabled because the last customer message is older than 24 hours.');
        }
        const cfg = await getSettingsForUser(userId);
        const agentName = String(cfg?.name || '').trim();
        if (!agentName) {
          return fail(400, 'Please set your Name in Settings before enabling Live mode.');
        }

        const now = Math.floor(Date.now() / 1000);
        await upsertHandoffForContact(userId, phone, {
          is_human: true,
          human_expires_ts: now + 5 * 60
        });
        sendLiveModeWelcomeMessage(userId, phone, cfg, agentName);
      } else {
        await upsertHandoffForContact(userId, phone, {
          is_human: false,
          human_expires_ts: 0
        });
      }

      try {
        const { broadcastLiveModeChange } = await import('../routes/realtime.mjs');
        await broadcastLiveModeChange(userId, canonicalContactId(phone), isLive);
      } catch {}

      if (wantsJson) {
        return res.json({ success: true, isLive: !!isLive });
      }
      return res.redirect(`/inbox/${encodeURIComponent(phone)}`);
    } catch (error) {
      console.error('Error updating handoff mode:', error);
      return fail(500, 'Failed to update live mode');
    }
  });

  async function handleHandoff(req, res) {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const source = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const isHuman = source?.is_human ? 1 : 0;
    const now = Math.floor(Date.now()/1000);
    const exp = isHuman ? (now + 5*60) : 0;
    try {
      if (isHuman) {
        if (await isConversationOver24h(userId, phone)) {
          const msg = encodeURIComponent('Live mode is disabled because the last customer message is older than 24 hours.');
          return res.redirect(`/inbox/${encodeURIComponent(phone)}?toast=${msg}&type=error`);
        }

        const cfg = await getSettingsForUser(userId);
        const agentName = String(cfg?.name || '').trim();
        if (!agentName) {
          const msg = encodeURIComponent('Please set your Name in Settings before enabling Live mode.');
          return res.redirect(`/inbox/${encodeURIComponent(phone)}?toast=${msg}&type=error`);
        }
        try {
          await upsertHandoffForContact(userId, phone, { is_human: true, human_expires_ts: exp });
        } catch {}
        sendLiveModeWelcomeMessage(userId, phone, cfg, agentName);
      } else {
        try {
          await upsertHandoffForContact(userId, phone, { is_human: false, human_expires_ts: 0 });
        } catch {}
      }
    } catch {}
    return res.redirect(`/inbox/${encodeURIComponent(phone)}`);
  }
  app.post("/handoff/:phone", ensureAuthed, handleHandoff);
  app.get("/handoff/:phone", ensureAuthed, handleHandoff);
  app.post("/inbox/:phone/simulate-status", ensureAuthed, (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const { messageId, status } = req.body;
    
    try {
      if (!messageId || !status) {
        return res.status(400).json({ error: 'Missing messageId or status' });
      }
      simulateDeliveryStatusUpdate(messageId, status);
      broadcastMessageStatus(userId, phone, messageId, status, {
        messageId,
        status,
        timestamp: Date.now()
      });
      
      res.json({ success: true, messageId, status });
    } catch (error) {
      console.error('Error simulating status update:', error);
      res.status(500).json({ error: 'Failed to update status' });
    }
  });
  app.post("/inbox/:phone/status", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);    const userId = getCurrentUserId(req);
    const { status, reason } = req.body;
    
    try {
      if (!Object.values(CONVERSATION_STATUSES).includes(status)) {
        return res.status(400).json({ error: 'Invalid conversation status' });
      }
      
      await updateConversationStatus(userId, phone, status, reason);
      if (status === CONVERSATION_STATUSES.RESOLVED) {
        try { await upsertHandoffForContact(userId, phone, { is_human: false, human_expires_ts: 0 }); } catch {}
        try {
          const cfg = await getSettingsForUser(userId);
          if (cfg?.whatsapp_token && cfg?.phone_number_id) {
            const over24h = false;
            if (over24h) {
              try {
                const tname = cfg.wa_template_name || 'hello_world';
                const tlang = cfg.wa_template_language || 'en_US';
                await sendWhatsAppTemplate(phone, tname, tlang, [], cfg);
              } catch (e) {
                console.warn('[CSAT] Session expired and template send failed:', e?.message || e);
              }
            } else {
              const agentName = String(cfg?.name || '').trim();
              const header = `Rate your experience with ${agentName || 'our team'}`;
              const body = 'Tap one of the options below:';
              const rows = [
                { id: 'CSAT_1', title: '😡 Very bad', description: '' },
                { id: 'CSAT_2', title: '😕 Bad', description: '' },
                { id: 'CSAT_3', title: '🙂 Okay', description: '' },
                { id: 'CSAT_4', title: '😀 Good', description: '' },
                { id: 'CSAT_5', title: '🤩 Excellent', description: '' }
              ];
              try {
                const resp = await sendWhatsappList(phone, header, body, 'Select', rows, cfg);
                const outboundId = resp?.messages?.[0]?.id;
                if (outboundId) {
                  try {
                    await recordOutboundMessage({
                      messageId: outboundId,
                      userId,
                      cfg,
                      to: phone,
                      type: 'interactive',
                      text: `${header}\n${body}`,
                      raw: { to: phone, interactive: { body: { text: header }, type: 'csat_list' } }
                    });
                  } catch {}
                  try {
                    const { broadcastNewMessage } = await import('../routes/realtime.mjs');
                    const messageData = {
                      id: outboundId,
                      direction: 'outbound',
                      type: 'interactive',
                      text_body: `${header}\n${body}`,
                      timestamp: Math.floor(Date.now() / 1000),
                      from_digits: (cfg.business_phone || '').replace(/\D/g, '') || null,
                      to_digits: String(phone),
                      contact_name: null,
                      contact: String(phone),
                      formatted_time: formatTimestampForDisplay(Math.floor(Date.now() / 1000)),
                      delivery_status: 'sent',
                      read_status: 'unread'
                    };
                    broadcastNewMessage(userId, String(phone), messageData);
                  } catch {}
                }
              } catch (e) {
                console.warn('[CSAT] Failed to send list prompt, falling back to text:', e?.message || e);
                const prompt = "Thanks for chatting with us! Please rate by replying with one emoji: 😡 😕 🙂 😀 🤩";
                try { 
                  const resp2 = await sendWhatsAppText(phone, prompt, cfg);
                  const outboundId2 = resp2?.messages?.[0]?.id;
                  if (outboundId2) {
                    try { await recordOutboundMessage({ messageId: outboundId2, userId, cfg, to: phone, type: 'text', text: prompt, raw: { to: phone, text: prompt, context: 'csat_fallback' } }); } catch {}
                    try {
                      const { broadcastNewMessage } = await import('../routes/realtime.mjs');
                      const messageData = {
                        id: outboundId2,
                        direction: 'outbound',
                        type: 'text',
                        text_body: prompt,
                        timestamp: Math.floor(Date.now() / 1000),
                        from_digits: (cfg.business_phone || '').replace(/\D/g, '') || null,
                        to_digits: String(phone),
                        contact_name: null,
                        contact: String(phone),
                        formatted_time: formatTimestampForDisplay(Math.floor(Date.now() / 1000)),
                        delivery_status: 'sent',
                        read_status: 'unread'
                      };
                      broadcastNewMessage(userId, String(phone), messageData);
                    } catch {}
                  }
                } catch {}
              }
            }
          } else {
            console.warn('[CSAT] Skipped prompt: missing WhatsApp config');
          }
          try {
            const { getDB } = await import('../db-mongodb.mjs');
            const dbNative = getDB();
            await dbNative.collection('contact_state').updateOne(
              { user_id: String(userId), contact_id: String(phone) },
              { $set: { await_rating: 1, await_rating_ts: Math.floor(Date.now()/1000), updatedAt: new Date() } },
              { upsert: true }
            );
          } catch (e) { console.warn('[CSAT] Failed to flag await_rating:', e?.message || e); }
        } catch {}
      }
      const statusDisplay = STATUS_DISPLAY_NAMES[status];
      res.redirect(`/inbox/${encodeURIComponent(phone)}`);
    } catch (error) {
      console.error('Error updating conversation status:', error);
      res.redirect(`/inbox/${encodeURIComponent(phone)}?toast=${encodeURIComponent('Failed to update status')}&type=error`);
    }
  });
  app.post("/inbox/:phone/renew", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    try {
      const now = Math.floor(Date.now()/1000);
      const row = await findHandoffForContact(userId, phone, 'human_expires_ts');
      const base = Number(row?.human_expires_ts || 0) > now ? Number(row?.human_expires_ts || 0) : now;
      const next = base + 5*60;
      await upsertHandoffForContact(userId, phone, { is_human: true, human_expires_ts: next });
    } catch {}
    res.redirect(`/inbox/${phone}`);
  });
  app.post("/inbox/:phone/archive", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    try { await Handoff.findOneAndUpdate({ contact_id: phone, user_id: userId }, { $set: { is_archived: true, updatedAt: new Date() } }, { upsert: true }); } catch {}
    res.redirect(`/inbox`);
  });
  app.post("/inbox/:phone/unarchive", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    try { await Handoff.findOneAndUpdate({ contact_id: phone, user_id: userId }, { $set: { is_archived: false, updatedAt: new Date() } }, { upsert: true }); } catch {}
    res.redirect(`/inbox?archived=1`);
  });
  app.post("/inbox/:phone/optout", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const { Customer } = await import('../schemas/mongodb.mjs');
    try { await Customer.findOneAndUpdate({ user_id: userId, contact_id: phone }, { $set: { opted_out: true, updatedAt: new Date() } }, { upsert: true }); } catch {}
    res.redirect(`/inbox/${encodeURIComponent(phone)}`);
  });
  app.post("/inbox/:phone/unoptout", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const { Customer } = await import('../schemas/mongodb.mjs');
    try { await Customer.updateOne({ user_id: userId, contact_id: phone }, { $set: { opted_out: false, updatedAt: new Date() } }); } catch {}
    res.redirect(`/inbox/${encodeURIComponent(phone)}`);
  });
  app.post("/inbox/:phone/block24h", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const { Customer } = await import('../schemas/mongodb.mjs');
    const until = Math.floor(Date.now()/1000) + 24*3600;
    try { await Customer.findOneAndUpdate({ user_id: userId, contact_id: phone }, { $set: { blocked_until_ts: until, updatedAt: new Date() } }, { upsert: true }); } catch {}
    res.redirect(`/inbox/${encodeURIComponent(phone)}`);
  });
  app.post("/inbox/:phone/clear", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const digits = normalizePhone(phone);
    try {
      await Message.deleteMany({
        user_id: String(userId),
        $or: [
          { from_digits: digits },
          { to_digits: digits },
          { from_id: { $in: [digits, '+' + digits] } },
          { to_id: { $in: [digits, '+' + digits] } }
        ]
      });
      try {
        const now = Math.floor(Date.now()/1000);
        await Message.create({
          id: `clear_${userId}_${digits}_${now}`,
          direction: 'outbound',
          from_id: null,
          to_id: phone,
          from_digits: null,
          to_digits: digits,
          type: 'system_clear',
          text_body: '',
          timestamp: now,
          user_id: String(userId),
          raw: { system: 'clear_marker' },
          delivery_status: 'sent'
        });
      } catch {}
    } catch (e) {
      console.error('Clear conversation failed:', e?.message || e);
    }
    return res.redirect(`/inbox/${encodeURIComponent(phone)}`);
  });
  app.post("/inbox/:phone/delete", ensureAuthed, async (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const digits = normalizePhone(phone);
    const variants = contactIdVariants(phone);
    try {
      const criteria = {
        user_id: String(userId),
        $or: [
          { from_digits: digits },
          { to_digits: digits },
          { from_id: { $in: variants.length ? variants : [digits, '+' + digits] } },
          { to_id: { $in: variants.length ? variants : [digits, '+' + digits] } }
        ]
      };
      const ids = (await Message.find(criteria).select('id').lean().catch(() => []))
        .map(m => m?.id)
        .filter(Boolean);

      if (ids.length) {
        const dbNative = getDB();
        try {
          await dbNative.collection('message_replies').deleteMany({
            $or: [
              { original_message_id: { $in: ids } },
              { reply_message_id: { $in: ids } }
            ]
          });
        } catch (e) {
          console.warn('[Inbox][DELETE] delete message_replies failed:', e?.message || e);
        }
        try {
          await dbNative.collection('message_reactions').deleteMany({ message_id: { $in: ids } });
        } catch (e) {
          console.warn('[Inbox][DELETE] delete message_reactions failed:', e?.message || e);
        }
        try {
          await MessageStatus.deleteMany({ user_id: String(userId), message_id: { $in: ids } });
        } catch (e) {
          console.warn('[Inbox][DELETE] delete message_statuses failed:', e?.message || e);
        }
      }
      await Message.deleteMany(criteria);
      try {
        const dbNative = getDB();
        await dbNative.collection('contact_interactions').deleteMany({
          user_id: String(userId),
          contact_id: { $in: variants.length ? variants : [phone, digits, '+' + digits] }
        });
      } catch (e) {
        console.warn('[Inbox][DELETE] delete contact_interactions failed:', e?.message || e);
      }
      try {
        await Customer.deleteMany({ user_id: userId, contact_id: { $in: variants } });
      } catch (e) {
        console.warn('[Inbox][DELETE] delete customer failed:', e?.message || e);
      }
    } catch (e) {
      console.error('Delete conversation failed:', e?.message || e);
    }
    try {
      await upsertHandoffForContact(userId, phone, {
        deleted_at: Math.floor(Date.now() / 1000),
        is_archived: false
      });
    } catch (e) {
      console.warn('[Inbox][DELETE] mark handoff deleted failed:', e?.message || e);
    }
    return redirectToInbox(res, { toast: 'Conversation deleted', type: 'success' });
  });

  function wantsJsonResponse(req) {
    const format = (req.query?.format || '').toString().toLowerCase();
    if (format === 'json' || format === '1' || format === 'true') return true;
    const accept = (req.headers['accept'] || '').toString().toLowerCase();
    if (accept.includes('application/json')) return true;
    if (req.xhr) return true;
    return false;
  }

  app.post("/send/:phone", ensureAuthed, async (req, res) => {
    const to = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const expectJson = wantsJsonResponse(req);
    const redirectToThread = `/inbox/${encodeURIComponent(to)}`;
    const respondSuccess = (payload = {}) => {
      if (expectJson) {
        return res.json({ success: true, ...payload });
      }
      return res.redirect(redirectToThread);
    };
    const respondError = (message, status = 400, extra = {}) => {
      if (expectJson) {
        return res.status(status).json({ success: false, error: message, ...extra });
      }
      const encoded = encodeURIComponent(message || 'Failed to send message.');
      return res.redirect(`${redirectToThread}?toast=${encoded}&type=error`);
    };

    const cfg = await getSettingsForUser(userId);
    const text = (req.body?.text || "").toString().trim();
    if (!text) return respondError('Message cannot be empty.', 400);
    try {
      let over24h = false;
      try {
        const row = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'`).get(userId, to) || {};
        const lastInbound = Number(row.ts || 0);
        const now = Math.floor(Date.now()/1000);
        over24h = lastInbound && (now - lastInbound) > 24*3600;
      } catch {}

      if (over24h) {
        const tname = (cfg.wa_template_name || '').toString().trim();
        let tlang = (cfg.wa_template_language || 'en_US').toString().trim() || 'en_US';
        if (!tname) {
          return respondError('Conversation is older than 24h. Please choose a default template on the Campaigns page before replying.', 400, { requireTemplate: true });
        }
        try {
          await sendReopenTemplateMessage({ userId, cfg, to });
          return respondSuccess({ templateSent: true });
        } catch (e) {
          console.error('24h reopen template send failed:', e?.message || e);
          return respondError(summarizeWhatsAppError(e), 502);
        }
      }
      const replyTo = req.body?.replyTo;
      const replyOriginal = await getReplyOriginalMeta(userId, replyTo);
      const originalMessageId = replyOriginal?.original_message_id || null;
      
      const data = await sendWhatsAppText(to, text, cfg, originalMessageId);
      const outboundId = data?.messages?.[0]?.id;
      const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
      if (!outboundId) {
        return respondError('WhatsApp API did not return a message id.', 502);
      }

      try { await recordOutboundMessage({ messageId: outboundId, userId, cfg, to, type: 'text', text, raw: { to, text } }); } catch {}
      try {
        const { broadcastNewMessage } = await import('../routes/realtime.mjs');
        const nowTs = Math.floor(Date.now() / 1000);
        const messageData = {
          id: outboundId,
          direction: 'outbound',
          type: 'text',
          text_body: text,
          timestamp: nowTs,
          from_digits: (cfg.business_phone || "").replace(/\D/g, "") || null,
          to_digits: String(to),
          contact_name: null,
          contact: String(to),
          formatted_time: formatTimestampForDisplay(nowTs),
          delivery_status: 'sent',
          read_status: 'unread',
          ...(replyOriginal ? { replyOriginal } : {})
        };
        broadcastNewMessage(userId, String(to), messageData);
      } catch {}
      try { await updateConversationStatus(userId, String(to), CONVERSATION_STATUSES.IN_PROGRESS, 'agent_reply'); } catch {}
      try { await ensureInProgressIfHuman(userId, String(to)); } catch {}
      try {
        updateContactActivity(userId, to);
      } catch (error) {
        console.error('Error updating contact activity:', error);
      }
      if (replyTo && outboundId) {
        try {
          const plan = await getUserPlan(userId);
          if ((plan?.plan_name || 'free') !== 'free') {
            const replyResult = await createReply(replyTo, outboundId);
            if (!replyResult.success) {
              console.error('Failed to create reply relationship:', replyResult.error);
            }
          }
        } catch (error) {
          console.error('Error creating reply relationship:', error);
        }
      }
      return respondSuccess({ messageId: outboundId, replyOriginal: replyOriginal || undefined });
    } catch (e) {
      console.error("Manual send error:", e);
      const tempMessageId = `failed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
      const timestamp = Math.floor(Date.now() / 1000);
      
      try {
        const stmt = db.prepare(`
          INSERT INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw, delivery_status, error_message)
          VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'text', ?, ?, ?, ?, ?)
        `);
        
        stmt.run(
          tempMessageId, 
          userId, 
          fromBiz, 
          to, 
          normalizePhone(fromBiz), 
          normalizePhone(to), 
          text, 
          timestamp, 
          JSON.stringify({ to, text }), 
          MESSAGE_STATUS.FAILED,
          e?.message || 'Unknown error'
        );
        
        if (process.env.DEBUG_LOGS === '1') console.log(`❌ Created failed message record: ${tempMessageId}`);
      } catch (dbError) {
        console.error("Error creating failed message record:", dbError);
      }
      
      return respondError(e?.message || 'Failed to send message.', 502, { temporaryMessageId: tempMessageId });
    }
  });
  app.post("/retry-message/:messageId", ensureAuthed, async (req, res) => {
    const messageId = req.params.messageId;
    const userId = getCurrentUserId(req);
    
    try {
      const retryResult = await retryFailedMessage(messageId);
      
      if (!retryResult.success) {
        return res.status(400).json({ 
          success: false, 
          error: retryResult.error 
        });
      }
      
      const message = retryResult.message;
      if (message.userId !== userId) {
        return res.status(403).json({ 
          success: false, 
          error: 'Unauthorized to retry this message' 
        });
      }
      const cfg = await getSettingsForUser(userId);
      if (!cfg || !cfg.whatsapp_token || !cfg.phone_number_id) {
        return res.status(400).json({ 
          success: false, 
          error: 'WhatsApp configuration not found' 
        });
      }
      try { if (process.env.DEBUG_LOGS === '1') console.log('[Retry] Resending WA text', { to_tail: String(message.to||'').slice(-6), hasPhoneId: !!cfg.phone_number_id, hasToken: !!cfg.whatsapp_token }); } catch {}
      const data = await sendWhatsAppText(message.to, message.text, cfg);
      const outboundId = data?.messages?.[0]?.id;
      
      if (outboundId) {
        const updateStmt = db.prepare(`
          UPDATE messages 
          SET id = ?, delivery_status = ?, delivery_timestamp = ?, error_message = NULL
          WHERE id = ?
        `);
        
        const timestamp = Math.floor(Date.now() / 1000);
        updateStmt.run(outboundId, MESSAGE_STATUS.SENT, timestamp, messageId);
        try {
          updateContactActivity(userId, message.to);
        } catch (error) {
          console.error('Error updating contact activity:', error);
        }
        
        if (process.env.DEBUG_LOGS === '1') console.log(`✅ Successfully retried message ${messageId} -> ${outboundId}`);
        try {
          const { broadcastNewMessage } = await import('../routes/realtime.mjs');
          const messageData = {
            id: outboundId,
            direction: 'outbound',
            type: 'text',
            text_body: message.text,
            timestamp: Math.floor(Date.now() / 1000),
            from_digits: (cfg.business_phone || '').replace(/\D/g, '') || null,
            to_digits: String(message.to),
            contact_name: null,
            contact: String(message.to),
            formatted_time: formatTimestampForDisplay(Math.floor(Date.now() / 1000)),
            delivery_status: 'sent',
            read_status: 'unread'
          };
          broadcastNewMessage(userId, String(message.to), messageData);
        } catch (e) {
          console.warn('[Retry] Broadcast failed (non-fatal):', e?.message || e);
        }
        
        return res.json({ 
          success: true, 
          message: 'Message retried successfully',
          newMessageId: outboundId
        });
      } else {
        markMessageAsFailed(messageId, 'Retry failed: No message ID returned from WhatsApp');
        
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to send message via WhatsApp' 
        });
      }
      
    } catch (error) {
      console.error('Retry message error:', error);
      markMessageAsFailed(messageId, `Retry failed: ${error.message}`);
      
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });
  app.post("/upload-image/:phone", ensureAuthed, uploadImage.single('image'), async (req, res) => {
    const to = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const cfg = await getSettingsForUser(userId);
    const caption = (req.body?.caption || "").toString().trim();
    
    if (!req.file) {
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    }
    const host = req.get('host');
    const isNgrok = host.includes('ngrok') || host.includes('ngrok.io');
    let imageUrl;
    let whatsappImageUrl;
    
    if (isNgrok) {
      imageUrl = `${req.protocol}://${host}/uploads/${req.file.filename}`;
      whatsappImageUrl = imageUrl;    } else {
      imageUrl = `${req.protocol}://${host}/uploads/${req.file.filename}`;
      const ngrokUrl = process.env.NGROK_URL || 'https://85d9d75e0287.ngrok-free.app';
      whatsappImageUrl = `${ngrokUrl}/uploads/${req.file.filename}`;
      if (process.env.DEBUG_LOGS === '1') console.log('⚠️ WARNING: Using localhost for display, ngrok for WhatsApp API');
    }
    
    if (process.env.DEBUG_LOGS === '1') console.log('Image upload - Generated URL:', imageUrl);
    if (process.env.DEBUG_LOGS === '1') console.log('Image upload - File:', req.file.filename);
    if (process.env.DEBUG_LOGS === '1') console.log('Image upload - Using ngrok:', isNgrok);
    if (process.env.DEBUG_LOGS === '1') console.log('Image upload - Note: WhatsApp needs this URL to be publicly accessible');
    try {
      let over24h = false;
      try {
        const row = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'`).get(userId, to) || {};
        const lastInbound = Number(row.ts || 0);
        const now = Math.floor(Date.now()/1000);
        over24h = lastInbound && (now - lastInbound) > 24*3600;
      } catch {}

      if (over24h) {
        const tname = (cfg.wa_template_name || '').toString().trim();
        const tlang = (cfg.wa_template_language || 'en_US').toString().trim() || 'en_US';
        if (!tname) {
          return res.redirect(`/inbox/${encodeURIComponent(to)}?toast=${encodeURIComponent('Conversation is older than 24h. Set a default template on the Campaigns page before sending media.')}&type=error`);
        }
        try {
          await sendReopenTemplateMessage({ userId, cfg, to });
        } catch (e) {
          console.error('24h reopen template send failed (image):', e?.message || e);
        }
        return res.redirect(`/inbox/${encodeURIComponent(to)}`);
      }
      const replyTo = req.body?.replyTo;
      const originalMessageId = await resolveReplyMessageId(userId, replyTo);
      
      if (process.env.DEBUG_LOGS === '1') console.log('Sending image via WhatsApp API:', { to, whatsappImageUrl, caption });
      
      let data;
      if (isNgrok) {
        data = await sendWhatsappImage(to, whatsappImageUrl, caption, cfg, originalMessageId);
      } else {
        if (process.env.DEBUG_LOGS === '1') console.log('Using cloud upload for localhost compatibility');
        const { sendWhatsappImageBase64 } = await import('../services/whatsapp.mjs');
        data = await sendWhatsappImageBase64(to, req.file.path, caption, cfg, originalMessageId);
      }
      
      if (process.env.DEBUG_LOGS === '1') console.log('WhatsApp API response:', data);
      const outboundId = data?.messages?.[0]?.id;
      const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
      
      if (outboundId) {
        try {
          const rawData = { to, imageUrl, caption, filename: req.file.filename };
          await recordOutboundMessage({ messageId: outboundId, userId, cfg, to, type: 'image', text: caption || '📷 Image', raw: rawData });
        } catch {}
        const replyTo = req.body?.replyTo;
        if (replyTo && outboundId) {
          try {
            const plan = await getUserPlan(userId);
            if ((plan?.plan_name || 'free') !== 'free') {
              const replyResult = await createReply(replyTo, outboundId);
              if (!replyResult.success) {
                console.error('Failed to create reply relationship:', replyResult.error);
              }
            }
          } catch (error) {
            console.error('Error creating reply relationship:', error);
          }
        }
        try { await ensureInProgressIfHuman(userId, String(to)); } catch {}
      }
    } catch (e) {
      console.error("Image upload send error:", e);
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    }
    
    res.redirect(`/inbox/${encodeURIComponent(to)}`);
  });
  app.post("/upload-document/:phone", ensureAuthed, uploadDocument.single('document'), async (req, res) => {
    const to = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const cfg = await getSettingsForUser(userId);
    const caption = (req.body?.caption || "").toString().trim();
    
    if (!req.file) {
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    }
    const host = req.get('host');
    const isNgrok = host.includes('ngrok') || host.includes('ngrok.io');
    
    let documentUrl;
    let whatsappDocumentUrl;
    
    if (isNgrok) {
      documentUrl = `${req.protocol}://${host}/uploads/${req.file.filename}`;
      whatsappDocumentUrl = documentUrl;
    } else {
      documentUrl = `${req.protocol}://${host}/uploads/${req.file.filename}`;
      const ngrokUrl = process.env.NGROK_URL || 'https://85d9d75e0287.ngrok-free.app';
      whatsappDocumentUrl = `${ngrokUrl}/uploads/${req.file.filename}`;
      if (process.env.DEBUG_LOGS === '1') console.log('⚠️ WARNING: Using localhost for display, ngrok for WhatsApp API');
    }
    
    if (process.env.DEBUG_LOGS === '1') console.log('Document upload - Generated URL:', documentUrl);
    if (process.env.DEBUG_LOGS === '1') console.log('Document upload - File:', req.file.filename);
    try {
      let over24h = false;
      try {
        const row = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'`).get(userId, to) || {};
        const lastInbound = Number(row.ts || 0);
        const now = Math.floor(Date.now()/1000);
        over24h = lastInbound && (now - lastInbound) > 24*3600;
      } catch {}

      if (over24h) {
        const tname = (cfg.wa_template_name || '').toString().trim();
        const tlang = (cfg.wa_template_language || 'en_US').toString().trim() || 'en_US';
        if (!tname) {
          return res.redirect(`/inbox/${encodeURIComponent(to)}?toast=${encodeURIComponent('Conversation is older than 24h. Set a default template on the Campaigns page before sending documents.')}&type=error`);
        }
        try {
          await sendReopenTemplateMessage({ userId, cfg, to });
        } catch (e) {
          console.error('24h reopen template send failed (document):', e?.message || e);
        }
        return res.redirect(`/inbox/${encodeURIComponent(to)}`);
      }
      const replyTo = req.body?.replyTo;
      const originalMessageId = await resolveReplyMessageId(userId, replyTo);
      
      if (process.env.DEBUG_LOGS === '1') console.log('Sending document via WhatsApp API:', { to, whatsappDocumentUrl, caption });
      if (process.env.DEBUG_LOGS === '1') console.log('WhatsApp config check:', { 
        hasToken: !!cfg.whatsapp_token, 
        hasPhoneId: !!cfg.phone_number_id,
        tokenLength: cfg.whatsapp_token?.length,
        phoneId: cfg.phone_number_id 
      });
      
      let data;
      if (isNgrok) {
        data = await sendWhatsappDocument(to, whatsappDocumentUrl, req.file.filename, caption, cfg, originalMessageId);
      } else {
        const { sendWhatsappDocumentBase64 } = await import('../services/whatsapp.mjs');
        data = await sendWhatsappDocumentBase64(to, req.file.path, req.file.filename, caption, cfg, originalMessageId);
      }
      
      if (process.env.DEBUG_LOGS === '1') console.log('WhatsApp API response:', data);
      const outboundId = data?.messages?.[0]?.id;
      const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
      
      if (outboundId) {
        try { 
          const rawData = { to, documentUrl, caption, filename: req.file.filename };
          await recordOutboundMessage({ messageId: outboundId, userId, cfg, to, type: 'document', text: caption || '📄 Document', raw: rawData });
        } catch {}
        try {
          const { broadcastNewMessage } = await import('../routes/realtime.mjs');
          const messageData = {
            id: outboundId,
            direction: 'outbound',
            type: 'document',
            text_body: caption || '📄 Document',
            timestamp: Math.floor(Date.now() / 1000),
            from_digits: (cfg.business_phone || "").replace(/\D/g, "") || null,
            to_digits: String(to),
            contact_name: null,
            contact: String(to),
            formatted_time: formatTimestampForDisplay(Math.floor(Date.now() / 1000)),
            delivery_status: 'sent',
            read_status: 'unread'
          };
          broadcastNewMessage(userId, String(to), messageData);
        } catch {}
        try { await ensureInProgressIfHuman(userId, String(to)); } catch {}
        if (replyTo && outboundId) {
          try {
            const plan = await getUserPlan(userId);
            if ((plan?.plan_name || 'free') !== 'free') {
              const replyResult = await createReply(replyTo, outboundId);
              if (!replyResult.success) {
                console.error('Failed to create reply relationship:', replyResult.error);
              }
            }
          } catch (error) {
            console.error('Error creating reply relationship:', error);
          }
        }
      }
    } catch (e) {
      console.error("Document upload send error:", e);
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    }
    
    res.redirect(`/inbox/${encodeURIComponent(to)}`);
  });

  app.post("/inbox/:phone/send-template", ensureAuthed, async (req, res) => {
    const to = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const cfg = await getSettingsForUser(userId);
    const tname = (cfg.wa_template_name || '').toString().trim();
    if (!tname) {
      const msg = encodeURIComponent('No default template configured. Pick one on the Campaigns page first.');
      return res.redirect(`/inbox/${encodeURIComponent(to)}?toast=${msg}&type=error`);
    }

    try {
      const sent = await sendReopenTemplateMessage({ userId, cfg, to, formValues: req.body || {} });
      const outboundId = sent?.resp?.messages?.[0]?.id;
      const templateLang = sent?.language || String(cfg.wa_template_language || "en_US").trim() || "en_US";
      const templateName = sent?.templateName || tname;
      const displayText = String(sent?.displayText || "").trim();
      if (outboundId) {
        try {
          await recordOutboundMessage({
            messageId: outboundId,
            userId,
            cfg: { ...cfg, user_id: userId },
            to,
            type: 'template',
            text: displayText || null,
            raw: {
              to,
              displayText: displayText || undefined,
              template: {
                name: templateName,
                language: { code: templateLang },
              },
            },
          });
        } catch {}
      }
      const msg = encodeURIComponent(`Template "${tname}" sent.`);
      return res.redirect(`/inbox/${encodeURIComponent(to)}?toast=${msg}&type=success`);
    } catch (e) {
      console.error('Template send error:', e?.message || e);
      const msg = encodeURIComponent(summarizeWhatsAppError(e));
      return res.redirect(`/inbox/${encodeURIComponent(to)}?toast=${msg}&type=error`);
    }
  });

  app.post("/inbox/:phone/nameCustomer", ensureAuthed, (req, res) => {
    const phone = parseRouteContact(req.params.phone);
    const userId = getCurrentUserId(req);
    const name = (req.body?.display_name || "").toString().trim().slice(0, 80);
    const notes = (req.body?.notes || "").toString().trim().slice(0, 400);
    if (!name) return res.redirect(`/inbox`);
  
    try {
      db.prepare(`
        INSERT INTO customers (user_id, contact_id, display_name, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(user_id, contact_id) DO UPDATE
        SET display_name = excluded.display_name, notes = excluded.notes, updated_at = excluded.updated_at
      `).run(userId, phone, name, notes || null);
    } catch {}
    return res.redirect(`/inbox`);
  });
  app.post("/api/reactions/:messageId", ensureAuthed, async (req, res) => {
    const { messageId } = req.params;
    const { emoji, phone } = req.body;
    const userId = getCurrentUserId(req);
    try {
      const plan = await getUserPlan(userId);
      if ((plan?.plan_name || 'free') === 'free') {
        return res.status(403).json({ success: false, error: 'upgrade_required' });
      }
    } catch {}
    
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required' });
    }
    
    const result = await toggleReaction(messageId, userId, emoji);
    if (result.success) {
      if (phone) {
        const action = result.added ? 'added' : 'removed';
        const reactionData = {
          messageId,
          emoji,
          userId,
          added: result.added,
          removed: result.removed
        };
        broadcastReaction(userId, phone, messageId, emoji, action, reactionData);
      }
      if (phone) {
        try {
          const dbNative = getDB();
          const originalMessage = await dbNative.collection('messages').findOne(
            { id: String(messageId), user_id: String(userId) },
            { projection: { id: 1, raw: 1 } }
          );
          if (originalMessage) {
            let whatsappMessageId = null;
            try {
              whatsappMessageId = originalMessage.id || null;
              if (!whatsappMessageId && originalMessage.raw) {
                const rawData = typeof originalMessage.raw === 'string' ? JSON.parse(originalMessage.raw) : (originalMessage.raw || {});
                whatsappMessageId = rawData.id || rawData.message_id || null;
              }
            } catch {}
            
            if (whatsappMessageId) {
              const settings = await getSettingsForUser(userId);
              
              if (settings.whatsapp_token && settings.phone_number_id) {
                if (result.added) {
                  const r = await sendWhatsappReaction(phone, whatsappMessageId, emoji, settings);
                  if (process.env.DEBUG_LOGS === '1') console.log('WA reaction add resp:', r);
                } else if (result.removed) {
                  const r = await sendWhatsappReaction(phone, whatsappMessageId, '', settings);
                  if (process.env.DEBUG_LOGS === '1') console.log('WA reaction remove resp:', r);
                }
              }
            }
          }
        } catch (error) {
          console.error('Error sending WhatsApp reaction:', error);
        }
      }
      
      res.json({ success: true, message: 'Reaction toggled successfully' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to toggle reaction' });
    }
  });
  
  app.get("/api/reactions/:messageId", ensureAuthed, (req, res) => {
    const { messageId } = req.params;
    const reactions = getMessageReactions(messageId);
    res.json({ reactions });
  });
  
  app.delete("/api/reactions/:messageId", ensureAuthed, async (req, res) => {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = getCurrentUserId(req);
    try {
      const plan = await getUserPlan(userId);
      if ((plan?.plan_name || 'free') === 'free') {
        return res.status(403).json({ success: false, error: 'upgrade_required' });
      }
    } catch {}
    
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required' });
    }
    
    const result = await removeReaction(messageId, userId, emoji);
    if (result.success) {
      res.json({ success: true, message: 'Reaction removed successfully' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to remove reaction' });
    }
  });
}