/**
 * Global test setup
 */
import { jest, expect } from '@jest/globals';

// Extend default timeout for integration tests
jest.setTimeout(30000);

// Mock environment variables for consistent testing
process.env.NODE_ENV = 'test';
process.env.DEBUG = 'false';
process.env.npm_package_version = '0.4.4-test';

// Suppress console output during tests unless DEBUG=true
if (process.env.DEBUG !== 'true') {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
}

// Global test utilities
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeValidCLIResponse(): R;
      toContainBrutalAnalysis(): R;
    }
  }
}

// Custom Jest matchers
expect.extend({
  toBeValidCLIResponse(received) {
    const pass = (
      received &&
      typeof received === 'object' &&
      typeof received.agent === 'string' &&
      typeof received.success === 'boolean' &&
      typeof received.executionTime === 'number' &&
      (received.success ? typeof received.output === 'string' : typeof received.error === 'string')
    );

    return {
      message: () => `expected ${JSON.stringify(received)} to be a valid CLI response`,
      pass
    };
  },

  toContainBrutalAnalysis(received) {
    const brutalIndicators = [
      'AI critics',
      'BRUTAL',
      'demolished',
      'destroyed',
      'systematically',
      'analysis',
      'security',
      'vulnerabilities',
      'failure',
      'disaster'
    ];

    const pass = (
      typeof received === 'string' &&
      brutalIndicators.some(indicator => 
        received.toLowerCase().includes(indicator.toLowerCase())
      )
    );

    return {
      message: () => `expected "${received}" to contain brutal analysis indicators`,
      pass
    };
  }
});