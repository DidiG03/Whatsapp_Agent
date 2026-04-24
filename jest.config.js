
export default {
  testEnvironment: 'node',
  globals: {
    'ts-jest': {
      useESM: true
    }
  },
  moduleFileExtensions: ['js', 'mjs', 'json'],
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
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$|uuid|winston))'
  ],
  testMatch: [
    '**/__tests__/**/*.test.{js,mjs}',
    '**/?(*.)+(spec|test).{js,mjs}'
  ],
  testPathIgnorePatterns: ['/node_modules/', '/coverage/', '/api/'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  collectCoverage: false,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'src/**/*.{js,mjs}',
    '!src/**/*.test.{js,mjs}',
    '!src/**/__tests__/**',
    '!src/db-mongodb.mjs',    '!src/config.mjs',  ],
  testTimeout: 10000,
  clearMocks: true,
  verbose: true,
  moduleNameMapper: {
    '.*src/db\\.mjs$': '<rootDir>/src/db-mongodb.mjs'
  }
};
