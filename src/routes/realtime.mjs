/**
 * Enhanced realtime routes for WebSocket connections and real-time messaging.
 */

import { ensureAuthed, getCurrentUserId } from '../middleware/auth.mjs';
import { db } from '../db.mjs';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { sendWhatsAppText } from '../services/whatsapp.mjs';
import { getSettingsForUser } from '../services/settings.mjs';

// Store active connections and user sessions
const activeConnections = new Map();
const userSessions = new Map();
const typingUsers = new Map();

// Initialize Socket.IO server
let io = null;

export function getIO() {
  return io;
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

  // Handle connections
  io.on('connection', (socket) => {
    const userId = socket.userId;
    const sessionId = `${userId}-${Date.now()}`;
    
    console.log(`🔌 User ${userId} connected with session ${sessionId}`);
    
    // Store connection
    activeConnections.set(sessionId, socket);
    userSessions.set(userId, sessionId);
    
    // Join user to their personal room
    socket.join(`user:${userId}`);
    
    // Handle ping/heartbeat
    socket.on('ping', (data) => {
      console.log('💓 Heartbeat received from user:', userId);
      try {
        socket.emit('pong', { timestamp: Date.now(), received: data.timestamp });
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
          const { phone, message, type = 'text' } = data;
          if (phone && message) {
            try {
              console.log('📤 Real-time message send request:', { userId, phone, message, type });
              
              // Clean phone number to remove any URL parameters
              const cleanPhone = phone.split('?')[0];
              console.log('📱 Cleaned phone number:', cleanPhone);
              
              // Get user settings for WhatsApp API
              const cfg = getSettingsForUser(userId);
          
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
            socket.emit('message_error', { error: 'Failed to send message via WhatsApp' });
          }
          
        } catch (error) {
          console.error('❌ Error sending message:', error);
          
          // Handle specific WhatsApp configuration errors
          if (error.message.includes('WhatsApp is not configured')) {
            socket.emit('message_error', { 
              error: 'WhatsApp is not configured. Please check your settings and configure WhatsApp API credentials.',
              type: 'config_error'
            });
          } else {
            socket.emit('message_error', { 
              error: 'Failed to send message: ' + error.message,
              type: 'send_error'
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
  if (io) {
    console.log('📡 Socket.IO available, emitting to chat:', `chat:${phone}`);
    io.to(`chat:${phone}`).emit('new_message', messageData);
  } else {
    console.log('❌ Socket.IO not available for broadcasting');
  }
}

// Function to broadcast typing indicators (called from webhooks)
export function broadcastTypingIndicator(userId, phone, type) {
  if (io) {
    io.to(`chat:${phone}`).emit(type === 'typing_start' ? 'typing_start' : 'typing_stop', {
      userId,
      phone,
      timestamp: Date.now()
    });
  }
}

// Function to broadcast live mode changes
export function broadcastLiveModeChange(userId, phone, isLive) {
  if (io) {
    io.to(`chat:${phone}`).emit('live_mode_changed', {
      userId,
      phone,
      isLive,
      timestamp: Date.now()
    });
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
