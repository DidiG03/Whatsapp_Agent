import fetch from "node-fetch";

const WEBSITE_FETCH_TIMEOUT_MS = Number(process.env.WEBSITE_FETCH_TIMEOUT_MS || 8000);
const WEBSITE_MAX_BYTES = Number(process.env.WEBSITE_MAX_BYTES || 512000);
const WEBSITE_TEXT_MAX = Number(process.env.WEBSITE_TEXT_MAX || 3200);
const WEBSITE_CACHE_TTL_MS = Number(process.env.WEBSITE_CACHE_TTL_MS || 1800000);

const websiteCache = new Map();

function isBlockedHostname(hostname = "") {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h) || /^fe80:/i.test(h) || /^fc00:/i.test(h) || /^fd00:/i.test(h)) return true;
  return false;
}

function normalizeWebsiteUrl(raw = "") {
  let value = String(raw || "").trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (isBlockedHostname(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function htmlToPlainText(html = "") {
  let source = String(html || "");
  source = source.replace(/<script[\s\S]*?<\/script>/gi, " ");
  source = source.replace(/<style[\s\S]*?<\/style>/gi, " ");
  source = source.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  const metaDesc = (
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(source)?.[1]
    || /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i.exec(source)?.[1]
    || ""
  ).trim();

  const body = source
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = [];
  if (title) parts.push(`Page title: ${title}`);
  if (metaDesc) parts.push(`Description: ${metaDesc}`);
  if (body) parts.push(body);
  return parts.join("\n").slice(0, WEBSITE_TEXT_MAX);
}

export async function fetchWebsiteTextSnippet(rawUrl, options = {}) {
  const url = normalizeWebsiteUrl(rawUrl);
  if (!url) return null;

  const cacheKey = url;
  const now = Date.now();
  const cached = websiteCache.get(cacheKey);
  if (cached && cached.expires > now && !options.refresh) {
    return cached.text;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBSITE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "User-Agent": "CodeOrbitAgentBot/1.0 (+https://codeorbit.tech)",
      },
    });

    if (!response.ok) return null;

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml")) {
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > WEBSITE_MAX_BYTES) return null;

    const text = htmlToPlainText(Buffer.from(buffer).toString("utf8"));
    if (!text) return null;

    websiteCache.set(cacheKey, { text, expires: now + WEBSITE_CACHE_TTL_MS });
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
