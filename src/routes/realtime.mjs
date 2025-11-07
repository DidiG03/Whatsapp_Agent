/**
 * Enhanced realtime routes for WebSocket connections and real-time messaging.
 */

import { ensureAuthed, getCurrentUserId, verifySessionToken } from '../middleware/auth.mjs';
import { Handoff, Notification } from '../schemas/mongodb.mjs';
import { db, getDB } from '../db-mongodb.mjs';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { sendWhatsAppText } from '../services/whatsapp.mjs';
import { createReply } from '../services/replies.mjs';
import { getUserPlan } from '../services/usage.mjs';
import { enqueueOutboundMessage, isQueueEnabled, initOutboundQueue } from '../jobs/outboundQueue.mjs';
import { recordOutboundMessage } from '../services/messages.mjs';
import { getSettingsForUser } from '../services/settings.mjs';
import { markMessageAsFailed, MESSAGE_STATUS } from '../services/messageStatus.mjs';
import { getAllMetrics } from '../monitoring/metrics.mjs';

// Store active connections and user sessions with limits
const activeConnections = new Map();
const userSessions = new Map();
const typingUsers = new Map();
const connectionTimestamps = new Map(); // Track connection times for cleanup
// Cache for WhatsApp token validations to avoid validating on every send
const tokenValidationCache = new Map(); // key -> { ok: boolean, exp: number }

// Connection limits and cleanup
const MAX_CONNECTIONS_PER_USER = 3;
const MAX_TOTAL_CONNECTIONS = 1000;
const CONNECTION_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const TYPING_CLEANUP_INTERVAL = 30 * 1000; // 30 seconds
const MAX_TYPING_CLEANUP_PER_TICK = Math.max(100, Number(process.env.MAX_TYPING_CLEANUP_PER_TICK || 1000));

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
      origin: (process.env.SOCKETIO_ALLOWED_ORIGIN || "*") ,
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

  // Authentication middleware for Socket.IO with signed token verification
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      const userIdClaim = socket.handshake.auth.userId || socket.handshake.query.userId;
      
      if (process.env.DEBUG_LOGS === '1') console.log('🔐 Socket.IO auth attempt:', { userId: userIdClaim, token: token ? 'present' : 'missing' });
      
      const verifiedUid = token ? verifySessionToken(token) : null;
      if (verifiedUid) {
        if (userIdClaim && String(userIdClaim) !== String(verifiedUid)) {
          if (process.env.DEBUG_LOGS === '1') console.log('❌ Socket.IO auth failed: Token/user mismatch');
          return next(new Error('Auth user mismatch'));
        }
        socket.userId = String(verifiedUid);
        if (process.env.DEBUG_LOGS === '1') console.log('✅ Socket.IO auth successful for userId:', socket.userId);
        return next();
      }
      
      // Fallback: allow connection with explicit userId claim only when enabled via env
      if (!verifiedUid && userIdClaim && process.env.SOCKETIO_ALLOW_UNVERIFIED === '1') {
        console.warn('⚠️ Socket.IO proceeding without token using claimed userId (fallback enabled by SOCKETIO_ALLOW_UNVERIFIED=1).');
        socket.userId = String(userIdClaim);
        return next();
      }
      
      if (process.env.DEBUG_LOGS === '1') console.log('❌ Socket.IO auth failed: Invalid or missing credentials');
      return next(new Error('Invalid auth token'));
    } catch (e) {
      if (process.env.DEBUG_LOGS === '1') console.log('❌ Socket.IO auth error:', e?.message || e);
      next(new Error('Authentication required'));
    }
  });

  // Set up cleanup intervals
  const connTimer = setInterval(cleanupStaleConnections, CONNECTION_CLEANUP_INTERVAL);
  if (typeof connTimer.unref === 'function') connTimer.unref();
  const typingTimer = setInterval(() => {
    // Clean up stale typing indicators more frequently
    const now = Date.now();
    let processed = 0;
    for (const [key, timestamp] of typingUsers.entries()) {
      if (now - timestamp > 60000) { // 1 minute
        typingUsers.delete(key);
      }
      processed++;
      if (processed >= MAX_TYPING_CLEANUP_PER_TICK) break;
    }
  }, TYPING_CLEANUP_INTERVAL);
  if (typeof typingTimer.unref === 'function') typingTimer.unref();

  // Handle connections
  io.on('connection', (socket) => {
    const userId = socket.userId;
    const sessionId = `${userId}-${Date.now()}`;
    
    if (process.env.DEBUG_LOGS === '1') console.log(`🔌 User ${userId} connected with session ${sessionId}`);
    
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
      if (process.env.DEBUG_LOGS === '1') console.log('💓 Heartbeat received from user:', userId);
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
      if (!phone) return;
      const room = `chat:${phone}`;
      // Leave the previous room if different
      if (socket.currentChat && socket.currentChat !== phone) {
        socket.leave(`chat:${socket.currentChat}`);
      }
      socket.join(room);
      socket.currentChat = phone;
      if (process.env.DEBUG_LOGS === '1') console.log(`👤 User ${userId} joined chat ${phone}`);
      // Notify others in the chat that user is online
      socket.to(room).emit('user_online', {
        userId,
        phone,
        timestamp: Date.now()
      });
    });
    
    // Handle leaving a chat room
    socket.on('leave_chat', (data) => {
      const { phone } = data;
      if (phone) {
        socket.leave(`chat:${phone}`);
        socket.currentChat = null;
        if (process.env.DEBUG_LOGS === '1') console.log(`👤 User ${userId} left chat ${phone}`);
        
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
          
          const { phone, message, type = 'text', replyTo } = data;
          if (typeof message !== 'string' || message.length === 0) {
            socket.emit('message_error', { error: 'Message must be a non-empty string' });
            return;
          }
          const maxLen = Number(process.env.REALTIME_MAX_MESSAGE_LEN || 2000);
          if (message.length > maxLen) {
            socket.emit('message_error', { error: `Message too long (>${maxLen} chars)` });
            return;
          }
          if (phone && message) {
            try {
              if (process.env.DEBUG_LOGS === '1') console.log('📤 Real-time message send request:', { userId, phone, type, len: String(message||'').length });
              
              // Clean phone number to remove any URL parameters
              let cleanPhone = phone.split('?')[0];
              if (process.env.DEBUG_LOGS === '1') console.log('📱 Cleaned phone number:', cleanPhone);
              
              // Get user settings for WhatsApp API
              const cfg = await getSettingsForUser(userId);
              
              if (!cfg || !cfg.whatsapp_token || !cfg.phone_number_id) {
                throw new Error('WhatsApp configuration not found');
              }
            
            // If queue is enabled, validate token with short-lived cache to reduce network calls
            if (isQueueEnabled()) {
              const ttlMs = Math.max(60_000, Number(process.env.REALTIME_TOKEN_CACHE_TTL_MS || 600_000));
              const cacheKey = `${String(cfg.phone_number_id)}:${String(cfg.whatsapp_token||'').slice(0,12)}`;
              const nowMs = Date.now();
              const cached = tokenValidationCache.get(cacheKey);
              if (!cached || cached.exp <= nowMs) {
                try {
                  const fetch = (await import('node-fetch')).default;
                  const resp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(String(cfg.phone_number_id))}`, {
                    headers: { Authorization: `Bearer ${cfg.whatsapp_token}` }
                  });
                  const ok = resp.status >= 200 && resp.status < 300;
                  tokenValidationCache.set(cacheKey, { ok, exp: nowMs + ttlMs });
                  if (!ok) {
                    throw new Error(resp.status === 401 || resp.status === 403 ? 'Invalid or expired WhatsApp token' : `Token validation failed (${resp.status})`);
                  }
                } catch (e) {
                  tokenValidationCache.set(cacheKey, { ok: false, exp: nowMs + Math.min(ttlMs, 60_000) });
                  // Force immediate failure so UI shows red bang without needing refresh
                  throw new Error(e?.message || 'WhatsApp token validation failed');
                }
              } else if (!cached.ok) {
                throw new Error('Invalid or expired WhatsApp token');
              }
            }
          
          // Queue-aware send
          let outboundId = null;
          let lastSendResponse = null;
          let initialDeliveryStatus = 'sent';
          // Prefer direct send when Redis is not connected (avoid silent no-ops)
          const preferDirect = !isQueueEnabled();
          if (!preferDirect) {
            const ok = await initOutboundQueue();
            if (!ok) {
              console.warn('⚠️ Queue requested but not available; falling back to direct send');
            }
            if (ok) {
              const jobId = await enqueueOutboundMessage({ userId, cfg, to: cleanPhone, message });
              if (jobId) {
                // Optimistic placeholder id for UI; actual delivery events will update later
                outboundId = `job_${jobId}`;
                initialDeliveryStatus = 'pending';
              }
            }
          }
          if (!outboundId) {
            // Ensure user id is present in cfg for downstream usage tracking
          if (!cfg.user_id) cfg.user_id = userId;
            try {
              if (process.env.DEBUG_LOGS === '1') console.log('📨 Sending WA text…', { to_tail: String(cleanPhone).slice(-6), cfg_meta: { hasPhoneId: !!cfg?.phone_number_id, hasToken: !!cfg?.whatsapp_token, phoneId_tail: String(cfg?.phone_number_id||'').slice(-6) } });
              lastSendResponse = await sendWhatsAppText(cleanPhone, message, cfg, replyTo || null);
              if (process.env.DEBUG_LOGS === '1') console.log('📨 WhatsApp API response:', {
                hasMessages: !!lastSendResponse?.messages?.[0]?.id,
                keys: lastSendResponse ? Object.keys(lastSendResponse).slice(0, 12) : null
              });
            } catch (e) {
              console.error('📨 WhatsApp send threw error:', e?.message || e);
              lastSendResponse = null;
            }
          outboundId = lastSendResponse?.messages?.[0]?.id;
          }
          
          if (outboundId) {
            if (process.env.DEBUG_LOGS === '1') console.log('✅ WhatsApp message sent successfully:', outboundId);
            
            // Store message in database with WhatsApp message ID
            await recordOutboundMessage({
              messageId: outboundId,
              userId,
              cfg,
              to: cleanPhone,
              type: 'text',
              text: message,
              raw: { to: cleanPhone, text: message }
            });
            // Link reply relationship so UI can render quoted preview
            try {
              if (replyTo) {
                const { createReply } = await import('../services/replies.mjs');
                createReply(String(replyTo), String(outboundId));
              }
            } catch {}
            // Mark conversation as In Progress when agent sends any message via realtime
            try {
              const { updateConversationStatus, CONVERSATION_STATUSES } = await import('../services/conversationStatus.mjs');
              await updateConversationStatus(userId, String(cleanPhone), CONVERSATION_STATUSES.IN_PROGRESS, 'agent_reply');
            } catch {}
            
            // Broadcast message to chat room
            const messageData = {
              id: outboundId,
              direction: 'outbound',
              type: 'text',
              text_body: message,
              timestamp: Math.floor(Date.now() / 1000),
              from_digits: (cfg.business_phone || "").replace(/\D/g, "") || null,
              to_digits: cleanPhone,
              contact_name: null,
              contact: cleanPhone,
              formatted_time: new Date().toLocaleString(),
              delivery_status: initialDeliveryStatus,
              read_status: 'unread'
            };
            
            io.to(`chat:${cleanPhone}`).emit('new_message', messageData);
            // Also echo directly back to the sender to avoid race conditions
            try { socket.emit('new_message', messageData); } catch {}
            
            // Stop typing indicator
            typingUsers.delete(`${userId}-${cleanPhone}`);
            socket.to(`chat:${cleanPhone}`).emit('typing_stop', {
              userId,
              phone: cleanPhone,
              timestamp: Date.now()
            });
            
            console.log('📡 Message broadcasted to chat room:', cleanPhone);

            // Create reply relationship if provided and plan allows
            try {
              if (replyTo && outboundId) {
                const plan = await getUserPlan(userId);
                if ((plan?.plan_name || 'free') !== 'free') {
                  await createReply(String(replyTo), String(outboundId));
                }
              }
            } catch (e) {
              console.warn('Reply link create failed (non-fatal):', e?.message || e);
            }
          } else {
            const detail = lastSendResponse ? JSON.stringify(lastSendResponse).slice(0, 1200) : 'no response';
            console.error('❌ Failed to send WhatsApp message (no outbound id). Detail:', detail);
            throw new Error('WhatsApp did not return message id. Check phone_number_id and token.');
          }
          
        } catch (error) {
          console.error('❌ Error sending message:', error);
          
          // Create a failed message record
          const tempMessageId = `failed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const timestamp = Math.floor(Date.now() / 1000);
          
          try {
            const dbNative = getDB();
            // cfg may be unavailable here; try to recompute business phone from settings
            let fromBiz = null;
            try {
              const cfg2 = await getSettingsForUser(userId);
              fromBiz = (cfg2?.business_phone || "").replace(/\D/g, "") || null;
            } catch {}
            const toDigits = (phone ? phone.split('?')[0] : null);
            await dbNative.collection('messages').insertOne({
              id: tempMessageId,
              user_id: userId,
              direction: 'outbound',
              from_id: fromBiz,
              to_id: toDigits,
              from_digits: fromBiz,
              to_digits: toDigits,
              type: 'text',
              text_body: message,
              timestamp,
              raw: { to: toDigits, text: message },
              delivery_status: MESSAGE_STATUS.FAILED,
              error_message: error.message
            });
            console.log(`❌ Created failed message record: ${tempMessageId}`);
            
            // Broadcast failed message to UI immediately so agent sees it without refresh
            const failedMessageData = {
              id: tempMessageId,
              direction: 'outbound',
              type: 'text',
              text_body: message,
              timestamp,
              from_digits: fromBiz,
              to_digits: toDigits,
              contact_name: null,
              contact: toDigits,
              formatted_time: new Date(timestamp * 1000).toLocaleString(),
              delivery_status: 'failed',
              read_status: 'unread'
            };
            try { io.to(`chat:${toDigits}`).emit('new_message', failedMessageData); } catch {}
            try { socket.emit('new_message', failedMessageData); } catch {}
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
      // Also notify the account owner's user room for global toasts (e.g., dashboard)
      try { io.to(`user:${userId}`).emit('new_message', messageData); } catch {}
      // Create a web notification record for inbound messages and broadcast event
      try {
        if (messageData && String(messageData.direction) === 'inbound') {
          const title = `New message from ${phone}`;
          const preview = (messageData.text_body || '').toString().slice(0, 140);
          const link = `/inbox/${encodeURIComponent(phone)}`;
          Notification.create({
            user_id: String(userId),
            type: 'inbound_message',
            title,
            message: preview,
            link,
            is_read: false,
            metadata: { phone, message_id: messageData.id }
          }).then(async (doc) => {
            try {
              const unreadCount = await Notification.countDocuments({ user_id: String(userId), is_read: false });
              io.to(`user:${userId}`).emit('notification_created', { notification: doc.toObject(), unreadCount });
            } catch {
              io.to(`user:${userId}`).emit('notification_created', { notification: doc.toObject() });
            }
          }).catch(() => {});
        }
      } catch {}
      // Heuristic: if a new inbound arrives, notify clients to refresh status
      try {
        if (messageData && messageData.direction === 'inbound') {
          io.to(`chat:${phone}`).emit('conversation_status_changed', {
            userId,
            phone,
            status: 'new',
            timestamp: Date.now()
          });
        }
      } catch {}
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
  if (process.env.DEBUG_LOGS === '1') {
    console.log('📡 Broadcasting reaction:', { userId, phone, messageId, emoji, action });
    console.log('📡 Socket.IO available:', !!io);
    console.log('📡 Socket.IO connected clients:', io ? io.engine.clientsCount : 'N/A');
  }
  
  try {
    if (io) {
      const roomName = `chat:${phone}`;
      if (process.env.DEBUG_LOGS === '1') {
        console.log('📡 Broadcasting to room:', roomName);
        console.log('📡 Room clients:', io.sockets.adapter.rooms.get(roomName)?.size || 0);
      }
      
      io.to(roomName).emit('message_reaction', {
        userId,
        phone,
        messageId,
        emoji,
        action, // 'added' or 'removed'
        reactionData,
        timestamp: Date.now()
      });
      
      if (process.env.DEBUG_LOGS === '1') console.log('📡 Reaction broadcasted successfully');
    } else {
      if (process.env.DEBUG_LOGS === '1') console.log('❌ Socket.IO not available for reaction broadcasting');
    }
  } catch (error) {
    console.error('❌ Error broadcasting reaction:', error);
  }
}

// Function to broadcast message status updates
export function broadcastMessageStatus(userId, phone, messageId, status, statusData) {
  if (process.env.DEBUG_LOGS === '1') {
    console.log('📡 Broadcasting message status:', { userId, phone, messageId, status });
    console.log('📡 Socket.IO available:', !!io);
    console.log('📡 Socket.IO connected clients:', io ? io.engine.clientsCount : 'N/A');
  }
  
  try {
    if (io) {
      const roomName = `chat:${phone}`;
      if (process.env.DEBUG_LOGS === '1') {
        console.log('📡 Broadcasting status to room:', roomName);
        console.log('📡 Room clients:', io.sockets.adapter.rooms.get(roomName)?.size || 0);
      }
      
      io.to(roomName).emit('message_status_update', {
        userId,
        phone,
        messageId,
        status, // 'sent', 'delivered', 'read', 'failed'
        statusData,
        timestamp: Date.now()
      });
      
      if (process.env.DEBUG_LOGS === '1') console.log('📡 Message status broadcasted successfully');
    } else {
      if (process.env.DEBUG_LOGS === '1') console.log('❌ Socket.IO not available for status broadcasting');
    }
  } catch (error) {
    console.error('❌ Error broadcasting message status:', error);
  }
}

// Function to broadcast metrics updates
export function broadcastMetricsUpdate(userId, metricsData) {
  if (process.env.DEBUG_LOGS === '1') console.log('📊 Broadcasting metrics update for user:', userId);
  
  try {
    if (io) {
      const roomName = `user:${userId}`;
      if (process.env.DEBUG_LOGS === '1') console.log('📊 Broadcasting metrics to room:', roomName);
      
      io.to(roomName).emit('metrics_update', {
        userId,
        data: metricsData,
        timestamp: Date.now()
      });
      
      if (process.env.DEBUG_LOGS === '1') console.log('📊 Metrics update broadcasted successfully');
    } else {
      if (process.env.DEBUG_LOGS === '1') console.log('❌ Socket.IO not available for metrics broadcasting');
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
      // Update handoff document in Mongo to reflect live mode
      await Handoff.findOneAndUpdate(
        { user_id: userId, contact_id: phone },
        { $set: { is_human: !!isLive, updatedAt: new Date() } },
        { upsert: true }
      );
      
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
