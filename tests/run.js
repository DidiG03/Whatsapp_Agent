#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const testType = args[0] || 'all';

const testCommands = {
  unit: 'npm run test:unit',
  integration: 'npm run test:integration',
  all: 'npm run test',
  coverage: 'npm run test:coverage',
  watch: 'npm run test:watch',
  ci: 'npm run test:ci'
};

function runTests(command) {
  console.log(`🧪 Running ${testType} tests...`);
  console.log(`📝 Command: ${command}`);
  
  const child = spawn('npm', command.split(' ').slice(1), {
    stdio: 'inherit',
    shell: true
  });
  
  child.on('close', (code) => {
    if (code === 0) {
      console.log(`✅ ${testType} tests completed successfully!`);
      
      if (testType === 'coverage' || testType === 'all') {
        generateTestReport();
      }
    } else {
      console.log(`❌ ${testType} tests failed with exit code ${code}`);
      process.exit(code);
    }
  });
  
  child.on('error', (error) => {
    console.error(`❌ Error running tests: ${error.message}`);
    process.exit(1);
  });
}

function generateTestReport() {
  const coveragePath = path.join(process.cwd(), 'coverage', 'lcov-report', 'index.html');
  
  if (fs.existsSync(coveragePath)) {
    console.log(`📊 Coverage report generated: ${coveragePath}`);
  }
  const summaryPath = path.join(process.cwd(), 'tests', 'test-summary.json');
  const summary = {
    timestamp: new Date().toISOString(),
    testType,
    environment: process.env.NODE_ENV || 'test',
    nodeVersion: process.version
  };
  
  try {
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`📋 Test summary saved: ${summaryPath}`);
  } catch (error) {
    console.warn(`⚠️  Could not save test summary: ${error.message}`);
  }
}

function showHelp() {
  console.log(`
🧪 WhatsApp Agent Test Runner

Usage: node tests/run.js [command]

Commands:
  unit        Run unit tests only
  integration Run integration tests only
  all         Run all tests (default)
  coverage    Run tests with coverage report
  watch       Run tests in watch mode
  ci          Run tests for CI environment
  help        Show this help message

Examples:
  node tests/run.js unit
  node tests/run.js coverage
  node tests/run.js watch

Environment Variables:
  NODE_ENV=test     Set test environment
  LOG_LEVEL=error   Reduce log noise during tests
  DB_PATH=:memory:  Use in-memory database
`);
}

if (args.includes('help') || args.includes('--help') || args.includes('-h')) {
  showHelp();
  process.exit(0);
}

if (!testCommands[testType]) {
  console.error(`❌ Unknown test type: ${testType}`);
  console.log('Run "node tests/run.js help" for available commands');
  process.exit(1);
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

runTests(testCommands[testType]);
