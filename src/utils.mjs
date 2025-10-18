/**
 * Generic utilities for rendering and formatting.
 * Contains:
 * - Phone normalization helper
 * - HTML escaping
 * - Transcript-to-chat-bubbles renderer
 * - Sidebar HTML renderer with current active nav
 */
import { CLERK_ENABLED } from "./config.mjs";

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
 * @param {"dashboard"|"inbox"|"contacts"|"onboarding"|"settings"|"kb"} activeKey
 * @returns {string} sidebar HTML
 */
export function renderSidebar(activeKey) {
  const link = (href, label, key) => {
    if (key === 'dashboard') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/dashboard-icon.svg" alt="Dashboard" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            <span style="color: grey;">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'inbox') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/inbox-icon.svg" alt="Inbox" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            <span style="color: grey;">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'contacts') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/name-person-icon.svg" alt="Contacts" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            <span style="color: grey;">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'onboarding') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/onboarding-icon.svg" alt="Onboarding" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            <span style="color: grey;">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'settings') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/settings-icon.svg" alt="Settings" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            <span style="color: grey;">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'kb') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/JSON-icon.svg" alt="KB" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            <span style="color: grey;">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'guide') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/ex-mark-icon.svg" alt="Guide" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            <span style="color: grey;">${label}</span>
          </a>
        </li>
      `;
    }
    if (key === 'plan') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/plan-icon.svg" alt="Plan" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            <span style="color: grey;">${label}</span>
          </a>
        </li>
      `;
    }
    return `<li><a ${activeKey === key ? 'class="active"' : ''} href="${href}"><span style="color: grey;">${label}</span></a></li>`;
  };
  const nav = `
    <ul class="nav">
      ${link('/dashboard', 'Dashboard', 'dashboard')}
      ${link('/inbox', 'Inbox', 'inbox')}
      ${link('/contacts', 'Contacts', 'contacts')}
      ${link('/settings', 'Settings', 'settings')}
      ${link('/kb/ui', 'Knowledge Base', 'kb')}
      ${link('/plan', 'Plan', 'plan')}
      ${link('/guide', 'Guide', 'guide')}
    </ul>
  `;
  const logout = CLERK_ENABLED ? '<a class="logout" href="/logout"><img src="/sign-out.svg" alt="Sign out" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>Sign out</a>' : '';
  return `
    <aside class="sidebar">
      <div style="display: flex; align-items: center; gap: 12px;">
      <img src="/logo-icon.png" alt="Code Orbit" style="width:30px;height:40px;margin-bottom:12px;"/>
      <div style="margin-top: 12px;" class="brand">Code Orbit Agent</div>
      </div>
      <div class="separator"></div>
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
        <div id="notification-bell" class="notification-bell" onclick="toggleNotifications(event)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
          </svg>
          <span id="notification-badge" class="notification-badge" style="display: none;">0</span>
          <div id="notification-dropdown" class="notification-dropdown" style="display: none;">
            <div class="notification-header">
              <span style="font-weight: 600;">Notifications</span>
              <button onclick="markAllAsRead(event)" class="mark-all-read">Mark all read</button>
            </div>
            <div id="notification-list" class="notification-list">
              <div class="notification-loading">Loading...</div>
            </div>
          </div>
        </div>
        <div class="small">${email ? `Signed in as: ${email}` : ''}</div>
      </div>
    </div>
  `;
}

