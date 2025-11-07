/** @type {import('jest').Config} */
export default {
  // Test environment
  testEnvironment: 'node',
  
  // Enable ES modules support
  globals: {
    'ts-jest': {
      useESM: true
    }
  },
  
  // File extensions to consider
  moduleFileExtensions: ['js', 'mjs', 'json'],
  
  // Transform files
  transform: {
    '^.+\\.m?js$': ['babel-jest', {
      presets: [
        ['@babel/preset-env', { 
          targets: { node: 'current' },
          modules: 'commonjs'
        }]
      ]
    }]
  },
  
  // Transform ignore patterns
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$|uuid|winston))'
  ],
  
  // Test file patterns
  testMatch: [
    '**/__tests__/**/*.test.{js,mjs}',
    '**/?(*.)+(spec|test).{js,mjs}'
  ],
  // Ignore non-test directories/files picked up by patterns
  testPathIgnorePatterns: ['/node_modules/', '/coverage/', '/api/'],
  
  // Setup files
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  
  // Coverage configuration (disabled for initial setup)
  collectCoverage: false,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'src/**/*.{js,mjs}',
    '!src/**/*.test.{js,mjs}',
    '!src/**/__tests__/**',
    '!src/db-mongodb.mjs', // Exclude database setup
    '!src/config.mjs', // Exclude config
  ],
  
  // Test timeout
  testTimeout: 10000,
  
  // Clear mocks between tests
  clearMocks: true,
  
  // Verbose output
  verbose: true,
  
  // Map legacy paths in tests to current modules
  moduleNameMapper: {
    '.*src/db\\.mjs$': '<rootDir>/src/db-mongodb.mjs'
  }
};
