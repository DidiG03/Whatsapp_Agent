

export const testConfig = {
  database: {
    test: ':memory:',
    temp: './tests/temp/test.sqlite'
  },
  timeouts: {
    short: 5000,
    medium: 10000,
    long: 30000
  },
  mocks: {
    openai: {
      enabled: true,
      response: 'Mocked AI response'
    },
    stripe: {
      enabled: true,
      testMode: true
    },
    clerk: {
      enabled: true,
      testUserId: 'test-user-123'
    }
  },
  testData: {
    userId: 'test-user-123',
    phoneNumber: '+1234567890',
    businessName: 'Test Business',
    email: 'test@example.com'
  },
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DB_PATH: ':memory:',
    CLERK_ENABLED: 'false',
    STRIPE_SECRET_KEY: 'sk_test_mock',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_mock'
  }
};

export default testConfig;
