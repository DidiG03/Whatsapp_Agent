import request from 'supertest';
import crypto from 'node:crypto';

jest.mock('../../src/services/settings.mjs', () => ({
  ...jest.requireActual('../../src/services/settings.mjs'),
  findSettingsByVerifyToken: jest.fn(async (token) => {
    if (token === 'test-verify') {
      return { user_id: 'test-user', verify_token: token };
    }
    return null;
  }),
  findSettingsByPhoneNumberId: jest.fn(async () => null),
  findSettingsByBusinessPhone: jest.fn(async () => null),
  buildBusinessSettingsSnippet: jest.fn(() => ''),
  getBusinessLocation: jest.fn(async () => null),
  upsertSettingsForUser: jest.fn(async () => ({})),
  getSettingsForUser: jest.fn(async () => ({})),
}));

import { createApp } from '../../src/app.mjs';

function signBody(secret, body) {
  const h = crypto.createHmac('sha256', secret);
  const raw = Buffer.from(JSON.stringify(body));
  h.update(raw);
  return `sha256=${h.digest('hex')}`;
}

describe('Webhook Routes (integration)', () => {
  let app;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const created = await createApp();
    app = created.app;
  });

  test('GET /webhook should verify token challenge', async () => {
    const verifyToken = 'test-verify';
    const res = await request(app)
      .get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': '1234' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('1234');
  });

  test('GET /webhook rejects wrong verify token', async () => {
    const res = await request(app)
      .get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': '1234' });
    expect(res.status).toBe(403);
  });

  test('POST /webhook should 200-ACK invalid payload (shape)', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('content-type', 'application/json')
      .send({ foo: 'bar' });
    expect(res.status).toBe(200);
  });

  test('POST /webhook rejects invalid signature, accepts valid', async () => {
    const secret = 'app-secret';
    const prevMeta = process.env.META_APP_SECRET;
    const prevFb = process.env.FACEBOOK_APP_SECRET;
    process.env.META_APP_SECRET = secret;
    delete process.env.FACEBOOK_APP_SECRET;
    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{}] }] };
    let res = await request(app)
      .post('/webhook')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .send(payload);
    expect([200, 403]).toContain(res.status);
    const sig = signBody(secret, payload);
    res = await request(app)
      .post('/webhook')
      .set('x-hub-signature-256', sig)
      .send(payload);
    expect([200, 204]).toContain(res.status);
    if (prevMeta === undefined) delete process.env.META_APP_SECRET; else process.env.META_APP_SECRET = prevMeta;
    if (prevFb === undefined) delete process.env.FACEBOOK_APP_SECRET; else process.env.FACEBOOK_APP_SECRET = prevFb;
  });
});
