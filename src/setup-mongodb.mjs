#!/usr/bin/env node

/**
 * MongoDB Setup Script
 * This script helps set up MongoDB for the WhatsApp Agent project
 */

import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp_agent';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'whatsapp_agent';

async function setupMongoDB() {
  console.log('Setting up MongoDB for WhatsApp Agent...');
  console.log(`Connection URI: ${MONGODB_URI.replace(/\/\/.*@/, '//***@')}`);
  
  try {
    // Connect to MongoDB
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log('✅ Connected to MongoDB successfully');
    
    // Create indexes for better performance
    const db = mongoose.connection.db;
    
    // Messages collection indexes
    await db.collection('messages').createIndex({ user_id: 1, timestamp: -1 });
    await db.collection('messages').createIndex({ from_digits: 1 });
    await db.collection('messages').createIndex({ to_digits: 1 });
    await db.collection('messages').createIndex({ direction: 1 });
    
    // Handoff collection indexes
    await db.collection('handoff').createIndex({ contact_id: 1, user_id: 1 }, { unique: true });
    await db.collection('handoff').createIndex({ user_id: 1, conversation_status: 1 });
    
    // AI requests collection indexes
    await db.collection('ai_requests').createIndex({ user_id: 1 });
    await db.collection('ai_requests').createIndex({ createdAt: -1 });
    
    // User settings collection indexes
    await db.collection('user_settings').createIndex({ user_id: 1 }, { unique: true });
    
    // Settings multi collection indexes
    await db.collection('settings_multi').createIndex({ user_id: 1 }, { unique: true });
    
    // Customers collection indexes
    await db.collection('customers').createIndex({ user_id: 1, contact_id: 1 }, { unique: true });
    await db.collection('customers').createIndex({ user_id: 1, email: 1 });
    
    // Notifications collection indexes
    await db.collection('notifications').createIndex({ user_id: 1 });
    await db.collection('notifications').createIndex({ user_id: 1, is_read: 1 });
    
    // Usage stats collection indexes
    await db.collection('usage_stats').createIndex({ user_id: 1, month_year: 1 }, { unique: true });
    
    console.log('✅ Database indexes created successfully');
    
    // Test basic operations
    const testCollection = db.collection('test_connection');
    await testCollection.insertOne({ test: true, timestamp: new Date() });
    await testCollection.deleteOne({ test: true });
    
    console.log('✅ Database operations test passed');
    
    console.log('\n🎉 MongoDB setup completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Set MONGODB_URI environment variable to your MongoDB connection string');
    console.log('2. Start your application with: npm start');
    console.log('\nFor MongoDB Atlas (cloud):');
    console.log('   MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/whatsapp_agent');
    console.log('\nFor local MongoDB:');
    console.log('   MONGODB_URI=mongodb://localhost:27017/whatsapp_agent');
    
  } catch (error) {
    console.error('❌ MongoDB setup failed:', error.message);
    console.log('\nTroubleshooting:');
    console.log('1. Make sure MongoDB is running on your system');
    console.log('2. Check your connection string format');
    console.log('3. Verify network connectivity and authentication');
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// Run setup if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupMongoDB();
}

export default setupMongoDB;
