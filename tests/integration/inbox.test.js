import request from 'supertest';

// Disable Clerk in tests
process.env.CLERK_PUBLISHABLE = '';
process.env.CLERK_SECRET_KEY = '';

// Mock heavy dependencies before app import
jest.mock('../../src/services/settings.mjs', () => ({
  getSettingsForUser: jest.fn(async () => ({ bookings_enabled: false }))
}));
jest.mock('../../src/services/usage.mjs', () => ({
  getUserPlan: jest.fn(async () => ({ plan_name: 'pro' }))
}));
jest.mock('../../src/db-mongodb.mjs', () => ({
  db: { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }) },
  getDB: () => ({ collection: () => ({ aggregate: () => ({ toArray: async () => [] }) }) }),
  getMongoose: () => ({ connection: { readyState: 0 } })
}));
jest.mock('../../src/schemas/mongodb.mjs', () => ({
  Handoff: { find: jest.fn().mockResolvedValue([]) },
  Message: { aggregate: jest.fn().mockResolvedValue([]) }
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
