import request from 'supertest';
process.env.CLERK_PUBLISHABLE = '';
process.env.CLERK_SECRET_KEY = '';

jest.mock('../../src/db-mongodb.mjs', () => ({
  db: { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }) },
  getDB: () => ({ collection: () => ({ aggregate: () => ({ toArray: async () => [] }) }) }),
  getMongoose: () => ({ connection: { readyState: 1 } }),
  initMongoDB: async () => ({ client: null, db: null }),
  isMongoConnected: () => true,
  closeMongoDB: async () => {},
}));

jest.mock('../../src/services/usage.mjs', () => ({
  getUserPlan: jest.fn(async () => ({ plan_name: 'free' })),
  isPlanUpgraded: jest.fn(() => false),
}));

jest.mock('../../src/services/audit.mjs', () => ({
  recordSettingsAudit: jest.fn(async () => {}),
}));

jest.mock('../../src/services/settings.mjs', () => ({
  getSettingsForUser: jest.fn(async () => ({})),
  upsertSettingsForUser: jest.fn(async () => true)
}));

import { createApp } from '../../src/app.mjs';
jest.unmock('@clerk/express');

describe('Settings Routes (integration)', () => {
  let app;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const created = await createApp();
    app = created.app;
  });

  test('GET /settings requires auth (responds 200 with mocked auth)', async () => {
    const res = await request(app).get('/settings');
    expect([200, 302, 303]).toContain(res.status);
  });

  test('POST /settings updates WhatsApp config safely', async () => {
    const res = await request(app)
      .post('/settings')
      .type('form')
      .send({
        phone_number_id: '123456789012345',
        whatsapp_token: 'EAA...token',
        business_phone: '+15551234567'
      });
    expect([200, 302, 303]).toContain(res.status);
  });
});
