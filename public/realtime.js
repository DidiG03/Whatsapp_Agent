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
    this.typingTimeout = null;
    this.isTyping = false;
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
      case 'typing_start':
        this.handleTypingStart(data);
        break;
      case 'typing_stop':
        this.handleTypingStop(data);
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
          'Accept': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        throw new Error('Failed to send message');
      }
      const data = await resp.json().catch(() => ({}));
      if (!data?.success) {
        throw new Error(data?.error || 'Failed to send message');
      }
      return true;
    } catch (error) {
      console.error('Failed to send message via HTTP:', error);
      return false;
    }
  }

  startTyping(phone) {
    if (!this.isConnected || this.isTyping) return;
    this.isTyping = true;
    this.publishChatEvent('typing_start', { userId: this.userId, phone });
    this.typingTimeout = setTimeout(() => this.stopTyping(phone), 3000);
  }

  stopTyping(phone) {
    if (!this.isTyping) return;
    this.isTyping = false;
    this.publishChatEvent('typing_stop', { userId: this.userId, phone });
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
      this.typingTimeout = null;
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
  }

  // ===== Methods below are reused from the legacy implementation =====
