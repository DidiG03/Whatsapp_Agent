/**
 * Helpers for WhatsApp message templates (24h reopen, campaigns).
 */

export function extractTemplateBodyAndVars(tplDoc) {
  let bodyText = "";
  if (typeof tplDoc?.body === "string" && tplDoc.body.trim()) {
    bodyText = tplDoc.body.trim();
  } else if (Array.isArray(tplDoc?.components)) {
    const bodyComp = tplDoc.components.find(
      (c) => String(c?.type || "").toUpperCase() === "BODY" && typeof c?.text === "string"
    );
    if (bodyComp?.text) bodyText = String(bodyComp.text).trim();
  }

  const matches = bodyText.match(/\{\{(\d+)\}\}/g) || [];
  const indices = [...new Set(
    matches
      .map((m) => Number((m.match(/\d+/) || [])[0]))
      .filter((n) => Number.isFinite(n) && n > 0)
  )].sort((a, b) => a - b);

  return { bodyText, indices };
}

export function languageFallbacks(language) {
  const lang = String(language || "en_US").trim() || "en_US";
  const out = [lang];
  if (lang === "en") out.push("en_US");
  if (lang === "en_US") out.push("en");
  return [...new Set(out)];
}

export async function findWaTemplateDoc(db, userId, name, language) {
  const uid = String(userId || "");
  const templateName = String(name || "").trim();
  if (!uid || !templateName) return { doc: null, language: String(language || "en_US") };

  for (const lang of languageFallbacks(language)) {
    const doc = await db.collection("wa_templates").findOne({
      user_id: uid,
      name: templateName,
      language: lang,
    });
    if (doc) return { doc, language: lang };
  }
  return { doc: null, language: String(language || "en_US").trim() || "en_US" };
}

export function buildTemplateBodyComponents(tplDoc, formValues = {}, defaults = {}) {
  const { indices } = extractTemplateBodyAndVars(tplDoc);
  if (!indices.length) return [];

  const parameters = indices.map((idx) => {
    const fromForm = String(formValues?.[`var${idx}`] || "").trim();
    const fromDefault = String(defaults?.[idx] ?? defaults?.[String(idx)] ?? "").trim();
    const text = (fromForm || fromDefault || "—").slice(0, 1024);
    return { type: "text", text };
  });

  return [{ type: "body", parameters }];
}

export function buildTemplateDisplayText(tplDoc, formValues = {}, defaults = {}) {
  const { bodyText, indices } = extractTemplateBodyAndVars(tplDoc);
  if (!bodyText) return "";
  if (!indices.length) return bodyText;

  let out = bodyText;
  for (const idx of indices) {
    const fromForm = String(formValues?.[`var${idx}`] || "").trim();
    const fromDefault = String(defaults?.[idx] ?? defaults?.[String(idx)] ?? "").trim();
    const val = (fromForm || fromDefault || "—").slice(0, 1024);
    out = out.replace(new RegExp(`\\{\\{${idx}\\}\\}`, "g"), val);
  }
  return out;
}

export function isTemplateTranslationError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("132001") || /does not exist in the translation/i.test(msg);
}

export function orderTemplateLanguageCandidates(preferredLang, dbLanguages = []) {
  const ordered = [];
  const add = (lang) => {
    const code = String(lang || "").trim();
    if (code && !ordered.includes(code)) ordered.push(code);
  };
  for (const lang of languageFallbacks(preferredLang)) add(lang);
  for (const lang of dbLanguages) add(lang);
  for (const lang of ["en_US", "en", "en_GB", "sq", "sq_AL"]) add(lang);
  return ordered;
}

export function orderMetaLanguages(preferredLang, metaLanguages = []) {
  const approved = [...new Set(
    (metaLanguages || [])
      .map((lang) => String(lang || "").trim())
      .filter(Boolean)
  )];
  if (!approved.length) return [];

  const ordered = [];
  for (const lang of languageFallbacks(preferredLang)) {
    if (approved.includes(lang) && !ordered.includes(lang)) ordered.push(lang);
  }
  for (const lang of approved) {
    if (!ordered.includes(lang)) ordered.push(lang);
  }
  return ordered;
}

export function buildTemplateNotFoundMessage(templateName, approvedTemplates = []) {
  const name = String(templateName || "").trim() || "template";
  const examples = (approvedTemplates || [])
    .slice(0, 4)
    .map((t) => `${t.name} (${t.language})`)
    .join(", ");
  let msg = `Template "${name}" is not on your connected WhatsApp account. It may still appear in the app from an old sync — open Campaigns, click Sync from Meta, then choose a template that shows APPROVED (not "Not on account").`;
  if (examples) msg += ` Available now: ${examples}.`;
  return msg;
}

export function templateSyncKey(name, language) {
  return `${String(name || "").trim()}::${String(language || "").trim()}`;
}

export async function markStaleTemplates(db, userId, seenKeys, { onlyIfComplete = true } = {}) {
  if (!onlyIfComplete) return 0;
  const uid = String(userId || "");
  if (!uid) return 0;

  const seen = seenKeys instanceof Set ? seenKeys : new Set(seenKeys || []);
  const rows = await db.collection("wa_templates").find({ user_id: uid }).toArray();
  let marked = 0;

  for (const row of rows) {
    const key = templateSyncKey(row?.name, row?.language);
    if (!key || key === "::") continue;
    if (seen.has(key)) continue;
    if (String(row?.status || "").toUpperCase() === "NOT_ON_META") continue;

    await db.collection("wa_templates").updateOne(
      { _id: row._id },
      { $set: { status: "NOT_ON_META", updatedAt: new Date() } }
    );
    marked += 1;
  }

  return marked;
}

async function resolveWabaId(cfg) {
  if (cfg?.waba_id) return String(cfg.waba_id);
  if (!cfg?.whatsapp_token || !cfg?.phone_number_id) return null;
  const fetch = (await import("node-fetch")).default;
  const phoneResp = await fetch(
    `https://graph.facebook.com/v20.0/${encodeURIComponent(String(cfg.phone_number_id))}?fields=whatsapp_business_account`,
    { headers: { Authorization: `Bearer ${cfg.whatsapp_token}` } }
  );
  if (!phoneResp.ok) return null;
  const phoneJson = await phoneResp.json();
  return phoneJson?.whatsapp_business_account?.id
    ? String(phoneJson.whatsapp_business_account.id)
    : null;
}

export async function fetchMetaTemplateLanguages(cfg, templateName) {
  const name = String(templateName || "").trim().toLowerCase();
  if (!name || !cfg?.whatsapp_token) return [];

  const wabaId = await resolveWabaId(cfg);
  if (!wabaId) return [];

  const fetch = (await import("node-fetch")).default;
  const langs = [];
  let url = `https://graph.facebook.com/v20.0/${encodeURIComponent(wabaId)}/message_templates?limit=100`;

  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${cfg.whatsapp_token}` } });
    if (!resp.ok) break;

    const json = await resp.json();
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      if (String(row?.name || "").trim().toLowerCase() !== name) continue;
      if (String(row?.status || "").toUpperCase() !== "APPROVED") continue;
      const lang = String(row?.language || "").trim();
      if (lang && !langs.includes(lang)) langs.push(lang);
    }

    url = json?.paging?.next || null;
    if (langs.length) break;
  }

  return langs;
}

export async function fetchMetaApprovedTemplates(cfg, limit = 8) {
  if (!cfg?.whatsapp_token) return [];

  const wabaId = await resolveWabaId(cfg);
  if (!wabaId) return [];

  const fetch = (await import("node-fetch")).default;
  const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(wabaId)}/message_templates?limit=${Math.min(limit, 50)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${cfg.whatsapp_token}` } });
  if (!resp.ok) return [];

  const json = await resp.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows
    .filter((row) => String(row?.status || "").toUpperCase() === "APPROVED")
    .map((row) => ({
      name: String(row?.name || "").trim(),
      language: String(row?.language || "").trim(),
    }))
    .filter((row) => row.name && row.language);
}

export async function listTemplateLanguages(db, userId, name) {
  const templateName = String(name || "").trim();
  if (!templateName) return [];
  const rows = await db.collection("wa_templates").find({
    user_id: String(userId || ""),
    name: templateName,
  }).project({ language: 1, status: 1 }).toArray();
  const approved = rows.filter((r) => String(r.status || "").toUpperCase() === "APPROVED");
  const source = approved.length ? approved : rows;
  return [...new Set(source.map((r) => String(r.language || "").trim()).filter(Boolean))];
}

export async function sendResolvedWhatsAppTemplate({
  db,
  userId,
  cfg,
  to,
  templateName,
  preferredLang,
  formValues = {},
  defaults = {},
  sendTemplate,
}) {
  const name = String(templateName || "").trim();
  if (!name) throw new Error("No template name configured");

  const [metaLangs, approvedTemplates] = await Promise.all([
    fetchMetaTemplateLanguages(cfg, name),
    fetchMetaApprovedTemplates(cfg),
  ]);

  if (!metaLangs.length) {
    throw new Error(buildTemplateNotFoundMessage(name, approvedTemplates));
  }

  const candidates = orderMetaLanguages(preferredLang, metaLangs);
  let lastErr;

  for (const lang of candidates) {
    const doc = await db.collection("wa_templates").findOne({
      user_id: String(userId || ""),
      name,
      language: lang,
    });
    const components = buildTemplateBodyComponents(doc, formValues, defaults);
    const displayText = buildTemplateDisplayText(doc, formValues, defaults);
    const { bodyText: tplBodyText } = extractTemplateBodyAndVars(doc);
    try {
      const resp = await sendTemplate(to, name, lang, components, { ...cfg, user_id: userId });
      return { resp, language: lang, components, displayText: displayText || tplBodyText || name };
    } catch (err) {
      lastErr = err;
      if (!isTemplateTranslationError(err)) throw err;
    }
  }

  throw lastErr || new Error("Template send failed: no matching translation found.");
}

export function summarizeWhatsAppError(err) {
  const raw = String(err?.message || err || "").trim();
  if (!raw) return "Failed to send template. Please try again.";
  const jsonMatch = raw.match(/\{[\s\S]*\}$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const detail = parsed?.error?.error_user_msg
        || parsed?.error?.message
        || parsed?.error?.error_data?.details;
      if (detail) return String(detail).slice(0, 240);
    } catch {}
  }
  if (raw.includes("WhatsApp error")) return raw.replace(/^WhatsApp error \d+:\s*/, "").slice(0, 240);
  return raw.slice(0, 240);
}
