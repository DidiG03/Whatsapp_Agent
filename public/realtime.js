/**
 * Realtime manager backed by Ably channels.
 * Handles live chat updates, typing indicators, and toast notifications.
 */
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
    this.socket = {
      on: (eventName, handler) => this.onGlobal(eventName, handler),
      off: (eventName, handler) => this.offGlobal(eventName, handler)
    };
    this.visibilityChangeHandler = this.handleVisibilityChange.bind(this);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityChangeHandler);
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
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const resp = await fetch('/api/realtime/status', {
        credentials: 'include',
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!resp.ok) {
        this.realtimeAvailable = false;
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (data?.userId && !this.userId) {
        this.userId = data.userId;
      }
      this.realtimeAvailable = !!data?.ablyAvailable;
    } catch (error) {
      console.warn('Realtime status check failed:', error?.message || error);
      this.realtimeAvailable = false;
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
        });

        client.connection.on('suspended', () => {
          this.isConnected = false;
          this.updateConnectionStatus(false);
          this.scheduleReconnect();
        });

        client.connection.on('failed', (err) => {
          this.isConnected = false;
          this.updateConnectionStatus(false);
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
    // If we are already connected, emit synthetic event for stateful info
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

  async sendMessage(phone, message, type = 'text', replyToMessageId = null) {
    try {
      const body = {
        text: message,
        type,
        replyTo: replyToMessageId || undefined
      };
      const resp = await fetch(`/send/${encodeURIComponent(phone)}?format=json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      if (resp.status === 401) {
        this.showToast('Session expired. Please sign in again.', 'error');
        try { window.authManager?.checkAuthStatus?.(); } catch {}
        return false;
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.success) {
        const msg = data?.error || `Failed to send message (status ${resp.status})`;
        throw new Error(msg);
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
  }

  // ===== Methods below are reused from the legacy implementation =====
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
    try {
      const resp = await fetch('/api/realtime/status', { credentials: 'include' });
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (data?.userId) {
          this.userId = data.userId;
          return data.userId;
        }
      }
    } catch (error) {
      console.warn('Realtime user id fetch failed:', error?.message || error);
    }
    return null;
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

  appendMessageToThread(message) {
    try {
      const thread = document.querySelector('.chat-thread');
      if (!thread) return false;
      if (message?.id && document.getElementById(`message-${message.id}`)) {
        return true;
      }
      const container = document.createElement('div');
      const direction = message?.direction === 'outbound' ? 'msg msg-out' : 'msg msg-in';
      container.className = `${direction} message-container`;
      if (message?.id) {
        container.id = `message-${message.id}`;
        container.setAttribute('data-message-id', message.id);
      }
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const meta = this.formatTimestamp(message?.timestamp);
      bubble.innerHTML = `
        <div class="wa-message-body">${this.formatMessageBody(message)}</div>
        <div class="meta">${meta}</div>
      `;
      container.appendChild(bubble);
      thread.appendChild(container);
      this.scrollThreadToBottom(thread);
      return true;
    } catch (error) {
      console.warn('Append message failed:', error?.message || error);
      return false;
    }
  }

  formatMessageBody(message) {
    const type = message?.type || 'text';
    if (type === 'text') {
      const body = message?.text_body || message?.text || '';
      return this.escapeHtml(body).replace(/\n/g, '<br/>');
    }
    if (type === 'image' && message?.imageUrl) {
      return `<img src="${this.escapeHtml(message.imageUrl)}" alt="Image" style="max-width:200px;border-radius:8px;" />`;
    }
    if (type === 'document' && message?.documentUrl) {
      const name = this.escapeHtml(message.documentName || 'Document');
      return `<a href="${this.escapeHtml(message.documentUrl)}" target="_blank" rel="noopener">📎 ${name}</a>`;
    }
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
      btn.setAttribute('data-is-human', isLive);
      const img = btn.querySelector('img');
      if (img) {
        img.src = isLive ? '/raise-hand-icon.svg' : '/bot-icon.svg';
        img.alt = isLive ? 'Human handling' : 'AI handling';
      }
      const hiddenInput = btn.closest('form')?.querySelector('input[name="is_human"]');
      if (hiddenInput) {
        hiddenInput.value = isLive ? '1' : '';
      }
    }
    this.showToast(isLive ? 'Live mode enabled' : 'Live mode disabled', 'info');
    this.emitGlobal('live_mode_changed', data);
  }




  scrollThreadToBottom(container) {
    if (!container) return;
    try {
      const el = container.classList?.contains('chat-thread') ? container : container.closest('.chat-thread');
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

  handleMessageStatusUpdate(data = {}) {
    if (data?.messageId) {
      const el = document.getElementById(`message-${data.messageId}`);
      if (el) {
        el.setAttribute('data-status', data.status || '');
        const meta = el.querySelector('.meta');
        if (meta && data.status) {
          const base = meta.textContent?.split('•')[0]?.trim() || '';
          meta.textContent = base ? `${base} • ${data.status}` : data.status;
        }
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
        /* noop */
      }
    }, 1000);
  }

  async toggleLiveMode(phone, isLive) {
    const payload = {
      phone,
      isLive: !!isLive
    };
    try {
      await fetch('/api/realtime/live-mode', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.warn('Live mode API call failed:', error?.message || error);
    }
    this.publishChatEvent('live_mode_changed', {
      userId: this.userId,
      phone,
      isLive: !!isLive,
      timestamp: Date.now()
    });
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
