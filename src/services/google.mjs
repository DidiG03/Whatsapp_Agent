/**
 * Minimal Google Calendar client helpers.
 * - Refreshes access tokens using refresh_token if available
 * - Calls FreeBusy and Events endpoints
 *
 * This scaffold works without googleapis dependency and degrades gracefully
 * when credentials are not configured, returning empty busy lists and
 * storing null event ids so the rest of the app can function.
 */
import fetch from "node-fetch";
import { db } from "../db-serverless.mjs";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CAL_BASE = "https://www.googleapis.com/calendar/v3";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;

function isTokenValid(row) {
  const exp = Number(row?.token_expiry || 0);
  if (!row?.access_token || !exp) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp - now > 120; // 2 minute buffer
}

async function refreshAccessToken(calendarRow) {
  if (!calendarRow?.refresh_token || !CLIENT_ID || !CLIENT_SECRET) return null;
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: calendarRow.refresh_token,
      grant_type: "refresh_token"
    });
    const resp = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!resp.ok) return null;
    const json = await resp.json();
    const accessToken = json.access_token;
    const expiresIn = Number(json.expires_in || 3600);
    if (accessToken) {
      const expiry = Math.floor(Date.now() / 1000) + expiresIn;
      try {
        db.prepare(`UPDATE calendars SET access_token = ?, token_expiry = ?, updated_at = strftime('%s','now') WHERE id = ?`).run(accessToken, expiry, calendarRow.id);
      } catch {}
      return accessToken;
    }
  } catch {}
  return null;
}

async function ensureAccessToken(calendarRow) {
  if (isTokenValid(calendarRow)) return calendarRow.access_token;
  return await refreshAccessToken(calendarRow);
}

export async function freeBusy(calendarRow, timeMinISO, timeMaxISO) {
  try {
    const token = await ensureAccessToken(calendarRow);
    if (!token || !calendarRow?.calendar_id) return [];
    const url = `${GOOGLE_CAL_BASE}/freeBusy`;
    const payload = {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: calendarRow.calendar_id }]
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) return [];
    const j = await resp.json();
    const arr = j?.calendars?.[calendarRow.calendar_id]?.busy || [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function createEvent(calendarRow, event) {
  try {
    const token = await ensureAccessToken(calendarRow);
    if (!token || !calendarRow?.calendar_id) return { id: null };
    const url = `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(calendarRow.calendar_id)}/events`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(event)
    });
    if (!resp.ok) return { id: null };
    const j = await resp.json();
    return { id: j?.id || null };
  } catch {
    return { id: null };
  }
}

export async function updateEvent(calendarRow, eventId, patch) {
  try {
    const token = await ensureAccessToken(calendarRow);
    if (!token || !calendarRow?.calendar_id || !eventId) return false;
    const url = `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(calendarRow.calendar_id)}/events/${encodeURIComponent(eventId)}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function deleteEvent(calendarRow, eventId) {
  try {
    const token = await ensureAccessToken(calendarRow);
    if (!token || !calendarRow?.calendar_id || !eventId) return false;
    const url = `${GOOGLE_CAL_BASE}/calendars/${encodeURIComponent(calendarRow.calendar_id)}/events/${encodeURIComponent(eventId)}`;
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` }
    });
    return resp.ok || resp.status === 204;
  } catch {
    return false;
  }
}


