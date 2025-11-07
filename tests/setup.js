/**
 * Jest test setup file
 * Runs before all tests to configure the test environment
 */

import { jest } from '@jest/globals';
import path from 'path';
import fs from 'fs';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests
process.env.DB_PATH = ':memory:'; // Use in-memory database for tests

// Mock import.meta.url for ES modules
Object.defineProperty(global, 'import', {
  value: {
    meta: {
      url: 'file://' + path.resolve(process.cwd(), 'tests/setup.js')
    }
  }
});

// Mock external services
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

// Mock OpenAI (both default and named export)
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

// Mock Stripe
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

// Mock nodemailer
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn(() => Promise.resolve({ messageId: 'test-message-id' })),
    verify: jest.fn(() => Promise.resolve(true))
  }))
}));

// Mock node-fetch
jest.mock('node-fetch', () => {
  return jest.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true }),
    text: () => Promise.resolve('OK')
  }));
});

// Global test helpers
global.testHelpers = {
  // Create a test user ID
  createTestUserId: () => 'test-user-' + Math.random().toString(36).substr(2, 9),
  
  // Create a test phone number
  createTestPhone: () => '+1234567890',
  
  // Create test message data
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
  
  // Create test contact data
  createTestContact: (overrides = {}) => ({
    contact_id: '+1234567890',
    display_name: 'Test Contact',
    notes: 'Test notes',
    ...overrides
  }),
  
  // Wait for async operations
  wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  
  // Mock Express request
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
  
  // Mock Express response
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

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
});

// Global test timeout
jest.setTimeout(10000);
