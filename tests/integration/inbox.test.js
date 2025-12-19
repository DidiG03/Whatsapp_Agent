import request from 'supertest';

// Disable Clerk in tests
process.env.CLERK_PUBLISHABLE = '';
process.env.CLERK_SECRET_KEY = '';

// Mock heavy dependencies before app import
jest.mock('../../src/services/settings.mjs', () => ({
  getSettingsForUser: jest.fn(async () => ({ bookings_enabled: false }))
}));
jest.mock('../../src/services/conversations.mjs', () => ({
  listContactsForUser: jest.fn(async () => ([
    { contact: '+1234567890', last_ts: 1, last_text: 'hi' }
  ])),
  listMessagesForThread: jest.fn(async () => ([]))
}));
jest.mock('../../src/services/usage.mjs', () => ({
  getUserPlan: jest.fn(async () => ({ plan_name: 'pro' })),
  getPlanStatus: jest.fn(async () => ({ isUpgraded: true, plan_name: 'pro' })),
  isPlanUpgraded: jest.fn(() => true)
}));
jest.mock('../../src/db-mongodb.mjs', () => ({
  db: { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }) },
  getDB: () => ({ collection: () => ({ aggregate: () => ({ toArray: async () => [] }) }) }),
  getMongoose: () => ({ connection: { readyState: 1 } }),
  // createApp() expects these exports; keep them lightweight for integration tests
  initMongoDB: async () => ({ client: null, db: null }),
  isMongoConnected: () => true
}));
jest.mock('../../src/schemas/mongodb.mjs', () => ({
  Customer: {
    find: jest.fn(() => ({ select: jest.fn().mockResolvedValue([]) })),
  },
  Handoff: {
    find: jest.fn(() => ({ select: jest.fn().mockResolvedValue([]) })),
  },
  Message: {
    countDocuments: jest.fn().mockResolvedValue(0),
  }
}));

import { createApp } from '../../src/app.mjs';

describe('Inbox Routes (integration)', () => {
  let app;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const created = await createApp();
    app = created.app;
  });

  test('GET /inbox renders or redirects with auth', async () => {
    const res = await request(app).get('/inbox');
    expect([200, 302]).toContain(res.status);
  });

  test('GET /inbox with search params works', async () => {
    const res = await request(app).get('/inbox').query({ q: 'hello', page: 1, page_size: 20 });
    expect([200, 302]).toContain(res.status);
  });
});
