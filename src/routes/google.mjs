import { ensureAuthed, getCurrentUserId, getSignedInEmail } from "../middleware/auth.mjs";
import { PUBLIC_BASE_URL } from "../config.mjs";
import { getDB } from "../db-mongodb.mjs";
import fetch from "node-fetch";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || null;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const CAL_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";

export default function registerGoogleRoutes(app) {
  // Start OAuth: redirect to Google
  app.get("/google/connect", ensureAuthed, async (req, res) => {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).send("Google OAuth not configured. Missing GOOGLE_CLIENT_ID/SECRET.");
    }
    const userId = getCurrentUserId(req);
    const redirectUri = `${PUBLIC_BASE_URL}/google/callback`;
    const state = encodeURIComponent(JSON.stringify({ u: userId }));
    const scopes = [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar"
    ].join(" ");
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      `?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&access_type=offline&prompt=consent` +
      `&state=${state}`;
    res.redirect(url);
  });

  // OAuth callback: exchange code, store calendar row
  app.get("/google/callback", ensureAuthed, async (req, res) => {
    try {
      const code = String(req.query.code || "");
      const redirectUri = `${PUBLIC_BASE_URL}/google/callback`;
      if (!code) return res.status(400).send("Missing code");
      const form = new URLSearchParams({
        code,
        client_id: CLIENT_ID || "",
        client_secret: CLIENT_SECRET || "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
      });
      const tokenResp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form
      });
      if (!tokenResp.ok) {
        return res.status(400).send("Token exchange failed");
      }
      const tokenJson = await tokenResp.json();
      const accessToken = tokenJson.access_token || null;
      const refreshToken = tokenJson.refresh_token || null;
      const expiresIn = Number(tokenJson.expires_in || 3600);
      const tokenExpiry = Math.floor(Date.now() / 1000) + expiresIn;

      // Fetch user email
      let accountEmail = null;
      if (accessToken) {
        try {
          const infoResp = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
          const info = await infoResp.json().catch(()=>null);
          accountEmail = info?.email || null;
        } catch {}
      }

      // Prefer the 'primary' calendar id; fallback: first from calendarList
      let calendarId = "primary";
      try {
        const listResp = await fetch(CAL_LIST_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (listResp.ok) {
          const data = await listResp.json();
          if (Array.isArray(data?.items) && data.items.length > 0) {
            const primary = data.items.find(i => i.primary) || data.items[0];
            calendarId = primary?.id || "primary";
          }
        }
      } catch {}

      const userId = getCurrentUserId(req);
      const db = getDB();
      // Upsert single calendar row for this user (one account)
      await db.collection("calendars").updateOne(
        { user_id: String(userId) },
        {
          $set: {
            provider: "google",
            account_email: accountEmail,
            calendar_id: calendarId,
            access_token: accessToken,
            token_expiry: tokenExpiry,
            updatedAt: new Date()
          },
          $setOnInsert: { user_id: String(userId), createdAt: new Date() }
        },
        { upsert: true }
      );
      if (refreshToken) {
        await db.collection("calendars").updateOne(
          { user_id: String(userId) },
          { $set: { refresh_token: refreshToken, updatedAt: new Date() } }
        );
      }
      return res.redirect("/bookings");
    } catch (e) {
      return res.status(500).send("OAuth error");
    }
  });

  app.post("/google/disconnect", ensureAuthed, async (req, res) => {
    try {
      const userId = getCurrentUserId(req);
      const db = getDB();
      await db.collection("calendars").deleteOne({ user_id: String(userId) });
      return res.redirect("/bookings");
    } catch {
      return res.redirect("/bookings");
    }
  });
}


