/**
 * Real-time messaging functionality using Socket.IO
 * Handles live chat, typing indicators, and live mode toggles
 */

class RealtimeManager {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.currentChat = null;
    this.userId = null;
    this.typingTimeout = null;
    this.isTyping = false;
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.scriptElement = null;
    this.eventListeners = new Map();
    this.connectionAttempts = 0;
    this.maxConnectionAttempts = 5;
    this.isDestroyed = false;
    
    this.init();
  }
  
  async init() {
    try {
      // Don't auto-connect, wait for userId to be set manually
      console.log('🔌 RealtimeManager initialized (waiting for userId)');
    } catch (error) {
      console.error('Failed to initialize RealtimeManager:', error);
    }
  }
  
  async connect() {
    if (this.isDestroyed) {
      console.warn('RealtimeManager is destroyed, cannot connect');
      return;
    }
    
    if (this.isConnected) {
      console.log('🔌 Already connected');
      return;
    }
    
    if (!this.userId) {
      console.warn('No user ID found, cannot connect');
      return;
    }
    
    if (this.connectionAttempts >= this.maxConnectionAttempts) {
      console.error('Max connection attempts reached, giving up');
      return;
    }
    
    this.connectionAttempts++;
    
    try {
      // Initialize Socket.IO connection
      await this.connectSocket();
      
      // Set up event listeners
      this.setupEventListeners();
      
      console.log('🔌 RealtimeManager connected with userId:', this.userId);
    } catch (error) {
      console.error('Failed to connect RealtimeManager:', error);
      this.handleConnectionError();
    }
  }
  
  async getUserId() {
    // Try to get user ID from auth manager
    if (window.authManager && window.authManager.getCurrentUserId) {
      return window.authManager.getCurrentUserId();
    }
    
    // Try to get from session storage
    const sessionData = sessionStorage.getItem('auth_session');
    if (sessionData) {
      try {
        const parsed = JSON.parse(sessionData);
        return parsed.userId;
      } catch (e) {
        console.warn('Failed to parse session data');
      }
    }
    
    // Try to get from URL parameters (for testing)
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('userId');
  }
  
  async connectSocket() {
    return new Promise((resolve, reject) => {
      try {
        // Clean up any existing script
        if (this.scriptElement && this.scriptElement.parentNode) {
          this.scriptElement.parentNode.removeChild(this.scriptElement);
        }
        
        // Import Socket.IO client
        this.scriptElement = document.createElement('script');
        this.scriptElement.src = '/socket.io/socket.io.js';
        this.scriptElement.onload = () => {
          console.log('🔌 Socket.IO client loaded, connecting...');
          // Configure Socket.IO with better connection options
          this.socket = io({
            auth: {
              userId: this.userId
            },
            query: {
              userId: this.userId
            },
            transports: ['polling', 'websocket'], // Start with polling, upgrade to websocket
            timeout: 30000, // 30 seconds
            reconnection: true,
            reconnectionDelay: 2000, // 2 seconds
            reconnectionDelayMax: 10000, // 10 seconds
            maxReconnectionAttempts: 3, // Reduced attempts
            forceNew: false, // Don't force new connection
            upgrade: true, // Allow transport upgrades
            rememberUpgrade: true, // Remember successful upgrades
            autoConnect: true
          });
          
          this.socket.on('connect', () => {
            this.isConnected = true;
            console.log('🔌 Connected to real-time server with userId:', this.userId);
            this.updateConnectionStatus(true);
            this.startHeartbeat();
            resolve();
          });
          
          this.socket.on('disconnect', (reason) => {
            this.isConnected = false;
            console.log('🔌 Disconnected from real-time server:', reason);
            this.updateConnectionStatus(false);
            this.stopHeartbeat();
            this.clearReconnectTimeout();
            
            // Auto-reconnect for certain disconnect reasons (but not if destroyed)
            if (!this.isDestroyed && (reason === 'io server disconnect' || reason === 'io client disconnect')) {
              console.log('🔄 Attempting to reconnect...');
              this.scheduleReconnect();
            }
          });
          
          this.socket.on('connect_error', (error) => {
            console.error('❌ Socket connection error:', error);
            this.isConnected = false;
            this.updateConnectionStatus(false);
            this.handleConnectionError();
          });

          this.socket.on('reconnect', (attemptNumber) => {
            console.log('🔄 Reconnected after', attemptNumber, 'attempts');
            this.isConnected = true;
            this.updateConnectionStatus(true);
            
            // Rejoin chat room after reconnection
            if (this.currentChat) {
              this.joinChat(this.currentChat);
            }
          });

          this.socket.on('reconnect_error', (error) => {
            console.error('Reconnection error:', error);
            this.updateConnectionStatus(false);
          });

          this.socket.on('reconnect_failed', () => {
            console.error('Failed to reconnect after maximum attempts');
            this.updateConnectionStatus(false);
          });
        };
        
        this.scriptElement.onerror = () => {
          reject(new Error('Failed to load Socket.IO client'));
        };
        
        document.head.appendChild(this.scriptElement);
      } catch (error) {
        reject(error);
      }
    });
  }
  
  
  // Join a chat room
  joinChat(phone) {
    if (!this.socket || !this.isConnected) {
      console.warn('Socket not connected, cannot join chat');
      return;
    }
    
    this.currentChat = phone;
    this.socket.emit('join_chat', { phone });
    console.log(`👤 Joined chat: ${phone}`);
  }
  
  // Leave a chat room
  leaveChat(phone) {
    if (!this.socket || !this.isConnected) return;
    
    this.socket.emit('leave_chat', { phone });
    this.currentChat = null;
    console.log(`👤 Left chat: ${phone}`);
  }
  
  // Send a message
  sendMessage(phone, message, type = 'text') {
    if (!this.socket || !this.isConnected) {
      console.warn('Socket not connected, cannot send message');
      return false;
    }
    
    this.socket.emit('send_message', { phone, message, type });
    return true;
  }
  
  // Start typing indicator
  startTyping(phone) {
    if (!this.socket || !this.isConnected || this.isTyping) return;
    
    this.isTyping = true;
    this.socket.emit('typing_start', { phone });
    
    // Auto-stop typing after 3 seconds
    this.typingTimeout = setTimeout(() => {
      this.stopTyping(phone);
    }, 3000);
  }
  
  // Stop typing indicator
  stopTyping(phone) {
    if (!this.socket || !this.isConnected || !this.isTyping) return;
    
    this.isTyping = false;
    this.socket.emit('typing_stop', { phone });
    
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
      this.typingTimeout = null;
    }
  }
  
  // Toggle live mode
  toggleLiveMode(phone, isLive) {
    if (!this.socket || !this.isConnected) return;
    
    this.socket.emit('toggle_live_mode', { phone, isLive });
  }
  
  // Handle new message received
  handleNewMessage(messageData) {
    console.log('📨 New message received:', messageData);
    
    // Check if message already exists to prevent duplicates
    const existingMessage = document.querySelector(`[data-message-id="${messageData.id}"]`);
    if (existingMessage) {
      console.log('📨 Message already exists, skipping duplicate:', messageData.id);
      return;
    }
    
    // Add message to chat thread
    this.addMessageToChat(messageData);
    
    // Scroll to bottom
    this.scrollToBottom();
    
    // Show notification if not in focus
    if (document.hidden) {
      this.showNotification(messageData);
    }
  }
  
  // Handle typing start
  handleTypingStart(data) {
    if (data.userId === this.userId) return; // Don't show own typing
    
    this.showTypingIndicator(data.userId, data.phone);
  }
  
  // Handle typing stop
  handleTypingStop(data) {
    if (data.userId === this.userId) return; // Don't hide own typing
    
    this.hideTypingIndicator(data.userId, data.phone);
  }
  
  // Handle live mode change
  handleLiveModeChange(data) {
    console.log('🔄 Live mode changed:', data);
    this.updateLiveModeIndicator(data.phone, data.isLive);
  }
  
  // Handle user online
  handleUserOnline(data) {
    if (data.userId === this.userId) return;
    this.showUserOnlineIndicator(data.userId, data.phone);
  }
  
  // Handle user offline
  handleUserOffline(data) {
    if (data.userId === this.userId) return;
    this.hideUserOnlineIndicator(data.userId, data.phone);
  }
  
  // Handle message error
  handleMessageError(error) {
    console.error('Message error:', error);
    
    if (error.type === 'config_error') {
      this.showErrorMessage('WhatsApp Configuration Error: ' + error.error);
    } else {
      this.showErrorMessage(error.error || 'Failed to send message');
    }
  }

  handleMessageStatusUpdate(data) {
    console.log('📊 Message status update:', data);
    
    const { messageId, status } = data;
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    
    if (messageElement) {
      const statusTicksDiv = messageElement.querySelector('.message-status-ticks');
      if (statusTicksDiv) {
        // Update the status class
        statusTicksDiv.className = `message-status-ticks message-status-${status}`;
        
        // Handle different status types
        const firstTick = statusTicksDiv.querySelector('.message-tick:nth-child(1)');
        const secondTick = statusTicksDiv.querySelector('.message-tick:nth-child(2)');
        
        if (firstTick && secondTick) {
          switch (status) {
            case 'sent':
              // Only first tick visible (gray)
              firstTick.style.display = 'block';
              firstTick.style.color = '#999';
              secondTick.style.display = 'none';
              break;
            case 'delivered':
              // Both ticks visible, first tick green, second tick gray
              firstTick.style.display = 'block';
              firstTick.style.color = '#4CAF50';
              secondTick.style.display = 'block';
              secondTick.style.color = '#999';
              break;
            case 'read':
              // Both ticks visible and green
              firstTick.style.display = 'block';
              firstTick.style.color = '#4CAF50';
              secondTick.style.display = 'block';
              secondTick.style.color = '#4CAF50';
              break;
            case 'failed':
              // Show failed state with retry button
              statusTicksDiv.innerHTML = `
                <div class="message-failed-indicator" title="Message failed to send">
                  <span class="failed-icon">!</span>
                  <button class="retry-button" onclick="retryMessage('${messageId}')" title="Retry sending message">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                      <path d="M21 3v5h-5"/>
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                      <path d="M3 21v-5h5"/>
                    </svg>
                  </button>
                </div>
              `;
              break;
            default:
              // Default to sent state
              firstTick.style.display = 'block';
              firstTick.style.color = '#999';
              secondTick.style.display = 'none';
          }
        }
        
        console.log(`✅ Updated message ${messageId} status to: ${status}`);
      } else {
        console.warn(`Status ticks div not found for message ${messageId}`);
      }
    } else {
      console.warn(`Message element not found for ID: ${messageId}`);
    }
  }
  
  handleMessageReaction(data) {
    console.log('😀 Message reaction update received:', data);
    console.log('😀 Socket connected:', this.isConnected);
    console.log('😀 Current chat:', this.currentChat);
    
    const { messageId, emoji, action, userId } = data;
    
    // Use data attribute selector which is more reliable than ID with special characters
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    
    if (!messageElement) {
      console.warn(`Message element not found for ID: ${messageId}`);
      console.warn(`Tried selector: [data-message-id="${messageId}"]`);
      return;
    }
    
    console.log(`Found message element for ID: ${messageId}`);
    this.updateReactionOnElement(messageElement, messageId, emoji, action);
  }
  
  updateReactionOnElement(messageElement, messageId, emoji, action) {
    // Find or create the reactions container
    let reactionsContainer = messageElement.querySelector('.message-reactions');
    if (!reactionsContainer) {
      reactionsContainer = document.createElement('div');
      reactionsContainer.className = 'message-reactions';
      
      // Insert before the action buttons
      const actionButtons = messageElement.querySelector('.message-actions');
      if (actionButtons) {
        actionButtons.parentNode.insertBefore(reactionsContainer, actionButtons);
      } else {
        // Insert at the end of the message bubble
        const messageBubble = messageElement.querySelector('.bubble');
        if (messageBubble) {
          messageBubble.appendChild(reactionsContainer);
        }
      }
    }
    
    // Find existing reaction for this emoji
    const existingReaction = reactionsContainer.querySelector(`[data-emoji="${emoji}"]`);
    
    if (action === 'added') {
      if (existingReaction) {
        // Update count
        const countSpan = existingReaction.querySelector('.reaction-count');
        if (countSpan) {
          const currentCount = parseInt(countSpan.textContent) || 0;
          countSpan.textContent = currentCount + 1;
        }
      } else {
        // Create new reaction element
        const reactionElement = document.createElement('span');
        reactionElement.className = 'reaction customer-reaction';
        reactionElement.setAttribute('data-message-id', messageId);
        reactionElement.setAttribute('data-emoji', emoji);
        reactionElement.title = 'Customer reaction';
        reactionElement.style.cursor = 'default';
        reactionElement.innerHTML = `${emoji}<span class="reaction-count">1</span>`;
        
        reactionsContainer.appendChild(reactionElement);
      }
      
      // Show a subtle animation for new reactions
      const reactionElement = reactionsContainer.querySelector(`[data-emoji="${emoji}"]`);
      if (reactionElement) {
        reactionElement.style.transform = 'scale(1.2)';
        reactionElement.style.transition = 'transform 0.2s ease';
        setTimeout(() => {
          reactionElement.style.transform = 'scale(1)';
        }, 200);
      }
      
    } else if (action === 'removed') {
      if (existingReaction) {
        const countSpan = existingReaction.querySelector('.reaction-count');
        if (countSpan) {
          const currentCount = parseInt(countSpan.textContent) || 0;
          if (currentCount <= 1) {
            // Remove the reaction entirely
            existingReaction.remove();
          } else {
            // Decrease count
            countSpan.textContent = currentCount - 1;
          }
        }
      }
    }
    
    console.log(`✅ Updated reactions for message ${messageId}: ${action} ${emoji}`);
  }
  
  // Add message to chat thread
  addMessageToChat(messageData) {
    const chatThread = document.querySelector('.chat-thread');
    if (!chatThread) return;
    
    const messageElement = this.createMessageElement(messageData);
    chatThread.appendChild(messageElement);
    
    // Trigger animation
    messageElement.style.opacity = '0';
    messageElement.style.transform = 'translateY(20px)';
    
    requestAnimationFrame(() => {
      messageElement.style.transition = 'all 0.3s ease-out';
      messageElement.style.opacity = '1';
      messageElement.style.transform = 'translateY(0)';
    });
  }
  
  // Create message element
  createMessageElement(messageData) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${messageData.direction === 'inbound' ? 'msg-in' : 'msg-out'} message-container`;
    msgDiv.setAttribute('data-message-id', messageData.id);
    
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'bubble';
    
    if (messageData.type === 'text') {
      bubbleDiv.textContent = messageData.text_body;
    } else if (messageData.type === 'image') {
      const img = document.createElement('img');
      img.src = messageData.media_url || '/placeholder-image.png';
      img.alt = 'Image';
      img.style.maxWidth = '200px';
      img.style.borderRadius = '8px';
      bubbleDiv.appendChild(img);
    } else {
      bubbleDiv.textContent = `[${messageData.type}] ${messageData.text_body || ''}`;
    }
    
    // Add timestamp INSIDE the bubble (same as existing messages)
    const metaDiv = document.createElement('div');
    metaDiv.className = 'meta';
    metaDiv.textContent = messageData.formatted_time || new Date().toLocaleString();
    
    // Add WhatsApp-style status ticks for outbound messages
    if (messageData.direction === 'outbound') {
      const deliveryStatus = messageData.delivery_status || 'sent';
      const readStatus = messageData.read_status || 'unread';
      
      // Determine final status (read overrides delivered)
      let finalStatus = deliveryStatus;
      if (readStatus === 'read') {
        finalStatus = 'read';
      }
      
      // Create status ticks
      const statusTicksDiv = document.createElement('div');
      statusTicksDiv.className = `message-status-ticks message-status-${finalStatus}`;
      
      const tick1 = document.createElement('div');
      tick1.className = 'message-tick';
      const tick2 = document.createElement('div');
      tick2.className = 'message-tick';
      
      statusTicksDiv.appendChild(tick1);
      statusTicksDiv.appendChild(tick2);
      
      metaDiv.appendChild(statusTicksDiv);
    }
    
    bubbleDiv.appendChild(metaDiv);
    
    msgDiv.appendChild(bubbleDiv);
    
    return msgDiv;
  }
  
  // Show typing indicator
  showTypingIndicator(userId, phone) {
    const chatThread = document.querySelector('.chat-thread');
    if (!chatThread) return;
    
    // Remove existing typing indicator
    this.hideTypingIndicator(userId, phone);
    
    const typingDiv = document.createElement('div');
    typingDiv.className = 'typing-indicator';
    typingDiv.id = `typing-${userId}-${phone}`;
    typingDiv.innerHTML = `
      <div class="msg msg-in">
        <div class="bubble">
          <div class="typing-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </div>
    `;
    
    chatThread.appendChild(typingDiv);
    this.scrollToBottom();
  }
  
  // Hide typing indicator
  hideTypingIndicator(userId, phone) {
    const existing = document.getElementById(`typing-${userId}-${phone}`);
    if (existing) {
      existing.remove();
    }
  }
  
  // Update live mode indicator
  updateLiveModeIndicator(phone, isLive) {
    const handoffBtn = document.getElementById('handoffToggleBtn');
    if (handoffBtn) {
      const img = handoffBtn.querySelector('img');
      if (img) {
        img.src = isLive ? '/raise-hand-icon.svg' : '/bot-icon.svg';
        img.alt = isLive ? 'Human handling' : 'AI handling';
      }
      handoffBtn.setAttribute('data-is-human', isLive);
      
      // Update the hidden input
      const hiddenInput = handoffBtn.closest('form')?.querySelector('input[name="is_human"]');
      if (hiddenInput) {
        hiddenInput.value = isLive ? '1' : '';
      }
    }
  }
  
  // Show user online indicator
  showUserOnlineIndicator(userId, phone) {
    const statusDiv = document.querySelector('.user-status');
    if (statusDiv) {
      statusDiv.textContent = '🟢 Agent Online';
      statusDiv.classList.add('online');
    }
  }
  
  // Hide user online indicator
  hideUserOnlineIndicator(userId, phone) {
    const statusDiv = document.querySelector('.user-status');
    if (statusDiv) {
      statusDiv.textContent = '⚪ Agent Offline';
      statusDiv.classList.remove('online');
    }
  }
  
  // Update connection status
  updateConnectionStatus(isConnected) {
    const statusElement = document.querySelector('.connection-status');
    if (statusElement) {
      statusElement.textContent = isConnected ? '🟢 Connected' : '🔴 Disconnected';
      statusElement.classList.toggle('connected', isConnected);
    }
  }
  
  // Scroll to bottom
  scrollToBottom() {
    const chatThread = document.querySelector('.chat-thread');
    if (chatThread) {
      chatThread.scrollTop = chatThread.scrollHeight;
    }
  }
  
  // Show notification
  showNotification(messageData) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('New Message', {
        body: messageData.text_body,
        icon: '/logo-icon.png'
      });
    }
  }
  
  // Show error message
  showErrorMessage(message) {
    if (window.showToast) {
      window.showToast(message, 'error');
    } else {
      alert(message);
    }
  }
  
  // Get connection status
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      currentChat: this.currentChat,
      userId: this.userId
    };
  }

  // Heartbeat mechanism to keep connection alive
  startHeartbeat() {
    this.stopHeartbeat(); // Clear any existing heartbeat
    
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected && this.socket) {
        try {
          // Send a ping to keep the connection alive
          this.socket.emit('ping', { timestamp: Date.now() });
          console.log('💓 Heartbeat sent');
        } catch (error) {
          console.error('💓 Heartbeat error:', error);
          this.handleConnectionError();
        }
      }
    }, 20000); // Send heartbeat every 20 seconds
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // Handle connection errors gracefully
  handleConnectionError() {
    console.log('🔧 Handling connection error, attempting to reconnect...');
    this.isConnected = false;
    this.updateConnectionStatus(false);
    
    // Attempt to reconnect after a short delay
    setTimeout(() => {
      if (!this.isConnected && this.socket) {
        try {
          this.socket.connect();
        } catch (error) {
          console.error('🔧 Reconnection failed:', error);
        }
      }
    }, 2000);
  }

  // Handle page visibility changes to manage connection
  handleVisibilityChange() {
    if (document.hidden) {
      console.log('📱 Page hidden, reducing connection activity');
      // Don't disconnect, but reduce activity
    } else {
      console.log('📱 Page visible, resuming full connection activity');
      // Ensure we're still connected and rejoin chat if needed
      if (this.isConnected && this.currentChat) {
        this.joinChat(this.currentChat);
      }
    }
  }

  // Schedule reconnection with exponential backoff
  scheduleReconnect() {
    if (this.isDestroyed || this.isConnected) return;
    
    const delay = Math.min(1000 * Math.pow(2, this.connectionAttempts - 1), 30000);
    console.log(`🔄 Scheduling reconnect in ${delay}ms (attempt ${this.connectionAttempts})`);
    
    this.reconnectTimeout = setTimeout(() => {
      if (!this.isDestroyed && !this.isConnected) {
        this.connect();
      }
    }, delay);
  }

  // Clear reconnection timeout
  clearReconnectTimeout() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  // Handle connection errors
  handleConnectionError() {
    this.clearReconnectTimeout();
    this.stopHeartbeat();
    
    if (this.connectionAttempts < this.maxConnectionAttempts) {
      this.scheduleReconnect();
    } else {
      console.error('❌ Max connection attempts reached, giving up');
      this.updateConnectionStatus(false);
    }
  }

  // Properly disconnect and cleanup
  disconnect() {
    console.log('🔌 Disconnecting RealtimeManager...');
    this.isDestroyed = true;
    
    // Clear all timeouts and intervals
    this.clearReconnectTimeout();
    this.stopHeartbeat();
    
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
      this.typingTimeout = null;
    }
    
    // Remove all event listeners
    this.removeAllEventListeners();
    
    // Disconnect socket
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    
    // Clean up script element
    if (this.scriptElement && this.scriptElement.parentNode) {
      this.scriptElement.parentNode.removeChild(this.scriptElement);
      this.scriptElement = null;
    }
    
    // Reset state
    this.isConnected = false;
    this.currentChat = null;
    this.isTyping = false;
    this.connectionAttempts = 0;
    
    console.log('🧹 RealtimeManager cleanup complete');
  }

  // Remove all event listeners
  removeAllEventListeners() {
    for (const [event, listener] of this.eventListeners) {
      if (this.socket) {
        this.socket.off(event, listener);
      }
    }
    this.eventListeners.clear();
  }

  // Enhanced setupEventListeners with proper cleanup tracking
  setupEventListeners() {
    if (!this.socket) return;
    
    // Store listeners for cleanup
    const listeners = {
      'new_message': (messageData) => this.handleNewMessage(messageData),
      'typing_start': (data) => this.handleTypingStart(data),
      'typing_stop': (data) => this.handleTypingStop(data),
      'pong': (data) => console.log('💓 Heartbeat acknowledged:', data),
      'live_mode_changed': (data) => this.handleLiveModeChange(data),
      'user_online': (data) => this.handleUserOnline(data),
      'user_offline': (data) => this.handleUserOffline(data),
      'message_error': (error) => this.handleMessageError(error),
      'message_status_update': (data) => this.handleMessageStatusUpdate(data),
      'message_reaction': (data) => {
        console.log('📡 Received message_reaction event:', data);
        this.handleMessageReaction(data);
      }
    };
    
    // Add listeners and track them
    for (const [event, listener] of Object.entries(listeners)) {
      this.socket.on(event, listener);
      this.eventListeners.set(event, listener);
    }
  }
}

// Initialize real-time manager when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.realtimeManager = new RealtimeManager();
  
  // Add visibility change listener to handle page focus/blur
  document.addEventListener('visibilitychange', () => {
    if (window.realtimeManager) {
      window.realtimeManager.handleVisibilityChange();
    }
  });
  
  // Add cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (window.realtimeManager) {
      window.realtimeManager.disconnect();
    }
  });
  
  // Add cleanup on page hide (mobile)
  window.addEventListener('pagehide', () => {
    if (window.realtimeManager) {
      window.realtimeManager.disconnect();
    }
  });
});

// Export for use in other scripts
window.RealtimeManager = RealtimeManager;
