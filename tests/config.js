/**
 * Test configuration for different environments
 */

export const testConfig = {
  // Database configuration
  database: {
    test: ':memory:',
    temp: './tests/temp/test.sqlite'
  },
  
  // Test timeouts
  timeouts: {
    short: 5000,
    medium: 10000,
    long: 30000
  },
  
  // Mock configurations
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
  
  // Test data
  testData: {
    userId: 'test-user-123',
    phoneNumber: '+1234567890',
    businessName: 'Test Business',
    email: 'test@example.com'
  },
  
  // Environment variables for tests
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
