/**
 * MongoDB Database Configuration
 * Provides MongoDB connection and database operations for the WhatsApp Agent
 */

import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { logHelpers } from './monitoring/logger.mjs';

// MongoDB connection configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_agent';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'whatsapp_agent';

let client = null;
let mongoDb = null;
let isConnected = false;

// Initialize MongoDB connection
export async function initMongoDB() {
  try {
    // Connect using mongoose for better connection management
    await mongoose.connect(MONGODB_URI, {
      dbName: MONGODB_DB_NAME,
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    // Also create a native MongoDB client for direct operations
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    mongoDb = client.db(MONGODB_DB_NAME);
    isConnected = true;

    logHelpers.logBusinessEvent('mongodb_connected', { 
      uri: MONGODB_URI.replace(/\/\/.*@/, '//***@'), // Hide credentials in logs
      database: MONGODB_DB_NAME 
    });

    console.log('MongoDB connected successfully');
    return { client, db: mongoDb };
  } catch (error) {
    isConnected = false;
    logHelpers.logError(error, { component: 'mongodb', operation: 'connection' });
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

// Get database instance
export function getDB() {
  if (!isConnected || !mongoDb) {
    throw new Error('MongoDB not connected. Call initMongoDB() first.');
  }
  return mongoDb;
}

// Get mongoose connection
export function getMongoose() {
  return mongoose;
}

// Check if MongoDB is connected
export function isMongoConnected() {
  return isConnected && mongoose.connection.readyState === 1;
}

// Close MongoDB connection
export async function closeMongoDB() {
  try {
    if (client) {
      await client.close();
    }
    await mongoose.disconnect();
    isConnected = false;
    console.log('MongoDB connection closed');
  } catch (error) {
    logHelpers.logError(error, { component: 'mongodb', operation: 'disconnect' });
  }
}

// Database adapter that mimics SQLite interface for compatibility
class MongoDBAdapter {
  constructor() {
    this.db = null;
    this.isInitialized = false;
  }

  async init() {
    if (!this.isInitialized) {
      const { db } = await initMongoDB();
      this.db = db;
      this.isInitialized = true;
    }
    return this.db;
  }

  async exec(operation) {
    // MongoDB doesn't have exec like SQLite, but we can use this for schema operations
    console.log('MongoDB exec:', operation);
    return { changes: 0 };
  }

  prepare(collectionName, operation = 'find') {
    return {
      get: async (...args) => {
        await this.init();
        // Support legacy SQL-shaped calls used throughout the codebase
        if (typeof collectionName === 'string' && /FROM\s+handoff/i.test(collectionName) && /is_human/i.test(collectionName)) {
          const [contactId, userId] = args;
          const doc = await this.db.collection('handoff').findOne({ contact_id: contactId, user_id: userId }, { projection: { is_human: 1, human_expires_ts: 1 } });
          if (!doc) return null;
          return { is_human: !!doc.is_human, exp: Number(doc.human_expires_ts || 0) };
        }

        // Legacy: SELECT escalation_step FROM handoff WHERE contact_id = ? AND user_id = ?
        if (typeof collectionName === 'string' && /FROM\s+handoff/i.test(collectionName) && /escalation_step/i.test(collectionName) && !/escalation_questions_json|escalation_question_index|escalation_reason/i.test(collectionName)) {
          const [contactId, userId] = args;
          const doc = await this.db.collection('handoff').findOne({ contact_id: contactId, user_id: userId }, { projection: { escalation_step: 1 } });
          if (!doc) return null;
          return { escalation_step: doc.escalation_step };
        }

        // Legacy: SELECT escalation_step, escalation_questions_json, escalation_question_index FROM handoff ...
        if (typeof collectionName === 'string' && /FROM\s+handoff/i.test(collectionName) && /escalation_step/i.test(collectionName) && /escalation_questions_json|escalation_question_index/i.test(collectionName)) {
          const [contactId, userId] = args;
          const doc = await this.db.collection('handoff').findOne({ contact_id: contactId, user_id: userId }, { projection: { escalation_step: 1, escalation_questions_json: 1, escalation_question_index: 1 } });
          if (!doc) return null;
          return { escalation_step: doc.escalation_step, escalation_questions_json: doc.escalation_questions_json, escalation_question_index: doc.escalation_question_index };
        }

        // Legacy: SELECT escalation_step, escalation_reason FROM handoff WHERE contact_id = ? AND user_id = ?
        if (typeof collectionName === 'string' && /FROM\s+handoff/i.test(collectionName) && /escalation_step/i.test(collectionName) && /escalation_reason/i.test(collectionName)) {
          const [contactId, userId] = args;
          const doc = await this.db.collection('handoff').findOne({ contact_id: contactId, user_id: userId }, { projection: { escalation_step: 1, escalation_reason: 1 } });
          if (!doc) return null;
          return { escalation_step: doc.escalation_step, escalation_reason: doc.escalation_reason };
        }

        // Legacy: SELECT display_name FROM customers WHERE user_id = ? AND contact_id = ?
        if (typeof collectionName === 'string' && /FROM\s+customers/i.test(collectionName) && /display_name/i.test(collectionName)) {
          const [a, b] = args;
          // Try both argument orders for compatibility
          let doc = await this.db.collection('customers').findOne({ user_id: a, contact_id: b }, { projection: { display_name: 1 } });
          if (!doc) doc = await this.db.collection('customers').findOne({ user_id: b, contact_id: a }, { projection: { display_name: 1 } });
          if (!doc) return null;
          return { display_name: doc.display_name };
        }

        // Normal path: collection name + query object
        const query = args[0] || {};
        // Legacy MAX(timestamp) via .get
        if (typeof collectionName === 'string' && /FROM\s+messages/i.test(collectionName) && /MAX\(timestamp\)/i.test(collectionName)) {
          const [userId, fromId] = args;
          const doc = await this.db.collection('messages').find({ user_id: userId, from_id: fromId, direction: 'inbound' }, { projection: { timestamp: 1 } }).sort({ timestamp: -1 }).limit(1).next();
          return doc ? { ts: Number(doc.timestamp || 0) } : { ts: 0 };
        }
        if (typeof collectionName !== 'string' || /\s|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|PRAGMA|strftime/i.test(collectionName)) {
          console.warn(`Invalid MongoDB get target:`, collectionName);
          return null;
        }
        const collection = this.db.collection(collectionName);
        if (typeof query === 'string' || !query || typeof query !== 'object') {
          console.warn(`Invalid MongoDB query for ${collectionName}:`, query);
          return null;
        }
        return await collection.findOne(query);
      },
      all: async (...args) => {
        await this.init();
        // Legacy compatibility: translate a few common SQL-shaped queries
        if (typeof collectionName === 'string' && /FROM\s+messages/i.test(collectionName) && /text_body/i.test(collectionName)) {
          const [userId, digitsA, digitsB, sinceTs] = args;
          const collection = this.db.collection('messages');
          const orDigits = [];
          if (digitsA) orDigits.push({ from_digits: String(digitsA) });
          if (digitsB) orDigits.push({ from_digits: String(digitsB) });
          // Also try match on from_id suffix digits
          if (digitsA) orDigits.push({ from_id: new RegExp(`${digitsA}$`) });
          const cursor = collection.find({
            user_id: userId,
            direction: 'inbound',
            type: 'text',
            timestamp: { $gte: Number(sinceTs || 0) },
            $or: orDigits.length ? orDigits : undefined
          }, { projection: { text_body: 1, timestamp: 1 } }).sort({ timestamp: 1 }).limit(8);
          const rows = await cursor.toArray();
          return rows.map(r => ({ t: r.text_body, ts: r.timestamp }));
        }

        // Legacy FTS: kb_items_fts JOIN kb_items ... MATCH ? [LIMIT ?]
        if (typeof collectionName === 'string' && /FROM\s+kb_items_fts/i.test(collectionName)) {
          // Patterns with user filter: (userId, matchQuery, limit)
          // Or without user filter: (matchQuery, limit)
          let userId = null;
          let matchQuery = '';
          let limit = 3;
          if (/WHERE\s+k\.user_id\s*=\s*\?/i.test(collectionName)) {
            [userId, matchQuery, limit] = args;
          } else {
            [matchQuery, limit] = args;
          }
          limit = Number(limit || 3);
          const tokens = String(matchQuery || '')
            .replace(/[()"']/g,' ')
            .split(/\bOR\b|\s+/i)
            .map(t => t.trim())
            .filter(t => t && t.length >= 2)
            .slice(0, 16);
          const or = tokens.map(t => ({ title: { $regex: t, $options: 'i' } }))
            .concat(tokens.map(t => ({ content: { $regex: t, $options: 'i' } })));
          const query = { ...(userId ? { user_id: userId } : {}), ...(or.length ? { $or: or } : {}) };
          const rows = await this.db.collection('kb_items').find(query, { projection: { id: 1, title: 1, content: 1 } }).limit(limit).toArray();
          return rows.map(r => ({ id: r.id || r._id?.toString(), title: r.title, content: r.content, rank: 0 }));
        }

        if (typeof collectionName === 'string' && /FROM\s+kb_items/i.test(collectionName) && /show_in_menu/i.test(collectionName)) {
          const [userId] = args;
          const rows = await this.db.collection('kb_items').find({ user_id: userId, $or: [ { show_in_menu: 1 }, { show_in_menu: true } ], title: { $exists: true, $ne: '' } }, { projection: { title: 1 } }).sort({ created_at: -1, id: -1 }).limit(20).toArray();
          return rows.map(r => ({ title: r.title }));
        }

        // Legacy: SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND from_id = ? AND direction = 'inbound'
        if (typeof collectionName === 'string' && /FROM\s+messages/i.test(collectionName) && /MAX\(timestamp\)/i.test(collectionName)) {
          const [userId, fromId] = args;
          const doc = await this.db.collection('messages').find({ user_id: userId, from_id: fromId, direction: 'inbound' }, { projection: { timestamp: 1 } }).sort({ timestamp: -1 }).limit(1).next();
          return doc ? { ts: Number(doc.timestamp || 0) } : { ts: 0 };
        }

        // Normal path
        const query = args[0] || {};
        if (typeof collectionName !== 'string' || /\s|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|PRAGMA|strftime/i.test(collectionName)) {
          console.warn(`Invalid MongoDB all target:`, collectionName);
          return [];
        }
        const collection = this.db.collection(collectionName);
        if (typeof query === 'string' || !query || typeof query !== 'object') {
          console.warn(`Invalid MongoDB query for ${collectionName}:`, query);
          return [];
        }
        return await collection.find(query).toArray();
      },
      run: async (...args) => {
        await this.init();
        // Reject SQL-like inputs; expect a simple collection name
        if (typeof collectionName !== 'string' || /\s|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|PRAGMA|strftime/i.test(collectionName)) {
          // Legacy translation: INSERT INTO messages ...
          if (typeof collectionName === 'string' && /INSERT\s+INTO\s+messages/i.test(collectionName)) {
            try {
              // Map positional args from SQLite-style run
              if (args && args.length >= 11) {
                const [id, user_id, from_id, to_id, from_digits, to_digits, text_body, timestamp, raw, delivery_status, error_message] = args;
                const doc = { id, user_id, direction: 'outbound', from_id, to_id, from_digits, to_digits, type: 'text', text_body, timestamp: Number(timestamp||0), raw, delivery_status, error_message };
                await this.db.collection('messages').insertOne(doc);
                return { changes: 1, lastInsertRowid: id };
              }
              // If a single object was passed
              const payload = args?.[0];
              if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                await this.db.collection('messages').insertOne(payload);
                return { changes: 1, lastInsertRowid: payload.id || null };
              }
            } catch (e) {}
            console.warn(`Invalid MongoDB run target:`, collectionName);
            return { changes: 0, lastInsertRowid: null };
          }
          // Legacy translation: INSERT INTO handoff (contact_id, user_id, escalation_step, updated_at) ... ON CONFLICT ...
          if (typeof collectionName === 'string' && /INSERT\s+INTO\s+handoff/i.test(collectionName)) {
            try {
              // Args may be (contactId, userId) with step embedded in SQL, or (contactId, userId, step)
              let [contactId, userId, step] = args;
              if (!step) {
                const m = /VALUES\s*\(\s*\?,\s*\?,\s*'([^']+)'/i.exec(collectionName);
                if (m) step = m[1];
              }
              const update = { updatedAt: new Date() };
              if (step) update.escalation_step = step;
              await this.db.collection('handoff').updateOne(
                { contact_id: String(contactId), user_id: String(userId) },
                { $set: update },
                { upsert: true }
              );
              return { changes: 1, lastInsertRowid: null };
            } catch (e) {}
            console.warn(`Invalid MongoDB run target:`, collectionName);
            return { changes: 0, lastInsertRowid: null };
          }
          // Legacy translation: UPDATE handoff SET is_human = 0 ... WHERE contact_id = ? AND user_id = ?
          if (typeof collectionName === 'string' && /UPDATE\s+handoff\s+SET\s+is_human\s*=\s*0/i.test(collectionName)) {
            try {
              const [contactId, userId] = args;
              await this.db.collection('handoff').updateOne(
                { contact_id: String(contactId), user_id: String(userId) },
                { $set: { is_human: false, updatedAt: new Date() } },
                { upsert: false }
              );
              return { changes: 1, lastInsertRowid: null };
            } catch (e) {}
            console.warn(`Invalid MongoDB run target:`, collectionName);
            return { changes: 0, lastInsertRowid: null };
          }
          console.warn(`Invalid MongoDB run target:`, collectionName);
          return { changes: 0, lastInsertRowid: null };
        }
        const collection = this.db.collection(collectionName);
        if (operation === 'insert') {
          const result = await collection.insertOne(data);
          return { changes: 1, lastInsertRowid: result.insertedId };
        } else if (operation === 'update') {
          const result = await collection.updateOne(data.query, data.update);
          return { changes: result.modifiedCount, lastInsertRowid: null };
        } else if (operation === 'delete') {
          const result = await collection.deleteOne(data);
          return { changes: result.deletedCount, lastInsertRowid: null };
        }
        return { changes: 0, lastInsertRowid: null };
      },
      finalize: () => {}
    };
  }

  pragma(setting) {
    console.log('MongoDB pragma:', setting);
    return [];
  }
}

// Create MongoDB adapter instance
const mongoAdapter = new MongoDBAdapter();

// Export the adapter as 'db' for compatibility with existing code
export const db = mongoAdapter;

// Initialize MongoDB on module load
initMongoDB().catch(error => {
  console.error('Failed to initialize MongoDB:', error);
});

export default mongoAdapter;
