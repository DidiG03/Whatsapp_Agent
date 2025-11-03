import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, normalizePhone, escapeHtml, renderTopbar, getProfessionalHead } from "../utils.mjs";
import { listContactsForUser, listMessagesForThread } from "../services/conversations.mjs";
import { db, getDB } from "../db-mongodb.mjs";
import { Customer, Handoff, Message, MessageStatus } from '../schemas/mongodb.mjs';
import { getSettingsForUser } from "../services/settings.mjs";
import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsappImage, sendWhatsappReaction, sendWhatsappList } from "../services/whatsapp.mjs";
import { getQuickReplies } from "../services/quickReplies.mjs";
import { getMessageReactions, toggleReaction, removeReaction, getMessagesReactions, getUserReactionsForMessages } from "../services/reactions.mjs";
import { createReply, getMessagesReplies, getReplyOriginals } from "../services/replies.mjs";
import { getUserPlan } from "../services/usage.mjs";
import { updateContactActivity, upsertContactProfile } from "../services/contacts.mjs";
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
import { initializeSocketIO, getIO, broadcastReaction } from "./realtime.mjs";
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/** Clean contact ID by removing URL parameters and query strings */
function cleanContactId(contactId) {
  if (!contactId) return contactId;
  
  // Remove common URL parameters that might be appended to phone numbers
  let cleaned = contactId.toString();
  
  // Remove query string parameters like ?type=success, &type=success, etc.
  cleaned = cleaned.replace(/[?&]type=[^&]*/g, '');
  cleaned = cleaned.replace(/[?&]status=[^&]*/g, '');
  cleaned = cleaned.replace(/[?&]state=[^&]*/g, '');
  cleaned = cleaned.replace(/[?&]code=[^&]*/g, '');
  
  // Remove any remaining query string parameters
  const questionMarkIndex = cleaned.indexOf('?');
  if (questionMarkIndex !== -1) {
    cleaned = cleaned.substring(0, questionMarkIndex);
  }
  
  // Remove any remaining ampersand parameters
  const ampersandIndex = cleaned.indexOf('&');
  if (ampersandIndex !== -1) {
    cleaned = cleaned.substring(0, ampersandIndex);
  }
  
  return cleaned;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Format a unix timestamp (seconds) for display:
// - today: show time only (HH:MM)
// - yesterday: show 'yesterday'
// - within last 7 days: show weekday name (e.g., Wednesday)
// - 7+ days ago: show date only
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
    return 'yesterday';
  }
  if (d >= startWeekAgo) {
    return d.toLocaleDateString([], { weekday: 'long' });
  }
  return d.toLocaleDateString();
}

// Configure multer for file uploads - serverless compatible
const storage = process.env.VERCEL 
  ? multer.memoryStorage() // Use memory storage in serverless
  : multer.diskStorage({
      destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
      }
    });

// Upload configuration for images
const uploadImage = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
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

// Upload configuration for documents
const uploadDocument = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for documents
  fileFilter: (req, file, cb) => {
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

// Advanced search function for messages and conversations
async function performAdvancedSearch(userId, filters) {
  const { q, messageType, direction, dateFrom, dateTo } = filters;
  
  // Build the search query
  let whereConditions = ['m.user_id = ?'];
  let queryParams = [userId];
  
  // Text search in message content
  if (q) {
    whereConditions.push(`(m.text_body LIKE ? OR m.raw LIKE ?)`);
    const searchTerm = `%${q}%`;
    queryParams.push(searchTerm, searchTerm);
  }
  
  // Message type filter
  if (messageType) {
    whereConditions.push('m.type = ?');
    queryParams.push(messageType);
  }
  
  // Direction filter
  if (direction) {
    whereConditions.push('m.direction = ?');
    queryParams.push(direction);
  }
  
  // Date range filters
  if (dateFrom) {
    whereConditions.push('m.timestamp >= ?');
    queryParams.push(Math.floor(new Date(dateFrom).getTime() / 1000));
  }
  
  if (dateTo) {
    whereConditions.push('m.timestamp <= ?');
    queryParams.push(Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000));
  }
  
  // Get contacts that have matching messages
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
  
  const searchResults = db.prepare(searchQuery).all(...queryParams);
  
  // Convert to contact format expected by the UI and clean contact IDs
  return searchResults.map(result => ({
    contact: cleanContactId(result.contact),
    last_message_ts: result.last_message_ts,
    message_count: result.message_count
  }));
}

// Advanced message search function for individual messages
async function performMessageSearch(userId, filters) {
  const { q, messageType, direction, dateFrom, dateTo, contact, limit, offset } = filters;
  
  // Build the search query
  let whereConditions = ['m.user_id = ?'];
  let queryParams = [userId];
  
  // Text search in message content
  if (q) {
    whereConditions.push(`(m.text_body LIKE ? OR m.raw LIKE ?)`);
    const searchTerm = `%${q}%`;
    queryParams.push(searchTerm, searchTerm);
  }
  
  // Message type filter
  if (messageType) {
    whereConditions.push('m.type = ?');
    queryParams.push(messageType);
  }
  
  // Direction filter
  if (direction) {
    whereConditions.push('m.direction = ?');
    queryParams.push(direction);
  }
  
  // Contact filter
  if (contact) {
    whereConditions.push('(m.from_digits = ? OR m.to_digits = ?)');
    queryParams.push(contact, contact);
  }
  
  // Date range filters
  if (dateFrom) {
    whereConditions.push('m.timestamp >= ?');
    queryParams.push(Math.floor(new Date(dateFrom).getTime() / 1000));
  }
  
  if (dateTo) {
    whereConditions.push('m.timestamp <= ?');
    queryParams.push(Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000));
  }
  
  // Get total count for pagination
  const countQuery = `
    SELECT COUNT(*) as total
    FROM messages m
    WHERE ${whereConditions.join(' AND ')}
  `;
  const totalResult = db.prepare(countQuery).get(...queryParams);
  const total = totalResult.total;
  
  // Get messages with pagination
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
  
  const messages = db.prepare(messagesQuery).all(userId, ...queryParams, limit, offset);
  
  // Format messages for API response
  const formattedMessages = messages.map(msg => ({
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

// When agent is in live (human) mode and sends the first message,
// automatically set conversation status to In Progress
async function ensureInProgressIfHuman(userId, phone) {
  try {
    const handoff = await Handoff.findOne({ user_id: userId, contact_id: phone }).select('is_human');
    if (!handoff?.is_human) return;
    const current = await getConversationStatus(userId, phone);
    if (current !== CONVERSATION_STATUSES.IN_PROGRESS && current !== CONVERSATION_STATUSES.RESOLVED) {
      await updateConversationStatus(userId, phone, CONVERSATION_STATUSES.IN_PROGRESS, 'agent_first_message');
    }
  } catch {}
}

// List archived conversations for a user (paginated)
async function listArchivedContacts(userId, { page = 1, pageSize = 20 } = {}) {
  try {
    // Get archived contact ids for this user
    const rows = await Handoff.find({ user_id: userId, is_archived: true, $or: [ { deleted_at: { $exists: false } }, { deleted_at: null } ] }).select('contact_id');
    const archivedIds = rows.map(r => String(r.contact_id)).filter(Boolean);
    if (!archivedIds.length) return [];

    // Aggregate last message per archived contact
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
    return contacts.map(c => ({ ...c, contact: cleanContactId(c.contact) }));
  } catch (e) {
    console.error('Archived list error:', e);
    return [];
  }
}

export default function registerInboxRoutes(app) {
  app.get("/inbox", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const q = (req.query.q || "").toString().trim();
    const messageType = (req.query.type || "").toString().trim();
    const direction = (req.query.direction || "").toString().trim();
    const dateFrom = (req.query.date_from || "").toString().trim();
    const dateTo = (req.query.date_to || "").toString().trim();
    const showArchived = ['1','true','yes'].includes(String(req.query.archived||'').toLowerCase());
    
    // Enhanced search logic
    let contacts;
    if (!showArchived && (q || messageType || direction || dateFrom || dateTo)) {
      // Advanced search with message content filtering
      contacts = await performAdvancedSearch(userId, { q, messageType, direction, dateFrom, dateTo });
    } else {
      // Regular contact list
      const page = Math.max(1, parseInt(req.query.page||'1', 10) || 1);
      const pageSize = Math.min(50, Math.max(10, parseInt(req.query.page_size||'20', 10) || 20));
      contacts = showArchived
        ? await listArchivedContacts(userId, { page, pageSize })
        : await listContactsForUser(userId, { page, pageSize });
    }
    const email = await getSignedInEmail(req);
    // Plan gating: only upgraded users can reply/react
    const plan = await getUserPlan(userId);
    const isUpgraded = (plan?.plan_name || 'free') !== 'free';

    // Ensure archived conversations are excluded from the default inbox list
    if (!showArchived) {
      try {
        const archivedRows = await Handoff.find({ user_id: userId, is_archived: true }).select('contact_id');
        const archivedSet = new Set(archivedRows.map(r => String(r.contact_id)));
        contacts = (contacts||[]).filter(c => !archivedSet.has(String(c.contact)));
      } catch(_) { }
    }

    // ETag for inbox list: derive from userId + view + top contact timestamps
    try {
      const viewKey = ['1','true','yes'].includes(String(req.query.archived||'').toLowerCase()) ? 'archived' : 'inbox';
      const etagBase = `${viewKey}:${contacts.length}:${contacts.slice(0, 50).map(c => `${c.contact}:${c.last_ts||0}`).join('|')}`;
      const etag = 'W/"'+Buffer.from(etagBase).toString('base64').slice(0, 32)+'"';
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('ETag', etag);
    } catch {}
    const customers = await Customer.find({ user_id: userId }).select('contact_id display_name');
    const customerNameByContact = new Map(customers.map(r => [String(r.contact_id), r.display_name]));
    const lastSeenRows = await Handoff.find({ user_id: userId }).select('contact_id last_seen_ts');
    const lastSeenByContact = new Map(lastSeenRows.map(r => [String(r.contact_id), Number(r.last_seen_ts || 0)]));
    // Compute unread inbound counts per contact (since last seen)
    const unreadCounts = new Map();
    try {
      await Promise.all((contacts||[]).slice(0, 50).map(async (c) => {
        try {
          const contactId = String(c.contact||'');
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
          unreadCounts.set(contactId, Number(cnt||0));
        } catch(_){ }
      }));
    } catch(_){ }
    
    // Get conversation statuses
    const statusRows = await Handoff.find({ user_id: userId }).select('contact_id conversation_status');
    const statusByContact = new Map(statusRows.map(r => [String(r.contact_id), r.conversation_status || CONVERSATION_STATUSES.NEW]));
    // Get escalations and check if support has handled them
    const escalationRows = await Handoff.find({ 
      user_id: userId, 
      escalation_reason: { $exists: true, $ne: null } 
    }).select('contact_id escalation_reason updatedAt is_human human_expires_ts');
    
    const escalationByContact = new Map();
    const now = Math.floor(Date.now()/1000);
    
    escalationRows.forEach(row => {
      const contactId = String(row.contact_id);
      const escalationTs = Number(row.updatedAt || 0);
      const isHuman = Number(row.is_human || 0);
      const humanExpiresTs = Number(row.human_expires_ts || 0);
      
      // Check if human mode is still active (not expired and not manually turned off)
      const isHumanModeActive = isHuman && humanExpiresTs > now;
      
      // Only show live chip if human mode is still active (escalation not handled yet)
      // If human mode is off or expired, the escalation has been handled
      if (isHumanModeActive) {
        escalationByContact.set(contactId, row.escalation_reason);
      }
    });
    const list = contacts.map(c => {
      const lastTs = Number(c.last_ts||0);
      const ts = formatTimestampForDisplay(lastTs);
      const preview = (c.last_text || "").slice(0, 60).replace(/</g,'&lt;');
      const initials = String(c.contact||'').slice(-2);
      const displayDefault = c.contact ? `+${String(c.contact).replace(/^\+/, '')}` : '';
      const displayName = customerNameByContact.get(String(c.contact)) || displayDefault;
      const seenTs = lastSeenByContact.get(String(c.contact)) || 0;
      const hasNew = lastTs > seenTs;
      const hasEscalation = escalationByContact.has(String(c.contact));
      const unreadCount = unreadCounts.get(String(c.contact)) || 0;
      const conversationStatus = statusByContact.get(String(c.contact)) || CONVERSATION_STATUSES.NEW;
      const statusDisplay = STATUS_DISPLAY_NAMES[conversationStatus];
      const statusColor = STATUS_COLORS[conversationStatus];
          const dropdownId = `menu_${c.contact}`;
          const menu = `
        <div class="dropdown" style="position:relative; overflow:visible;">
          <button type="button" class="btn-ghost" style="position:relative; z-index:10000;" onclick="return toggleMenu('${dropdownId}', event)">
            <img src="/menu-icon.svg" alt="Menu" style="width:20px;height:20px;vertical-align:middle;border:none;"/>
          </button>
          <div id="${dropdownId}" class="dropdown-menu" style="position:absolute; right:0; top:36px; background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:6px; min-width:180px; display:none; box-shadow:0 10px 30px rgba(0,0,0,0.18); z-index:10001;" onclick="event.stopPropagation()">
            ${showArchived ? `
            <form method=\"post\" action=\"/inbox/${encodeURIComponent(c.contact)}/unarchive\" onsubmit=\"event.preventDefault(); if (window.checkAuthThenSubmit) { checkAuthThenSubmit(this).then(valid => { if (valid) this.submit(); }); } else { this.submit(); } return false;\" style=\"margin:0;\">
              <button type="submit" class="btn-ghost btn-full" style="display:flex; align-items:center; gap:8px; justify-content:flex-start;">
                <img src="/archive-icon.svg" alt="Unarchive"/> Unarchive
              </button>
            </form>` : `
            <form method=\"post\" action=\"/inbox/${encodeURIComponent(c.contact)}/archive\" onsubmit=\"event.preventDefault(); if (window.checkAuthThenSubmit) { checkAuthThenSubmit(this).then(valid => { if (valid) this.submit(); }); } else { this.submit(); } return false;\" style=\"margin:0;\">
              <button type="submit" class="btn-ghost btn-full" style="display:flex; align-items:center; gap:8px; justify-content:flex-start;">
                <img src="/archive-icon.svg" alt="Archive"/> Archive
              </button>
            </form>`}
            <form method=\"post\" action=\"/inbox/${encodeURIComponent(c.contact)}/clear\" onsubmit=\"event.preventDefault(); if (window.checkAuthThenSubmit) { checkAuthThenSubmit(this).then(valid => { if (valid) this.submit(); }); } else { this.submit(); } return false;\" style=\"margin:0;\">
              <button type="submit" class="btn-ghost btn-full" style="display:flex; align-items:center; gap:8px; justify-content:flex-start;">
                <img src="/clear-icon.svg" alt="Clear"/> Clear
              </button>
            </form>
            <form method=\"post\" action=\"/inbox/${encodeURIComponent(c.contact)}/delete\" onsubmit=\"event.preventDefault(); if (window.checkAuthThenSubmit) { checkAuthThenSubmit(this).then(valid => { if (valid) this.submit(); }); } else { this.submit(); } return false;\" style=\"margin:0;\">
              <button type="submit" class="btn-ghost btn-full" style="display:flex; align-items:center; gap:8px; justify-content:flex-start; color:#c00;">
                <img src="/delete-icon.svg" alt="Delete"/> Delete
              </button>
            </form>
            <form method=\"post\" action=\"/inbox/${encodeURIComponent(c.contact)}/block24h\" onsubmit=\"event.preventDefault(); if (window.checkAuthThenSubmit) { checkAuthThenSubmit(this).then(valid => { if (valid) this.submit(); }); } else { this.submit(); } return false;\" style=\"margin:0;\">
              <button type="submit" class="btn-ghost btn-full" style="display:flex; align-items:center; gap:8px; justify-content:flex-start;">
                ⛔ Block
              </button>
            </form>
          </div>
        </div>
      `;
      return `
        <li class="inbox-item">
          <a href="/inbox/${encodeURIComponent(c.contact)}">
            <div class="wa-row">
              <div class="wa-avatar">${initials}</div>
              <div class="wa-col">
                <div class="wa-name">
                  ${displayName}
                  ${unreadCount > 0 ? `<span class="badge-count" style="display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;background:#22c55e;color:#fff;border-radius:999px;font-size:10px;font-weight:600;vertical-align:middle;">${unreadCount>99?'99+':unreadCount}</span>` : (hasNew ? '<span class="badge-dot"></span>' : '')}
                  ${hasEscalation ? '<span class="live-chip">live</span>' : ''}
                  ${hasEscalation ? '<span class="escalation-chip">Agent Escalation</span>' : ''}
                  <span class="status-chip" style="background-color: ${statusColor}; color: white; font-size: 10px; padding: 2px 6px; border-radius: 10px; margin-left: 6px;">${statusDisplay}</span>
                </div>
                <div class="wa-top">
                  <div class="item-preview small">${preview}</div>
                  <div style="display:flex; align-items:center; gap:8px;">
                    <div class="item-ts small">${ts}</div>
                    <div class="dropdown-icon">
                      ${menu}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </a>
        </li>
      `;
    }).join("");
    
    // Add search results count
    const searchResultsCount = (q || messageType || direction || dateFrom || dateTo) ? 
      `<div class="search-result-count">Found ${contacts.length} conversation${contacts.length !== 1 ? 's' : ''} matching your search criteria</div>` : '';
    
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html>${getProfessionalHead('Inbox')}<body>
        <!-- Loading Overlay -->
        <div id="loadingOverlay" class="loading-overlay">
          <div class="loading-container">
            <div class="loading-spinner"></div>
            <div class="loading-text">Loading conversations...</div>
            <div class="loading-progress">
              <div class="loading-progress-bar"></div>
            </div>
            <div class="loading-dots">
              <div class="loading-dot"></div>
              <div class="loading-dot"></div>
              <div class="loading-dot"></div>
            </div>
          </div>
        </div>
        
        <script src="/toast.js"></script>
        <script src="/auth-utils.js"></script>
        <script>
          // WhatsApp token check and modal
          async function checkWaTokenAndPrompt(){
            try{
              const r = await fetch('/api/settings/wa-token/status', { credentials: 'include' });
              const j = await r.json();
              if (j.status === 'invalid' || j.status === 'missing') {
                openWaTokenModal(j.status);
              }
            }catch(_){ }
          }

          function openWaTokenModal(state){
            var m = document.getElementById('waTokenModal');
            if(!m) return; m.style.display='flex';
            var msg = document.getElementById('waTokenMsg');
            if(msg){
              msg.textContent = state === 'missing' ? 'Your WhatsApp configuration is incomplete. Please add a valid token.' : 'Your WhatsApp token appears to be invalid or expired. Please enter a new token.';
            }
          }
          function closeWaTokenModal(){
            var m = document.getElementById('waTokenModal');
            if(m) m.style.display='none';
          }
          async function saveWaToken(){
            var input = document.getElementById('waTokenInput');
            var btn = document.getElementById('waTokenSave');
            if(!input || !input.value.trim()) return;
            btn.disabled = true;
            try{
              const resp = await fetch('/api/settings/wa-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ whatsapp_token: input.value.trim() })
              });
              const data = await resp.json();
              if (!resp.ok || !data.success) {
                alert(data?.error || 'Failed to update token');
                btn.disabled = false; return;
              }
              closeWaTokenModal();
              // Soft reload the page to refresh settings and media access
              location.reload();
            }catch(e){ btn.disabled=false; alert('Error: ' + (e?.message||e)); }
          }
          // Loading management
          let loadingComplete = false;
          let pageReady = false;
          
          function hideLoading() {
            if (loadingComplete) return;
            loadingComplete = true;
            
            const overlay = document.getElementById('loadingOverlay');
            if (overlay) {
              overlay.classList.add('hidden');
              setTimeout(() => {
                overlay.style.display = 'none';
              }, 300);
            }
          }
          
          function showPageContent() {
            pageReady = true;
            
            // Ensure loading is hidden after a minimum time
            setTimeout(() => {
              hideLoading();
              // Add loaded class to page transition elements
              const pageElements = document.querySelectorAll('.page-transition');
              pageElements.forEach(el => el.classList.add('loaded'));
            }, 500);
          }
          
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{ 
              const r=await fetch('/auth/status',{credentials:'include'}); 
              const j=await r.json(); 
              if(!j.signedIn){ 
                window.location='/auth'; 
                return; 
              } 
            }catch(e){ 
              window.location='/auth'; 
            }
            
            // Auth check complete, show content
            showPageContent();
            // After showing content, check token health and prompt if needed
            setTimeout(checkWaTokenAndPrompt, 150);
          })();
          
          // Fallback: hide loading after maximum time
          setTimeout(() => {
            if (!loadingComplete) {
              hideLoading();
              // Add loaded class to page transition elements
              const pageElements = document.querySelectorAll('.page-transition');
              pageElements.forEach(el => el.classList.add('loaded'));
            }
          }, 3000);
        </script>
        <div class="container page-transition">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / Inbox`, email)}
          <div class="layout">
            ${renderSidebar('inbox')}
            <main class="main">
              <div class="main-content">
                <div class="search-container">
                  <form method="get" action="/inbox" class="search-form">
                  <div class="search-input-group">
                    <input class="search-input" type="text" name="q" placeholder='Search conversations...' value="${q}"/>
                    <button type="submit" class="search-btn">
                      <img src="/search-icon.svg" alt="Search" width="20" height="20">
                    </button>
                  </div>
                  <div class="search-filters" id="searchFilters" style="display: none;">
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
                      <button type="button" onclick="clearFilters()" class="btn-ghost">Clear</button>
                      <button type="submit" class="btn-primary">Search</button>
                    </div>
                  </div>
                  <div class="search-actions">
                    <button type="button" onclick="toggleSearchFilters()" class="filter-toggle-btn">
                      <img src="/filter-icon.svg" alt="Filter" width="20" height="20">
                    </button>

                    ${showArchived ? `
                      <a href="/inbox" class="btn-ghost" title="Back to Inbox" style="display:inline-flex;align-items:center;gap:6px;">
                        <img src="/inbox-icon.svg" alt="Inbox" width="18" height="18"> Inbox
                      </a>
                    ` : `
                      <a href="/inbox?archived=1" class="btn-ghost" title="View Archived" style="display:inline-flex;align-items:center;gap:6px;">
                        <img src="/archive-icon.svg" alt="Archived" width="18" height="18"> 
                      </a>
                    `}
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
                      <button type="button" class="btn-ghost" onclick="closeNameModal()">Cancel</button>
                      <button type="submit" class="btn-primary">Save</button>
                    </div>
                  </form>
                  
                  
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
                      <button type="button" class="btn-ghost" onclick="closeWaTokenModal()">Cancel</button>
                      <button type="button" id="waTokenSave" class="btn-primary" onclick="saveWaToken()">Save Token</button>
                    </div>
                  </div>
                </div>
              </div>
              <script>
                function openNameModal(contactId){
                  var f = document.getElementById('nameForm');
                  if (f) f.action = '/inbox/' + encodeURIComponent(contactId) + '/nameCustomer';
                  var m = document.getElementById('nameModal');
                  if (m){ m.style.display = 'flex'; }
                }
                function closeNameModal(){
                  var m = document.getElementById('nameModal');
                  if (m){ m.style.display = 'none'; }
                }
                function openImageModal(){
                  var m = document.getElementById('imageModal');
                  if (m){ m.style.display = 'flex'; }
                }
                function closeImageModal(){
                  var m = document.getElementById('imageModal');
                  if (m){ m.style.display = 'none'; }
                }
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
                  document.querySelector('input[name="date_from"]').value = '';
                  document.querySelector('input[name="date_to"]').value = '';
                }
                
                // Search history functionality
                function saveSearchHistory(query) {
                  if (!query.trim()) return;
                  
                  let history = JSON.parse(localStorage.getItem('searchHistory') || '[]');
                  // Remove if already exists
                  history = history.filter(item => item !== query);
                  // Add to beginning
                  history.unshift(query);
                  // Keep only last 10 searches
                  history = history.slice(0, 10);
                  localStorage.setItem('searchHistory', JSON.stringify(history));
                }
                
                function loadSearchHistory() {
                  const history = JSON.parse(localStorage.getItem('searchHistory') || '[]');
                  return history;
                }
                
                function showSearchSuggestions() {
                  const history = loadSearchHistory();
                  if (history.length === 0) return;
                  
                  const input = document.querySelector('input[name="q"]');
                  const container = document.querySelector('.search-container');
                  
                  // Remove existing suggestions
                  const existingSuggestions = document.querySelector('.search-suggestions');
                  if (existingSuggestions) existingSuggestions.remove();
                  
                  if (input.value.trim() === '') {
                    const suggestionsDiv = document.createElement('div');
                    suggestionsDiv.className = 'search-suggestions';
                    
                    let suggestionsHtml = '<div class="suggestions-header">Recent Searches</div>';
                    history.forEach(item => {
                      const escapedItem = item.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                      suggestionsHtml += '<div class="suggestion-item" onclick="selectSuggestion(\'' + escapedItem + '\')">' + item + '</div>';
                    });
                    
                    suggestionsDiv.innerHTML = suggestionsHtml;
                    container.appendChild(suggestionsDiv);
                  }
                }
                
                function selectSuggestion(query) {
                  document.querySelector('input[name="q"]').value = query;
                  hideSearchSuggestions();
                }
                
                function hideSearchSuggestions() {
                  const suggestions = document.querySelector('.search-suggestions');
                  if (suggestions) suggestions.remove();
                }
                
                // Add event listeners for search history
                document.addEventListener('DOMContentLoaded', function() {
                  const searchInput = document.querySelector('input[name="q"]');
                  const searchForm = document.querySelector('.search-form');
                  
                  if (searchInput) {
                    searchInput.addEventListener('focus', showSearchSuggestions);
                    searchInput.addEventListener('blur', function() {
                      setTimeout(hideSearchSuggestions, 200);
                    });
                    searchInput.addEventListener('input', function() {
                      if (this.value.trim() === '') {
                        showSearchSuggestions();
                      } else {
                        hideSearchSuggestions();
                      }
                    });
                  }
                  
                  if (searchForm) {
                    searchForm.addEventListener('submit', function() {
                      const query = searchInput.value.trim();
                      if (query) {
                        saveSearchHistory(query);
                      }
                    });
                  }
                });
                function switchImageTab(tab){
                  var urlTab = document.getElementById('urlTab');
                  var uploadTab = document.getElementById('uploadTab');
                  var urlForm = document.getElementById('imageUrlForm');
                  var uploadForm = document.getElementById('imageUploadForm');
                  
                  if(tab === 'url'){
                    urlTab.style.background = 'var(--surface)';
                    uploadTab.style.background = '#f0f0f0';
                    urlForm.style.display = 'grid';
                    uploadForm.style.display = 'none';
                  } else {
                    urlTab.style.background = '#f0f0f0';
                    uploadTab.style.background = 'var(--surface)';
                    urlForm.style.display = 'none';
                    uploadForm.style.display = 'grid';
                  }
                }
                document.addEventListener('keydown', function(e){
                  if(e.key==='Escape'){ closeNameModal(); closeImageModal(); }
                });
              </script>
              <script>
                function toggleMenu(id, evt){
                  if(evt){ try{ evt.preventDefault(); evt.stopPropagation(); }catch(_){} }
                  try{
                    document.querySelectorAll('.dropdown-menu').forEach(el=>{ if(el.id!==id){ el.style.display='none'; if(el.__portal){ try{el.__portal.remove()}catch{}; el.__portal=null; } } });
                    const origin = document.getElementById(id);
                    if(!origin) return false;
                    // Portal clone attached to body to defeat clipping
                    if(!origin.__portal){
                      const rect = (evt && (evt.currentTarget||evt.target).getBoundingClientRect()) || origin.getBoundingClientRect();
                      const portal = origin.cloneNode(true);
                      portal.id = id + '_p';
                      portal.style.position = 'fixed';
                      portal.style.left = Math.max(8, rect.right - 180) + 'px';
                      portal.style.top = (rect.bottom + 8) + 'px';
                      portal.style.display = 'block';
                      portal.style.zIndex = 100000;
                      portal.onclick = function(e){ e.stopPropagation(); };
                      document.body.appendChild(portal);
                      origin.style.display='none';
                      origin.__portal = portal;
                      window.addEventListener('click', function onClose(){
                        if(origin.__portal){ try{ origin.__portal.remove(); }catch{} origin.__portal=null; }
                        window.removeEventListener('click', onClose);
                      });
                    } else {
                      try{ origin.__portal.remove(); }catch{} origin.__portal=null;
                    }
                  }catch(_){ }
                  return false;
                }
                document.addEventListener('click', function(){
                  document.querySelectorAll('.dropdown-menu').forEach(el=>{ el.style.display='none'; });
                });
              </script>
                <ul class="list card">${searchResultsCount}${list || `
                  <div class="empty-state" style="text-align:center; padding:60px 20px; color:#666;">
                    <h3 style="margin:0 0 12px 0; color:#333; font-size:20px; font-weight:500;">No conversations yet</h3>
                    <p style="margin:0 0 24px 0; font-size:14px; line-height:1.5; max-width:400px; margin-left:auto; margin-right:auto;">
                      Your WhatsApp conversations will appear here once customers start messaging your business number.
                    </p>
                    <div style="background:#f8f9fa; border-radius:12px; padding:20px; margin:0 auto; max-width:400px; border:1px solid #e9ecef;">
                      <div style="font-size:13px; color:#666; margin-bottom:12px; font-weight:500;">💡 Getting Started:</div>
                      <ul style="text-align:left; font-size:13px; color:#666; margin:0; padding-left:20px; line-height:1.6;">
                        <li>Share your WhatsApp Business number with customers</li>
                        <li>Customers can start conversations by sending any message</li>
                        <li>AI will automatically respond and manage conversations</li>
                        <li>You can take over anytime for human support</li>
                      </ul>
                    </div>
                  </div>
                `}</ul>
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  // Advanced search API endpoint
  app.get("/api/search", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const q = (req.query.q || "").toString().trim();
    const messageType = (req.query.type || "").toString().trim();
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

  // Search results page
  app.get("/search", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const q = (req.query.q || "").toString().trim();
    const messageType = (req.query.type || "").toString().trim();
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
    
    // Render search results
    const resultsHtml = searchResults.messages.map(msg => {
      const contactName = msg.contact_name || `+${msg.contact.replace(/^\+/, '')}`;
      const directionIcon = msg.direction === 'inbound' ? '←' : '→';
      const typeIcon = msg.type === 'image' ? '🖼️' : msg.type === 'document' ? '📄' : msg.type === 'interactive' ? '🔘' : '💬';
      
      // Highlight search terms in text
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
        ${page > 1 ? `<a href="/search?${new URLSearchParams({...req.query, page: page - 1})}" class="btn-ghost">← Previous</a>` : ''}
        <span class="pagination-info">Page ${page} of ${Math.ceil(searchResults.total / limit)}</span>
        ${searchResults.hasMore ? `<a href="/search?${new URLSearchParams({...req.query, page: page + 1})}" class="btn-ghost">Next →</a>` : ''}
      </div>
    ` : '';
    
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>Code Orbit - Search Results</title><link rel="stylesheet" href="/styles.css"></head>
      <body>
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return; } }catch(e){ window.location='/auth'; }
          })();
        </script>
        <div class="container">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / <a href="/inbox">Inbox</a> / Search Results`, email)}
          <div class="layout">
            ${renderSidebar('inbox')}
            <main class="main">
              <div class="search-container">
                <form method="get" action="/search" class="search-form">
                  <div class="search-input-group">
                    <input class="search-input" type="text" name="q" placeholder='Search messages...' value="${q}"/>
                    <button type="submit" class="search-btn">
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
                      <button type="button" onclick="clearFilters()" class="btn-ghost">Clear</button>
                      <button type="submit" class="btn-primary">Search</button>
                    </div>
                  </div>
                  <button type="button" onclick="toggleSearchFilters()" class="filter-toggle-btn">
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

  app.get("/inbox/:phone", ensureAuthed, async (req, res) => {
    const phone = req.params.phone.split('?')[0]; // Remove any query parameters from phone
    const userId = getCurrentUserId(req);
    const phoneDigits = normalizePhone(phone);
    // Mark as seen (Mongo)
    try {
      const nowSec = Math.floor(Date.now()/1000);
      await Handoff.findOneAndUpdate(
        { contact_id: phone, user_id: userId },
        { $set: { last_seen_ts: nowSec, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch {}
    const cust = await Customer.findOne({ user_id: userId, contact_id: phone }).select('display_name');
    const headerName = cust?.display_name || ('+' + String(phone).replace(/^\+/, ''));
    // Fetch richer message data using Mongo aggregation
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
    // Hide system clear markers from the chat view
    try { msgs = msgs.filter(m => m?.type !== 'system_clear'); } catch {}
    
    // Load reactions and replies for all messages
    const messageIds = msgs.map(m => m.id);
    const reactionsByMessage = await getMessagesReactions(messageIds);
    const userReactionsByMessage = await getUserReactionsForMessages(messageIds, userId);
    const repliesByMessage = await getMessagesReplies(messageIds);
    const replyOriginals = await getReplyOriginals(messageIds);
    const status = await Handoff.findOne({ contact_id: phone, user_id: userId }).select('is_human human_expires_ts');
    let isHuman = !!status?.is_human;
    const expTs = Number(status?.human_expires_ts || 0);
    const nowSec = Math.floor(Date.now()/1000);
    const remain = expTs > nowSec ? (expTs - nowSec) : 0;
    // Normalize expired human mode back to AI by default
    if (isHuman && remain <= 0) {
      isHuman = false;
      try { await Handoff.findOneAndUpdate({ contact_id: phone, user_id: userId }, { $set: { is_human: false, human_expires_ts: 0, updatedAt: new Date() } }, { upsert: true }); } catch {}
    }
    
    // Get conversation status
    const conversationStatus = await getConversationStatus(userId, phone);
    const statusKey = conversationStatus || 'new';
    const statusDisplay = STATUS_DISPLAY_NAMES[statusKey] || 'New';
    const statusColor = STATUS_COLORS[statusKey] || STATUS_COLORS['new'];
    
    const email = await getSignedInEmail(req);
    const quickReplies = await getQuickReplies(userId);
    // ETag for thread: hash of last message id + count
    try {
      const etagBase = `${userId}:${phone}:${msgs.length}:${msgs[msgs.length-1]?.id||''}`;
      const etag = 'W/"'+Buffer.from(etagBase).toString('base64').slice(0, 32)+'"';
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.setHeader('ETag', etag);
    } catch {}

    // Plan gating: only upgraded users can reply/react
    let isUpgraded = false;
    try {
      const plan = await getUserPlan(userId);
      isUpgraded = (plan?.plan_name || 'free') !== 'free';
    } catch {}

    const items = msgs.map(m => {
      const cls = m.direction === 'inbound' ? 'msg msg-in' : 'msg msg-out';
      let display = String(m.text_body || '').trim();
      // For non-text messages, derive a readable label from raw payload
      // Also handle cases where text_body contains placeholder text like '[image]'
      if (!display || display === '[image]' || display === '[document]' || display === '[audio]' || display === '[video]' || (m.type && m.type !== 'text')) {
        // Raw can be stored as an object (Mongo) or as a JSON string (legacy)
        let raw = {};
        if (m && typeof m.raw === 'object' && m.raw !== null) {
          raw = m.raw;
        } else {
          try { raw = JSON.parse(m.raw || '{}'); } catch { raw = {}; }
        }
        if (m.type === 'interactive') {
          const br = raw?.interactive?.button_reply;
          const lr = raw?.interactive?.list_reply;
          const bodyText = raw?.interactive?.body?.text;
          if (br?.title) display = br.title;
          else if (lr?.title) display = lr.title;
          else if (bodyText) display = bodyText;
          else display = '[interactive]';
        } else if (m.type === 'document') {
          // Handle both inbound (raw.document.link) and outbound (raw.documentUrl) document formats
          let documentUrl = raw?.document?.link || raw?.documentUrl;
          const filename = raw?.document?.filename || raw?.filename || 'Document';
          
          if (documentUrl) {
            // Fix localhost URLs to use current request's host
            if (documentUrl.includes('localhost:3000')) {
              const host = req.get('host');
              const protocol = req.protocol;
              documentUrl = documentUrl.replace(/https?:\/\/localhost:3000/, `${protocol}://${host}`);
            }
            
            // Get file extension for icon
            const fileExtension = filename.split('.').pop()?.toUpperCase() || 'DOC';
            
            display = `
              <div class="document-message" style="margin:8px 0; background:#f0f0f0; border-radius:8px; padding:12px; max-width:250px; cursor:pointer;" onclick="window.open('${escapeHtml(documentUrl)}', '_blank')">
                <div style="display:flex; align-items:center; gap:12px;">
                  <div style="width:40px; height:40px; background:#25d366; border-radius:6px; display:flex; align-items:center; justify-content:center; color:white; font-weight:bold; font-size:12px; flex-shrink:0;">
                    ${fileExtension}
                  </div>
                  <div style="flex:1; min-width:0;">
                    <div style="font-weight:500; color:#111b21; font-size:14px; margin-bottom:2px; word-break:break-word;">${escapeHtml(filename)}</div>
                    <div style="font-size:12px; color:#667781;">Tap to download</div>
                  </div>
                  <div style="color:#25d366; font-size:16px;">📥</div>
                </div>
              </div>
            `;
          } else {
            display = `[document] ${escapeHtml(filename)}`;
          }
        } else if (m.type === 'image') {
          // Handle both inbound (raw.image.link) and outbound (raw.imageUrl) image formats.
          // For inbound images without direct link, construct secure proxy via media id.
          let imageUrl = raw?.image?.link || raw?.imageUrl;
          if (!imageUrl && raw?.image?.id) {
            imageUrl = `/wa-media/${encodeURIComponent(String(userId))}/${encodeURIComponent(String(raw.image.id))}`;
          }
          if (imageUrl) {
            // Fix localhost URLs to use current request's host
            if (imageUrl.includes('localhost:3000')) {
              const host = req.get('host');
              const protocol = req.protocol;
              imageUrl = imageUrl.replace(/https?:\/\/localhost:3000/, `${protocol}://${host}`);
            }
            display = `<div style="margin:8px 0;"><img src="${escapeHtml(imageUrl)}" style="max-width:200px; max-height:200px; border-radius:8px; object-fit:cover; cursor:pointer;" alt="Image" onclick="window.open('${escapeHtml(imageUrl)}', '_blank')" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"/><div style="display:none; padding:8px; background:#f0f0f0; border-radius:8px; font-size:12px; color:#666;">[Image failed to load]</div></div>`;
          } else {
            display = '[image]';
          }
        } else if (m.type === 'audio') {
          display = '[audio]';
        } else if (m.type === 'video') {
          display = '[video]';
        } else if (m.type) {
          display = `[${m.type}]`;
        }
      }
      // Only escape HTML if the display doesn't contain HTML tags (like images)
      const safe = display.includes('<img') || display.includes('<div') ? display : escapeHtml(display).replace(/\n/g, '<br/>');
      const ts = formatTimestampForDisplay(m.ts||0);
      
      // Generate WhatsApp-style status ticks for outbound messages
      let statusTicks = '';
      if (m.direction === 'outbound') {
        // Use delivery/read status directly from message document
        const deliveryStatus = m.delivery_status || MESSAGE_STATUS.SENT;
        const readStatus = m.read_status || READ_STATUS.UNREAD;
        
        // Determine final status (read overrides delivered)
        let finalStatus = deliveryStatus;
        if (readStatus === READ_STATUS.READ) {
          finalStatus = MESSAGE_STATUS.READ;
        }
        
        // Generate ticks HTML
        if (finalStatus === MESSAGE_STATUS.FAILED) {
          // Show red exclamation mark for failed messages with retry button
          statusTicks = `
            <div class="message-status-ticks message-status-failed">
              <div class="message-failed-indicator" title="Message failed to send">
                <span class="failed-icon">!</span>
                <button class="retry-button" data-message-id="${m.id}" onclick="retryMessage('${m.id}')" title="Retry sending message">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                    <path d="M21 3v5h-5"/>
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                    <path d="M3 21v-5h5"/>
                  </svg>
                </button>
              </div>
            </div>
          `;
        } else {
          // Show normal ticks for other statuses
          statusTicks = `
            <div class="message-status-ticks message-status-${finalStatus}">
              <div class="message-tick"></div>
              <div class="message-tick"></div>
            </div>
          `;
        }
      }
      
      // Get reactions for this message
      const messageReactions = reactionsByMessage[m.id] || [];
      const userReactions = userReactionsByMessage[m.id] || [];
      
      // Get original message if this is a reply
      const originalMessage = replyOriginals[m.id];
      
      // Render original message preview if this is a reply
      let originalMessageHtml = '';
      if (originalMessage) {
        const originalText = originalMessage.text_body || '[Media]';
        const truncatedText = originalText.length > 40 ? originalText.substring(0, 40) + '...' : originalText;
        const authorName = originalMessage.direction === 'inbound' ? 'Customer' : 'You';
        originalMessageHtml = `
          <div class="reply-preview" onclick="scrollToMessage('${originalMessage.original_message_id}')">
            <div class="reply-preview-content">
              <div class="reply-preview-author">${authorName}</div>
              <div class="reply-preview-text">${escapeHtml(truncatedText)}</div>
            </div>
          </div>
        `;
      }
      
      // Render reactions
      let reactionsHtml = '';
      if (messageReactions.length > 0) {
        reactionsHtml = '<div class="message-reactions">';
        messageReactions.forEach(reaction => {
          const isUserReaction = userReactions.includes(reaction.emoji);
          const reactionClass = isUserReaction ? 'user-reaction' : 'customer-reaction';
          const allowClick = isUserReaction && isUpgraded;
          const clickHandler = allowClick ? `onclick="toggleReaction('${m.id}', '${reaction.emoji}')"` : '';
          const cursorStyle = allowClick ? 'cursor: pointer;' : 'cursor: default;';
          const title = isUserReaction ? 'Click to remove your reaction' : 'Customer reaction';
          reactionsHtml += `<span class="reaction ${reactionClass}" data-message-id="${m.id}" data-emoji="${reaction.emoji}" ${clickHandler} style="${cursorStyle}" title="${title}">${reaction.emoji}<span class="reaction-count">${reaction.count}</span></span>`;
        });
        reactionsHtml += '</div>';
      }
      
      // Add action buttons inside the bubble
      const actionButtons = isUpgraded ? `
        <div class="message-actions">
          <button class="action-btn reply-btn" onclick="replyToMessage('${m.id}')" title="Reply to this message">↩️</button>
          <button class="action-btn reaction-btn" onclick="showReactionPicker('${m.id}')" title="Add reaction">+</button>
        </div>
      ` : '';
      
      return `<div class="${cls} message-container" id="message-${m.id}" data-message-id="${m.id}">${originalMessageHtml}<div class="bubble">${safe}<div class="meta">${ts}${statusTicks}</div>${reactionsHtml}${actionButtons}</div></div>`;
    }).join("");
    const toastMsg = (req.query?.toast || '').toString();
    const toastType = (req.query?.type || '').toString();
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>Code Orbit - Chat +${String(phone).replace(/^\+/, '')}</title><link rel="stylesheet" href="/styles.css"></head>
        <body>
          <!-- Loading Overlay -->
          <div id="loadingOverlay" class="loading-overlay">
            <div class="loading-container">
              <div class="loading-spinner"></div>
              <div class="loading-text">Loading conversation...</div>
              <div class="loading-progress">
                <div class="loading-progress-bar"></div>
              </div>
              <div class="loading-dots">
                <div class="loading-dot"></div>
                <div class="loading-dot"></div>
                <div class="loading-dot"></div>
              </div>
            </div>
          </div>
          <script src="/toast.js"></script>
          <script src="/auth-utils.js"></script>
          <script>
            let loadingComplete = false;
            let pageReady = false;
            
            function hideLoading() {
              if (loadingComplete) return;
              loadingComplete = true;
              
              const overlay = document.getElementById('loadingOverlay');
              if (overlay) {
                overlay.classList.add('hidden');
                setTimeout(() => {
                  overlay.style.display = 'none';
                }, 300);
              }
            }
            
            function showPageContent() {
              pageReady = true;
              
              // Ensure loading is hidden after a minimum time
              setTimeout(() => {
                hideLoading();
                // Add loaded class to page transition elements
                const pageElements = document.querySelectorAll('.page-transition');
                pageElements.forEach(el => el.classList.add('loaded'));
              }, 500);
            }

            // Enhanced authentication check on page load
            (async function checkAuthOnLoad(){
              await window.authManager.checkAuthOnLoad();
              
              // Auth check complete, show content
              showPageContent();
            })();

            // Fallback: hide loading after maximum time
            setTimeout(() => {
              if (!loadingComplete) {
                hideLoading();
                // Add loaded class to page transition elements
                const pageElements = document.querySelectorAll('.page-transition');
                pageElements.forEach(el => el.classList.add('loaded'));
              }
            }, 3000);

            let realtimeManager = null;
            const phone = '${phone}'.split('?')[0]; // Clean phone number to remove query parameters
            const phoneDigits = phone.replace(/\D/g, ''); // Normalize to digits for realtime rooms/APIs
            const userId = '${userId}';
            
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
            function toggleHandoffMode() {
              const handoffBtn = document.getElementById('handoffToggleBtn');
              const isCurrentlyHuman = handoffBtn.getAttribute('data-is-human') === 'true';
              const newHumanMode = !isCurrentlyHuman;
              
              // Update UI immediately
              const img = handoffBtn.querySelector('img');
              img.src = newHumanMode ? '/raise-hand-icon.svg' : '/bot-icon.svg';
              img.alt = newHumanMode ? 'Human handling' : 'AI handling';
              handoffBtn.setAttribute('data-is-human', newHumanMode);
              
              // Update the hidden input
              const hiddenInput = handoffBtn.closest('form').querySelector('input[name="is_human"]');
              hiddenInput.value = newHumanMode ? '1' : '';
              
              // Send via real-time if available
              if (realtimeManager && realtimeManager.isConnected) {
                realtimeManager.toggleLiveMode(phoneDigits, newHumanMode);
              }
              
              // Submit the form with authentication
              const form = handoffBtn.closest('form');
              checkAuthThenSubmit(form).then(valid => {
                if (valid) {
                  form.submit();
                } else {
                  // Revert UI on auth failure
                  img.src = isCurrentlyHuman ? '/raise-hand-icon.svg' : '/bot-icon.svg';
                  img.alt = isCurrentlyHuman ? 'Human handling' : 'AI handling';
                  handoffBtn.setAttribute('data-is-human', isCurrentlyHuman);
                  hiddenInput.value = isCurrentlyHuman ? '1' : '';
                }
              });
            }
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
              const chatContainer = document.querySelector('.chat-thread');
              if (chatContainer) {
                chatContainer.scrollTop = chatContainer.scrollHeight;
                // Force a reflow to ensure scroll happens
                chatContainer.offsetHeight;
              }
            }

            function scrollToBottomAfterImages() {
              // Wait for all images to load before scrolling
              const images = document.querySelectorAll('.chat-thread img');
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
                alert('File size must be less than 100MB');
                event.target.value = '';
                return;
              }
              
              // Validate file type
              const allowedTypes = ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.zip', '.rar'];
              const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
              if (!allowedTypes.includes(fileExtension)) {
                alert('File type not supported. Please select a PDF, Word document, text file, or other supported format.');
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
              alert('Voice recording feature coming soon!');
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
                // Send text message via real-time system (no page refresh)
                const textarea = document.getElementById('messageInput');
                const message = textarea ? textarea.value.trim() : '';
                
                if (!message) {
                  if (window?.ENV?.DEBUG_LOGS === '1') console.log('No message to send');
                  return;
                }
                
                // Ensure real-time is connected (attempt quick connect if needed)
                const ensureConnected = async () => {
                  try {
                    if (!realtimeManager) return false;
                    if (realtimeManager.isConnected) return true;
                    await realtimeManager.connect();
                    realtimeManager.joinChat(phoneDigits);
                    await new Promise(r => setTimeout(r, 500));
                    return realtimeManager.isConnected;
                  } catch(_) { return false; }
                };
                
                (async () => {
                  const ok = await ensureConnected();
                  if (!ok) {
                    console.error('Real-time connection unavailable. Message not sent.');
                    alert('Connection issue: message not sent. Please try again.');
                    return;
                  }
                  if (window?.ENV?.DEBUG_LOGS === '1') console.log('📤 Sending message via real-time:', message);
                  const success = realtimeManager.sendMessage(phoneDigits, message, 'text', currentReplyToMessageId);
                  if (success) {
                    textarea.value = '';
                    clearReply();
                  } else {
                    console.error('Failed to send message via real-time');
                    alert('Failed to send message. Please try again.');
                  }
                })();
              }
              return false;
            }

            window.addEventListener('DOMContentLoaded', function() {
              setupComposer();
              
              // Setup attachment menu
              document.getElementById('attachDocumentBtn').addEventListener('click', function() {
                document.getElementById('documentFileInput').click();
                document.getElementById('attachMenu').style.display = 'none';
              });
              
              document.getElementById('attachImageBtn').addEventListener('click', function() {
                document.getElementById('imageFileInput').click();
                document.getElementById('attachMenu').style.display = 'none';
              });
              
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
              if (!dropdown) return;
              
              // Close other dropdowns
              document.querySelectorAll('.dropdown-menu').forEach(el => {
                if (el.id !== 'statusDropdown') el.style.display = 'none';
              });
              
              // Toggle status dropdown
              dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
            }
            
            function updateConversationStatus(status) {
              // Update UI immediately
              const statusChip = document.querySelector('.status-chip');
              const statusDisplay = getStatusDisplayName(status);
              const statusColor = getStatusColor(status);
              
              if (statusChip) {
                statusChip.textContent = statusDisplay;
                statusChip.style.backgroundColor = statusColor;
              }
              
              // Close dropdown
              document.getElementById('statusDropdown').style.display = 'none';
              
              // Submit status update via fetch API
              fetch('/inbox/' + phone + '/status', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: 'status=' + encodeURIComponent(status)
              })
              .then(response => {
                if (response.ok) {
                  // Show success message
                  window.location.href = '/inbox/' + phone + '?toast=' + encodeURIComponent('Status updated to ' + statusDisplay) + '&type=success';
                } else {
                  throw new Error('Status update failed');
                }
              })
              .catch(error => {
                console.error('Status update failed:', error);
                alert('Failed to update status. Please try again.');
                // Revert UI changes on error
                if (statusChip) {
                  statusChip.textContent = '${statusDisplay}';
                  statusChip.style.backgroundColor = '${statusColor}';
                }
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
              const statusButton = document.querySelector('.status-dropdown button');
              
              if (statusDropdown && statusButton && 
                  !statusDropdown.contains(e.target) && 
                  !statusButton.contains(e.target)) {
                statusDropdown.style.display = 'none';
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
          <div class="container page-transition">
            ${renderTopbar(`<a href="/dashboard">Dashboard</a> / <a href="/inbox">Inbox</a> / +${String(phone).replace(/^\+/, '')}`, email)}
            <div class="layout">
              ${renderSidebar('inbox')}
              <main class="main">
                <div class="main-content">
                  <div class="wa-chat-header">
                    <a href="/inbox" style="margin-right:20px;">
                      <img src="/left-arrow-icon.svg" alt="Back" style="width:10px;height:10px;vertical-align:middle;"/>
                    </a>
                    <div class="wa-avatar">${String(phone).slice(-2)}</div>
                      <div style="flex:1;">
                        <div class="wa-name">${headerName}</div>
                        <div class="small">
                          ${isHuman ? ('Human' + (remain ? ' • <span id="exp_remain"></span> left' : '')) : 'AI'}
                        </div>
                    </div>
                    <form method="post" action="/handoff/${phone}" onsubmit="event.preventDefault(); toggleHandoffMode(); return false;">
                      <input type="hidden" name="is_human" value="${isHuman ? '' : '1'}"/>
                      <button type="submit" class="btn-ghost handoff-toggle-btn" id="handoffToggleBtn" data-is-human="${isHuman}">
                        <img 
                          src="${isHuman ? '/raise-hand-icon.svg' : '/bot-icon.svg'}"
                          alt="${isHuman ? 'Human handling' : 'AI handling'}" 
                          style="width:26px;height:26px;vertical-align:middle;margin-right:6px; cursor:pointer;"
                        />
                      </button>
                    </form>
                    ${isHuman ? `<form method="post" action="/inbox/${phone}/renew" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                      <button type="submit" class="btn-ghost" title="Renew 5 minutes"><img src="/restart-onboarding.svg" alt="Renew" style="width:20px;height:20px;vertical-align:middle;"/></button>
                    </form>` : ''}
                    <form method="post" action="/inbox/${phone}/archive" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                      <button type="submit" class="btn-ghost"><img src="/archive-icon.svg" alt="Archive" style="width:20px;height:20px;vertical-align:middle;"/></button>
                    </form>
                    <form method="post" action="/inbox/${phone}/clear" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                      <button type="submit" class="btn-ghost"><img src="/clear-icon.svg" alt="Clear" style="width:24px;height:24px;vertical-align:middle;"/></button>
                    </form>
                    <form method="post" action="/inbox/${phone}/delete" onsubmit="event.preventDefault(); checkAuthThenSubmit(this).then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                      <button type="submit" class="btn-ghost"><img src="/delete-icon.svg" alt="Delete" style="width:20px;height:20px;vertical-align:middle;"/></button>
                    </form>
                    <!-- Conversation Status Management -->
                    <div class="status-dropdown" style="position:relative; margin-left:8px; margin-bottom:8px;">
                      <button type="button" class="btn-ghost" onclick="toggleStatusDropdown()" style="padding:4px 8px; border-radius:6px; display:flex; align-items:center; gap:4px;">
                        <span class="status-chip" style="background-color: ${statusColor}; color: white; font-size: 11px; padding: 3px 8px; border-radius: 12px;">${statusDisplay}</span>
                        <span style="font-size:12px; color:#666;">▼</span>
                      </button>
                      <div id="statusDropdown" class="status-dropdown-menu" style="position:absolute; right:0; top:32px; background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:8px; min-width:160px; display:none; box-shadow:0 6px 20px rgba(0,0,0,0.12); z-index:10;">
                        <div style="font-size:12px; color:#666; margin-bottom:6px; padding-bottom:4px; border-bottom:1px solid #eee;">Change Status</div>
                        ${Object.entries(CONVERSATION_STATUSES).map(([key, value]) => `
                          <button type="button" class="status-option ${conversationStatus === value ? 'active' : ''}" onclick="updateConversationStatus('${value}')" style="display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; border:none; background:transparent; padding:6px 8px; border-radius:4px; font-size:13px; ${conversationStatus === value ? 'background:#f0f9ff; color:#0369a1;' : ''}">
                            <span style="width:8px; height:8px; border-radius:50%; background-color: ${STATUS_COLORS[value]};"></span>
                            ${STATUS_DISPLAY_NAMES[value]}
                            ${conversationStatus === value ? '✓' : ''}
                          </button>
                        `).join('')}
                      </div>
                    </div>
                  </div>
                  ${(() => {
                    try{
                      const lastInbound = (msgs||[]).filter(x=>x.direction==='inbound').map(x=>Number(x.ts||0)).sort((a,b)=>b-a)[0]||0;
                      const over24 = lastInbound && (Math.floor(Date.now()/1000)-lastInbound) > 24*3600;
                      if (over24) {
                        return `
                          <div class="small" style="margin:8px 0; padding:8px; background:#fff8e1; border:1px solid #fde68a; border-radius:8px;">Session expired (>24h). Send template to reopen window.
                            <form method="post" action="/inbox/${phone}/send-template" data-auth-enhanced style="display:flex; gap:6px; align-items:center; margin-top:6px;">
                              <input class="settings-field" name="var1" placeholder="{{1}} (optional)" style="height:32px;"/>
                              <input class="settings-field" name="var2" placeholder="{{2}} (optional)" style="height:32px;"/>
                              <button class="btn-ghost" type="submit">Send Template</button>
                            </form>
                          </div>
                        `;
                      }
                    }catch(_){ }
                    return '';
                  })()}
                  <div class="chat-thread" style="overflow-y:auto; height:70vh; max-height:70vh;">
                    ${items || '<div class="small" style="text-align:center;padding:16px;">No messages</div>'}
                    <div>
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
                  </div>
                  <form method="post" action="/send/${phone}" onsubmit="event.preventDefault(); handleFormSubmit(event); return false;" style="margin-top: 8px;">
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
              </main>
            </div>  
          </div>
        </body>
      </html>
    `);
  });

  app.post("/handoff/:phone", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const isHuman = req.body?.is_human ? 1 : 0;
    const now = Math.floor(Date.now()/1000);
    const exp = isHuman ? (now + 5*60) : 0;
    try { await Handoff.findOneAndUpdate({ contact_id: phone, user_id: userId }, { $set: { is_human: !!isHuman, human_expires_ts: exp, updatedAt: new Date() } }, { upsert: true }); } catch {}
    res.redirect(`/inbox/${phone}`);
  });

  // Simulate message status updates (for demo purposes)
  app.post("/inbox/:phone/simulate-status", ensureAuthed, (req, res) => {
    const phone = req.params.phone.split('?')[0];
    const userId = getCurrentUserId(req);
    const { messageId, status } = req.body;
    
    try {
      if (!messageId || !status) {
        return res.status(400).json({ error: 'Missing messageId or status' });
      }
      
      // Import the simulation function
      simulateDeliveryStatusUpdate(messageId, status);
      
      // Broadcast status update to real-time clients
      const io = getIO();
      if (io) {
        io.to(`chat:${phone}`).emit('message_status_update', {
          messageId,
          status,
          timestamp: Date.now()
        });
      }
      
      res.json({ success: true, messageId, status });
    } catch (error) {
      console.error('Error simulating status update:', error);
      res.status(500).json({ error: 'Failed to update status' });
    }
  });

  // Update conversation status
  app.post("/inbox/:phone/status", ensureAuthed, async (req, res) => {
    const phone = req.params.phone.split('?')[0]; // Clean phone number
    const userId = getCurrentUserId(req);
    const { status, reason } = req.body;
    
    try {
      if (!Object.values(CONVERSATION_STATUSES).includes(status)) {
        return res.status(400).json({ error: 'Invalid conversation status' });
      }
      
      await updateConversationStatus(userId, phone, status, reason);
      
      // If resolved → request CSAT rating via WhatsApp and flag awaiting rating
      if (status === CONVERSATION_STATUSES.RESOLVED) {
        // Ensure live mode is off when conversation is resolved
        try { await Handoff.findOneAndUpdate({ contact_id: phone, user_id: userId }, { $set: { is_human: false, human_expires_ts: 0, updatedAt: new Date() } }, { upsert: true }); } catch {}
        try {
          const cfg = await getSettingsForUser(userId);
          if (cfg?.whatsapp_token && cfg?.phone_number_id) {
            // Send WhatsApp list for emoji selection
            const header = 'Rate your experience';
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
                try { await recordOutboundMessage({ messageId: outboundId, userId, cfg, to: phone, type: 'interactive', text: `${header}\n${body}`, raw: { to: phone, interactive: 'csat_list' } }); } catch {}
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
      
      // Redirect back to conversation with success message
      const statusDisplay = STATUS_DISPLAY_NAMES[status];
      res.redirect(`/inbox/${phone}`);
    } catch (error) {
      console.error('Error updating conversation status:', error);
      res.redirect(`/inbox/${phone}?toast=${encodeURIComponent('Failed to update status')}&type=error`);
    }
  });

  // Renew 5 more minutes of human mode
  app.post("/inbox/:phone/renew", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    try {
      const now = Math.floor(Date.now()/1000);
      const row = await Handoff.findOne({ contact_id: phone, user_id: userId }).select('human_expires_ts');
      const base = Number(row?.human_expires_ts || 0) > now ? Number(row?.human_expires_ts || 0) : now;
      const next = base + 5*60;
      await Handoff.findOneAndUpdate({ contact_id: phone, user_id: userId }, { $set: { is_human: true, human_expires_ts: next, updatedAt: new Date() } }, { upsert: true });
    } catch {}
    res.redirect(`/inbox/${phone}`);
  });

  // Archive a conversation (hide from inbox list)
  app.post("/inbox/:phone/archive", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    try { await Handoff.findOneAndUpdate({ contact_id: phone, user_id: userId }, { $set: { is_archived: true, updatedAt: new Date() } }, { upsert: true }); } catch {}
    res.redirect(`/inbox`);
  });

  // Unarchive a conversation (return to inbox list)
  app.post("/inbox/:phone/unarchive", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    try { await Handoff.findOneAndUpdate({ contact_id: phone, user_id: userId }, { $set: { is_archived: false, updatedAt: new Date() } }, { upsert: true }); } catch {}
    // Stay on archived view
    res.redirect(`/inbox?archived=1`);
  });

  // Opt-out a contact
  app.post("/inbox/:phone/optout", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const { Customer } = await import('../schemas/mongodb.mjs');
    try { await Customer.findOneAndUpdate({ user_id: userId, contact_id: phone }, { $set: { opted_out: true, updatedAt: new Date() } }, { upsert: true }); } catch {}
    res.redirect(`/inbox/${encodeURIComponent(phone)}`);
  });

  // Remove opt-out
  app.post("/inbox/:phone/unoptout", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const { Customer } = await import('../schemas/mongodb.mjs');
    try { await Customer.updateOne({ user_id: userId, contact_id: phone }, { $set: { opted_out: false, updatedAt: new Date() } }); } catch {}
    res.redirect(`/inbox/${encodeURIComponent(phone)}`);
  });

  // Block for 24 hours
  app.post("/inbox/:phone/block24h", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const { Customer } = await import('../schemas/mongodb.mjs');
    const until = Math.floor(Date.now()/1000) + 24*3600;
    try { await Customer.findOneAndUpdate({ user_id: userId, contact_id: phone }, { $set: { blocked_until_ts: until, updatedAt: new Date() } }, { upsert: true }); } catch {}
    res.redirect(`/inbox/${encodeURIComponent(phone)}`);
  });

  // Clear a conversation (delete messages only for this contact/user)
  app.post("/inbox/:phone/clear", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const digits = normalizePhone(phone);
    try {
      // Delete by digits; include id fallbacks (+digits or digits) for older records
      await Message.deleteMany({
        user_id: String(userId),
        $or: [
          { from_digits: digits },
          { to_digits: digits },
          { from_id: { $in: [digits, '+' + digits] } },
          { to_id: { $in: [digits, '+' + digits] } }
        ]
      });
      // Insert a lightweight system marker so the conversation remains in the inbox list
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

  // Delete a conversation (mark deleted and remove messages)
  app.post("/inbox/:phone/delete", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
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
    } catch (e) {
      console.error('Delete conversation failed:', e?.message || e);
    }
    try {
      await Handoff.findOneAndUpdate(
        { contact_id: phone, user_id: userId },
        { $set: { deleted_at: Math.floor(Date.now()/1000), updatedAt: new Date() } },
        { upsert: true }
      );
    } catch {}
    return res.redirect(`/inbox`);
  });

  app.post("/send/:phone", ensureAuthed, async (req, res) => {
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = await getSettingsForUser(userId);
    const text = (req.body?.text || "").toString().trim();
    if (!text) return res.redirect(`/inbox/${to}`);
    // Enforce 24h window: if last inbound >24h ago, attempt a template instead
    try {
      const lastInbound = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'`).get(userId, to)?.ts || 0;
      const now = Math.floor(Date.now()/1000);
      const over24h = lastInbound && (now - Number(lastInbound)) > 24*3600;
      if (over24h) {
        try {
          await sendWhatsAppTemplate(to, 'hello_world', 'en_US', [], cfg);
          // Optionally queue the freeform reply AFTER user responds to the template
          return res.redirect(`/inbox/${encodeURIComponent(to)}`);
        } catch (e) {
          console.error('Template send failed, falling back to text within 24h only:', e?.message || e);
          return res.redirect(`/inbox/${encodeURIComponent(to)}`);
        }
      }
    } catch {}
    try {
      // Get the original message ID if this is a reply
      let originalMessageId = null;
      const replyTo = req.body?.replyTo;
      if (replyTo) {
        // Get the WhatsApp message ID from the original message
        const originalMessage = db.prepare(`SELECT id FROM messages WHERE id = ? AND user_id = ?`).get(replyTo, userId);
        originalMessageId = originalMessage?.id;
      }
      
      const data = await sendWhatsAppText(to, text, cfg, originalMessageId);
      const outboundId = data?.messages?.[0]?.id;
      const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
      if (outboundId) {
        try { await recordOutboundMessage({ messageId: outboundId, userId, cfg, to, type: 'text', text, raw: { to, text } }); } catch {}
        try {
          const { broadcastNewMessage } = await import('../routes/realtime.mjs');
          const messageData = {
            id: outboundId,
            direction: 'outbound',
            type: 'text',
            text_body: text,
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
        // If agent is live, move status to in_progress on first message
        try { await ensureInProgressIfHuman(userId, String(to)); } catch {}
        
        // Update contact activity
        try {
          updateContactActivity(userId, to);
        } catch (error) {
          console.error('Error updating contact activity:', error);
        }
        
        // Handle reply relationship if this is a reply to another message
        const replyTo = req.body?.replyTo;
        if (replyTo && outboundId) {
          try {
            const plan = await getUserPlan(userId);
            if ((plan?.plan_name || 'free') !== 'free') {
              const replyResult = createReply(replyTo, outboundId);
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
      console.error("Manual send error:", e);
      
      // Create a failed message record in the database
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
      
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    }
    res.redirect(`/inbox/${encodeURIComponent(to)}`);
  });

  // Retry failed message endpoint
  app.post("/retry-message/:messageId", ensureAuthed, async (req, res) => {
    const messageId = req.params.messageId;
    const userId = getCurrentUserId(req);
    
    try {
      // Get the failed message details
      const retryResult = await retryFailedMessage(messageId);
      
      if (!retryResult.success) {
        return res.status(400).json({ 
          success: false, 
          error: retryResult.error 
        });
      }
      
      const message = retryResult.message;
      
      // Verify the message belongs to the current user
      if (message.userId !== userId) {
        return res.status(403).json({ 
          success: false, 
          error: 'Unauthorized to retry this message' 
        });
      }
      
      // Get user settings for WhatsApp API
      const cfg = await getSettingsForUser(userId);
      if (!cfg || !cfg.whatsapp_token || !cfg.phone_number_id) {
        return res.status(400).json({ 
          success: false, 
          error: 'WhatsApp configuration not found' 
        });
      }
      
      // Attempt to resend the message (with diagnostics)
      try { if (process.env.DEBUG_LOGS === '1') console.log('[Retry] Resending WA text', { to_tail: String(message.to||'').slice(-6), hasPhoneId: !!cfg.phone_number_id, hasToken: !!cfg.whatsapp_token }); } catch {}
      const data = await sendWhatsAppText(message.to, message.text, cfg);
      const outboundId = data?.messages?.[0]?.id;
      
      if (outboundId) {
        // Update the message with the new WhatsApp message ID
        const updateStmt = db.prepare(`
          UPDATE messages 
          SET id = ?, delivery_status = ?, delivery_timestamp = ?, error_message = NULL
          WHERE id = ?
        `);
        
        const timestamp = Math.floor(Date.now() / 1000);
        updateStmt.run(outboundId, MESSAGE_STATUS.SENT, timestamp, messageId);
        
        // Update contact activity
        try {
          updateContactActivity(userId, message.to);
        } catch (error) {
          console.error('Error updating contact activity:', error);
        }
        
        if (process.env.DEBUG_LOGS === '1') console.log(`✅ Successfully retried message ${messageId} -> ${outboundId}`);
        
        // Broadcast the newly sent message to the chat in real-time
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
        // Mark as failed again
        markMessageAsFailed(messageId, 'Retry failed: No message ID returned from WhatsApp');
        
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to send message via WhatsApp' 
        });
      }
      
    } catch (error) {
      console.error('Retry message error:', error);
      
      // Mark as failed again
      markMessageAsFailed(messageId, `Retry failed: ${error.message}`);
      
      return res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });

  // Upload and send image route
  app.post("/upload-image/:phone", ensureAuthed, uploadImage.single('image'), async (req, res) => {
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = await getSettingsForUser(userId);
    const caption = (req.body?.caption || "").toString().trim();
    
    if (!req.file) {
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    }

    // Create a public URL for the uploaded image
    // Use the current request's host to ensure URLs are accessible from the current context
    const host = req.get('host');
    const isNgrok = host.includes('ngrok') || host.includes('ngrok.io');
    
    // Always use the current request's host for display purposes
    // For WhatsApp API, we'll use ngrok URL if available
    let imageUrl;
    let whatsappImageUrl;
    
    if (isNgrok) {
      imageUrl = `${req.protocol}://${host}/uploads/${req.file.filename}`;
      whatsappImageUrl = imageUrl; // Same URL for ngrok
    } else {
      // For display: use current request host
      imageUrl = `${req.protocol}://${host}/uploads/${req.file.filename}`;
      
      // For WhatsApp API: use ngrok URL if available
      const ngrokUrl = process.env.NGROK_URL || 'https://85d9d75e0287.ngrok-free.app';
      whatsappImageUrl = `${ngrokUrl}/uploads/${req.file.filename}`;
      if (process.env.DEBUG_LOGS === '1') console.log('⚠️ WARNING: Using localhost for display, ngrok for WhatsApp API');
    }
    
    if (process.env.DEBUG_LOGS === '1') console.log('Image upload - Generated URL:', imageUrl);
    if (process.env.DEBUG_LOGS === '1') console.log('Image upload - File:', req.file.filename);
    if (process.env.DEBUG_LOGS === '1') console.log('Image upload - Using ngrok:', isNgrok);
    if (process.env.DEBUG_LOGS === '1') console.log('Image upload - Note: WhatsApp needs this URL to be publicly accessible');

    // Enforce 24h window: if last inbound >24h ago, attempt a template instead
    try {
      const lastInbound = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'`).get(userId, to)?.ts || 0;
      const now = Math.floor(Date.now()/1000);
      const over24h = lastInbound && (now - Number(lastInbound)) > 24*3600;
      if (over24h) {
        try {
          await sendWhatsAppTemplate(to, 'hello_world', 'en_US', [], cfg);
          return res.redirect(`/inbox/${encodeURIComponent(to)}`);
        } catch (e) {
          console.error('Template send failed, falling back to image within 24h only:', e?.message || e);
          return res.redirect(`/inbox/${encodeURIComponent(to)}`);
        }
      }
    } catch {}

    try {
      // Get the original message ID if this is a reply
      let originalMessageId = null;
      const replyTo = req.body?.replyTo;
      if (replyTo) {
        // Get the WhatsApp message ID from the original message
        const originalMessage = db.prepare(`SELECT id FROM messages WHERE id = ? AND user_id = ?`).get(replyTo, userId);
        originalMessageId = originalMessage?.id;
      }
      
      if (process.env.DEBUG_LOGS === '1') console.log('Sending image via WhatsApp API:', { to, whatsappImageUrl, caption });
      
      let data;
      if (isNgrok) {
        // Use direct URL method for ngrok
        // Check if the image URL is accessible (for debugging)
        try {
          const response = await fetch(whatsappImageUrl, { method: 'HEAD' });
          if (window?.ENV?.DEBUG_LOGS === '1') console.log('Image URL accessibility check:', response.status, response.statusText);
        } catch (urlError) {
          if (window?.ENV?.DEBUG_LOGS === '1') console.log('Image URL not accessible:', urlError.message);
        }
        
        data = await sendWhatsappImage(to, whatsappImageUrl, caption, cfg, originalMessageId);
      } else {
        // Use cloud upload method for localhost
        if (window?.ENV?.DEBUG_LOGS === '1') console.log('Using cloud upload for localhost compatibility');
        const { sendWhatsappImageBase64 } = await import('../services/whatsapp.mjs');
        data = await sendWhatsappImageBase64(to, req.file.path, caption, cfg);
      }
      
      if (process.env.DEBUG_LOGS === '1') console.log('WhatsApp API response:', data);
      const outboundId = data?.messages?.[0]?.id;
      const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
      
      if (outboundId) {
        try {
          const rawData = { to, imageUrl, caption, filename: req.file.filename };
          await recordOutboundMessage({ messageId: outboundId, userId, cfg, to, type: 'image', text: caption || '📷 Image', raw: rawData });
        } catch {}
        
        // Handle reply relationship if this is a reply to another message
        const replyTo = req.body?.replyTo;
        if (replyTo && outboundId) {
          try {
            const plan = await getUserPlan(userId);
            if ((plan?.plan_name || 'free') !== 'free') {
              const replyResult = createReply(replyTo, outboundId);
              if (!replyResult.success) {
                console.error('Failed to create reply relationship:', replyResult.error);
              }
            }
          } catch (error) {
            console.error('Error creating reply relationship:', error);
          }
        }
        // If agent is live, move status to in_progress on first message
        try { await ensureInProgressIfHuman(userId, String(to)); } catch {}
      }
    } catch (e) {
      console.error("Image upload send error:", e);
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    }
    
    res.redirect(`/inbox/${encodeURIComponent(to)}`);
  });

  // Upload and send document route
  app.post("/upload-document/:phone", ensureAuthed, uploadDocument.single('document'), async (req, res) => {
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = await getSettingsForUser(userId);
    const caption = (req.body?.caption || "").toString().trim();
    
    if (!req.file) {
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    }

    // Create a public URL for the uploaded document
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

    // Enforce 24h window: if last inbound >24h ago, attempt a template instead
    try {
      const lastInbound = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'`).get(userId, to)?.ts || 0;
      const now = Math.floor(Date.now()/1000);
      const over24h = lastInbound && (now - Number(lastInbound)) > 24*3600;
      if (over24h) {
        try {
          await sendWhatsAppTemplate(to, 'hello_world', 'en_US', [], cfg);
          return res.redirect(`/inbox/${encodeURIComponent(to)}`);
        } catch (e) {
          console.error('Template send failed, falling back to document within 24h only:', e?.message || e);
          return res.redirect(`/inbox/${encodeURIComponent(to)}`);
        }
      }
    } catch {}

    try {
      // Get the original message ID if this is a reply
      let originalMessageId = null;
      const replyTo = req.body?.replyTo;
      if (replyTo) {
        const originalMessage = db.prepare(`SELECT id FROM messages WHERE id = ? AND user_id = ?`).get(replyTo, userId);
        originalMessageId = originalMessage?.id;
      }
      
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
        data = await sendWhatsappDocumentBase64(to, req.file.path, req.file.filename, caption, cfg);
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
        // If agent is live, move status to in_progress on first message
        try { await ensureInProgressIfHuman(userId, String(to)); } catch {}
        
        // Handle reply relationship if this is a reply to another message
        if (replyTo && outboundId) {
          try {
            const plan = await getUserPlan(userId);
            if ((plan?.plan_name || 'free') !== 'free') {
              const replyResult = createReply(replyTo, outboundId);
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
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = await getSettingsForUser(userId);
    const tname = cfg.wa_template_name || 'hello_world';
    const tlang = cfg.wa_template_language || 'en_US';
    const components = [];
    const var1 = (req.body?.var1 || '').toString().trim();
    const var2 = (req.body?.var2 || '').toString().trim();
    const bodyParams = [];
    if (var1) bodyParams.push({ type: 'text', text: var1 });
    if (var2) bodyParams.push({ type: 'text', text: var2 });
    if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams });
    try { 
      await sendWhatsAppTemplate(to, tname, tlang, components, cfg);
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    } catch (e) { 
      console.error('Template send error:', e?.message || e);
      return res.redirect(`/inbox/${encodeURIComponent(to)}`);
    }
  });

  app.post("/inbox/:phone/nameCustomer", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
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

  // Message reactions API endpoints
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
      // Broadcast the reaction change in real-time
      if (phone) {
        const action = result.added ? 'added' : 'removed';
        const reactionData = {
          messageId,
          emoji,
          userId,
          added: result.added,
          removed: result.removed
        };
        
        // Broadcast to all users in the chat room
        broadcastReaction(userId, phone, messageId, emoji, action, reactionData);
      }
      
      // Send reaction changes to WhatsApp
      if (phone) {
        try {
          // Get the original message to find the WhatsApp message ID (MongoDB)
          const dbNative = getDB();
          const originalMessage = await dbNative.collection('messages').findOne(
            { id: String(messageId), user_id: String(userId) },
            { projection: { id: 1, raw: 1 } }
          );
          if (originalMessage) {
            let whatsappMessageId = null;
            try {
              // Prefer the stored message id (it should be the WA message id)
              whatsappMessageId = originalMessage.id || null;
              // Fallback to raw payload if needed
              if (!whatsappMessageId && originalMessage.raw) {
                const rawData = typeof originalMessage.raw === 'string' ? JSON.parse(originalMessage.raw) : (originalMessage.raw || {});
                whatsappMessageId = rawData.id || rawData.message_id || null;
              }
            } catch {}
            
            if (whatsappMessageId) {
              // Get user settings for WhatsApp configuration
              const settings = await getSettingsForUser(userId);
              
              if (settings.whatsapp_token && settings.phone_number_id) {
                if (result.added) {
                  // Send reaction addition to WhatsApp
                  const r = await sendWhatsappReaction(phone, whatsappMessageId, emoji, settings);
                  if (process.env.DEBUG_LOGS === '1') console.log('WA reaction add resp:', r);
                } else if (result.removed) {
                  // Send reaction removal to WhatsApp (empty emoji)
                  const r = await sendWhatsappReaction(phone, whatsappMessageId, '', settings);
                  if (process.env.DEBUG_LOGS === '1') console.log('WA reaction remove resp:', r);
                }
              }
            }
          }
        } catch (error) {
          console.error('Error sending WhatsApp reaction:', error);
          // Don't fail the API call if WhatsApp sending fails
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