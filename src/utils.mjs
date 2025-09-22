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
  if (!transcript || !transcript.trim()) return '<div class="small" style="text-align:center;">(no messages yet)</div>';
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
 * @param {"dashboard"|"inbox"|"onboarding"|"settings"|"kb"} activeKey
 * @returns {string} sidebar HTML
 */
export function renderSidebar(activeKey) {
  const link = (href, label, key) => {
    if (key === 'dashboard') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/dashboard-icon.svg" alt="Dashboard" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            ${label}
          </a>
        </li>
      `;
    }
    if (key === 'inbox') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/inbox-icon.svg" alt="Inbox" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            ${label}
          </a>
        </li>
      `;
    }
    if (key === 'onboarding') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/onboarding-icon.svg" alt="Onboarding" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            ${label}
          </a>
        </li>
      `;
    }
    if (key === 'settings') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/settings-icon.svg" alt="Settings" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            ${label}
          </a>
        </li>
      `;
    }
    if (key === 'kb') {
      return `
        <li>
          <a ${activeKey === key ? 'class="active"' : ''} href="${href}">
            <img src="/JSON-icon.svg" alt="KB" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>
            ${label}
          </a>
        </li>
      `;
    }
    return `<li><a ${activeKey === key ? 'class="active"' : ''} href="${href}">${label}</a></li>`;
  };
  const nav = `
    <ul class="nav">
      ${link('/dashboard', 'Dashboard', 'dashboard')}
      ${link('/inbox', 'Inbox', 'inbox')}
      ${link('/onboarding', 'Onboarding', 'onboarding')}
      ${link('/settings', 'Settings', 'settings')}
      ${link('/kb', 'KB (JSON)', 'kb')}
    </ul>
  `;
  const logout = CLERK_ENABLED ? '<a class="logout" href="/logout"><img src="/sign-out.svg" alt="Sign out" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;"/>Sign out</a>' : '';
  return `
    <aside class="sidebar">
      <div class="brand">Code Orbit</div>
      ${nav}
      <div class="spacer"></div>
      ${logout}
    </aside>
  `;
}

