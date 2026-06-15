import fetch from "node-fetch";

export async function checkWhatsAppGroupsSupport(cfg = {}) {
  const phoneNumberId = String(cfg.phone_number_id || "").trim();
  const token = String(cfg.whatsapp_token || "").trim();
  if (!phoneNumberId || !token) {
    return {
      supported: false,
      reason: "missing_config",
      message: "WhatsApp token and Phone Number ID are required.",
    };
  }

  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/groups?limit=5`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await resp.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 500) };
    }

    if (resp.ok) {
      const groups = body?.data?.groups || body?.groups || [];
      return {
        supported: true,
        reason: "ok",
        message: groups.length
          ? `Groups API is enabled. Found ${groups.length} active group(s).`
          : "Groups API is enabled, but no active groups yet.",
        groups: Array.isArray(groups)
          ? groups.map((g) => ({
              id: g.id,
              subject: g.subject || g.name || null,
            }))
          : [],
      };
    }

    const errMsg = body?.error?.message || text.slice(0, 300) || `HTTP ${resp.status}`;
    const errCode = body?.error?.code;
    return {
      supported: false,
      reason: "api_error",
      message: errMsg,
      errorCode: errCode,
      status: resp.status,
    };
  } catch (e) {
    return {
      supported: false,
      reason: "network_error",
      message: e?.message || String(e),
    };
  }
}
