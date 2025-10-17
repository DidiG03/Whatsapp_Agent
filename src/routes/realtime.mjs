/**
 * Realtime routes for WebSocket connections and real-time features.
 */

import { ensureAuthed } from '../middleware/auth.mjs';
import { db } from '../db.mjs';

// Store active SSE connections for typing indicators
const typingConnections = new Map();

export default function registerRealtimeRoutes(app) {
  
  // Server-Sent Events endpoint for typing indicators
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
    
    // Store this connection
    typingConnections.set(connectionId, res);
    
    // Send initial connection confirmation
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Connected to typing updates' })}\n\n`);
    
    // Handle client disconnect
    req.on('close', () => {
      typingConnections.delete(connectionId);
    });
    
    req.on('aborted', () => {
      typingConnections.delete(connectionId);
    });
  });
  
  // API endpoint to simulate typing start (for testing)
  app.post("/api/typing/:phone/start", (req, res) => {
    const phone = req.params.phone;
    const userId = req.body.userId || req.query.userId || req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }
    
    const connectionId = `${userId}-${phone}`;
    
    const connection = typingConnections.get(connectionId);
    if (connection) {
      connection.write(`data: ${JSON.stringify({ type: 'typing_start' })}\n\n`);
      res.json({ success: true, message: 'Typing indicator started' });
    } else {
      res.json({ success: false, message: 'No active connection' });
    }
  });
  
  // API endpoint to simulate typing stop (for testing)
  app.post("/api/typing/:phone/stop", (req, res) => {
    const phone = req.params.phone;
    const userId = req.body.userId || req.query.userId || req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }
    
    const connectionId = `${userId}-${phone}`;
    
    const connection = typingConnections.get(connectionId);
    if (connection) {
      connection.write(`data: ${JSON.stringify({ type: 'typing_stop' })}\n\n`);
      res.json({ success: true, message: 'Typing indicator stopped' });
    } else {
      res.json({ success: false, message: 'No active connection' });
    }
  });
  
  // Function to broadcast typing indicators (can be called from webhooks)
  function broadcastTypingIndicator(userId, phone, type) {
    const connectionId = `${userId}-${phone}`;
    const connection = typingConnections.get(connectionId);
    
    if (connection) {
      try {
        connection.write(`data: ${JSON.stringify({ type })}\n\n`);
      } catch (error) {
        // Connection might be closed, remove it
        typingConnections.delete(connectionId);
      }
    }
  }
  
  // Export the function for external use
  global.broadcastTypingIndicator = broadcastTypingIndicator;
  
  app.get("/realtime", (req, res) => {
    res.json({ 
      message: "Realtime features active",
      activeConnections: typingConnections.size,
      endpoints: [
        "GET /api/typing/:phone - SSE connection for typing indicators",
        "POST /api/typing/:phone/start - Simulate typing start",
        "POST /api/typing/:phone/stop - Simulate typing stop"
      ]
    });
  });
}
