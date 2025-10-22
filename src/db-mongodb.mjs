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
      get: async (query = {}) => {
        await this.init();
        // Reject SQL-like collection names
        if (typeof collectionName !== 'string' || /\s|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|PRAGMA|strftime/i.test(collectionName)) {
          console.warn(`Invalid MongoDB get target:`, collectionName);
          return null;
        }
        const collection = this.db.collection(collectionName);
        // Ensure query is a valid MongoDB query object
        if (typeof query === 'string' || !query || typeof query !== 'object') {
          console.warn(`Invalid MongoDB query for ${collectionName}:`, query);
          return null;
        }
        return await collection.findOne(query);
      },
      all: async (query = {}) => {
        await this.init();
        // Reject SQL-like collection names
        if (typeof collectionName !== 'string' || /\s|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|PRAGMA|strftime/i.test(collectionName)) {
          console.warn(`Invalid MongoDB all target:`, collectionName);
          return [];
        }
        const collection = this.db.collection(collectionName);
        
        // Ensure query is a valid MongoDB query object
        if (typeof query === 'string' || !query || typeof query !== 'object') {
          console.warn(`Invalid MongoDB query for ${collectionName}:`, query);
          return [];
        }
        
        return await collection.find(query).toArray();
      },
      run: async (data) => {
        await this.init();
        // Reject SQL-like inputs; expect a simple collection name
        if (typeof collectionName !== 'string' || /\s|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|PRAGMA|strftime/i.test(collectionName)) {
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
