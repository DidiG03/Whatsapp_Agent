/**
 * Enhanced realtime routes for WebSocket connections and real-time messaging.
 */

import { ensureAuthed, getCurrentUserId } from '../middleware/auth.mjs';
import { db } from '../db-serverless.mjs';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { sendWhatsAppText } from '../services/whatsapp.mjs';
import { getSettingsForUser } from '../services/settings.mjs';
import { markMessageAsFailed, MESSAGE_STATUS } from '../services/messageStatus.mjs';
import { getAllMetrics } from '../monitoring/metrics.mjs';

// Store active connections and user sessions with limits
const activeConnections = new Map();
const userSessions = new Map();
const typingUsers = new Map();
const connectionTimestamps = new Map(); // Track connection times for cleanup

// Connection limits and cleanup
const MAX_CONNECTIONS_PER_USER = 3;
const MAX_TOTAL_CONNECTIONS = 1000;
const CONNECTION_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const TYPING_CLEANUP_INTERVAL = 30 * 1000; // 30 seconds

// Initialize Socket.IO server
let io = null;

export function getIO() {
  return io;
}

// Cleanup functions
function cleanupStaleConnections() {
  const now = Date.now();
  const staleThreshold = 10 * 60 * 1000; // 10 minutes
  
  console.log('🧹 Starting connection cleanup...');
  
  // Clean up stale connections
  for (const [sessionId, timestamp] of connectionTimestamps.entries()) {
    if (now - timestamp > staleThreshold) {
      const connection = activeConnections.get(sessionId);
      if (connection && connection.connected) {
        console.log(`🧹 Cleaning up stale connection: ${sessionId}`);
        connection.disconnect();
      }
      activeConnections.delete(sessionId);
      connectionTimestamps.delete(sessionId);
    }
  }
  
  // Clean up stale typing indicators
  for (const [key, timestamp] of typingUsers.entries()) {
    if (now - timestamp > 60000) { // 1 minute
      typingUsers.delete(key);
    }
  }
  
  console.log(`🧹 Cleanup complete. Active connections: ${activeConnections.size}, Typing users: ${typingUsers.size}`);
}

function enforceConnectionLimits(userId) {
  // Check total connections limit
  if (activeConnections.size >= MAX_TOTAL_CONNECTIONS) {
    console.warn(`⚠️ Max total connections (${MAX_TOTAL_CONNECTIONS}) reached`);
    return false;
  }
  
  // Check per-user connection limit
  const userConnections = Array.from(activeConnections.values())
    .filter(conn => conn.userId === userId);
  
  if (userConnections.length >= MAX_CONNECTIONS_PER_USER) {
    console.warn(`⚠️ User ${userId} has reached max connections (${MAX_CONNECTIONS_PER_USER})`);
    // Disconnect oldest connection for this user
    const oldestConnection = userConnections[0];
    if (oldestConnection) {
      oldestConnection.disconnect();
    }
  }
  
  return true;
}

export function initializeSocketIO(server) {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true
    },
    transports: ['polling', 'websocket'], // Start with polling, upgrade to websocket
    pingTimeout: 30000, // 30 seconds
    pingInterval: 15000, // 15 seconds
    upgradeTimeout: 5000, // 5 seconds
    allowEIO3: true,
    serveClient: true,
    allowUpgrades: true,
    perMessageDeflate: {
      threshold: 1024,
      concurrencyLimit: 10,
      memLevel: 7
    },
    maxHttpBufferSize: 1e6, // 1MB
    connectTimeout: 20000, // 20 seconds
    forceNew: false
  });

  // Authentication middleware for Socket.IO
  io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    const userId = socket.handshake.auth.userId || socket.handshake.query.userId;
    
    console.log('🔐 Socket.IO auth attempt:', { userId, token: token ? 'present' : 'missing' });
    
    if (!userId) {
      console.log('❌ Socket.IO auth failed: No userId provided');
      return next(new Error('Authentication required'));
    }
    
    socket.userId = userId;
    console.log('✅ Socket.IO auth successful for userId:', userId);
    next();
  });

  // Set up cleanup intervals
  setInterval(cleanupStaleConnections, CONNECTION_CLEANUP_INTERVAL);
  setInterval(() => {
    // Clean up stale typing indicators more frequently
    const now = Date.now();
    for (const [key, timestamp] of typingUsers.entries()) {
      if (now - timestamp > 60000) { // 1 minute
        typingUsers.delete(key);
      }
    }
  }, TYPING_CLEANUP_INTERVAL);

  // Handle connections
  io.on('connection', (socket) => {
    const userId = socket.userId;
    const sessionId = `${userId}-${Date.now()}`;
    
    console.log(`🔌 User ${userId} connected with session ${sessionId}`);
    
    // Enforce connection limits
    if (!enforceConnectionLimits(userId)) {
      socket.disconnect();
      return;
    }
    
    // Store connection with timestamp
    activeConnections.set(sessionId, socket);
    connectionTimestamps.set(sessionId, Date.now());
    userSessions.set(userId, sessionId);
    
    // Join user to their personal room
    socket.join(`user:${userId}`);
    
    // Handle ping/heartbeat with error handling
    socket.on('ping', (data) => {
      console.log('💓 Heartbeat received from user:', userId);
      try {
        if (socket.connected) {
          socket.emit('pong', { timestamp: Date.now(), received: data.timestamp });
          // Update connection timestamp on successful ping
          connectionTimestamps.set(sessionId, Date.now());
        }
      } catch (error) {
        console.error('💓 Error sending pong:', error);
      }
    });
    
    // Handle joining a chat room
    socket.on('join_chat', (data) => {
      const { phone } = data;
      if (phone) {
        socket.join(`chat:${phone}`);
        socket.currentChat = phone;
        console.log(`👤 User ${userId} joined chat ${phone}`);
        
        // Notify others in the chat that user is online
        socket.to(`chat:${phone}`).emit('user_online', {
          userId,
          phone,
          timestamp: Date.now()
        });
      }
    });
    
    // Handle leaving a chat room
    socket.on('leave_chat', (data) => {
      const { phone } = data;
      if (phone) {
        socket.leave(`chat:${phone}`);
        socket.currentChat = null;
        console.log(`👤 User ${userId} left chat ${phone}`);
        
        // Notify others in the chat that user is offline
        socket.to(`chat:${phone}`).emit('user_offline', {
          userId,
          phone,
          timestamp: Date.now()
        });
      }
    });
    
    // Handle typing indicators
    socket.on('typing_start', (data) => {
      const { phone } = data;
      if (phone) {
        typingUsers.set(`${userId}-${phone}`, Date.now());
        socket.to(`chat:${phone}`).emit('typing_start', {
          userId,
          phone,
          timestamp: Date.now()
        });
      }
    });
    
    socket.on('typing_stop', (data) => {
      const { phone } = data;
      if (phone) {
        typingUsers.delete(`${userId}-${phone}`);
        socket.to(`chat:${phone}`).emit('typing_stop', {
          userId,
          phone,
          timestamp: Date.now()
        });
      }
    });
    
    // Handle live mode toggle
    socket.on('toggle_live_mode', (data) => {
      const { phone, isLive } = data;
      if (phone) {
        socket.to(`chat:${phone}`).emit('live_mode_changed', {
          userId,
          phone,
          isLive,
          timestamp: Date.now()
        });
      }
    });
    
    // Handle message sending
        socket.on('send_message', async (data) => {
          if (!socket.connected) {
            console.warn('Socket not connected, ignoring message send request');
            return;
          }
          
          const { phone, message, type = 'text' } = data;
          if (phone && message) {
            try {
              console.log('📤 Real-time message send request:', { userId, phone, message, type });
              
              // Clean phone number to remove any URL parameters
              const cleanPhone = phone.split('?')[0];
              console.log('📱 Cleaned phone number:', cleanPhone);
              
              // Get user settings for WhatsApp API
              const cfg = getSettingsForUser(userId);
              
              if (!cfg || !cfg.whatsapp_token || !cfg.phone_number_id) {
                throw new Error('WhatsApp configuration not found');
              }
          
          // Send message via WhatsApp API
          const whatsappResponse = await sendWhatsAppText(cleanPhone, message, cfg);
          const outboundId = whatsappResponse?.messages?.[0]?.id;
          
          if (outboundId) {
            console.log('✅ WhatsApp message sent successfully:', outboundId);
            
            // Store message in database with WhatsApp message ID
            const fromBiz = (cfg.business_phone || "").replace(/\D/g, "") || null;
            const timestamp = Math.floor(Date.now() / 1000);
            
            const stmt = db.prepare(`
              INSERT OR IGNORE INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw)
              VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'text', ?, ?, ?)
            `);
            
            stmt.run(outboundId, userId, fromBiz, cleanPhone, fromBiz, cleanPhone, message, timestamp, JSON.stringify({ to: cleanPhone, text: message }));
            
            // Broadcast message to chat room
            const messageData = {
              id: outboundId,
              direction: 'outbound',
              type: 'text',
              text_body: message,
              timestamp,
              from_digits: fromBiz,
              to_digits: cleanPhone,
              contact_name: null,
              contact: cleanPhone,
              formatted_time: new Date(timestamp * 1000).toLocaleString(),
              delivery_status: 'sent',
              read_status: 'unread'
            };
            
            io.to(`chat:${cleanPhone}`).emit('new_message', messageData);
            
            // Stop typing indicator
            typingUsers.delete(`${userId}-${cleanPhone}`);
            socket.to(`chat:${cleanPhone}`).emit('typing_stop', {
              userId,
              phone: cleanPhone,
              timestamp: Date.now()
            });
            
            console.log('📡 Message broadcasted to chat room:', cleanPhone);
          } else {
            console.error('❌ Failed to send WhatsApp message:', whatsappResponse);
            
            // Create a failed message record
            const tempMessageId = `failed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const timestamp = Math.floor(Date.now() / 1000);
            
            try {
              const stmt = db.prepare(`
                INSERT INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw, delivery_status, error_message)
                VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'text', ?, ?, ?, ?, ?)
              `);
              
              stmt.run(
                tempMessageId, 
                userId, 
                fromBiz, 
                cleanPhone, 
                fromBiz, 
                cleanPhone, 
                message, 
                timestamp, 
                JSON.stringify({ to: cleanPhone, text: message }), 
                MESSAGE_STATUS.FAILED,
                'Failed to send message via WhatsApp'
              );
              
              console.log(`❌ Created failed message record: ${tempMessageId}`);
            } catch (dbError) {
              console.error("Error creating failed message record:", dbError);
            }
            
            socket.emit('message_error', { 
              error: 'Failed to send message via WhatsApp',
              messageId: tempMessageId
            });
          }
          
        } catch (error) {
          console.error('❌ Error sending message:', error);
          
          // Create a failed message record
          const tempMessageId = `failed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const timestamp = Math.floor(Date.now() / 1000);
          
          try {
            const stmt = db.prepare(`
              INSERT INTO messages (id, user_id, direction, from_id, to_id, from_digits, to_digits, type, text_body, timestamp, raw, delivery_status, error_message)
              VALUES (?, ?, 'outbound', ?, ?, ?, ?, 'text', ?, ?, ?, ?, ?)
            `);
            
            stmt.run(
              tempMessageId, 
              userId, 
              fromBiz, 
              cleanPhone, 
              fromBiz, 
              cleanPhone, 
              message, 
              timestamp, 
              JSON.stringify({ to: cleanPhone, text: message }), 
              MESSAGE_STATUS.FAILED,
              error.message
            );
            
            console.log(`❌ Created failed message record: ${tempMessageId}`);
          } catch (dbError) {
            console.error("Error creating failed message record:", dbError);
          }
          
          // Handle specific WhatsApp configuration errors
          if (error.message.includes('WhatsApp is not configured')) {
            socket.emit('message_error', { 
              error: 'WhatsApp is not configured. Please check your settings and configure WhatsApp API credentials.',
              type: 'config_error',
              messageId: tempMessageId
            });
          } else {
            socket.emit('message_error', { 
              error: 'Failed to send message: ' + error.message,
              type: 'send_error',
              messageId: tempMessageId
            });
          }
        }
      }
    });
    
    // Handle disconnect
    socket.on('disconnect', (reason) => {
      console.log(`🔌 User ${userId} disconnected:`, reason);
      
      try {
        // Clean up connections
        activeConnections.delete(sessionId);
        connectionTimestamps.delete(sessionId);
        userSessions.delete(userId);
        
        // Clean up typing indicators
        for (const [key, timestamp] of typingUsers.entries()) {
          if (key.startsWith(`${userId}-`)) {
            typingUsers.delete(key);
            const phone = key.split('-')[1];
            socket.to(`chat:${phone}`).emit('typing_stop', {
              userId,
              phone,
              timestamp: Date.now()
            });
          }
        }
        
        // Notify current chat that user is offline
        if (socket.currentChat) {
          socket.to(`chat:${socket.currentChat}`).emit('user_offline', {
            userId,
            phone: socket.currentChat,
            timestamp: Date.now()
          });
        }
        
        // Remove from all rooms
        socket.leaveAll();
        
        console.log(`🧹 Cleaned up connection for user ${userId}, session ${sessionId}`);
      } catch (error) {
        console.error('🔌 Error during disconnect cleanup:', error);
      }
    });
  });

  return io;
}

// Function to broadcast new messages (called from webhook)
export function broadcastNewMessage(userId, phone, messageData) {
  console.log('📡 Broadcasting new message:', { userId, phone, messageData });
  try {
    if (io) {
      console.log('📡 Socket.IO available, emitting to chat:', `chat:${phone}`);
      io.to(`chat:${phone}`).emit('new_message', messageData);
    } else {
      console.log('❌ Socket.IO not available for broadcasting');
    }
  } catch (error) {
    console.error('❌ Error broadcasting new message:', error);
  }
}

// Function to broadcast typing indicators (called from webhooks)
export function broadcastTypingIndicator(userId, phone, type) {
  try {
    if (io) {
      io.to(`chat:${phone}`).emit(type === 'typing_start' ? 'typing_start' : 'typing_stop', {
        userId,
        phone,
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error('❌ Error broadcasting typing indicator:', error);
  }
}

// Function to broadcast live mode changes
export function broadcastLiveModeChange(userId, phone, isLive) {
  try {
    if (io) {
      io.to(`chat:${phone}`).emit('live_mode_changed', {
        userId,
        phone,
        isLive,
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error('❌ Error broadcasting live mode change:', error);
  }
}

// Function to broadcast message reactions
export function broadcastReaction(userId, phone, messageId, emoji, action, reactionData) {
  console.log('📡 Broadcasting reaction:', { userId, phone, messageId, emoji, action });
  console.log('📡 Socket.IO available:', !!io);
  console.log('📡 Socket.IO connected clients:', io ? io.engine.clientsCount : 'N/A');
  
  try {
    if (io) {
      const roomName = `chat:${phone}`;
      console.log('📡 Broadcasting to room:', roomName);
      console.log('📡 Room clients:', io.sockets.adapter.rooms.get(roomName)?.size || 0);
      
      io.to(roomName).emit('message_reaction', {
        userId,
        phone,
        messageId,
        emoji,
        action, // 'added' or 'removed'
        reactionData,
        timestamp: Date.now()
      });
      
      console.log('📡 Reaction broadcasted successfully');
    } else {
      console.log('❌ Socket.IO not available for reaction broadcasting');
    }
  } catch (error) {
    console.error('❌ Error broadcasting reaction:', error);
  }
}

// Function to broadcast message status updates
export function broadcastMessageStatus(userId, phone, messageId, status, statusData) {
  console.log('📡 Broadcasting message status:', { userId, phone, messageId, status });
  console.log('📡 Socket.IO available:', !!io);
  console.log('📡 Socket.IO connected clients:', io ? io.engine.clientsCount : 'N/A');
  
  try {
    if (io) {
      const roomName = `chat:${phone}`;
      console.log('📡 Broadcasting status to room:', roomName);
      console.log('📡 Room clients:', io.sockets.adapter.rooms.get(roomName)?.size || 0);
      
      io.to(roomName).emit('message_status_update', {
        userId,
        phone,
        messageId,
        status, // 'sent', 'delivered', 'read', 'failed'
        statusData,
        timestamp: Date.now()
      });
      
      console.log('📡 Message status broadcasted successfully');
    } else {
      console.log('❌ Socket.IO not available for status broadcasting');
    }
  } catch (error) {
    console.error('❌ Error broadcasting message status:', error);
  }
}

// Function to broadcast metrics updates
export function broadcastMetricsUpdate(userId, metricsData) {
  console.log('📊 Broadcasting metrics update for user:', userId);
  
  try {
    if (io) {
      const roomName = `user:${userId}`;
      console.log('📊 Broadcasting metrics to room:', roomName);
      
      io.to(roomName).emit('metrics_update', {
        userId,
        data: metricsData,
        timestamp: Date.now()
      });
      
      console.log('📊 Metrics update broadcasted successfully');
    } else {
      console.log('❌ Socket.IO not available for metrics broadcasting');
    }
  } catch (error) {
    console.error('❌ Error broadcasting metrics update:', error);
  }
}

// Legacy SSE endpoints for backward compatibility
export default function registerRealtimeRoutes(app) {
  
  // Server-Sent Events endpoint for typing indicators (legacy)
  app.get("/api/typing/:phone", (req, res) => {
    const phone = req.params.phone;
    const userId = req.query.userId || req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }
    
    const connectionId = `${userId}-${phone}`;
    
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });
    
    // Send initial connection confirmation
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Connected to typing updates' })}\n\n`);
    
    // Handle client disconnect
    req.on('close', () => {
      console.log(`SSE connection closed for ${connectionId}`);
    });
    
    req.on('aborted', () => {
      console.log(`SSE connection aborted for ${connectionId}`);
    });
  });
  
  // API endpoint to get active connections info
  app.get("/api/realtime/status", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    
    res.json({
      userId,
      isConnected: userSessions.has(userId),
      activeConnections: activeConnections.size,
      activeUsers: userSessions.size,
      typingUsers: Array.from(typingUsers.keys()),
      socketIOAvailable: io !== null
    });
  });
  
  // API endpoint to toggle live mode
  app.post("/api/realtime/live-mode", ensureAuthed, async (req, res) => {
    const userId = getCurrentUserId(req);
    const { phone, isLive } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }
    
    try {
      // Update handoff table to reflect live mode
      const stmt = db.prepare(`
        INSERT INTO handoff (contact_id, user_id, is_human, updated_at)
        VALUES (?, ?, ?, strftime('%s','now'))
        ON CONFLICT(contact_id, user_id) DO UPDATE SET 
          is_human = ?, 
          updated_at = strftime('%s','now')
      `);
      
      stmt.run(phone, userId, isLive ? 1 : 0, isLive ? 1 : 0);
      
      // Broadcast live mode change
      broadcastLiveModeChange(userId, phone, isLive);
      
      res.json({ 
        success: true, 
        message: `Live mode ${isLive ? 'enabled' : 'disabled'}`,
        phone,
        isLive
      });
      
    } catch (error) {
      console.error('Error toggling live mode:', error);
      res.status(500).json({ error: 'Failed to toggle live mode' });
    }
  });
  
  // Test endpoint to manually trigger message broadcast
  app.post("/api/realtime/test-broadcast", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    const messageData = {
      id: `test_${Date.now()}`,
      direction: 'inbound',
      type: 'text',
      text_body: message,
      timestamp: Math.floor(Date.now() / 1000),
      from_digits: phone,
      to_digits: null,
      contact_name: null,
      contact: phone,
      formatted_time: new Date().toLocaleString()
    };
    
    broadcastNewMessage(userId, phone, messageData);
    
    res.json({ 
      success: true, 
      message: 'Test message broadcasted',
      phone,
      messageData
    });
  });

  // Test endpoint to manually trigger message status update broadcast
  app.post("/api/realtime/test-status", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const { phone, messageId, status } = req.body;
    
    if (!phone || !messageId || !status) {
      return res.status(400).json({ 
        error: 'Phone, messageId, and status required' 
      });
    }
    
    const statusData = {
      messageId,
      status,
      recipientId: phone,
      timestamp: Date.now(),
      error: null
    };
    
    console.log('🧪 Testing message status broadcast:', { userId, phone, messageId, status });
    broadcastMessageStatus(userId, phone, messageId, status, statusData);
    
    res.json({ 
      success: true, 
      message: 'Test message status broadcasted',
      phone,
      messageId,
      status,
      statusData
    });
  });

  // Test endpoint to manually trigger reaction removal broadcast
  app.post("/api/realtime/test-reaction-removal", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const { phone, messageId, emoji } = req.body;
    
    if (!phone || !messageId || !emoji) {
      return res.status(400).json({ 
        error: 'Phone, messageId, and emoji required' 
      });
    }
    
    const reactionData = {
      messageId,
      emoji,
      userId: `test_${userId}`,
      added: false,
      removed: true
    };
    
    console.log('🧪 Testing reaction removal broadcast:', { userId, phone, messageId, emoji });
    broadcastReaction(userId, phone, messageId, emoji, 'removed', reactionData);
    
    res.json({ 
      success: true, 
      message: 'Test reaction removal broadcasted',
      phone,
      messageId,
      emoji,
      reactionData
    });
  });

  // Test endpoint to manually trigger reaction broadcast
  app.post("/api/realtime/test-reaction", ensureAuthed, (req, res) => {
    const userId = getCurrentUserId(req);
    const { phone, messageId, emoji } = req.body;
    
    if (!phone || !messageId || !emoji) {
      return res.status(400).json({ 
        error: 'Phone, messageId, and emoji required' 
      });
    }
    
    const reactionData = {
      messageId,
      emoji,
      userId: `test_${userId}`,
      added: true,
      removed: false
    };
    
    console.log('🧪 Testing reaction broadcast:', { userId, phone, messageId, emoji });
    broadcastReaction(userId, phone, messageId, emoji, 'added', reactionData);
    
    res.json({ 
      success: true, 
      message: 'Test reaction broadcasted',
      phone,
      messageId,
      emoji,
      reactionData
    });
  });

  app.get("/realtime", (req, res) => {
    res.json({ 
      message: "Enhanced realtime features active",
      activeConnections: activeConnections.size,
      activeUsers: userSessions.size,
      socketIOAvailable: io !== null,
      endpoints: [
        "GET /api/typing/:phone - SSE connection for typing indicators (legacy)",
        "GET /api/realtime/status - Get realtime connection status",
        "POST /api/realtime/live-mode - Toggle live mode for agent",
        "POST /api/realtime/test-broadcast - Test message broadcast",
        "WebSocket events: join_chat, leave_chat, typing_start, typing_stop, send_message, toggle_live_mode"
      ]
    });
  });
}
