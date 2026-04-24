

import { jest } from '@jest/globals';
import path from 'path';
import fs from 'fs';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';process.env.DB_PATH = ':memory:';Object.defineProperty(global, 'import', {
  value: {
    meta: {
      url: 'file://' + path.resolve(process.cwd(), 'tests/setup.js')
    }
  }
});
jest.mock('@clerk/express', () => ({
  clerkMiddleware: jest.fn(() => (req, res, next) => next()),
  getAuth: jest.fn(() => ({ userId: 'test-user-id', sessionId: 'test-session-id' })),
  clerkClient: {
    users: {
      getUser: jest.fn(() => Promise.resolve({
        id: 'test-user-id',
        primaryEmailAddressId: 'email-1',
        emailAddresses: [{ id: 'email-1', emailAddress: 'test@example.com' }]
      }))
    },
    sessions: {
      getSession: jest.fn(() => Promise.resolve({ status: 'active' })),
      revokeSession: jest.fn(() => Promise.resolve())
    }
  }
}));
jest.mock('openai', () => {
  const mockClient = {
    chat: {
      completions: {
        create: jest.fn(() => Promise.resolve({
          choices: [{ message: { content: 'Mocked AI response' } }]
        }))
      }
    }
  };
  const MockOpenAI = jest.fn().mockImplementation(() => mockClient);
  return {
    __esModule: true,
    default: MockOpenAI,
    OpenAI: MockOpenAI
  };
});
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: jest.fn(() => Promise.resolve({ id: 'test-session-id', url: 'https://checkout.stripe.com/test' })),
        retrieve: jest.fn(() => Promise.resolve({ id: 'test-session-id', payment_status: 'paid' }))
      }
    },
    customers: {
      retrieve: jest.fn(() => Promise.resolve({ id: 'test-customer-id' }))
    },
    subscriptions: {
      retrieve: jest.fn(() => Promise.resolve({ id: 'test-subscription-id', status: 'active' })),
      cancel: jest.fn(() => Promise.resolve({ id: 'test-subscription-id', status: 'canceled' }))
    }
  }));
});
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn(() => Promise.resolve({ messageId: 'test-message-id' })),
    verify: jest.fn(() => Promise.resolve(true))
  }))
}));
jest.mock('node-fetch', () => {
  return jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true }),
    text: () => Promise.resolve('OK')
  }));
});
global.testHelpers = {
  createTestUserId: () => 'test-user-' + Math.random().toString(36).substr(2, 9),
  createTestPhone: () => '+1234567890',
  createTestMessage: (overrides = {}) => ({
    id: 'test-msg-' + Math.random().toString(36).substr(2, 9),
    direction: 'inbound',
    from_id: '+1234567890',
    to_id: '+0987654321',
    type: 'text',
    text_body: 'Test message',
    timestamp: Math.floor(Date.now() / 1000),
    raw: { test: true },
    ...overrides
  }),
  createTestContact: (overrides = {}) => ({
    contact_id: '+1234567890',
    display_name: 'Test Contact',
    notes: 'Test notes',
    ...overrides
  }),
  wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  createMockRequest: (overrides = {}) => ({
    method: 'GET',
    url: '/test',
    headers: {},
    body: {},
    params: {},
    query: {},
    user: { id: 'test-user-id' },
    ...overrides
  }),
  createMockResponse: () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.redirect = jest.fn().mockReturnValue(res);
    res.setHeader = jest.fn().mockReturnValue(res);
    res.end = jest.fn().mockReturnValue(res);
    return res;
  }
};
afterEach(() => {
  jest.clearAllMocks();
});
jest.setTimeout(10000);
