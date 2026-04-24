
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import https from "node:https";
const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000 });

async function postWhatsAppMessage(cfg, payload, { retry = false } = {}) {
  if (!cfg.phone_number_id || !cfg.whatsapp_token) {
    try {
      console.error('[WA] Missing configuration', {
        hasPhoneId: !!cfg?.phone_number_id,
        hasToken: !!cfg?.whatsapp_token,
        phoneId_tail: String(cfg?.phone_number_id || '').slice(-6)
      });
    } catch {}
    throw new Error("WhatsApp is not configured");
  }
  const url = `https://graph.facebook.com/v20.0/${cfg.phone_number_id}/messages`;
  const headers = {
    "Authorization": `Bearer ${cfg.whatsapp_token}`,
    "Content-Type": "application/json"
  };
  if (process.env.DEBUG_LOGS === '1') {
    try {
      const meta = {
        target: 'whatsapp_send',
        phoneId_tail: String(cfg.phone_number_id || '').slice(-6),
        hasToken: !!cfg.whatsapp_token,
        payload_type: payload?.type || 'text',
        to_tail: String(payload?.to || '').slice(-6),
        has_context: !!payload?.context,
        retry
      };
      console.log('[WA] Request meta:', meta);
    } catch {}
  }

  if (!retry) {
    try {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), agent: keepAliveAgent });
      if (!resp.ok) {
        const text = await resp.text();
        console.error('[WA] HTTP error', { status: resp.status, body: text.slice(0, 2000) });
        if (resp.status === 401) {
          throw new Error(`WhatsApp authentication failed (401): Invalid or expired token. Please check your WhatsApp Business API configuration.`);
        }
        throw new Error(`WhatsApp error ${resp.status}: ${text}`);
      }
      const json = await resp.json();
      if (process.env.DEBUG_LOGS === '1') { try { console.log('[WA] HTTP ok', { hasMessages: !!json?.messages?.[0]?.id, keys: Object.keys(json||{}).slice(0, 12) }); } catch {} }
      return json;
    } catch (e) {
      console.error('[WA] Network/Fetch error:', e?.message || e);
      throw e;
    }
  }

  const maxRetries = 3;
  let attempt = 0;
  let lastErr;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), agent: keepAliveAgent });
      if (resp.status === 401) {
        const text = await resp.text();
        console.error('[WA] Auth 401 during retry', { body: text.slice(0, 2000) });
        throw new Error(`WhatsApp authentication failed (401): Invalid or expired token. Please check your WhatsApp Business API configuration.`);
      }
      if (resp.status >= 500) throw new Error(`WhatsApp 5xx ${resp.status}`);
      if (!resp.ok) {
        const text = await resp.text();
        console.error('[WA] Non-OK response during retry', { status: resp.status, body: text.slice(0, 2000) });
        throw new Error(`WhatsApp error ${resp.status}: ${text}`);
      }
      const json = await resp.json();
      if (process.env.DEBUG_LOGS === '1') { try { console.log('[WA] Retry HTTP ok', { hasMessages: !!json?.messages?.[0]?.id, keys: Object.keys(json||{}).slice(0, 12) }); } catch {} }
      return json;
    } catch (e) {
      lastErr = e;
      if (e.message.includes('authentication failed')) {
        throw e;
      }
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
export async function sendWhatsAppText(to, body, cfg, replyToMessageId = null) {
  const payload = { 
    messaging_product: "whatsapp", 
    to, 
    text: { body }
  };
  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }
  if (process.env.DEBUG_LOGS === '1') { try { console.log('[WA] Sending text', { to: String(to).slice(-6), hasToken: !!cfg?.whatsapp_token, hasPhoneId: !!cfg?.phone_number_id }); } catch {} }

  let result;
  try {
    result = await postWhatsAppMessage(cfg, payload, { retry: true });
  } catch (e) {
    console.error('[WA] Send text error:', { message: e?.message || String(e) });
    throw e;
  }
  if (process.env.DEBUG_LOGS === '1') {
    try {
      const meta = {
        hasMessages: !!(result && result.messages && result.messages[0] && result.messages[0].id),
        rawKeys: result ? Object.keys(result).slice(0, 10) : null
      };
      console.log('[WA] Send text API result', meta);
    } catch {}
  }
  if (cfg.user_id && result?.messages?.[0]?.id) {
    try {
      const { incrementUsage } = await import('./usage.mjs');
      incrementUsage(cfg.user_id, 'outbound_messages');
    } catch (e) {
      console.error('Failed to track outbound message usage:', e.message);
    }
  }
  
  return result;
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
            title: 'Options',
            rows: (Array.isArray(rows) ? rows : []).slice(0, 10).map(r => ({
              id: r.id,
              title: String(r.title || '').slice(0, 24),
              description: r.description ? String(r.description).slice(0, 72) : null
            }))
          }
        ]
      }
    }
  }
  return await postWhatsAppMessage(cfg, payload, { retry: false });
}
export async function sendWhatsappReaction(to, messageId, emoji, cfg) {
  if (!cfg.phone_number_id || !cfg.whatsapp_token) {
    throw new Error("WhatsApp is not configured");
  }
  if (!messageId || !emoji) {
    return { ok: false, status: 400, body: 'Missing messageId or emoji' };
  }
  
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
    body: JSON.stringify(payload),
    agent: keepAliveAgent
  });
  
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    try { console.warn('[WA Reaction] Non-OK response', { status: resp.status, body: text.slice(0, 500) }); } catch {}
    return { ok: false, status: resp.status, body: text };
  }
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { ok: true, status: resp.status, body: json };
}

export async function sendWhatsappImage(to, imageUrl, caption, cfg, replyToMessageId = null) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { 
      link: imageUrl,
      ...(caption ? { caption } : {})
    }
  };
  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }
  
  const result = await postWhatsAppMessage(cfg, payload, { retry: true });
  if (cfg.user_id && result?.messages?.[0]?.id) {
    try {
      const { incrementUsage } = await import('./usage.mjs');
      incrementUsage(cfg.user_id, 'outbound_messages');
    } catch (e) {
      console.error('Failed to track outbound image message usage:', e.message);
    }
  }
  
  return result;
}

export async function sendWhatsappImageBase64(to, imagePath, caption, cfg) {
  try {
    const imageBuffer = await fs.promises.readFile(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const mimeType = mimeTypes[ext] || 'image/jpeg';
    let publicImageUrl = null;
    try {
      const formData = new FormData();
      formData.append('file', imageBuffer, {
        filename: path.basename(imagePath),
        contentType: mimeType
      });
      
      const uploadResponse = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders(),
        agent: keepAliveAgent
      });
      
      if (uploadResponse.ok) {
        const uploadResult = await uploadResponse.json();
        if (uploadResult.status === 'success') {
          publicImageUrl = uploadResult.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
          console.log('Image uploaded to tmpfiles.org:', publicImageUrl);
        }
      }
    } catch (e) {
      console.log('tmpfiles.org upload failed:', e.message);
    }
    if (!publicImageUrl) {
      try {
        const formData = new FormData();
        formData.append('file', imageBuffer, {
          filename: path.basename(imagePath),
          contentType: mimeType
        });
        
        const uploadResponse = await fetch('https://0x0.st', {
          method: 'POST',
          body: formData,
          headers: formData.getHeaders(),
          agent: keepAliveAgent
        });
        
        if (uploadResponse.ok) {
          publicImageUrl = (await uploadResponse.text()).trim();
          console.log('Image uploaded to 0x0.st:', publicImageUrl);
        }
      } catch (e) {
        console.log('0x0.st upload failed:', e.message);
      }
    }
    
    if (!publicImageUrl) {
      throw new Error('Failed to upload image to any hosting service');
    }
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { 
        link: publicImageUrl,
        ...(caption ? { caption } : {})
      }
    };
    
    const result = await postWhatsAppMessage(cfg, payload, { retry: true });
    if (cfg.user_id && result?.messages?.[0]?.id) {
      try {
        const { incrementUsage } = await import('./usage.mjs');
        incrementUsage(cfg.user_id, 'outbound_messages');
      } catch (e) {
        console.error('Failed to track outbound image message usage:', e.message);
      }
    }
    
    return result;
  } catch (error) {
    console.error('Error sending base64 image:', error);
    throw error;
  }
}
export async function sendWhatsappDocument(to, documentUrl, filename, caption, cfg, replyToMessageId = null) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document: { 
      link: documentUrl,
      filename: filename,
      ...(caption ? { caption } : {})
    }
  };
  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }
  
  const result = await postWhatsAppMessage(cfg, payload, { retry: true });
  if (cfg.user_id && result?.messages?.[0]?.id) {
    try {
      const { incrementUsage } = await import('./usage.mjs');
      incrementUsage(cfg.user_id, 'outbound_messages');
    } catch (e) {
      console.error('Failed to track outbound document message usage:', e.message);
    }
  }
  
  return result;
}
export async function sendWhatsappDocumentBase64(to, documentPath, filename, caption, cfg) {
  try {
    const documentBuffer = await fs.promises.readFile(documentPath);
    const ext = path.extname(documentPath).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.rtf': 'application/rtf',
      '.odt': 'application/vnd.oasis.opendocument.text',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.csv': 'text/csv',
      '.zip': 'application/zip',
      '.rar': 'application/x-rar-compressed'
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    let publicDocumentUrl = null;
    try {
      const formData = new FormData();
      formData.append('file', documentBuffer, {
        filename: filename,
        contentType: mimeType
      });
      
      const uploadResponse = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders(),
        agent: keepAliveAgent
      });
      
      if (uploadResponse.ok) {
        const uploadResult = await uploadResponse.json();
        if (uploadResult.status === 'success') {
          publicDocumentUrl = uploadResult.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
          console.log('Document uploaded to tmpfiles.org:', publicDocumentUrl);
        }
      }
    } catch (e) {
      console.log('tmpfiles.org upload failed:', e.message);
    }
    
    if (!publicDocumentUrl) {
      throw new Error('Failed to upload document to hosting service');
    }
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { 
        link: publicDocumentUrl,
        filename: filename,
        ...(caption ? { caption } : {})
      }
    };
    
    const result = await postWhatsAppMessage(cfg, payload, { retry: true });
    if (cfg.user_id && result?.messages?.[0]?.id) {
      try {
        const { incrementUsage } = await import('./usage.mjs');
        incrementUsage(cfg.user_id, 'outbound_messages');
      } catch (e) {
        console.error('Failed to track outbound document message usage:', e.message);
      }
    }
    
    return result;
  } catch (error) {
    console.error('Error sending base64 document:', error);
    throw error;
  }
}

export async function sendProductCatalog(to, products, cfg) {
  if (!Array.isArray(products) || products.length === 0) {
    return await sendWhatsAppText(to, "No products available at the moment.", cfg);
  }

  let message = "🛍️ *Our Products*\n\n";

  for (let i = 0; i < Math.min(products.length, 10); i++) {
    const product = products[i];
    message += `*${i + 1}. ${product.title}*\n`;
    message += `💰 Price: $${product.price}\n`;

    if (product.description) {
      message += `📝 ${product.description.substring(0, 100)}${product.description.length > 100 ? '...' : ''}\n`;
    }

    message += '\n';
  }

  message += "Reply with a product number to learn more or place an order!";

  return await sendWhatsAppText(to, message, cfg);
}
export async function sendProductDetails(to, product, cfg) {
  let message = `🛍️ *${product.title}*\n\n`;

  if (product.image) {
    await sendWhatsappImage(to, product.image, product.title, cfg);
  }

  message += `💰 Price: $${product.price}\n`;

  if (product.description) {
    message += `📝 ${product.description}\n\n`;
  }

  if (product.variants && product.variants.length > 0) {
    message += "*Available Options:*\n";
    product.variants.forEach((variant, index) => {
      message += `${index + 1}. ${variant.title} - $${variant.price}\n`;
    });
    message += '\n';
  }

  message += "Reply 'BUY' to place an order or ask me any questions!";

  return await sendWhatsAppText(to, message, cfg);
}
export async function sendOrderConfirmation(to, order, cfg) {
  let message = `✅ *Order Confirmed!*\n\n`;
  message += `📋 Order #${order.order_number}\n`;
  message += `💰 Total: $${order.total_price}\n\n`;

  if (order.line_items && order.line_items.length > 0) {
    message += "*Items Ordered:*\n";
    order.line_items.forEach(item => {
      message += `• ${item.quantity}x ${item.title} - $${item.price}\n`;
    });
    message += '\n';
  }

  message += `🚚 We'll send you updates on your order status.`;
  message += `\n\nThank you for shopping with us! 🛍️`;

  return await sendWhatsAppText(to, message, cfg);
}
export async function sendOrderStatusUpdate(to, order, cfg) {
  let message = `📦 *Order Update*\n\n`;
  message += `📋 Order #${order.order_number}\n`;
  message += `📊 Status: ${order.financial_status}\n`;

  if (order.fulfillment_status) {
    message += `🚚 Fulfillment: ${order.fulfillment_status}\n`;
  }

  if (order.tracking_numbers && order.tracking_numbers.length > 0) {
    message += `\n📍 Tracking: ${order.tracking_urls ? order.tracking_urls[0] : order.tracking_numbers[0]}\n`;
  }

  return await sendWhatsAppText(to, message, cfg);
}
export async function sendAbandonedCartReminder(to, cart, cfg) {
  let message = `🛒 *Don't forget your cart!*\n\n`;
  message += `You have ${cart.line_items?.length || 0} item(s) waiting in your cart:\n\n`;

  if (cart.line_items) {
    cart.line_items.forEach(item => {
      message += `• ${item.quantity}x ${item.title}\n`;
    });
  }

  message += `\n💰 Total: $${cart.total_price}\n\n`;
  message += `Complete your purchase now or your cart will be cleared soon.\n\n`;
  message += `Reply 'CHECKOUT' to complete your order!`;

  return await sendWhatsAppText(to, message, cfg);
}
export async function sendProductSelectionList(to, products, cfg) {
  if (!Array.isArray(products) || products.length === 0) {
    return await sendWhatsAppText(to, "No products available.", cfg);
  }

  const rows = products.slice(0, 10).map((product, index) => ({
    id: `product_${product.id}`,
    title: product.title.substring(0, 24),
    description: `$${product.price}`
  }));

  return await sendWhatsappList(
    to,
    "🛍️ Select a Product",
    "Choose a product to view details and purchase",
    "View Products",
    rows,
    cfg
  );
}

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
  const result = await postWhatsAppMessage(cfg, payload, { retry: false });
  if (cfg.user_id && result?.messages?.[0]?.id) {
    try {
      const { incrementUsage } = await import('./usage.mjs');
      incrementUsage(cfg.user_id, 'template_messages');
    } catch (e) {
      console.error('Failed to track template message usage:', e.message);
    }
  }
  
  return result;
}
