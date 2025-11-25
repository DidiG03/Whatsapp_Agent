/**
 * Generic utilities for rendering and formatting.
 * Contains:
 * - Phone normalization helper
 * - HTML escaping
 * - Transcript-to-chat-bubbles renderer
 * - Sidebar HTML renderer with current active nav
 * - Professional enhancements script inclusion
 */
import { CLERK_ENABLED } from "./config.mjs";
const ASSET_VER = process.env.STATIC_ASSETS_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'dev';

/**
 * Get the professional enhancements script tag for all pages
 * @returns {string} HTML script tag for enhancements
 */
export function getEnhancementsScript() {
  return `<script src="/enhancements.js"></script>`;
}

/**
 * Get the complete head section with all necessary scripts and styles
 * @param {string} title - Page title
 * @returns {string} Complete HTML head section
 */
export function getProfessionalHead(title) {
  return `
    <head>
      <title>WhatsApp Agent - ${title}</title>
      <link rel="icon" href="/favicon.ico" sizes="any">
      <link rel="stylesheet" href="/styles.css?v=${ASSET_VER}">
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="theme-color" content="#2563eb">
      ${getEnhancementsScript()}
    </head>
  `;
}

/**
 * Normalize phone-like strings to digits-only. Used for consistent lookups.
 * @param {string} value Raw phone string
 * @returns {string} digits-only
 */
export function normalizePhone(value) {
  return (value || "").replace(/\D/g, "");
}

/** Normalize to E.164-like (+digits) when plausible, else null. */
export function normalizePhoneE164(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[ \-().]/g, "");
  if (/^\+?\d{7,15}$/.test(cleaned)) {
    return cleaned.startsWith("+") ? cleaned : "+" + cleaned;
  }
  return null;
}

/**
 * Escape unsafe characters for safe HTML insertion.
 * @param {string} text raw text
 * @returns {string} escaped HTML
 */
export function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Convert a plain-text onboarding transcript into bubble-styled HTML.
 * Recognizes lines prefixed with "You:" and "AI:" as separate messages.
 * @param {string} transcript combined transcript text
 * @returns {string} HTML of chat bubbles
 */
export function renderTranscriptAsBubbles(transcript) {
  if (!transcript || !transcript.trim()) return '<div class="empty_chat" style="text-align:center;">How can I improve your KB?</div>';
  const lines = transcript.split('\n');
  const messages = [];
  let current = null;
  for (const raw of lines) {
    const line = raw || '';
    if (line.startsWith('You:')) {
      if (current) messages.push(current);
      current = { role: 'user', text: line.slice(4).trim() };
    } else if (line.startsWith('AI:')) {
      if (current) messages.push(current);
      current = { role: 'ai', text: line.slice(3).trim() };
    } else if (line.trim() === '') {
      if (current) { messages.push(current); current = null; }
    } else {
      if (current) current.text += (current.text ? '\n' : '') + line;
    }
  }
  if (current) messages.push(current);
  const html = messages.map(m => {
    const cls = m.role === 'user' ? 'user' : 'ai';
    return `<div class="row ${cls}"><div class="bubble ${cls}">${escapeHtml(m.text).replace(/\n/g, '<br/>')}</div></div>`;
  }).join('');
  return `<div class="chat">${html}</div>`;
}

/**
 * Render the left-hand sidebar with navigation links.
 * Adds an "active" class on the current section.
 * @param {"dashboard"|"inbox"|"contacts"|"onboarding"|"settings"|"kb"|"bookings"} activeKey
 * @returns {string} sidebar HTML
 */
export function renderSidebar(activeKey, options = {}) {
  const showBookings = options.showBookings !== false; // default true
  const showKb = (options.showKb !== false) && (options.isUpgraded ?? true); // hide KB unless explicitly allowed
  const iconSize = 15; // px, "just a bit bigger"
  const fontSize = "12px"; // Smaller font size for sidebar text
  const svgPrimary = `width:${iconSize}px;height:${iconSize}px;vertical-align:middle;margin-right:5px;`;
  const svgSecondary = `width:12px;height:12px;`; // For secondary inline badge/feature icons

  const textStyle = `color: grey; font-size: ${fontSize}; cursor: pointer;`;
  const disabledTextStyle = `color: #9ca3af; font-size: ${fontSize}; cursor: not-allowed;`;

  const link = (href, label, key) => {
    if (key === 'dashboard') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <img src="/dashboard-icon.svg" alt="Dashboard" style="${svgPrimary}"/>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'inbox') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <img src="/inbox-icon.svg" alt="Inbox" style="${svgPrimary}"/>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'contacts') {
      return `
        <li>
          <div style="display: flex; align-items: center; padding: 8px 12px; ${disabledTextStyle} opacity: 0.6;">
            <img src="/name-person-icon.svg" alt="Contacts" style="${svgPrimary}"/>
            <span style="${disabledTextStyle}">Contacts</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: auto; color: #f59e0b;${svgSecondary}">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <circle cx="12" y="16" r="1"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
        </li>
      `;
    }
    if (key === 'onboarding') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <img src="/onboarding-icon.svg" alt="Onboarding" style="${svgPrimary}"/>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'settings') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <img src="/settings-icon.svg" alt="Settings" style="${svgPrimary}"/>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'kb') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <img src="/JSON-icon.svg" alt="KB" style="${svgPrimary}"/>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'campaigns') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <img src="/send-whatsapp-icon.svg" alt="Campaigns" style="${svgPrimary}"/>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'bookings') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'guide') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <img src="/ex-mark-icon.svg" alt="Guide" style="${svgPrimary}"/>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'plan') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <img src="/plan-icon.svg" alt="Plan" style="${svgPrimary}"/>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'monitoring') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;">
            <svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;">
              <path d="M3 3v18h18V3H3zm16 16H5V5h14v14z"/>
              <path d="M7 7h10v2H7V7zm0 4h10v2H7v-2zm0 4h7v2H7v-2z"/>
            </svg>
            <span style="${textStyle}">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'webhooks') {
      return `
        <li>
          <div style="display: flex; align-items: center; padding: 8px 12px; ${disabledTextStyle} opacity: 0.6;">
            <svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              <path d="M13 8H7"/>
              <path d="M17 12H7"/>
              <path d="M17 16H7"/>
            </svg>
            <span style="${disabledTextStyle}">Webhooks</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: auto; color: #f59e0b;${svgSecondary}">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <circle cx="12" y="16" r="1"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
        </li>
      `;
    }
    if (key === 'api-management') {
      return `
        <li>
          <div style="display: flex; align-items: center; padding: 8px 12px; ${disabledTextStyle} opacity: 0.6;">
            <svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
            <span style="${disabledTextStyle}">API Management</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: auto; color: #f59e0b;${svgSecondary}">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <circle cx="12" y="16" r="1"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
        </li>
      `;
    }
    return `<li><a ${activeKey === key ? 'class="active"' : ''} href="${href}" style="font-size:${fontSize};cursor:pointer;"><span style="${textStyle}">${label}</span></a></li>`;
  };
  const nav = `
    <ul class="nav">
      ${link('/dashboard', 'Dashboard', 'dashboard')}
      ${link('/inbox', 'Inbox', 'inbox')}
      ${showBookings ? link('/bookings', 'Bookings', 'bookings') : ''}
      ${showKb ? link('/kb/ui', 'Knowledge Base', 'kb') : ''}
      ${link('/campaigns', 'Campaigns', 'campaigns')}
      ${link('/plan', 'Plan', 'plan')}
      ${link('/settings', 'Settings', 'settings')}
      ${link('/guide', 'Guide', 'guide')}
    </ul>
  `;
  const logout = CLERK_ENABLED ? `<a class="logout" href="/logout" style="font-size:${fontSize};cursor:pointer;"><img src="/sign-out.svg" alt="Sign out" style="width:${iconSize}px;height:${iconSize}px;vertical-align:middle;margin-right:5px;"/>Sign out</a>` : '';
  return `
    <aside class="sidebar">
      <div style="display: flex; align-items: center; gap: 12px;">
        <img src="/logo-icon.png" alt="Code Orbit" style="width:20px;height:27px;margin-bottom:8px;"/>
        <div style="margin-top: 12px; font-size: ${fontSize};" class="brand">Code Orbit Agent</div>
      </div>
      ${nav}
      <div class="spacer"></div>
      ${logout}
    </aside>
  `;
}

export function renderTopbar(crumbs, email) {
  return `
    <div class="card topbar">
      <div class="crumbs">${crumbs}</div>
      <div style="display: flex; align-items: center; gap: 16px;">
        <div id="usage-limit-pill" class="usage-limit-pill" style="display:none;" title="You have exceeded your monthly message limit">
          Limit exceeded
        </div>
        <div id="notification-bell" class="notification-bell" onclick="toggleNotifications(event)" style="position:relative; z-index:10000;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
          </svg>
          <span id="notification-badge" class="notification-badge" style="display: none;">0</span>
          <div id="notification-dropdown" class="notification-dropdown" style="display: none; z-index:10001;">
            <div class="notification-header">
              <span style="font-weight: 600;">Notifications</span>
              <button onclick="markAllAsRead(event)" class="mark-all-read">Mark all read</button>
            </div>
            <div id="notification-list" class="notification-list"></div>
          </div>
        </div>
        <div class="small">${email ? `Signed in as: ${email}` : ''}</div>
      </div>
    </div>
    <script src="/toast.js"></script>
    <script src="/realtime.js"></script>
    <script src="/notifications.js"></script>
    <script>
      (function checkUsageLimit(){
        try {
          fetch('/api/usage/status', { credentials: 'include' })
            .then(function(r){ return r.ok ? r.json() : null; })
            .then(function(d){
              if (!d) return;
              var pill = document.getElementById('usage-limit-pill');
              if (!pill) return;
              if (d.overLimit) {
                pill.style.display = 'inline-flex';
              } else {
                pill.style.display = 'none';
              }
            })
            .catch(function(){});
        } catch(e) {}
      })();
    </script>
  `;
}

// --- Signed media URLs -------------------------------------------------------
import crypto from 'node:crypto';

/** Create a time-limited signature for a local uploads path (e.g., "/uploads/abc.pdf"). */
export function signMediaPath(path, ttlSeconds = 300) {
  try {
    const secret = process.env.MEDIA_SIGN_SECRET || process.env.SESSION_TOKEN_SECRET || 'dev-media-secret';
    const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds);
    const h = crypto.createHmac('sha256', secret).update(`${path}|${exp}`).digest('hex');
    return { exp, sig: h };
  } catch {
    return { exp: 0, sig: '' };
  }
}


// --- Timezone-safe date helpers ---------------------------------------------
/**
 * Get year/month/day components for a Date as experienced in a given IANA time zone.
 * Returns numeric parts suitable for constructing UTC instants that represent
 * local wall-clock times.
 */
export function getYmdPartsInTimeZone(dateObj, timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(dateObj);
  const year = Number(parts.find(p => p.type === 'year')?.value || '1970');
  const month = Number(parts.find(p => p.type === 'month')?.value || '01');
  const day = Number(parts.find(p => p.type === 'day')?.value || '01');
  return { year, month, day };
}

/**
 * Build a UTC Date that represents a wall-clock time (hour:minute) on dateISO
 * in a given IANA time zone.
 */
export function buildUtcFromLocalWallTime(dateISO, hour, minute = 0, timeZone = 'UTC') {
  try {
    const baseUtc = new Date(`${dateISO}T00:00:00.000Z`);
    const { year, month, day } = getYmdPartsInTimeZone(baseUtc, timeZone || 'UTC');
    return new Date(Date.UTC(year, month - 1, day, Number(hour || 0), Number(minute || 0), 0, 0));
  } catch {
    return new Date(`${dateISO}T${String(hour).padStart(2,'0')}:${String(minute || 0).padStart(2,'0')}:00.000Z`);
  }
}
