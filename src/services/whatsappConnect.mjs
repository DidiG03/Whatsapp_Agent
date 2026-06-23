import crypto from "node:crypto";
import fetch from "node-fetch";
import {
  META_APP_ID,
  META_APP_SECRET,
  META_EMBEDDED_SIGNUP_CONFIG_ID,
  META_GRAPH_VERSION,
  PUBLIC_BASE_URL,
} from "../config.mjs";
import { getSettingsForUser, upsertSettingsForUser } from "./settings.mjs";

export function isMetaEmbeddedSignupConfigured() {
  return Boolean(META_APP_ID && META_APP_SECRET && META_EMBEDDED_SIGNUP_CONFIG_ID);
}

export function createVerifyToken() {
  return crypto.randomBytes(24).toString("hex");
}

function graphUrl(path) {
  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`;
}

function metaErrorMessage(data, fallback) {
  return data?.error?.message || data?.error_message || fallback;
}

export async function exchangeEmbeddedSignupCode(code) {
  const url = new URL(graphUrl("oauth/access_token"));
  url.searchParams.set("client_id", META_APP_ID);
  url.searchParams.set("client_secret", META_APP_SECRET);
  url.searchParams.set("code", String(code || "").trim());
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    const err = new Error(metaErrorMessage(data, "Failed to exchange Meta authorization code"));
    err.meta = data;
    throw err;
  }
  return String(data.access_token);
}

async function graphPost(path, token, body = {}) {
  const resp = await fetch(graphUrl(path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

async function graphGet(path, token) {
  const resp = await fetch(graphUrl(path), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function fetchPhoneNumberDetails(phoneNumberId, token) {
  const { ok, data } = await graphGet(
    `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,whatsapp_business_account`,
    token
  );
  if (!ok) return null;
  return data;
}

async function registerCloudApiPhone(phoneNumberId, token) {
  const pin = String(process.env.META_PHONE_REGISTER_PIN || "").trim();
  if (!pin) return { skipped: true };
  return graphPost(`${encodeURIComponent(phoneNumberId)}/register`, token, {
    messaging_product: "whatsapp",
    pin,
  });
}

async function subscribeAppToWaba(wabaId, token) {
  return graphPost(`${encodeURIComponent(wabaId)}/subscribed_apps`, token, {});
}

export async function validateWhatsAppToken(phoneNumberId, token) {
  const { ok, status } = await graphGet(encodeURIComponent(String(phoneNumberId)), token);
  if (status === 401 || status === 403) return { valid: false, status };
  return { valid: ok, status };
}

export function buildConnectionStatus(settings = {}) {
  const hasToken = Boolean(settings.whatsapp_token);
  const hasPhoneId = Boolean(settings.phone_number_id);
  return {
    connected: hasToken && hasPhoneId,
    hasToken,
    hasPhoneId,
    hasWabaId: Boolean(settings.waba_id),
    phoneNumberId: settings.phone_number_id || null,
    wabaId: settings.waba_id || null,
    businessPhone: settings.business_phone || null,
    verifyTokenSet: Boolean(settings.verify_token),
    embeddedSignupAvailable: isMetaEmbeddedSignupConfigured(),
    webhookUrl: `${PUBLIC_BASE_URL}/webhook`,
  };
}

export async function completeWhatsAppConnection(userId, payload = {}) {
  const code = String(payload.code || "").trim();
  const phoneNumberId = String(payload.phone_number_id || "").trim();
  let wabaId = String(payload.waba_id || "").trim();

  if (!isMetaEmbeddedSignupConfigured()) {
    throw new Error("WhatsApp Embedded Signup is not configured on this server.");
  }
  if (!code) throw new Error("Missing authorization code from Meta.");
  if (!phoneNumberId) throw new Error("Missing phone number ID from Meta signup.");

  const accessToken = await exchangeEmbeddedSignupCode(code);
  const current = await getSettingsForUser(userId);
  const verifyToken = current.verify_token || createVerifyToken();
  const appSecret = META_APP_SECRET || current.app_secret || null;

  try {
    const registerResult = await registerCloudApiPhone(phoneNumberId, accessToken);
    if (registerResult?.skipped !== true && !registerResult?.ok) {
      console.warn("[WA Connect] phone register skipped/failed:", registerResult?.data?.error?.message || registerResult?.status);
    }
  } catch (error) {
    console.warn("[WA Connect] phone register error:", error?.message || error);
  }

  const phoneDetails = await fetchPhoneNumberDetails(phoneNumberId, accessToken);
  if (!wabaId) {
    wabaId = String(phoneDetails?.whatsapp_business_account?.id || "").trim();
  }

  if (wabaId) {
    try {
      const sub = await subscribeAppToWaba(wabaId, accessToken);
      if (!sub.ok) {
        console.warn("[WA Connect] subscribed_apps failed:", sub.data?.error?.message || sub.status);
      }
    } catch (error) {
      console.warn("[WA Connect] subscribed_apps error:", error?.message || error);
    }
  }

  const businessPhone = String(phoneDetails?.display_phone_number || current.business_phone || "")
    .replace(/\D/g, "") || null;

  const tokenCheck = await validateWhatsAppToken(phoneNumberId, accessToken);
  if (!tokenCheck.valid) {
    throw new Error(`Connected token failed validation (${tokenCheck.status || "unknown"}).`);
  }

  await upsertSettingsForUser(userId, {
    phone_number_id: phoneNumberId,
    waba_id: wabaId || null,
    whatsapp_token: accessToken,
    verify_token: verifyToken,
    app_secret: appSecret,
    business_phone: businessPhone,
  });

  return {
    success: true,
    phone_number_id: phoneNumberId,
    waba_id: wabaId || null,
    business_phone: businessPhone,
    verified_name: phoneDetails?.verified_name || null,
    webhook_url: `${PUBLIC_BASE_URL}/webhook`,
    verify_token: verifyToken,
  };
}

export async function disconnectWhatsApp(userId) {
  await upsertSettingsForUser(userId, {
    phone_number_id: null,
    waba_id: null,
    whatsapp_token: null,
    business_phone: null,
  });
  return { success: true };
}
