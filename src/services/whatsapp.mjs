/**
 * WhatsApp Graph API client.
 * Exposes a resilient text send function with basic exponential backoff.
 */
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import FormData from "form-data";

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
      // Handle 401 authentication errors specifically
      if (resp.status === 401) {
        throw new Error(`WhatsApp authentication failed (401): Invalid or expired token. Please check your WhatsApp Business API configuration.`);
      }
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
      if (resp.status === 401) {
        // Don't retry 401 errors - they indicate authentication issues
        const text = await resp.text();
        throw new Error(`WhatsApp authentication failed (401): Invalid or expired token. Please check your WhatsApp Business API configuration.`);
      }
      if (resp.status >= 500) throw new Error(`WhatsApp 5xx ${resp.status}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`WhatsApp error ${resp.status}: ${text}`);
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      // Don't retry if it's an authentication error
      if (e.message.includes('authentication failed')) {
        throw e;
      }
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
 * @param {{ phone_number_id?: string, whatsapp_token?: string, user_id?: string }} cfg Tenant configuration
 * @returns {Promise<any>} Raw JSON response from the Graph API
 */
export async function sendWhatsAppText(to, body, cfg, replyToMessageId = null) {
  const payload = { 
    messaging_product: "whatsapp", 
    to, 
    text: { body }
  };
  
  // Add reply context if replying to a message
  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }
  
  const result = await postWhatsAppMessage(cfg, payload, { retry: true });
  
  // Track outbound message usage
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
  if (!cfg.phone_number_id || !cfg.whatsapp_token) {
    throw new Error("WhatsApp is not configured");
  }
  if (!messageId || !emoji) {
    return;
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
    body: JSON.stringify(payload)
  });
  
  if (!resp.ok) {
    // swallow errors for reactions, they are non-critical
    return;
  }
}


/**
 * Send a WhatsApp image by URL.
 * @param {string} to Recipient phone number (digits or E.164)
 * @param {string} imageUrl URL of the image to send
 * @param {string} caption Optional caption for the image
 * @param {{ phone_number_id?: string, whatsapp_token?: string, user_id?: string }} cfg Tenant configuration
 * @returns {Promise<any>} Raw JSON response from the Graph API
 */
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
  
  // Add reply context if replying to a message
  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }
  
  const result = await postWhatsAppMessage(cfg, payload, { retry: true });
  
  // Track outbound message usage
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
    // Read the image file
    const imageBuffer = fs.readFileSync(imagePath);
    
    // Get file extension to determine MIME type
    const ext = path.extname(imagePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    const mimeType = mimeTypes[ext] || 'image/jpeg';
    
    // Try to upload to a free image hosting service
    let publicImageUrl = null;
    
    // Try tmpfiles.org (free, no API key required)
    try {
      const formData = new FormData();
      formData.append('file', imageBuffer, {
        filename: path.basename(imagePath),
        contentType: mimeType
      });
      
      const uploadResponse = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
      });
      
      if (uploadResponse.ok) {
        const uploadResult = await uploadResponse.json();
        if (uploadResult.status === 'success') {
          // Convert tmpfiles.org URL to direct image URL
          publicImageUrl = uploadResult.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
          console.log('Image uploaded to tmpfiles.org:', publicImageUrl);
        }
      }
    } catch (e) {
      console.log('tmpfiles.org upload failed:', e.message);
    }
    
    // If tmpfiles failed, try another service
    if (!publicImageUrl) {
      try {
        // Try 0x0.st (another free service)
        const formData = new FormData();
        formData.append('file', imageBuffer, {
          filename: path.basename(imagePath),
          contentType: mimeType
        });
        
        const uploadResponse = await fetch('https://0x0.st', {
          method: 'POST',
          body: formData,
          headers: formData.getHeaders()
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
    
    // Now send the image using the public URL
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
    
    // Track outbound message usage
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

/**
 * Send a WhatsApp document message via URL.
 * @param {string} to Recipient phone number (with country code, no +)
 * @param {string} documentUrl URL of the document to send
 * @param {string} filename Name of the document file
 * @param {string} caption Optional caption for the document
 * @param {{ phone_number_id?: string, whatsapp_token?: string, user_id?: string }} cfg Tenant configuration
 * @param {string} replyToMessageId Optional message ID to reply to
 * @returns {Promise<any>} Raw JSON response from the Graph API
 */
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
  
  // Add reply context if replying to a message
  if (replyToMessageId) {
    payload.context = { message_id: replyToMessageId };
  }
  
  const result = await postWhatsAppMessage(cfg, payload, { retry: true });
  
  // Track outbound message usage
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

/**
 * Send a WhatsApp document message via base64 upload (for localhost development).
 * @param {string} to Recipient phone number (with country code, no +)
 * @param {string} documentPath Path to the document file
 * @param {string} filename Name of the document file
 * @param {string} caption Optional caption for the document
 * @param {{ phone_number_id?: string, whatsapp_token?: string, user_id?: string }} cfg Tenant configuration
 * @returns {Promise<any>} Raw JSON response from the Graph API
 */
export async function sendWhatsappDocumentBase64(to, documentPath, filename, caption, cfg) {
  try {
    // Read the document file
    const documentBuffer = fs.readFileSync(documentPath);
    
    // Get file extension to determine MIME type
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
    
    // Try to upload to a free file hosting service
    let publicDocumentUrl = null;
    
    // Try tmpfiles.org (free, no API key required)
    try {
      const formData = new FormData();
      formData.append('file', documentBuffer, {
        filename: filename,
        contentType: mimeType
      });
      
      const uploadResponse = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: formData,
        headers: formData.getHeaders()
      });
      
      if (uploadResponse.ok) {
        const uploadResult = await uploadResponse.json();
        if (uploadResult.status === 'success') {
          // Convert tmpfiles.org URL to direct document URL
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
    
    // Now send the document using the public URL
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
    
    // Track outbound message usage
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

/**
 * Send a WhatsApp template message (HSM) using a pre-approved template.
 * @param {string} to recipient phone
 * @param {string} templateName approved template name (e.g., "hello_world")
 * @param {string} language language code (e.g., "en_US")
 * @param {Array} components optional components (header/body/buttons)
 * @param {{ user_id?: string }} cfg Tenant configuration
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
  const result = await postWhatsAppMessage(cfg, payload, { retry: false });
  
  // Track template message usage
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
