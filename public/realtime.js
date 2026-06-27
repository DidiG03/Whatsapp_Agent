
class RealtimeManager {
  constructor() {
    this.ably = null;
    this.ablyScriptPromise = null;
    this.userChannel = null;
    this.chatChannel = null;
    this.chatChannelName = null;
    this.currentChat = null;
    this.userId = null;
    this.isConnected = false;
    this.isDestroyed = false;
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
    this.realtimeAvailable = true;
    this.globalHandlers = new Map();
    this.latestMetrics = null;
    this.refreshTimeout = null;
    this.realtimeStatusPromise = null;
    this.realtimeStatusCache = null;
    this.reconnectIntervalId = null;
    this.isTypingActive = false;
    this.typingPhone = null;
    this.socket = {
      on: (eventName, handler) => this.onGlobal(eventName, handler),
      off: (eventName, handler) => this.offGlobal(eventName, handler)
    };
    this.visibilityChangeHandler = this.handleVisibilityChange.bind(this);
    this.onlineHandler = () => {
      try { if (!this.isConnected) this.connect(); } catch {}
    };
    this.focusHandler = () => {
      try { if (!document.hidden && !this.isConnected) this.connect(); } catch {}
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityChangeHandler);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('focus', this.focusHandler);
    }
    console.log('🔌 RealtimeManager initialized (Ably)');
  }

  async connect() {
    if (this.isDestroyed) return;
    if (this.isConnected) return;

    try {
      if (!this.userId) {
        this.userId = await this.getUserId();
      }
      await this.ensureRealtimeAvailable();
      if (!this.realtimeAvailable) {
        console.warn('Realtime disabled on this deployment; skipping connect');
        return;
      }
      await this.loadAblyScript();
      await this.createAblyClient();
    } catch (error) {
      console.error('Failed to initialize realtime connection:', error);
      this.handleConnectionError();
    }
  }

  async ensureRealtimeAvailable() {
    if (this.realtimeChecked) return;
    this.realtimeChecked = true;
    const status = await this.fetchRealtimeStatus();
    if (status?.userId && !this.userId) {
      this.userId = status.userId;
    }
    this.realtimeAvailable = !!status?.ablyAvailable;
    if (!this.realtimeAvailable && !status) {
      console.warn('Realtime status check failed; realtime disabled for this session');
    }
  }

  async loadAblyScript() {
    if (window.Ably) return;
    if (this.ablyScriptPromise) return this.ablyScriptPromise;
    this.ablyScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.ably.io/lib/ably.min-1.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Ably client'));
      document.head.appendChild(script);
    });
    return this.ablyScriptPromise;
  }

  async createAblyClient() {
    return new Promise((resolve, reject) => {
      try {
        const client = new Ably.Realtime({
          authUrl: '/api/realtime/ably/token',
          authMethod: 'GET',
          authHeaders: { 'X-Requested-With': 'XMLHttpRequest' },
          clientId: this.userId ? `user:${this.userId}` : undefined,
          transports: ['web_socket', 'comet']
        });

        client.connection.on('connected', () => {
          console.log('🔌 Connected to Ably realtime');
          this.ably = client;
          this.isConnected = true;
          this.connectionAttempts = 0;
          this.stopReconnectLoop();
          this.updateConnectionStatus(true);
          this.setupUserChannel();
          if (this.currentChat) {
            this.joinChat(this.currentChat);
          }
          resolve();
        });

        client.connection.on('disconnected', () => {
          this.isConnected = false;
          this.updateConnectionStatus(false);
          this.startReconnectLoop();
        });

        client.connection.on('suspended', () => {
          this.isConnected = false;
          this.updateConnectionStatus(false);
          this.scheduleReconnect();
        });

        client.connection.on('failed', (err) => {
          this.isConnected = false;
          this.updateConnectionStatus(false);
          try { this.checkAuthAndMaybeRedirect(); } catch {}
          reject(err);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  setupUserChannel() {
    if (!this.ably || !this.userId) return;
    if (this.userChannel) {
      try { this.userChannel.unsubscribe(); } catch {}
    }
    this.userChannel = this.ably.channels.get(`user:${this.userId}`);
    this.userChannel.subscribe((message) => {
      const name = message?.name;
      const data = message?.data;
      this.dispatchGlobalEvent(name, data);
    });
  }

  dispatchGlobalEvent(name, data) {
    if (!name) return;
    switch (name) {
      case 'new_message':
        this.handleNewMessage(data);
        break;
      case 'live_mode_changed':
        this.handleLiveModeChange(data);
        break;
      case 'metrics_update':
        this.latestMetrics = data;
        this.emitGlobal(name, data);
        break;
      case 'notification_created':
        this.emitGlobal(name, data);
        break;
      default:
        this.emitGlobal(name, data);
    }
  }

  emitGlobal(name, payload) {
    const listeners = this.globalHandlers.get(name);
    if (!listeners) return;
    listeners.forEach((handler) => {
      try { handler(payload); } catch (error) { console.error('Realtime handler error:', error); }
    });
  }

  onGlobal(eventName, handler) {
    if (!eventName || typeof handler !== 'function') return;
    if (!this.globalHandlers.has(eventName)) {
      this.globalHandlers.set(eventName, new Set());
    }
    this.globalHandlers.get(eventName).add(handler);
    if (eventName === 'metrics_update' && this.latestMetrics) {
      handler(this.latestMetrics);
    }
  }

  offGlobal(eventName, handler) {
    const listeners = this.globalHandlers.get(eventName);
    if (!listeners) return;
    listeners.delete(handler);
  }

  async joinChat(phone) {
    if (!phone) return;
    if (!this.isConnected) {
      await this.connect();
      if (!this.isConnected) return;
    }
    const channelName = `chat:${this.userId}:${phone.replace(/[^0-9+]/g, '')}`;
    if (this.chatChannelName === channelName && this.chatChannel) {
      this.currentChat = phone;
      return;
    }
    if (this.chatChannel) {
      try { this.chatChannel.unsubscribe(); } catch {}
    }
    this.chatChannelName = channelName;
    this.chatChannel = this.ably.channels.get(channelName);
    this.chatChannel.subscribe((message) => {
      this.dispatchChatEvent(message?.name, message?.data);
    });
    this.currentChat = phone;
    this.publishChatEvent('user_online', { userId: this.userId, phone });
    console.log(`👤 Joined chat: ${phone}`);
  }

  leaveChat(phone) {
    if (this.isTypingActive) {
      try { this.stopTyping(phone || this.currentChat || this.typingPhone); } catch {}
    }
    if (this.chatChannel) {
      this.publishChatEvent('user_offline', { userId: this.userId, phone });
      try { this.chatChannel.unsubscribe(); } catch {}
    }
    this.chatChannel = null;
    this.chatChannelName = null;
    this.currentChat = null;
    console.log(`👤 Left chat: ${phone}`);
  }

  dispatchChatEvent(name, data) {
    if (!name) return;
    switch (name) {
      case 'new_message':
        this.handleNewMessage(data);
        break;
      case 'live_mode_changed':
        this.handleLiveModeChange(data);
        break;
      case 'user_online':
        this.handleUserOnline(data);
        break;
      case 'user_offline':
        this.handleUserOffline(data);
        break;
      case 'message_status_update':
        this.handleMessageStatusUpdate(data);
        break;
      case 'message_reaction':
        this.handleMessageReaction(data);
        break;
      case 'typing_start':
        this.handleTypingStart(data);
        break;
      case 'typing_stop':
        this.handleTypingStop(data);
        break;
      default:
        this.emitGlobal(name, data);
    }
  }

  publishChatEvent(name, payload) {
    if (!this.chatChannel) return;
    try {
      this.chatChannel.publish(name, payload);
    } catch (error) {
      console.warn('Failed to publish chat event:', name, error?.message || error);
    }
  }

  normalizePhoneDigits(phone) {
    return String(phone || '').replace(/[^0-9+]/g, '');
  }

  startTyping(phone) {
    if (!phone || !this.isConnected || !this.chatChannel) return;
    const normalized = this.normalizePhoneDigits(phone);
    if (this.isTypingActive && this.typingPhone === normalized) return;
    this.isTypingActive = true;
    this.typingPhone = normalized;
    this.publishChatEvent('typing_start', {
      userId: this.userId,
      phone: normalized,
      timestamp: Date.now()
    });
  }

  stopTyping(phone) {
    if (!phone || !this.isConnected || !this.chatChannel) return;
    if (!this.isTypingActive) return;
    const normalized = this.normalizePhoneDigits(phone);
    this.isTypingActive = false;
    this.typingPhone = null;
    this.publishChatEvent('typing_stop', {
      userId: this.userId,
      phone: normalized,
      timestamp: Date.now()
    });
  }

  handleTypingStart(data = {}) {
    if (String(data.userId) === String(this.userId)) return;
    if (data.phone && this.currentChat && !this.isSamePhone(data.phone, this.currentChat)) return;
    this.emitGlobal('typing_start', data);
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
      indicator.style.display = 'block';
      this.scrollThreadToBottom(document.querySelector('.chat-thread-messages') || document.querySelector('.chat-thread'));
    }
  }

  handleTypingStop(data = {}) {
    if (String(data.userId) === String(this.userId)) return;
    if (data.phone && this.currentChat && !this.isSamePhone(data.phone, this.currentChat)) return;
    this.emitGlobal('typing_stop', data);
    const indicator = document.getElementById('typingIndicator');
    if (indicator) {
      indicator.style.display = 'none';
    }
  }

  async sendMessage(phone, message, type = 'text', replyToMessageId = null) {
    try {
      this.stopTyping(phone);
      const replyOriginal = replyToMessageId
        ? this.getReplyPreviewFromDom(replyToMessageId)
        : null;
      const body = {
        text: message,
        type,
        replyTo: replyToMessageId || undefined
      };
      const resp = await fetch(`/send/${encodeURIComponent(phone)}?format=json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      if (resp.status === 401) {
        window.authManager?.handleUnauthorized?.();
        return false;
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.success) {
        const msg = data?.error || `Failed to send message (status ${resp.status})`;
        throw new Error(msg);
      }
      if (data?.messageId) {
        if (!this.currentChat) {
          this.currentChat = this.normalizePhoneDigits(phone);
        }
        const nowTs = Math.floor(Date.now() / 1000);
        this.handleNewMessage({
          id: data.messageId,
          direction: 'outbound',
          type: 'text',
          text_body: message,
          timestamp: nowTs,
          to_digits: String(phone),
          contact: String(phone),
          delivery_status: 'sent',
          replyOriginal: data.replyOriginal || replyOriginal || null
        });
      }
      if (data?.templateSent) {
        this.showToast('24h window was closed. Sent template to reopen conversation.', 'info');
      }
      return true;
    } catch (error) {
      console.error('Failed to send message via HTTP:', error);
      this.showToast(error?.message || 'Failed to send message. Please try again.', 'error');
      return false;
    }
  }

  handleConnectionError() {
    this.isConnected = false;
    this.updateConnectionStatus(false);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.isDestroyed) return;
    if (this.connectionAttempts >= this.maxConnectionAttempts) {
      console.warn('Max realtime reconnection attempts reached');
      this.startReconnectLoop();
      return;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.connectionAttempts++;
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, 2000 * this.connectionAttempts);
  }

  startReconnectLoop() {
    if (this.reconnectIntervalId) return;
    this.reconnectIntervalId = setInterval(() => {
      if (this.isDestroyed) return;
      if (!this.isConnected) {
        try { this.connect(); } catch {}
      }
    }, 60000);
  }

  stopReconnectLoop() {
    if (this.reconnectIntervalId) {
      clearInterval(this.reconnectIntervalId);
      this.reconnectIntervalId = null;
    }
  }

  updateConnectionStatus(isConnected) {
    const statusEl = document.getElementById('realtimeStatus');
    if (statusEl) {
      statusEl.textContent = isConnected ? 'Connected' : 'Connecting…';
      statusEl.className = isConnected ? 'status-connected' : 'status-disconnected';
    }
  }

  handleVisibilityChange() {
    if (document.hidden) {
      return;
    }
    if (!this.isConnected) {
      this.connect();
    }
  }

  disconnect() {
    try {
      if (this.chatChannel) {
        this.chatChannel.unsubscribe();
        this.chatChannel = null;
      }
      if (this.userChannel) {
        this.userChannel.unsubscribe();
        this.userChannel = null;
      }
      if (this.ably) {
        try { this.ably.close(); } catch {}
        this.ably = null;
      }
      this.isConnected = false;
    } catch (error) {
      console.error('Realtime disconnect error:', error);
    }
  }

  destroy() {
    this.isDestroyed = true;
    this.disconnect();
    this.globalHandlers.clear();
    if (this.visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
    }
    if (typeof window !== 'undefined') {
      try { window.removeEventListener('online', this.onlineHandler); } catch {}
      try { window.removeEventListener('focus', this.focusHandler); } catch {}
    }
    this.stopReconnectLoop();
  }
  normalizePhone(phone) {
    return String(phone || '').replace(/[^0-9]/g, '');
  }

  isSamePhone(a, b) {
    const pa = this.normalizePhone(a);
    const pb = this.normalizePhone(b);
    if (!pa || !pb) return false;
    return pa === pb;
  }

  async getUserId() {
    if (this.userId) return this.userId;
    try {
      if (window.authManager && typeof window.authManager.getCurrentUserId === 'function') {
        const id = await window.authManager.getCurrentUserId();
        if (id) {
          this.userId = id;
          return id;
        }
      }
    } catch (error) {
      console.warn('Realtime user id via auth manager failed:', error?.message || error);
    }
    const status = await this.fetchRealtimeStatus();
    if (status?.userId) {
      this.userId = status.userId;
      return this.userId;
    }
    return null;
  }

  async fetchRealtimeStatus() {
    if (this.realtimeStatusCache) return this.realtimeStatusCache;
    if (!this.realtimeStatusPromise) {
      this.realtimeStatusPromise = (async () => {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 4000);
        try {
          const resp = await fetch('/api/realtime/status', {
            credentials: 'include',
            signal: ctrl.signal
          });
          if (!resp.ok) {
            return null;
          }
          const data = await resp.json().catch(() => ({}));
          return data;
        } catch (error) {
          console.warn('Realtime status fetch failed:', error?.message || error);
          return null;
        } finally {
          clearTimeout(timeout);
          this.realtimeStatusPromise = null;
        }
      })();
    }
    const data = await this.realtimeStatusPromise;
    if (data) {
      this.realtimeStatusCache = data;
    }
    return data;
  }

  async checkAuthAndMaybeRedirect() {
    try {
      const fetchFn = window.authManager?.authenticatedFetch?.bind(window.authManager) || fetch;
      const resp = await fetchFn('/api/realtime/status', {
        credentials: 'include'
      });
      if (resp.status === 401) {
        window.authManager?.handleUnauthorized?.();
        return false;
      }
    } catch {
    }
    return true;
  }

  handleNewMessage(data = {}) {
    const phone =
      data.phone ||
      data.contact ||
      (data.direction === 'inbound' ? data.from_digits : data.to_digits);
    const isCurrent = phone && this.currentChat && this.isSamePhone(phone, this.currentChat);
    if (isCurrent) {
      const appended = this.appendMessageToThread(data);
      if (!appended) {
        this.refreshChatThread(phone);
      }
    } else if (phone) {
      this.showToast(`New message from ${phone}`, 'info');
    }
    this.emitGlobal('new_message', data);
  }

  getChatMessagesEl() {
    return document.querySelector('.chat-thread-messages') || document.querySelector('.chat-thread');
  }

  appendMessageToThread(message) {
    try {
      const thread = this.getChatMessagesEl();
      if (!thread) return false;
      if (message?.id && document.getElementById(`message-${message.id}`)) {
        if (message.replyOriginal) {
          this.ensureReplyPreviewOnMessage(message.id, message.replyOriginal, message?.direction || 'outbound');
        }
        return true;
      }
      const emptyState = thread.querySelector('.chat-empty-state');
      if (emptyState) emptyState.remove();
      const container = document.createElement('div');
      const direction = message?.direction === 'outbound' ? 'msg msg-out' : 'msg msg-in';
      container.className = `${direction} message-container`;
      if (message?.id) {
        container.id = `message-${message.id}`;
        container.setAttribute('data-message-id', message.id);
      }
      const bubble = document.createElement('div');
      const isVoice = (message?.type || '') === 'audio';
      bubble.className = isVoice ? 'bubble bubble--voice' : 'bubble';
      const meta = this.formatTimestamp(message?.timestamp);
      const deliveryStatus = this.normalizeDeliveryStatus(message?.delivery_status || 'sent');
      const ticksHtml = message?.direction === 'outbound'
        ? `<div class="message-status-ticks message-status-${deliveryStatus}"><div class="message-tick"></div><div class="message-tick"></div></div>`
        : '';
      const canActions = (typeof window !== 'undefined' && !!window.IS_UPGRADED && !!window.CHAT_IS_HUMAN && message?.id);
      const actionsHtml = canActions
        ? `<div class="message-actions">
             <button class="action-btn reply-btn" onclick="replyToMessage('${message.id}')" title="Reply to this message">↩️</button>
             <button class="action-btn reaction-btn" onclick="showReactionPicker('${message.id}')" title="Add reaction">+</button>
           </div>`
        : '';
      bubble.innerHTML = `
        <div class="wa-message-body">${this.formatMessageBody(message)}</div>
        <div class="meta">${meta}${ticksHtml}</div>
        ${actionsHtml}
      `;
      if (message.replyOriginal) {
        const previewWrap = document.createElement('div');
        previewWrap.innerHTML = this.buildReplyPreviewHtml(
          message.replyOriginal,
          message?.direction || 'outbound'
        ).trim();
        const preview = previewWrap.firstElementChild;
        if (preview) container.appendChild(preview);
      }
      container.appendChild(bubble);
      const anchor = thread.querySelector('[data-thread-anchor]');
      if (anchor && anchor.parentElement === thread) {
        thread.insertBefore(container, anchor);
      } else {
        thread.appendChild(container);
      }
      this.scrollThreadToBottom(thread);
      if (isVoice && typeof window.initVoiceMessages === 'function') {
        window.initVoiceMessages(container);
      }
      return true;
    } catch (error) {
      console.warn('Append message failed:', error?.message || error);
      return false;
    }
  }

  ensureReplyPreviewOnMessage(messageId, replyOriginal, replyDirection = 'outbound') {
    const container = document.getElementById(`message-${messageId}`);
    if (!container || container.querySelector('.reply-preview')) return;
    const previewWrap = document.createElement('div');
    previewWrap.innerHTML = this.buildReplyPreviewHtml(replyOriginal, replyDirection).trim();
    const preview = previewWrap.firstElementChild;
    const bubble = container.querySelector('.bubble');
    if (preview && bubble) {
      container.insertBefore(preview, bubble);
    }
  }

  getReplyPreviewFromDom(messageId) {
    const el = document.getElementById(`message-${messageId}`);
    if (!el) return null;
    const isInbound = el.classList.contains('msg-in');
    const bubble = el.querySelector('.bubble');
    let text = '[Media]';
    if (bubble) {
      const clone = bubble.cloneNode(true);
      clone.querySelector('.meta')?.remove();
      clone.querySelector('.message-actions')?.remove();
      clone.querySelector('.message-reactions')?.remove();
      const body = clone.querySelector('.wa-message-body');
      text = (body ? body.textContent : clone.textContent || '').trim() || '[Media]';
    }
    return {
      original_message_id: messageId,
      direction: isInbound ? 'inbound' : 'outbound',
      text_body: text
    };
  }

  buildReplyPreviewHtml(originalMessage, replyDirection = 'outbound') {
    if (!originalMessage?.original_message_id) return '';
    const originalText = originalMessage.text_body || '[Media]';
    const truncatedText = originalText.length > 40
      ? `${originalText.substring(0, 40)}...`
      : originalText;
    const authorName = originalMessage.direction === 'inbound' ? 'Customer' : 'You';
    const borderColor = replyDirection === 'inbound' ? '#3b82f6' : '#10b981';
    const id = this.escapeHtml(originalMessage.original_message_id);
    const safeText = this.escapeHtml(truncatedText);
    return `
      <div class="reply-preview" onclick="scrollToMessage('${id}')" style="cursor:pointer; margin:4px 0 2px 0;">
        <div class="reply-preview-content" style="display:flex; gap:8px; align-items:flex-start; background:#f5f7f9; border-left:3px solid ${borderColor}; padding:6px 8px; border-radius:6px;">
          <div style="flex:1; min-width:0;">
            <div class="reply-preview-author" style="font-size:11px; color:#64748b; font-weight:600;">${authorName}</div>
            <div class="reply-preview-text" style="font-size:12px; color:#111b21; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${safeText}</div>
          </div>
        </div>
      </div>
    `;
  }

  parseMessageRaw(message) {
    const raw = message?.raw;
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return {}; }
    }
    return {};
  }

  resolveImageUrl(message) {
    const direct = message?.imageUrl || message?.media_url;
    if (direct) return direct;
    const raw = this.parseMessageRaw(message);
    let url = raw?.image?.link || raw?.imageUrl;
    if (!url && raw?.image?.id && this.userId) {
      url = `/wa-media/${encodeURIComponent(String(this.userId))}/${encodeURIComponent(String(raw.image.id))}`;
    }
    return url || null;
  }

  resolveDocumentUrl(message) {
    const direct = message?.documentUrl || message?.media_url;
    if (direct) return direct;
    const raw = this.parseMessageRaw(message);
    return raw?.document?.link || raw?.documentUrl || null;
  }

  resolveAudioUrl(message) {
    const direct = message?.audioUrl || (message?.type === 'audio' ? message?.media_url : null);
    if (direct) return direct;
    const raw = this.parseMessageRaw(message);
    let url = raw?.audio?.link || raw?.audioUrl;
    if (!url && raw?.audio?.id && this.userId) {
      url = `/wa-media/${encodeURIComponent(String(this.userId))}/${encodeURIComponent(String(raw.audio.id))}`;
    }
    return url || null;
  }

  renderImageHtml(url) {
    const safe = this.escapeHtml(url);
    return `<div style="margin:8px 0;"><img src="${safe}" style="max-width:200px; max-height:200px; border-radius:8px; object-fit:cover; cursor:pointer;" alt="Image" onclick="window.open('${safe}', '_blank')" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"/><div style="display:none; padding:8px; background:#f0f0f0; border-radius:8px; font-size:12px; color:#666;">[Image failed to load]</div></div>`;
  }

  renderAudioHtml(url, transcript = '', messageId = '') {
    const safe = this.escapeHtml(url);
    const safeId = this.escapeHtml(String(messageId || ''));
    const bars = Array.from({ length: 14 }, (_, i) => {
      const h = 6 + ((i * 7) % 18);
      return `<span style="--vh:${h}px"></span>`;
    }).join('');
    const transcriptHtml = String(transcript || '').trim()
      ? `<div class="voice-message__transcript">${this.escapeHtml(transcript).replace(/\n/g, '<br/>')}</div>`
      : '';
    return `
      <div class="voice-message" data-message-id="${safeId}">
        <button type="button" class="voice-message__play" aria-label="Play voice message" onclick="window.toggleVoiceMessage && window.toggleVoiceMessage(this)">&#9654;</button>
        <div class="voice-message__track">
          <div class="voice-message__wave" aria-hidden="true">${bars}</div>
          <div class="voice-message__footer">
            <span class="voice-message__label">Voice message</span>
            <span class="voice-message__duration">--:--</span>
          </div>
        </div>
        <audio class="voice-message__audio" preload="auto" src="${safe}"></audio>
      </div>
      ${transcriptHtml}
    `.trim();
  }

  formatMessageBody(message) {
    const type = message?.type || 'text';
    if (type === 'image') {
      const imageUrl = this.resolveImageUrl(message);
      if (imageUrl) return this.renderImageHtml(imageUrl);
      return '[image]';
    }
    if (type === 'document') {
      const documentUrl = this.resolveDocumentUrl(message);
      if (documentUrl) {
        const name = this.escapeHtml(message.documentName || message.text_body || 'Document');
        return `<a href="${this.escapeHtml(documentUrl)}" target="_blank" rel="noopener">📎 ${name}</a>`;
      }
      return this.escapeHtml(message?.text_body || '[document]');
    }
    if (type === 'text') {
      const body = message?.text_body || message?.text || '';
      if (body.trim() === '[image]' || message?.media_url || message?.imageUrl) {
        const imageUrl = this.resolveImageUrl(message);
        if (imageUrl) return this.renderImageHtml(imageUrl);
      }
      return this.escapeHtml(body).replace(/\n/g, '<br/>');
    }
    if (type === 'audio') {
      const audioUrl = this.resolveAudioUrl(message);
      const transcript = message?.text_body || message?.text || '';
      if (audioUrl) return this.renderAudioHtml(audioUrl, transcript, message?.id);
      if (String(transcript || '').trim()) {
        return `🎤 ${this.escapeHtml(transcript).replace(/\n/g, '<br/>')}`;
      }
      return '[audio]';
    }
    if (type === 'video') return '[video]';
    return this.escapeHtml(message?.text_body || `[${type}]`);
  }

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  formatTimestamp(ts) {
    if (!ts) return '';
    try {
      const date = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  showToast(message, type = 'info') {
    try {
      if (window.Toast && typeof window.Toast[type] === 'function') {
        window.Toast[type](message);
        return;
      }
      if (window.Toast && typeof window.Toast.show === 'function') {
        window.Toast.show(message, type);
        return;
      }
    } catch {}
    console.log(`[Toast:${type}]`, message);
  }

  handleLiveModeChange(data = {}) {
    const phone = data.phone || data.contact;
    if (!phone || !this.currentChat || !this.isSamePhone(phone, this.currentChat)) {
      this.emitGlobal('live_mode_changed', data);
      return;
    }
    const isLive = !!data.isLive;
    const btn = document.getElementById('handoffToggleBtn');
    if (btn) {
      btn.classList.toggle('is-human', isLive);
      btn.setAttribute('data-is-human', isLive ? 'true' : 'false');
      btn.title = isLive ? 'Switch to AI' : 'Take over conversation';
      const hiddenInput = btn.closest('form')?.querySelector('input[name="is_human"]');
      if (hiddenInput) {
        hiddenInput.value = isLive ? '1' : '';
      }
    }
    const modePill = document.querySelector('.wa-chat-header__mode');
    if (modePill) {
      modePill.classList.toggle('is-human', isLive);
      modePill.classList.toggle('is-ai', !isLive);
      modePill.textContent = isLive ? 'Human' : 'AI';
    }
    if (typeof window.applyComposerLiveMode === 'function') {
      window.applyComposerLiveMode(isLive);
    }
    try { window.CHAT_IS_HUMAN = !!isLive; } catch {}
    this.emitGlobal('live_mode_changed', data);
  }

  scrollThreadToBottom(container) {
    if (!container) return;
    try {
      const el = container.classList?.contains('chat-thread-messages')
        ? container
        : (container.closest?.('.chat-thread-messages') || container.closest?.('.chat-thread') || container);
      if (el && el.scrollHeight) {
        el.scrollTop = el.scrollHeight;
      }
    } catch {}
  }

  handleUserOnline(data = {}) {
    if (data?.phone && this.currentChat && this.isSamePhone(data.phone, this.currentChat)) {
      console.log('Contact online');
    }
    this.emitGlobal('user_online', data);
  }

  handleUserOffline(data = {}) {
    if (data?.phone && this.currentChat && this.isSamePhone(data.phone, this.currentChat)) {
      console.log('Contact offline');
    }
    this.emitGlobal('user_offline', data);
  }

  normalizeDeliveryStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'read') return 'read';
    if (value === 'delivered') return 'delivered';
    if (value === 'failed') return 'failed';
    return 'sent';
  }

  updateMessageStatusTicks(messageEl, status) {
    const meta = messageEl.querySelector('.bubble .meta');
    if (!meta) return;
    const normalized = this.normalizeDeliveryStatus(status);
    if (normalized === 'failed') return;
    let ticks = meta.querySelector('.message-status-ticks');
    if (!ticks) {
      ticks = document.createElement('div');
      ticks.innerHTML = '<div class="message-tick"></div><div class="message-tick"></div>';
      meta.appendChild(ticks);
    }
    ticks.className = `message-status-ticks message-status-${normalized}`;
    messageEl.setAttribute('data-status', normalized);
  }

  handleMessageStatusUpdate(data = {}) {
    if (data?.messageId) {
      const el = document.getElementById(`message-${data.messageId}`);
      if (el) {
        this.updateMessageStatusTicks(el, data.status);
      }
    }
    this.emitGlobal('message_status_update', data);
  }

  handleMessageReaction(data = {}) {
    this.emitGlobal('message_reaction', data);
  }

  refreshChatThread(phone) {
    if (!phone || !this.currentChat || !this.isSamePhone(phone, this.currentChat)) return;
    if (this.refreshTimeout) return;
    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = null;
      try {
        window.location.reload();
      } catch {

      }
    }, 1000);
  }

  async toggleLiveMode(phone, isLive) {
    const payload = {
      phone,
      isLive: !!isLive
    };
    try {
      const fetchFn = window.authManager?.authenticatedFetch?.bind(window.authManager) || fetch;
      const resp = await fetchFn('/api/realtime/live-mode', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      let data = null;
      try { data = await resp.json(); } catch {}
      if (!resp.ok || data?.error) {
        const msg = data?.error || 'Failed to update live mode';
        this.showToast(msg, 'error');
        return false;
      }
    } catch (error) {
      console.warn('Live mode API call failed:', error?.message || error);
      this.showToast('Failed to update live mode', 'error');
      return false;
    }
    this.publishChatEvent('live_mode_changed', {
      userId: this.userId,
      phone,
      isLive: !!isLive,
      timestamp: Date.now()
    });
    return true;
  }
}

(function bootstrapRealtimeManager() {
  if (typeof window === 'undefined') return;
  try {
    if (window.realtimeManager && typeof window.realtimeManager.destroy === 'function') {
      window.realtimeManager.destroy();
    }
  } catch {}
  const manager = new RealtimeManager();
  window.realtimeManager = manager;
  const connectSafely = () => {
    manager.connect().catch((error) => {
      console.warn('Realtime connect failed:', error?.message || error);
    });
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    connectSafely();
  } else {
    document.addEventListener('DOMContentLoaded', connectSafely, { once: true });
  }
  window.addEventListener('beforeunload', () => {
    try { manager.destroy(); } catch {}
  });
})();

function formatVoiceDuration(audioEl) {
  const wrap = audioEl?.closest?.('.voice-message');
  const label = wrap?.querySelector('.voice-message__duration');
  if (!label || !audioEl) return false;
  const raw = Number(audioEl.duration);
  if (!Number.isFinite(raw) || raw <= 0 || raw === Infinity) return false;
  const s = Math.max(0, Math.round(raw));
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, '0');
  label.textContent = `${m}:${r}`;
  return true;
}

function bindVoiceAudio(audio) {
  if (!audio || audio._voiceDurationBound) return;
  audio._voiceDurationBound = true;
  const tryUpdate = () => formatVoiceDuration(audio);
  ['loadedmetadata', 'durationchange', 'loadeddata', 'canplay', 'canplaythrough'].forEach((ev) => {
    audio.addEventListener(ev, tryUpdate);
  });
  audio.addEventListener('error', () => {
    const label = audio.closest('.voice-message')?.querySelector('.voice-message__duration');
    if (label && label.textContent === '--:--') label.textContent = '0:00';
  });
  let attempts = 0;
  const poll = () => {
    if (tryUpdate() || attempts >= 12) return;
    attempts += 1;
    setTimeout(poll, 250);
  };
  try { audio.load(); } catch {}
  poll();
}

function toggleVoiceMessage(btn) {
  const wrap = btn?.closest?.('.voice-message');
  const audio = wrap?.querySelector('.voice-message__audio');
  if (!audio) return;
  document.querySelectorAll('.voice-message__audio').forEach((a) => {
    if (a === audio) return;
    a.pause();
    const otherBtn = a.closest('.voice-message')?.querySelector('.voice-message__play');
    const otherWrap = a.closest('.voice-message');
    if (otherBtn) {
      otherBtn.innerHTML = '&#9654;';
      otherBtn.classList.remove('is-playing');
    }
    otherWrap?.classList.remove('is-playing');
  });
  if (audio.paused) {
    audio.play().catch(() => {});
    formatVoiceDuration(audio);
    btn.innerHTML = '&#10074;&#10074;';
    btn.classList.add('is-playing');
    wrap.classList.add('is-playing');
  } else {
    audio.pause();
    btn.innerHTML = '&#9654;';
    btn.classList.remove('is-playing');
    wrap.classList.remove('is-playing');
  }
  if (!audio._voiceBound) {
    audio._voiceBound = true;
    audio.addEventListener('ended', () => {
      btn.innerHTML = '&#9654;';
      btn.classList.remove('is-playing');
      wrap.classList.remove('is-playing');
    });
  }
}

function initVoiceMessages(root = document) {
  root.querySelectorAll('.voice-message__audio').forEach(bindVoiceAudio);
}

if (typeof window !== 'undefined') {
  window.toggleVoiceMessage = toggleVoiceMessage;
  window.formatVoiceDuration = formatVoiceDuration;
  window.initVoiceMessages = initVoiceMessages;
  document.addEventListener('DOMContentLoaded', () => initVoiceMessages(), { once: true });
}
