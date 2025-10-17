import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { renderSidebar, normalizePhone, escapeHtml, renderTopbar } from "../utils.mjs";
import { listContactsForUser, listMessagesForThread } from "../services/conversations.mjs";
import { db } from "../db.mjs";
import { getSettingsForUser } from "../services/settings.mjs";
import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsappImage, sendWhatsappReaction } from "../services/whatsapp.mjs";
import { getQuickReplies } from "../services/quickReplies.mjs";
import { getMessageReactions, toggleReaction, removeReaction, getMessagesReactions, getUserReactionsForMessages } from "../services/reactions.mjs";
import { createReply, getMessagesReplies, getReplyOriginals } from "../services/replies.mjs";
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure multer for file uploads
const storage = multer.diskStorage({
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

export default function registerInboxRoutes(app) {
  app.get("/inbox", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const q = (req.query.q || "").toString().trim();
    const contacts = listContactsForUser(userId).filter(c => !q || String(c.contact).includes(q));
    const email = await getSignedInEmail(req);
    const customers = db.prepare(`SELECT contact_id, display_name FROM customers WHERE user_id = ?`).all(userId);
    const customerNameByContact = new Map(customers.map(r => [String(r.contact_id), r.display_name]));
    const lastSeenRows = db.prepare(`SELECT contact_id, COALESCE(last_seen_ts,0) AS seen FROM handoff WHERE user_id = ?`).all(userId);
    const lastSeenByContact = new Map(lastSeenRows.map(r => [String(r.contact_id), Number(r.seen||0)]));
    // Get escalations and check if support has handled them
    const escalationRows = db.prepare(`
      SELECT h.contact_id, h.escalation_reason, h.updated_at as escalation_ts, 
             h.is_human, h.human_expires_ts
      FROM handoff h 
      WHERE h.user_id = ? AND h.escalation_reason IS NOT NULL
    `).all(userId);
    
    const escalationByContact = new Map();
    const now = Math.floor(Date.now()/1000);
    
    escalationRows.forEach(row => {
      const contactId = String(row.contact_id);
      const escalationTs = Number(row.escalation_ts || 0);
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
      const ts = new Date(lastTs*1000).toLocaleString();
      const preview = (c.last_text || "").slice(0, 60).replace(/</g,'&lt;');
      const initials = String(c.contact||'').slice(-2);
      const displayDefault = c.contact ? `+${String(c.contact).replace(/^\+/, '')}` : '';
      const displayName = customerNameByContact.get(String(c.contact)) || displayDefault;
      const seenTs = lastSeenByContact.get(String(c.contact)) || 0;
      const hasNew = lastTs > seenTs;
      const hasEscalation = escalationByContact.has(String(c.contact));
      const dropdownId = `menu_${c.contact}`;
      const menu = `
        <div class="dropdown" style="position:relative;">
          <button type="button" class="btn-ghost" style="border:none;" onclick="return toggleMenu('${dropdownId}', event)">
            <img src="/menu-icon.svg" alt="Menu" style="width:20px;height:20px;vertical-align:middle;border:none;"/>
          </button>
          <div id="${dropdownId}" class="dropdown-menu" style="position:absolute; right:0; top:28px; background:#fff; border:1px solid var(--border); border-radius:8px; padding:6px; min-width:140px; display:none; box-shadow:0 6px 20px rgba(0,0,0,0.12); z-index:10;" onclick="event.stopPropagation()">
            <form method="post" action="/inbox/${c.contact}/archive" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin:0;">
              <button type="submit" class="btn-ghost" style="display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; border:none;">
                <img src="/archive-icon.svg" alt="Archive"/> Archive
              </button>
            </form>
            <form method="post" action="/inbox/${c.contact}/clear" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin:0;">
              <button type="submit" class="btn-ghost" style="display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; border:none;">
                <img src="/clear-icon.svg" alt="Clear"/> Clear
              </button>
            </form>
            <form method="post" action="/inbox/${c.contact}/delete" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin:0;">
              <button type="submit" class="btn-ghost" style="display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; color:#c00; border:none;">
                <img src="/delete-icon.svg" alt="Delete"/> Delete
              </button>
            </form>
            <form method="post" action="/inbox/${c.contact}/nameCustomer" style="margin:0;">
              <button type="button" class="btn-ghost" style="display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; border:none;" onclick="openNameModal('${c.contact}'); return false;">
                <img src="/name-person-icon.svg" alt="Name Person"/> Name Customer
              </button>
            </form>
          </div>
        </div>
      `;
      return `
        <li class="inbox-item">
          <a href="/inbox/${c.contact}">
            <div class="wa-row">
              <div class="wa-avatar">${initials}</div>
              <div class="wa-col">
                <div class="wa-name">${displayName}${hasNew ? '<span class="badge-dot"></span>' : ''}${hasEscalation ? '<span class="live-chip">live</span>' : ''}</div>
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
    // Prevent caching to avoid showing cached authenticated pages after logout
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.end(`
      <html><head><title>Code Orbit - Inbox</title><link rel="stylesheet" href="/styles.css"></head>
      <body>
        <script src="/notifications.js"></script>
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return; } }catch(e){ window.location='/auth'; }
          })();
        </script>
        <div class="container">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / Inbox`, email)}
          <div class="layout">
            ${renderSidebar('inbox')}
            <main class="main">
              <form method="get" action="/inbox" style="display:flex; gap:8px; align-items:center;">
                <input class="settings-field" type="text" name="q" placeholder='Search...' style="background-image: url('/search-icon-black.svg'); background-repeat: no-repeat; background-position: 8px center; background-size: 16px 16px; padding-left: 36px;" value="${q}"/>
                <button type="submit"><img src="/search-icon.svg" alt="Search" style="width:20px;height:20px;vertical-align:middle;"/></button>
              </form>
              <div id="nameModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:1000; align-items:center; justify-content:center;">
                <div class="card" style="width:420px; max-width:95vw;">
                  <div class="small" style="margin-bottom:8px;">Name Customer</div>
                  <form id="nameForm" method="post" action="" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="display:grid; gap:8px;">
                    <input class="settings-field" type="text" name="display_name" placeholder="Customer name" required />
                    <textarea class="settings-field" name="notes" rows="3" placeholder="Notes (optional)"></textarea>
                    <div style="display:flex; gap:8px; justify-content:flex-end;">
                      <button type="button" class="btn-ghost" onclick="closeNameModal()">Cancel</button>
                      <button type="submit">Save</button>
                    </div>
                  </form>
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
                    document.querySelectorAll('.dropdown-menu').forEach(el=>{ if(el.id!==id) el.style.display='none'; });
                    const el = document.getElementById(id);
                    if(!el) return false; el.style.display = (el.style.display==='block') ? 'none' : 'block';
                  }catch(_){ }
                  return false;
                }
                document.addEventListener('click', function(){
                  document.querySelectorAll('.dropdown-menu').forEach(el=>{ el.style.display='none'; });
                });
              </script>
              <ul class="list card">${list || '<div class="small" style="margin-top:16px;">No conversations yet</div>'}</ul>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  app.get("/inbox/:phone", ensureAuthed, async (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const phoneDigits = normalizePhone(phone);
    // Mark as seen
    try {
      db.prepare(`INSERT INTO handoff (contact_id, user_id, last_seen_ts, updated_at)
        VALUES (?, ?, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET last_seen_ts = strftime('%s','now'), updated_at = strftime('%s','now')`).run(phone, userId);
    } catch {}
    const cust = db.prepare(`SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?`).get(userId, phone);
    const headerName = cust?.display_name || ('+' + String(phone).replace(/^\+/, ''));
    // Fetch richer message data so we can render interactive/document messages too
    const msgs = db.prepare(`
      SELECT m.id, m.direction, m.type, m.text_body, COALESCE(m.timestamp, 0) AS ts, m.raw,
             ms.status as message_status, ms.timestamp as status_timestamp
      FROM messages m
      LEFT JOIN (
        SELECT message_id, status, timestamp, ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY timestamp DESC) as rn
        FROM message_statuses 
        WHERE user_id = ?
      ) ms ON m.id = ms.message_id AND ms.rn = 1
      WHERE m.user_id = ?
        AND (
          ((m.from_digits = ? OR (m.from_digits IS NULL AND REPLACE(REPLACE(REPLACE(m.from_id,'+',''),' ',''),'-','') = ?)) AND m.direction = 'inbound') OR
          ((m.to_digits   = ? OR (m.to_digits   IS NULL AND REPLACE(REPLACE(REPLACE(m.to_id,'+',''),' ',''),'-','')   = ?)) AND m.direction = 'outbound')
        )
      ORDER BY m.timestamp ASC
    `).all(userId, userId, phoneDigits, phoneDigits, phoneDigits, phoneDigits);
    
    // Load reactions and replies for all messages
    const messageIds = msgs.map(m => m.id);
    const reactionsByMessage = getMessagesReactions(messageIds);
    const userReactionsByMessage = getUserReactionsForMessages(messageIds, userId);
    const repliesByMessage = getMessagesReplies(messageIds);
    const replyOriginals = getReplyOriginals(messageIds);
    const status = db.prepare(`SELECT is_human, COALESCE(human_expires_ts,0) AS exp FROM handoff WHERE contact_id = ? AND user_id = ?`).get(phone, userId);
    const isHuman = !!status?.is_human;
    const expTs = Number(status?.exp || 0);
    const nowSec = Math.floor(Date.now()/1000);
    const remain = expTs > nowSec ? (expTs - nowSec) : 0;
    const email = await getSignedInEmail(req);
    const quickReplies = getQuickReplies(userId);
    const items = msgs.map(m => {
      const cls = m.direction === 'inbound' ? 'msg msg-in' : 'msg msg-out';
      let display = String(m.text_body || '').trim();
      // For non-text messages, derive a readable label from raw payload
      // Also handle cases where text_body contains placeholder text like '[image]'
      if (!display || display === '[image]' || display === '[document]' || display === '[audio]' || display === '[video]' || (m.type && m.type !== 'text')) {
        let raw;
        try { raw = JSON.parse(m.raw || '{}'); } catch { raw = {}; }
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
          // Handle both inbound (raw.image.link) and outbound (raw.imageUrl) image formats
          let imageUrl = raw?.image?.link || raw?.imageUrl;
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
      const ts = new Date((m.ts||0)*1000).toLocaleString();
      
      // Generate status indicator for outbound messages
      let statusIndicator = '';
      if (m.direction === 'outbound' && m.message_status) {
        const status = m.message_status.toLowerCase();
        if (status === 'sent') {
          statusIndicator = '<span class="msg-status sent" title="Sent">✓</span>';
        } else if (status === 'delivered') {
          statusIndicator = '<span class="msg-status delivered" title="Delivered">✓✓</span>';
        } else if (status === 'read') {
          statusIndicator = '<span class="msg-status read" title="Read">✓✓</span>';
        } else if (status === 'failed') {
          statusIndicator = '<span class="msg-status failed" title="Failed">✗</span>';
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
          const clickHandler = isUserReaction ? `onclick="toggleReaction('${m.id}', '${reaction.emoji}')"` : '';
          const cursorStyle = isUserReaction ? 'cursor: pointer;' : 'cursor: default;';
          const title = isUserReaction ? 'Click to remove your reaction' : 'Customer reaction';
          reactionsHtml += `<span class="reaction ${reactionClass}" data-message-id="${m.id}" data-emoji="${reaction.emoji}" ${clickHandler} style="${cursorStyle}" title="${title}">${reaction.emoji}<span class="reaction-count">${reaction.count}</span></span>`;
        });
        reactionsHtml += '</div>';
      }
      
      // Add action buttons inside the bubble
      const actionButtons = `
        <div class="message-actions">
          <button class="action-btn reply-btn" onclick="replyToMessage('${m.id}')" title="Reply to this message">↩️</button>
          <button class="action-btn reaction-btn" onclick="showReactionPicker('${m.id}')" title="Add reaction">+</button>
        </div>
      `;
      
      return `<div class="${cls} message-container" id="message-${m.id}">${originalMessageHtml}<div class="bubble">${safe}<div class="meta">${ts}${statusIndicator}</div>${reactionsHtml}${actionButtons}</div></div>`;
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
        <script>
          // Check authentication on page load
          (async function checkAuthOnLoad(){
            try{ const r=await fetch('/auth/status',{credentials:'include'}); const j=await r.json(); if(!j.signedIn){ window.location='/auth'; return; } }catch(e){ window.location='/auth'; }
          })();
          
          // Check authentication before form submission to prevent redirects
          async function checkAuthThenSubmit(form){
            try {
              const response = await fetch('/auth/status', { credentials: 'include' });
              const authData = await response.json();
              if (!authData.signedIn) {
                alert('Your session has expired. Please sign in again.');
                window.location = '/auth';
                return false;
              }
              return true;
            } catch (error) {
              console.error('Auth check failed:', error);
              alert('Authentication check failed. Please try again.');
              return false;
            }
          }
          function setupComposer(){
            const ta=document.querySelector('#messageInput');
            if(!ta) return; 
            
            ta.addEventListener('keydown', function(e){
              if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); this.form.submit(); }
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
            const phone = '${phone}';
            const userId = '${userId}';
            
            // Connect to Server-Sent Events for typing indicators
            const eventSource = new EventSource(\`/api/typing/\${phone}?userId=\${userId}\`);
            
            eventSource.onmessage = function(event) {
              const data = JSON.parse(event.data);
              if (data.type === 'typing_start') {
                showTypingIndicator();
              } else if (data.type === 'typing_stop') {
                hideTypingIndicator();
              }
            };
            
            eventSource.onerror = function(event) {
              console.log('SSE connection error:', event);
            };
            
            // Clean up on page unload
            window.addEventListener('beforeunload', function() {
              eventSource.close();
            });
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
            const phone = '${phone}';
            const userId = '${userId}';
            fetch(\`/api/typing/\${phone}/start\`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ userId: userId })
            }).then(response => response.json())
              .then(data => {
                console.log('Typing start test:', data);
              })
              .catch(error => {
                console.error('Error testing typing start:', error);
              });
          }
          
          function testTypingStop() {
            const phone = '${phone}';
            const userId = '${userId}';
            fetch(\`/api/typing/\${phone}/stop\`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ userId: userId })
            }).then(response => response.json())
              .then(data => {
                console.log('Typing stop test:', data);
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
            
            const phone = '${phone}';
            fetch(\`/api/reactions/\${currentMessageId}\`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ emoji: emoji, phone: phone })
            }).then(response => response.json())
              .then(data => {
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
            const phone = '${phone}';
            fetch(\`/api/reactions/\${messageId}\`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ emoji: emoji, phone: phone })
            }).then(response => response.json())
              .then(data => {
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
          
          // Reply functions
          function replyToMessage(messageId) {
            currentReplyToMessageId = messageId;
            const messageElement = document.getElementById(\`message-\${messageId}\`);
            
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
            const messageElement = document.getElementById(\`message-\${messageId}\`);
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
              replyIndicator.innerHTML = \`
                <div class="reply-indicator-content">
                  <div class="reply-indicator-text"><strong>\${authorName}</strong><br>\${truncatedText}</div>
                  <button class="reply-indicator-close" onclick="clearReply()">×</button>
                </div>
              \`;
              
              // Insert before the input container
              const inputContainer = document.querySelector('.wa-input-container');
              if (inputContainer) {
                inputContainer.parentNode.insertBefore(replyIndicator, inputContainer);
              }
            } else {
              replyIndicator.querySelector('.reply-indicator-text').innerHTML = \`<strong>\${authorName}</strong><br>\${truncatedText}\`;
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
            const messageElement = document.getElementById(\`message-\${messageId}\`);
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
            
            preview.innerHTML = \`
              <div class="document-icon">\${fileExtension}</div>
              <div class="document-info">
                <div class="document-name">\${escapeHtml(file.name)}</div>
                <div class="document-size">\${fileSize}</div>
              </div>
              <button type="button" class="document-remove" onclick="clearDocumentPreview()">Remove</button>
            \`;
            
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

              imageForm.submit();
              // Scroll to bottom after image is sent
              setTimeout(scrollToBottom, 500);
              clearReply(); // Clear reply state
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

              documentForm.submit();
              // Scroll to bottom after document is sent
              setTimeout(scrollToBottom, 500);
              clearReply(); // Clear reply state
            } else {
              // Otherwise, send the text message normally
              checkAuthThenSubmit().then(valid => { 
                if(valid) {
                  // Add reply information if replying to a message
                  if (currentReplyToMessageId) {
                    const replyInput = document.createElement('input');
                    replyInput.type = 'hidden';
                    replyInput.name = 'replyTo';
                    replyInput.value = currentReplyToMessageId;
                    event.target.appendChild(replyInput);
                  }
                  
                  event.target.submit();
                  // Scroll to bottom after text message is sent
                  setTimeout(scrollToBottom, 500);
                  clearReply(); // Clear reply state
                }
              });
            }
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
        <div class="container">
          ${renderTopbar(`<a href="/dashboard">Dashboard</a> / <a href="/inbox">Inbox</a> / +${String(phone).replace(/^\+/, '')}`, email)}
          <div class="layout">
            ${renderSidebar('inbox')}
            <main class="main">
              <div style="min-height: calc(100vh - 107px);" class="card">
                ${toastMsg ? `<div class="toast ${toastType || 'info'}">${toastMsg}</div>` : ''}
                <div class="wa-chat-header">
                  <a href="/inbox" style="border:none; margin-right:20px;">
                    <img src="/left-arrow-icon.svg" alt="Back" style="width:20px;height:20px;vertical-align:middle;"/>
                  </a>
                  <div class="wa-avatar">${String(phone).slice(-2)}</div>
                  <div style="flex:1;">
                    <div class="wa-name">${headerName}</div>
                    <div class="small">${isHuman ? ('Human' + (remain ? ' • <span id="exp_remain"></span> left' : '')) : 'AI'}</div>
                  </div>
                  <form method="post" action="/handoff/${phone}" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;">
                    <input type="hidden" name="is_human" value="${isHuman ? '' : '1'}"/>
                    <button type="submit" class="btn-ghost" style="border:none; background:transparent; padding:0; margin:0;">
                      <img 
                        src="${isHuman ? '/raise-hand-icon.svg' : '/bot-icon.svg'}"
                        alt="${isHuman ? 'Human handling' : 'AI handling'}" 
                        style="width:26px;height:26px;vertical-align:middle;margin-right:6px; cursor:pointer;"
                      />
                    </button>
                  </form>
                  ${isHuman ? `<form method="post" action="/inbox/${phone}/renew" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                    <button type="submit" class="btn-ghost" title="Renew 5 minutes" style="border:none;"><img src="/restart-onboarding.svg" alt="Renew" style="width:20px;height:20px;vertical-align:middle;"/></button>
                  </form>` : ''}
                  <form method="post" action="/inbox/${phone}/archive" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                    <button type="submit" class="btn-ghost" style="border:none;"><img src="/archive-icon.svg" alt="Archive" style="width:20px;height:20px;vertical-align:middle;"/></button>
                  </form>
                  <form method="post" action="/inbox/${phone}/clear" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                    <button type="submit" class="btn-ghost" style="border:none;"><img src="/clear-icon.svg" alt="Clear" style="width:24px;height:24px;vertical-align:middle;"/></button>
                  </form>
                  <form method="post" action="/inbox/${phone}/delete" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;" style="margin-left:8px;">
                    <button type="submit" class="btn-ghost" style="color:#c00; border:none;"><img src="/delete-icon.svg" alt="Delete" style="width:20px;height:20px;vertical-align:middle;"/></button>
                  </form>
                </div>
                ${(() => {
                  try{
                    const lastInbound = (msgs||[]).filter(x=>x.direction==='inbound').map(x=>Number(x.ts||0)).sort((a,b)=>b-a)[0]||0;
                    const over24 = lastInbound && (Math.floor(Date.now()/1000)-lastInbound) > 24*3600;
                    if (over24) {
                      return `<div class=\"small\" style=\"margin:8px 0; padding:8px; background:#fff8e1; border:1px solid #fde68a; border-radius:8px;\">Session expired (>24h). Send template to reopen window.
                        <form method=\"post\" action=\"/inbox/${phone}/send-template\" onsubmit=\"event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) this.submit(); }); return false;\" style=\"display:flex; gap:6px; align-items:center; margin-top:6px;\">
                          <input class=\"settings-field\" name=\"var1\" placeholder=\"{{1}} (optional)\" style=\"height:32px;\"/>
                          <input class=\"settings-field\" name=\"var2\" placeholder=\"{{2}} (optional)\" style=\"height:32px;\"/>
                          <button class=\"btn-ghost\" type=\"submit\" style=\"border:none;\">Send Template</button>
                        </form>
                      </div>`;
                    }
                  }catch(_){ }
                  return '';
                })()}
                <div class="chat-thread">
                  ${items || '<div class="small" style="text-align:center;padding:16px;">No messages</div>'}
                  <div id="typingIndicator" class="typing-indicator" style="display:none;">
                    <div class="msg msg-in">
                      <div class="bubble">
                        <div class="typing-dots">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                        <div class="meta">Typing...</div>
                      </div>
                    </div>
                  </div>
                </div>
                
                ${quickReplies.length > 0 ? `
                <div class="quick-replies-container" id="quickRepliesContainer">
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
                      <button type="button" class="quick-reply-btn" onclick="selectQuickReply('${reply.text.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')" data-text="${reply.text.replace(/"/g, '&quot;')}">
                        <span class="quick-reply-text">${escapeHtml(reply.text)}</span>
                        <span class="quick-reply-category">${reply.category || 'General'}</span>
                      </button>
                    `).join('')}
                  </div>
                </div>
                ` : ''}
                
                <div class="wa-composer">
                  <div id="imagePreview" style="display:none; margin-bottom:8px; padding:8px; background:#f0f0f0; border-radius:8px;">
                    <div style="display:flex; gap:8px; align-items:center;">
                      <img id="previewImg" style="width:60px; height:60px; object-fit:cover; border-radius:8px;" />
                      <div style="font-size:12px; color:#666;">Selected image</div>
                      <div style="flex:1;"></div>
                      <button type="button" onclick="clearImagePreview()" style="background:#ff4444; color:white; border:none; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:12px;">Remove</button>
                    </div>
                  </div>
                  
                  <form id="imageUploadForm" method="post" action="/upload-image/${phone}" enctype="multipart/form-data" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) { this.submit(); setTimeout(scrollToBottom, 500); } }); return false;" style="display:none;">
                    <input type="file" name="image" accept="image/*" id="imageFileInput" onchange="handleImageSelect(event)" />
                    <textarea name="caption" id="hiddenCaption" style="display:none;"></textarea>
                  </form>
                  
                  <form id="documentUploadForm" method="post" action="/upload-document/${phone}" enctype="multipart/form-data" onsubmit="event.preventDefault(); checkAuthThenSubmit().then(valid => { if(valid) { this.submit(); setTimeout(scrollToBottom, 500); } }); return false;" style="display:none;">
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
                  
                  <!-- Reaction Picker -->
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
                      
                      <button type="button" ${!isHuman ? 'disabled' : ''} onclick="document.getElementById('imageFileInput').click()" class="wa-camera-btn" title="Camera">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 12m-3.2 0a3.2 3.2 0 1 1 6.4 0a3.2 3.2 0 1 1 -6.4 0"/>
                          <path d="M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/>
                        </svg>
                      </button>
                      
                      <button type="button" ${!isHuman ? 'disabled' : ''} onclick="startVoiceRecording()" class="wa-mic-btn" title="Voice Message">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                          <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                        </svg>
                      </button>
                      
                      <button type="submit" id="sendButton" class="wa-send-btn" title="Send" ${!isHuman ? 'disabled data-original-disabled="true"' : ''}>
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                        </svg>
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </main>
          </div>
        </div>
      </body></html>
    `);
  });

  app.post("/handoff/:phone", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const isHuman = req.body?.is_human ? 1 : 0;
    const now = Math.floor(Date.now()/1000);
    const exp = isHuman ? (now + 5*60) : 0;
    const upsert = db.prepare(`
      INSERT INTO handoff (contact_id, user_id, is_human, human_expires_ts, updated_at) VALUES (?, ?, ?, ?, strftime('%s','now'))
      ON CONFLICT(contact_id, user_id) DO UPDATE SET is_human = excluded.is_human, human_expires_ts = excluded.human_expires_ts, updated_at = excluded.updated_at
    `);
    try { upsert.run(phone, userId, isHuman, exp); } catch {}
    res.redirect(`/inbox/${phone}`);
  });

  // Renew 5 more minutes of human mode
  app.post("/inbox/:phone/renew", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    try {
      const now = Math.floor(Date.now()/1000);
      const row = db.prepare(`SELECT COALESCE(human_expires_ts,0) AS exp FROM handoff WHERE contact_id = ? AND user_id = ?`).get(phone, userId) || { exp: 0 };
      const base = Number(row.exp || 0) > now ? Number(row.exp || 0) : now;
      const next = base + 5*60;
      db.prepare(`INSERT INTO handoff (contact_id, user_id, is_human, human_expires_ts, updated_at)
        VALUES (?, ?, 1, ?, strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET is_human = 1, human_expires_ts = ?, updated_at = strftime('%s','now')
      `).run(phone, userId, next, next);
    } catch {}
    res.redirect(`/inbox/${phone}`);
  });

  // Archive a conversation (hide from inbox list)
  app.post("/inbox/:phone/archive", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    try {
      db.prepare(`INSERT INTO handoff (contact_id, user_id, is_archived, updated_at) VALUES (?, ?, 1, strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET is_archived = 1, updated_at = excluded.updated_at`).run(phone, userId);
    } catch {}
    res.redirect(`/inbox`);
  });

  // Clear a conversation (delete messages only for this contact/user)
  app.post("/inbox/:phone/clear", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const digits = normalizePhone(phone);
    try {
      db.prepare(`DELETE FROM messages WHERE user_id = ? AND (
        (from_digits = ? OR (from_digits IS NULL AND REPLACE(REPLACE(REPLACE(from_id,'+',''),' ',''),'-','') = ?)) OR
        (to_digits   = ? OR (to_digits   IS NULL AND REPLACE(REPLACE(REPLACE(to_id,'+',''),' ',''),'-','')   = ?))
      )`).run(userId, digits, digits, digits, digits);
    } catch {}
    res.redirect(`/inbox/${phone}`);
  });

  // Delete a conversation (mark deleted and remove messages)
  app.post("/inbox/:phone/delete", ensureAuthed, (req, res) => {
    const phone = req.params.phone;
    const userId = getCurrentUserId(req);
    const digits = normalizePhone(phone);
    try {
      db.prepare(`DELETE FROM messages WHERE user_id = ? AND (
        (from_digits = ? OR (from_digits IS NULL AND REPLACE(REPLACE(REPLACE(from_id,'+',''),' ',''),'-','') = ?)) OR
        (to_digits   = ? OR (to_digits   IS NULL AND REPLACE(REPLACE(REPLACE(to_id,'+',''),' ',''),'-','')   = ?))
      )`).run(userId, digits, digits, digits, digits);
    } catch {}
    try {
      db.prepare(`INSERT INTO handoff (contact_id, user_id, deleted_at, updated_at) VALUES (?, ?, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET deleted_at = strftime('%s','now'), updated_at = strftime('%s','now')`).run(phone, userId);
    } catch {}
    res.redirect(`/inbox`);
  });

  app.post("/send/:phone", ensureAuthed, async (req, res) => {
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = getSettingsForUser(userId);
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
          return res.redirect(`/inbox/${to}?toast=Template sent. Ask the user to reply to reopen the session.&type=success`);
        } catch (e) {
          console.error('Template send failed, falling back to text within 24h only:', e?.message || e);
          return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
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
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw)
          VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'text', ?, strftime('%s','now'), ?)
        `);
        try { stmt.run(outboundId, userId, fromBiz, to, normalizePhone(fromBiz), normalizePhone(to), text, JSON.stringify({ to, text })); } catch {}
        
        // Handle reply relationship if this is a reply to another message
        const replyTo = req.body?.replyTo;
        if (replyTo && outboundId) {
          try {
            const replyResult = createReply(replyTo, outboundId);
            if (!replyResult.success) {
              console.error('Failed to create reply relationship:', replyResult.error);
            }
          } catch (error) {
            console.error('Error creating reply relationship:', error);
          }
        }
      }
    } catch (e) {
      console.error("Manual send error:", e);
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
    }
    res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Message sent')}&type=success`);
  });

  // Upload and send image route
  app.post("/upload-image/:phone", ensureAuthed, uploadImage.single('image'), async (req, res) => {
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = getSettingsForUser(userId);
    const caption = (req.body?.caption || "").toString().trim();
    
    if (!req.file) {
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('No image file provided')}&type=error`);
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
      console.log('⚠️ WARNING: Using localhost for display, ngrok for WhatsApp API');
    }
    
    console.log('Image upload - Generated URL:', imageUrl);
    console.log('Image upload - File:', req.file.filename);
    console.log('Image upload - Using ngrok:', isNgrok);
    console.log('Image upload - Note: WhatsApp needs this URL to be publicly accessible');

    // Enforce 24h window: if last inbound >24h ago, attempt a template instead
    try {
      const lastInbound = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'`).get(userId, to)?.ts || 0;
      const now = Math.floor(Date.now()/1000);
      const over24h = lastInbound && (now - Number(lastInbound)) > 24*3600;
      if (over24h) {
        try {
          await sendWhatsAppTemplate(to, 'hello_world', 'en_US', [], cfg);
          return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template sent. Ask the user to reply to reopen the session.')}&type=success`);
        } catch (e) {
          console.error('Template send failed, falling back to image within 24h only:', e?.message || e);
          return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
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
      
      console.log('Sending image via WhatsApp API:', { to, whatsappImageUrl, caption });
      
      let data;
      if (isNgrok) {
        // Use direct URL method for ngrok
        // Check if the image URL is accessible (for debugging)
        try {
          const response = await fetch(whatsappImageUrl, { method: 'HEAD' });
          console.log('Image URL accessibility check:', response.status, response.statusText);
        } catch (urlError) {
          console.log('Image URL not accessible:', urlError.message);
        }
        
        data = await sendWhatsappImage(to, whatsappImageUrl, caption, cfg, originalMessageId);
      } else {
        // Use cloud upload method for localhost
        console.log('Using cloud upload for localhost compatibility');
        const { sendWhatsappImageBase64 } = await import('../services/whatsapp.mjs');
        data = await sendWhatsappImageBase64(to, req.file.path, caption, cfg);
      }
      
      console.log('WhatsApp API response:', data);
      const outboundId = data?.messages?.[0]?.id;
      const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
      
      if (outboundId) {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw)
          VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'image', ?, strftime('%s','now'), ?)
        `);
        try { 
          // Store the display URL (not the WhatsApp URL) for proper rendering
          const rawData = { to, imageUrl, caption, filename: req.file.filename };
          stmt.run(outboundId, userId, fromBiz, to, normalizePhone(fromBiz), normalizePhone(to), caption || '📷 Image', JSON.stringify(rawData)); 
        } catch {}
        
        // Handle reply relationship if this is a reply to another message
        const replyTo = req.body?.replyTo;
        if (replyTo && outboundId) {
          try {
            const replyResult = createReply(replyTo, outboundId);
            if (!replyResult.success) {
              console.error('Failed to create reply relationship:', replyResult.error);
            }
          } catch (error) {
            console.error('Error creating reply relationship:', error);
          }
        }
      }
    } catch (e) {
      console.error("Image upload send error:", e);
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Image send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
    }
    
    res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Image sent')}&type=success`);
  });

  // Upload and send document route
  app.post("/upload-document/:phone", ensureAuthed, uploadDocument.single('document'), async (req, res) => {
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = getSettingsForUser(userId);
    const caption = (req.body?.caption || "").toString().trim();
    
    if (!req.file) {
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('No document file provided')}&type=error`);
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
      console.log('⚠️ WARNING: Using localhost for display, ngrok for WhatsApp API');
    }
    
    console.log('Document upload - Generated URL:', documentUrl);
    console.log('Document upload - File:', req.file.filename);

    // Enforce 24h window: if last inbound >24h ago, attempt a template instead
    try {
      const lastInbound = db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'`).get(userId, to)?.ts || 0;
      const now = Math.floor(Date.now()/1000);
      const over24h = lastInbound && (now - Number(lastInbound)) > 24*3600;
      if (over24h) {
        try {
          await sendWhatsAppTemplate(to, 'hello_world', 'en_US', [], cfg);
          return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template sent. Ask the user to reply to reopen the session.')}&type=success`);
        } catch (e) {
          console.error('Template send failed, falling back to document within 24h only:', e?.message || e);
          return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
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
      
      console.log('Sending document via WhatsApp API:', { to, whatsappDocumentUrl, caption });
      console.log('WhatsApp config check:', { 
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
      
      console.log('WhatsApp API response:', data);
      const outboundId = data?.messages?.[0]?.id;
      const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
      
      if (outboundId) {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw)
          VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'document', ?, strftime('%s','now'), ?)
        `);
        try { 
          const rawData = { to, documentUrl, caption, filename: req.file.filename };
          stmt.run(outboundId, userId, fromBiz, to, normalizePhone(fromBiz), normalizePhone(to), caption || '📄 Document', JSON.stringify(rawData)); 
        } catch {}
        
        // Handle reply relationship if this is a reply to another message
        if (replyTo && outboundId) {
          try {
            const replyResult = createReply(replyTo, outboundId);
            if (!replyResult.success) {
              console.error('Failed to create reply relationship:', replyResult.error);
            }
          } catch (error) {
            console.error('Error creating reply relationship:', error);
          }
        }
      }
    } catch (e) {
      console.error("Document upload send error:", e);
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Document send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
    }
    
    res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Document sent')}&type=success`);
  });

  app.post("/inbox/:phone/send-template", ensureAuthed, async (req, res) => {
    const to = req.params.phone;
    const userId = getCurrentUserId(req);
    const cfg = getSettingsForUser(userId);
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
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template sent successfully')}&type=success`);
    } catch (e) { 
      console.error('Template send error:', e?.message || e);
      return res.redirect(`/inbox/${to}?toast=${encodeURIComponent('Template send failed: ' + (e?.message || 'Unknown error'))}&type=error`);
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
    
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required' });
    }
    
    const result = toggleReaction(messageId, userId, emoji);
    if (result.success) {
      // If this is adding a reaction (not removing), send it via WhatsApp
      if (result.added && phone) {
        try {
          // Get the original message to find the WhatsApp message ID
          const originalMessage = db.prepare(`SELECT raw FROM messages WHERE id = ? AND user_id = ?`).get(messageId, userId);
          
          if (originalMessage && originalMessage.raw) {
            const rawData = JSON.parse(originalMessage.raw);
            const whatsappMessageId = rawData.id || rawData.message_id;
            
            if (whatsappMessageId) {
              // Get user settings for WhatsApp configuration
              const settings = getSettingsForUser(userId);
              
              if (settings.whatsapp_token && settings.phone_number_id) {
                await sendWhatsappReaction(phone, whatsappMessageId, emoji, settings);
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
  
  app.delete("/api/reactions/:messageId", ensureAuthed, (req, res) => {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = getCurrentUserId(req);
    
    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required' });
    }
    
    const result = removeReaction(messageId, userId, emoji);
    if (result.success) {
      res.json({ success: true, message: 'Reaction removed successfully' });
    } else {
      res.status(500).json({ error: result.error || 'Failed to remove reaction' });
    }
  });
}