/**
 * Test configurations and utilities
 */
import { BrutalistServerConfig } from '../../src/types/brutalist.js';

export const defaultTestConfig: BrutalistServerConfig = {
  workingDirectory: '/tmp/test',
  defaultTimeout: 5000, // Short timeout for tests
  enableSandbox: true,
  transport: 'stdio',
  httpPort: 0 // Random port for HTTP tests
};

export const unsafeTestConfig: BrutalistServerConfig = {
  workingDirectory: '/tmp/test',
  defaultTimeout: 5000,
  enableSandbox: false,
  transport: 'stdio'
};

export const httpTestConfig: BrutalistServerConfig = {
  workingDirectory: '/tmp/test',
  defaultTimeout: 10000,
  enableSandbox: true,
  transport: 'http',
  httpPort: 0 // Jest will assign a random available port
};

export const testPaths = {
  validProject: '/tmp/test-project',
  nonexistentPath: '/does/not/exist',
  maliciousPath: '../../../etc/passwd',
  largeProject: '/tmp/large-project'
};

export const testPrompts = {
  simple: 'Analyze this code for issues',
  complex: 'Perform comprehensive security analysis including SQL injection, XSS, authentication bypasses, and privilege escalation vulnerabilities',
  malicious: '<script>alert("xss")</script>',
  empty: '',
  unicode: '🚀 Analyze this rocket-fast code 🔥'
};