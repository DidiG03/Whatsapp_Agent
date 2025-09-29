/**
 * WhatsApp Graph API client.
 * Exposes a resilient text send function with basic exponential backoff.
 */
import fetch from "node-fetch";

async function postWhatsAppMessage(cfg, payload, { retry = false } = {}) {
  if (!cfg.phone_number_id || !cfg.whatsapp_token) throw new Error("WhatsApp is not configured");
  const url = `https://graph.facebook.com/v20.0/${cfg.phone_number_id}/messages`;
  const headers = {
    "Authorization": `Bearer ${cfg.whatsapp_token}`,
    "Content-Type": "application/json"
  };

  if (!retry) {
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`WhatsApp error ${resp.status}: ${text}`);
    }
    return await resp.json();
  }

  const maxRetries = 3;
  let attempt = 0;
  let lastErr;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      if (resp.status >= 500) throw new Error(`WhatsApp 5xx ${resp.status}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`WhatsApp error ${resp.status}: ${text}`);
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/**
 * Send a WhatsApp text message via Meta Graph API.
 * Retries transient errors with exponential backoff up to 3 attempts.
 * @param {string} to Recipient phone number (digits or E.164 accepted by API)
 * @param {string} body Message text content
 * @param {{ phone_number_id?: string, whatsapp_token?: string }} cfg Tenant configuration
 * @returns {Promise<any>} Raw JSON response from the Graph API
 */
export async function sendWhatsAppText(to, body, cfg) {
  const payload = { messaging_product: "whatsapp", to, text: { body } };
  return await postWhatsAppMessage(cfg, payload, { retry: true });
}


export async function sendWhatsappButton(to, promptText, buttons, cfg) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: promptText
      },
      action: {
        buttons: buttons.map(b => ({
          type: "reply",
          reply: {
            id: b.id,
            title: b.title.slice(0, 20)
          }
        }))
      }
    }
  };
  return await postWhatsAppMessage(cfg, payload, { retry: false });
}

export async function sendWhatsappList(to, headerText, bodyText, buttonLabel, rows, cfg) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: headerText
      },
      body: {
        text: bodyText
      },
      action: {
        button: buttonLabel,
        sections: [
          {
            title: "Choose an option",
            rows: rows.map(r => ({
              id: r.id,
              title: r.title.slice(0, 24),
              description: r.description.slice(0, 72) || null
            }))
          }
        ]
      }
    }
  }
  return await postWhatsAppMessage(cfg, payload, { retry: false });
}

/**
 * React to a specific inbound message with an emoji (e.g., 👍).
 * @param {string} to Recipient phone number (digits or E.164)
 * @param {string} messageId The message id to react to (usually the inbound id)
 * @param {string} emoji The emoji character to use for the reaction
 * @param {{ phone_number_id?: string, whatsapp_token?: string }} cfg Tenant configuration
 */
export async function sendWhatsappReaction(to, messageId, emoji, cfg) {
  if (!cfg.phone_number_id || !cfg.whatsapp_token) throw new Error("WhatsApp is not configured");
  if (!messageId || !emoji) return;
  const url = `https://graph.facebook.com/v20.0/${cfg.phone_number_id}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "reaction",
    reaction: { message_id: messageId, emoji }
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.whatsapp_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    // swallow errors for reactions, they are non-critical
    return;
  }
}

/**
 * Send a WhatsApp document (e.g., PDF) by URL.
 */
export async function sendWhatsappDocument(to, docUrl, filename, cfg) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { link: docUrl, filename: filename || undefined }
  };
  return await postWhatsAppMessage(cfg, payload, { retry: false });
}

/**
 * Send a WhatsApp template message (HSM) using a pre-approved template.
 * @param {string} to recipient phone
 * @param {string} templateName approved template name (e.g., "hello_world")
 * @param {string} language language code (e.g., "en_US")
 * @param {Array} components optional components (header/body/buttons)
 */
export async function sendWhatsAppTemplate(to, templateName, language, components = [], cfg) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: language || "en_US" },
      ...(components && components.length ? { components } : {})
    }
  };
  return await postWhatsAppMessage(cfg, payload, { retry: false });
}
