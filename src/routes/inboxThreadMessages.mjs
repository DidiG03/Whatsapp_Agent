import { escapeHtml, renderVoiceMessageHtml } from "../utils.mjs";
import { MESSAGE_STATUS, READ_STATUS } from "../services/messageStatus.mjs";

function formatTimestampForDisplay(unixTs) {
  const ts = Number(unixTs || 0);
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday);
  startYesterday.setDate(startToday.getDate() - 1);
  const startWeekAgo = new Date(startToday);
  startWeekAgo.setDate(startToday.getDate() - 7);

  if (d >= startToday) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (d >= startYesterday) {
    return 'Yesterday';
  }
  if (d >= startWeekAgo) {
    return d.toLocaleDateString([], { weekday: 'long' });
  }
  return d.toLocaleDateString();
}

export function renderThreadMessagesHtml(msgs, ctx = {}) {
  const {
    userId,
    req,
    isUpgraded = false,
    reactionsByMessage = {},
    userReactionsByMessage = {},
    replyOriginals = {},
    templatePreviewByKey = new Map(),
  } = ctx;

  return (msgs || []).map((m) => {
    const cls = m.direction === 'inbound' ? 'msg msg-in' : 'msg msg-out';
    let display = String(m.text_body || '').trim();
    if (!display || display === '[image]' || display === '[document]' || display === '[audio]' || display === '[video]' || (m.type && m.type !== 'text')) {
      let raw = {};
      if (m && typeof m.raw === 'object' && m.raw !== null) {
        raw = m.raw;
      } else {
        try { raw = JSON.parse(m.raw || '{}'); } catch { raw = {}; }
      }
      if (m.type === 'interactive') {
        const br = raw?.interactive?.button_reply;
        const lr = raw?.interactive?.list_reply;
        const bodyText = raw?.interactive?.body?.text;
        if (br?.title) display = br.title;
        else if (lr?.title) display = lr.title;
        else if (bodyText) display = bodyText;
        else {
          try {
            const v = raw?.value || raw;
            const arr = Array.isArray(v?.messages) ? v.messages : (Array.isArray(raw?.messages) ? raw.messages : []);
            const first = arr[0] || {};
            const lr2 = first?.interactive?.list_reply?.title;
            const br2 = first?.interactive?.button_reply?.title;
            const body2 = first?.interactive?.body?.text;
            if (lr2) display = lr2;
            else if (br2) display = br2;
            else if (body2) display = body2;
            else display = '[interactive]';
          } catch { display = '[interactive]'; }
        }
      } else if (m.type === 'document') {
        let documentUrl = raw?.document?.link || raw?.documentUrl;
        const filename = raw?.document?.filename || raw?.filename || 'Document';

        if (documentUrl) {
          if (documentUrl.includes('localhost:3000') && req) {
            const host = req.get('host');
            const protocol = req.protocol;
            documentUrl = documentUrl.replace(/https?:\/\/localhost:3000/, `${protocol}://${host}`);
          }
          const fileExtension = filename.split('.').pop()?.toUpperCase() || 'DOC';

          display = `
              <div class="document-message" style="margin:8px 0; background:#f0f0f0; border-radius:8px; padding:12px; max-width:250px; cursor:pointer;" onclick="window.open('${escapeHtml(documentUrl)}', '_blank')">
                <div style="display:flex; align-items:center; gap:12px;">
                  <div style="width:40px; height:40px; background:#25d366; border-radius:6px; display:flex; align-items:center; justify-content:center; color:white; font-weight:bold; font-size:12px; flex-shrink:0;">
                    ${fileExtension}
                  </div>
                  <div style="flex:1; min-width:0;">
                    <div style="font-weight:500; color:#111b21; font-size:14px; margin-bottom:2px; word-break:break-word;">${escapeHtml(filename)}</div>
                    <div style="font-size:12px; color:#667781;">Tap to download</div>
                  </div>
                  <div style="color:#25d366; font-size:16px;">📥</div>
                </div>
              </div>
            `;
        } else {
          display = `[document] ${escapeHtml(filename)}`;
        }
      } else if (m.type === 'image') {
        let imageUrl = raw?.image?.link || raw?.imageUrl;
        if (!imageUrl && raw?.image?.id) {
          imageUrl = `/wa-media/${encodeURIComponent(String(userId))}/${encodeURIComponent(String(raw.image.id))}`;
        }
        if (imageUrl) {
          if (imageUrl.includes('localhost:3000') && req) {
            const host = req.get('host');
            const protocol = req.protocol;
            imageUrl = imageUrl.replace(/https?:\/\/localhost:3000/, `${protocol}://${host}`);
          }
          display = `<div style="margin:8px 0;"><img src="${escapeHtml(imageUrl)}" style="max-width:200px; max-height:200px; border-radius:8px; object-fit:cover; cursor:pointer;" alt="Image" onclick="window.open('${escapeHtml(imageUrl)}', '_blank')" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"/><div style="display:none; padding:8px; background:#f0f0f0; border-radius:8px; font-size:12px; color:#666;">[Image failed to load]</div></div>`;
        } else {
          display = '[image]';
        }
      } else if (m.type === 'audio') {
        let audioUrl = raw?.audio?.link || null;
        if (!audioUrl && raw?.audio?.id) {
          audioUrl = `/wa-media/${encodeURIComponent(String(userId))}/${encodeURIComponent(String(raw.audio.id))}`;
        }
        const transcript = String(m.text_body || '').trim();
        if (audioUrl) {
          if (audioUrl.includes('localhost:3000') && req) {
            const host = req.get('host');
            const protocol = req.protocol;
            audioUrl = audioUrl.replace(/https?:\/\/localhost:3000/, `${protocol}://${host}`);
          }
          display = renderVoiceMessageHtml({ audioUrl, transcript, messageId: m.id });
        } else if (transcript) {
          display = `🎤 ${escapeHtml(transcript).replace(/\n/g, '<br/>')}`;
        } else {
          display = '[audio]';
        }
      } else if (m.type === 'video') {
        display = '[video]';
      } else if (m.type === 'template') {
        if (!display) {
          const tplName = raw?.template?.name;
          const tplLang = raw?.template?.language?.code || raw?.template?.language || '';
          if (raw?.displayText) {
            display = String(raw.displayText);
          } else if (tplName && tplLang && templatePreviewByKey.has(`${tplName}::${tplLang}`)) {
            display = templatePreviewByKey.get(`${tplName}::${tplLang}`);
          } else if (tplName) {
            for (const lang of [tplLang, 'en_US', 'en', 'sq'].filter(Boolean)) {
              const preview = templatePreviewByKey.get(`${tplName}::${lang}`);
              if (preview) { display = preview; break; }
            }
            if (!display) display = `Template: ${tplName}`;
          } else {
            display = '[template]';
          }
        }
      } else if (m.type) {
        display = `[${m.type}]`;
      }
    }
    const isVoiceBubble = m.type === 'audio' && display.includes('voice-message');
    const bubbleClass = isVoiceBubble ? 'bubble bubble--voice' : 'bubble';
    const safe = display.includes('<img') || display.includes('<div') || display.includes('voice-message')
      ? display
      : escapeHtml(display).replace(/\n/g, '<br/>');
    const ts = formatTimestampForDisplay(m.ts || 0);
    let statusTicks = '';
    if (m.direction === 'outbound') {
      const deliveryStatus = m.delivery_status || MESSAGE_STATUS.SENT;
      const readStatus = m.read_status || READ_STATUS.UNREAD;
      let finalStatus = deliveryStatus;
      if (readStatus === READ_STATUS.READ) {
        finalStatus = MESSAGE_STATUS.READ;
      }
      if (finalStatus === MESSAGE_STATUS.FAILED) {
        statusTicks = `
            <div class="message-status-ticks message-status-failed">
              <div class="message-failed-indicator" title="Message failed to send">
                <span class="failed-icon">!</span>
                <button class="btn btn-danger" data-message-id="${m.id}" onclick="retryMessage('${m.id}')" title="Retry sending message">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                    <path d="M21 3v5h-5"/>
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                    <path d="M3 21v-5h5"/>
                  </svg>
                </button>
              </div>
            </div>
          `;
      } else {
        statusTicks = `
            <div class="message-status-ticks message-status-${finalStatus}">
              <div class="message-tick"></div>
              <div class="message-tick"></div>
            </div>
          `;
      }
    }
    const messageReactions = reactionsByMessage[m.id] || [];
    const userReactions = userReactionsByMessage[m.id] || [];
    const originalMessage = replyOriginals[m.id];
    let originalMessageHtml = '';
    if (originalMessage) {
      const originalText = originalMessage.text_body || '[Media]';
      const truncatedText = originalText.length > 40 ? `${originalText.substring(0, 40)}...` : originalText;
      const authorName = originalMessage.direction === 'inbound' ? 'Customer' : 'You';
      originalMessageHtml = `
          <div class="reply-preview" onclick="scrollToMessage('${originalMessage.original_message_id}')" style="cursor:pointer; margin:4px 0 2px 0;">
            <div class="reply-preview-content" style="display:flex; gap:8px; align-items:flex-start; background:#f5f7f9; border-left:3px solid ${m.direction === 'inbound' ? '#3b82f6' : '#10b981'}; padding:6px 8px; border-radius:6px;">
              <div style="flex:1; min-width:0;">
                <div class="reply-preview-author" style="font-size:11px; color:#64748b; font-weight:600;">${authorName}</div>
                <div class="reply-preview-text" style="font-size:12px; color:#111b21; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(truncatedText)}</div>
              </div>
            </div>
          </div>
        `;
    }
    let reactionsHtml = '';
    if (messageReactions.length > 0) {
      reactionsHtml = '<div class="message-reactions">';
      messageReactions.forEach((reaction) => {
        const isUserReaction = userReactions.includes(reaction.emoji);
        const reactionClass = isUserReaction ? 'user-reaction' : 'customer-reaction';
        const allowClick = isUserReaction && isUpgraded;
        const clickHandler = allowClick ? `onclick="toggleReaction('${m.id}', '${reaction.emoji}')"` : '';
        const cursorStyle = allowClick ? 'cursor: pointer;' : 'cursor: default;';
        const title = isUserReaction ? 'Click to remove your reaction' : 'Customer reaction';
        reactionsHtml += `<span class="reaction ${reactionClass}" data-message-id="${m.id}" data-emoji="${reaction.emoji}" ${clickHandler} style="${cursorStyle}" title="${title}">${reaction.emoji}<span class="reaction-count">${reaction.count}</span></span>`;
      });
      reactionsHtml += '</div>';
    }
    const actionButtons = isUpgraded ? `
        <div class="message-actions">
          <button class="action-btn reply-btn" onclick="replyToMessage('${m.id}')" title="Reply to this message">↩️</button>
          <button class="action-btn reaction-btn" onclick="showReactionPicker('${m.id}')" title="Add reaction">+</button>
        </div>
      ` : '';

    return `<div class="${cls} message-container" id="message-${m.id}" data-message-id="${m.id}">${originalMessageHtml}<div class="${bubbleClass}">${safe}<div class="meta">${ts}${statusTicks}</div>${reactionsHtml}${actionButtons}</div></div>`;
  }).join('');
}
