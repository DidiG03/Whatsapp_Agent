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
    if (this.isConnected) {
      console.log('🔌 Already connected');
      return;
    }
    
    if (!this.userId) {
      console.warn('No user ID found, cannot connect');
      return;
    }
    
    try {
      // Initialize Socket.IO connection
      await this.connectSocket();
      
      // Set up event listeners
      this.setupEventListeners();
      
      console.log('🔌 RealtimeManager connected with userId:', this.userId);
    } catch (error) {
      console.error('Failed to connect RealtimeManager:', error);
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
        // Import Socket.IO client
        const script = document.createElement('script');
        script.src = '/socket.io/socket.io.js';
        script.onload = () => {
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
      maxReconnectionAttempts: 5, // Limit attempts
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
            
            // Auto-reconnect for certain disconnect reasons
            if (reason === 'io server disconnect' || reason === 'io client disconnect') {
              console.log('🔄 Attempting to reconnect...');
              setTimeout(() => {
                if (!this.isConnected) {
                  this.socket.connect();
                }
              }, 2000);
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
        
        script.onerror = () => {
          reject(new Error('Failed to load Socket.IO client'));
        };
        
        document.head.appendChild(script);
      } catch (error) {
        reject(error);
      }
    });
  }
  
  setupEventListeners() {
    if (!this.socket) return;
    
    // Handle new messages
    this.socket.on('new_message', (messageData) => {
      this.handleNewMessage(messageData);
    });
    
    // Handle typing indicators
    this.socket.on('typing_start', (data) => {
      this.handleTypingStart(data);
    });
    
    this.socket.on('typing_stop', (data) => {
      this.handleTypingStop(data);
    });
    
    // Handle heartbeat responses
    this.socket.on('pong', (data) => {
      console.log('💓 Heartbeat acknowledged:', data);
    });
    
    // Handle live mode changes
    this.socket.on('live_mode_changed', (data) => {
      this.handleLiveModeChange(data);
    });
    
    // Handle user online/offline
    this.socket.on('user_online', (data) => {
      this.handleUserOnline(data);
    });
    
    this.socket.on('user_offline', (data) => {
      this.handleUserOffline(data);
    });
    
    // Handle message errors
    this.socket.on('message_error', (error) => {
      this.handleMessageError(error);
    });
    
    // Handle message status updates
    this.socket.on('message_status_update', (data) => {
      this.handleMessageStatusUpdate(data);
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
        
        // Show/hide second tick based on status
        const secondTick = statusTicksDiv.querySelector('.message-tick:nth-child(2)');
        if (secondTick) {
          secondTick.style.display = status === 'sent' ? 'none' : 'block';
        }
        
        console.log(`✅ Updated message ${messageId} status to: ${status}`);
      }
    }
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
});

// Export for use in other scripts
window.RealtimeManager = RealtimeManager;
