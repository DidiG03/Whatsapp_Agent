
import { CLERK_ENABLED, CLERK_PUBLISHABLE } from "./config.mjs";
const ASSET_VER = process.env.STATIC_ASSETS_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || 'dev';
export function getEnhancementsScript() {
  return `<script src="/enhancements.js"></script>`;
}
export function getVercelWebAnalyticsSnippet() {
  if (!process.env.VERCEL) return '';
  return `
      <script>
        window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
      </script>
      <script defer src="/_vercel/insights/script.js"></script>
  `;
}
export function getClerkBrowserScript() {
  if (!CLERK_ENABLED || !CLERK_PUBLISHABLE) return "";
  const clerkJsVersion = (process.env.CLERK_JS_VERSION || "5").toString().trim() || "5";
  return `
      <script
        async
        crossorigin="anonymous"
        data-clerk-publishable-key="${CLERK_PUBLISHABLE}"
        src="https://unpkg.com/@clerk/clerk-js@${clerkJsVersion}/dist/clerk.browser.js"
      ></script>`;
}

export function getProfessionalHead(title) {
  return `
    <head>
      <title>Code Orbit Agent — ${title}</title>
      <link rel="icon" href="/favicon.ico" sizes="any">
      <link rel="stylesheet" href="/styles.css?v=${ASSET_VER}">
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
      <meta name="theme-color" content="#1e293b">
      ${getClerkBrowserScript()}
      <script src="/auth-utils.js?v=${ASSET_VER}"></script>
      ${getEnhancementsScript()}
      ${getVercelWebAnalyticsSnippet()}
    </head>
  `;
}
export function normalizePhone(value) {
  return (value || "").replace(/\D/g, "");
}
export function normalizePhoneE164(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[ \-().]/g, "");
  if (/^\+?\d{7,15}$/.test(cleaned)) {
    return cleaned.startsWith("+") ? cleaned : "+" + cleaned;
  }
  return null;
}
export function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderVoiceMessageHtml({ audioUrl, transcript = '', messageId = '' } = {}) {
  if (!audioUrl) return '';
  const safeUrl = escapeHtml(audioUrl);
  const safeId = escapeHtml(String(messageId || ''));
  const bars = Array.from({ length: 14 }, (_, i) => {
    const h = 6 + ((i * 7) % 18);
    return `<span style="--vh:${h}px"></span>`;
  }).join('');
  const transcriptHtml = String(transcript || '').trim()
    ? `<div class="voice-message__transcript">${escapeHtml(transcript).replace(/\n/g, '<br/>')}</div>`
    : '';
  return `
    <div class="voice-message" data-message-id="${safeId}">
      <button type="button" class="voice-message__play" aria-label="Play voice message" onclick="window.toggleVoiceMessage && window.toggleVoiceMessage(this)">&#9654;</button>
      <div class="voice-message__track">
        <div class="voice-message__wave" aria-hidden="true">${bars}</div>
        <div class="voice-message__footer">
          <span class="voice-message__label">Voice message</span>
          <span class="voice-message__duration">--:--</span>
        </div>
      </div>
      <audio class="voice-message__audio" preload="auto" src="${safeUrl}"></audio>
    </div>
    ${transcriptHtml}
  `.trim();
}

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
export function getAccountInitials(email) {
  const value = String(email || "").trim();
  if (!value) return "?";
  const local = value.split("@")[0] || value;
  const parts = local.split(/[._\-+\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

export function renderPageHeader(title, subtitle = "", actionsHtml = "") {
  return `
    <header class="page-header${actionsHtml ? " page-header--with-actions" : ""}">
      <div class="page-header__text">
        <h1 class="page-title">${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="page-subtitle">${escapeHtml(subtitle)}</p>` : ""}
      </div>
      ${actionsHtml ? `<div class="page-header__actions">${actionsHtml}</div>` : ""}
    </header>
  `;
}

export function renderSidebar(activeKey, options = {}) {
  const showBookings = options.showBookings !== false;
  const showKb = (options.showKb !== false) && (options.isUpgraded ?? true);
  const lockIcon = `<svg class="nav-link__lock" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><circle cx="12" cy="16" r="1"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

  const navLink = (href, label, key, iconHtml, disabled = false) => {
    if (disabled) {
      return `<li><div class="nav-link nav-link--disabled">${iconHtml}<span>${label}</span>${lockIcon}</div></li>`;
    }
    const active = activeKey === key ? " active" : "";
    return `<li><a class="nav-link${active}" href="${href}">${iconHtml}<span>${label}</span></a></li>`;
  };

  const imgIcon = (src, alt) => `<img class="nav-link__icon" src="${src}" alt="" aria-hidden="true" />`;
  const svgIcon = (paths) => `<svg class="nav-link__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${paths}</svg>`;

  const nav = `
    <ul class="nav">
      ${navLink("/inbox", "Inbox", "inbox", imgIcon("/inbox-icon.svg"))}
      ${showBookings ? navLink("/bookings", "Bookings", "bookings", svgIcon('<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>')) : ""}
      ${showKb ? navLink("/kb/ui", "Knowledge Base", "kb", imgIcon("/JSON-icon.svg")) : ""}
      ${navLink("/refining", "Refining", "refining", svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'))}
      ${navLink("/campaigns", "Campaigns", "campaigns", imgIcon("/send-whatsapp-icon.svg"))}
      ${navLink("/plan", "Plan", "plan", imgIcon("/plan-icon.svg"))}
      ${navLink("/settings", "Settings", "settings", imgIcon("/settings-icon.svg"))}
    </ul>
  `;
  const logout = CLERK_ENABLED
    ? `<a class="logout" href="/logout" onclick="try{window.realtimeManager?.destroy?.()}catch(e){}">${imgIcon("/sign-out.svg")}<span>Sign out</span></a>`
    : "";
  return `
    <aside class="sidebar" id="app-sidebar">
      <a class="sidebar-brand" href="/inbox">
        <img src="/logo-icon.png" alt="Code Orbit" class="sidebar-brand__logo" />
        <div class="sidebar-brand__text">
          <span class="sidebar-brand__name">Code Orbit Agent</span>
          <span class="sidebar-brand__tagline">Workspace</span>
        </div>
      </a>
      ${nav}
      <div class="spacer"></div>
      ${logout}
    </aside>
  `;
}

export function renderTopbar(crumbs, email) {
  const initials = getAccountInitials(email);
  const accountLabel = email ? email.split("@")[0] : "Account";
  return `
    <div class="topbar">
      <div class="topbar__start">
        <button type="button" class="mobile-nav-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="app-sidebar">
          <svg class="mobile-nav-toggle__icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16"/>
          </svg>
        </button>
        <div class="crumbs">${crumbs}</div>
      </div>
      <div class="topbar__actions">
        <div id="usage-limit-pill" class="usage-limit-pill" style="display:none;" title="You have exceeded your monthly message limit">
          Limit exceeded
        </div>
        <div id="notification-bell" class="notification-bell" onclick="toggleNotifications(event)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
          </svg>
          <span id="notification-badge" class="notification-badge" style="display: none;">0</span>
          <div id="notification-dropdown" class="notification-dropdown" style="display: none;">
            <div class="notification-header">
              <span style="font-weight: 600;">Notifications</span>
              <button onclick="markAllAsRead(event)" class="mark-all-read">Mark all read</button>
            </div>
            <div id="notification-list" class="notification-list"></div>
          </div>
        </div>
        <div class="account-chip" title="${escapeHtml(email || "")}">
          <span class="account-chip__avatar" aria-hidden="true">${escapeHtml(initials)}</span>
          <span class="account-chip__meta">
            <span class="account-chip__label">${escapeHtml(accountLabel)}</span>
            <span class="account-chip__email">${escapeHtml(email || "")}</span>
          </span>
        </div>
      </div>
    </div>
    <script src="/toast.js"></script>
    <script src="/realtime.js?v=${ASSET_VER}"></script>
    <script src="/notifications.js?v=${ASSET_VER}"></script>
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
import crypto from 'node:crypto';
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

function getDateTimePartsInTimeZone(dateObj, timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dateObj);
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value || '1970'),
    month: Number(parts.find((p) => p.type === 'month')?.value || '1'),
    day: Number(parts.find((p) => p.type === 'day')?.value || '1'),
    hour: Number(parts.find((p) => p.type === 'hour')?.value || '0'),
    minute: Number(parts.find((p) => p.type === 'minute')?.value || '0'),
  };
}

export function buildUtcFromLocalWallTime(dateISO, hour, minute = 0, timeZone = 'UTC') {
  try {
    const [y, mo, d] = String(dateISO || '').split('-').map(Number);
    if (!y || !mo || !d) throw new Error('invalid dateISO');
    const hh = Number(hour || 0);
    const mm = Number(minute || 0);
    if (!timeZone || timeZone === 'UTC') {
      return new Date(Date.UTC(y, mo - 1, d, hh, mm, 0, 0));
    }
    let guess = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
    for (let i = 0; i < 5; i++) {
      const p = getDateTimePartsInTimeZone(new Date(guess), timeZone);
      if (p.year === y && p.month === mo && p.day === d && p.hour === hh && p.minute === mm) {
        return new Date(guess);
      }
      const desired = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
      const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
      guess += desired - actual;
    }
    return new Date(guess);
  } catch {
    return new Date(`${dateISO}T${String(hour).padStart(2,'0')}:${String(minute || 0).padStart(2,'0')}:00.000Z`);
  }
}
