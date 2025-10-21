/**
 * Serverless Database Configuration for Vercel
 * This module provides a mock database for serverless environments
 * In production, you should use PostgreSQL or another cloud database
 */

// Mock database for serverless environments
class MockDatabase {
  constructor() {
    this.data = new Map();
    console.log('Using mock database for serverless environment');
  }

  exec(sql) {
    console.log('Mock database exec:', sql.substring(0, 100) + '...');
    return { changes: 0 };
  }

  prepare(sql) {
    console.log('Mock database prepare:', sql.substring(0, 100) + '...');
    return {
      get: () => null,
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 1 }),
      finalize: () => {}
    };
  }

  pragma(setting) {
    console.log('Mock database pragma:', setting);
    return [];
  }
}

// Use mock database in serverless environment
export const db = new MockDatabase();

// Initialize schema for serverless environment
try {
  db.exec(`
    -- Mock schema initialization
    -- In production, use PostgreSQL with proper schema
    SELECT 'Mock database initialized' as status;
  `);
  console.log('Serverless mock database initialized successfully');
} catch (error) {
  console.error('Error initializing serverless mock database:', error);
  // Don't throw - let the app continue without database if needed
}

// Export the same interface as the original db.mjs
export default db;