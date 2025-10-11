/**
 * Smoke Tests: Build Verification
 *
 * These tests verify that the built code actually works.
 * They catch issues like:
 * - Import errors (require() in ESM modules)
 * - Missing dependencies
 * - Build configuration problems
 * - Basic runtime failures
 *
 * Philosophy: If the built artifact doesn't work, nothing else matters.
 */

import { describe, it, expect } from '@jest/globals';
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';

const ROOT_DIR = join(__dirname, '../..');
const DIST_DIR = join(ROOT_DIR, 'dist');
const DIST_INDEX = join(DIST_DIR, 'index.js');

/**
 * Wait for stdout to contain expected content
 */
function waitForStdout(
  process: ChildProcess,
  predicate: (data: string) => boolean,
  timeoutMs: number = 5000
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for stdout. Received: ${buffer.substring(0, 500)}`));
    }, timeoutMs);

    process.stdout?.on('data', (chunk) => {
      buffer += chunk.toString();
      if (predicate(buffer)) {
        clearTimeout(timeout);
        resolve(buffer);
      }
    });

    process.stderr?.on('data', (chunk) => {
      const stderr = chunk.toString();
      // Check for fatal errors
      if (stderr.includes('require is not defined') ||
          stderr.includes('Cannot find module')) {
        clearTimeout(timeout);
        reject(new Error(`Fatal error in stderr: ${stderr}`));
      }
    });

    process.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    process.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
}

describe('Build Verification Smoke Tests', () => {
  it('dist directory exists', () => {
    expect(existsSync(DIST_DIR)).toBe(true);
  });

  it('dist/index.js exists', () => {
    expect(existsSync(DIST_INDEX)).toBe(true);
  });

  it('built server starts without import errors', async () => {
    const server = spawn('node', [DIST_INDEX]);

    try {
      // Send initialize request
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0' }
        }
      };

      server.stdin?.write(JSON.stringify(initRequest) + '\n');

      // Wait for valid response (not require error)
      const response = await waitForStdout(
        server,
        (data) => data.includes('"result"'),
        10000
      );

      expect(response).toContain('"result"');
      expect(response).toContain('brutalist-mcp');
      expect(response).not.toContain('require is not defined');
      expect(response).not.toContain('Cannot find module');
    } finally {
      server.kill();
    }
  }, 15000);

  it('built server responds to tools/list request', async () => {
    const server = spawn('node', [DIST_INDEX]);

    try {
      // Initialize first
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0' }
        }
      };

      server.stdin?.write(JSON.stringify(initRequest) + '\n');

      // Wait for init response
      await waitForStdout(
        server,
        (data) => data.includes('"id":1'),
        5000
      );

      // Request tools list
      const toolsRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      };

      server.stdin?.write(JSON.stringify(toolsRequest) + '\n');

      // Wait for tools response
      const response = await waitForStdout(
        server,
        (data) => data.includes('"id":2') && data.includes('tools'),
        5000
      );

      expect(response).toContain('roast_codebase');
      expect(response).toContain('roast_idea');
      expect(response).toContain('roast_security');
    } finally {
      server.kill();
    }
  }, 15000);

  it('built server handles simple tool execution', async () => {
    const server = spawn('node', [DIST_INDEX]);

    try {
      // Initialize
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '1.0' }
        }
      };

      server.stdin?.write(JSON.stringify(initRequest) + '\n');
      await waitForStdout(server, (data) => data.includes('"id":1'), 5000);

      // Execute roast_idea (fast, no file system access)
      const toolRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'roast_idea',
          arguments: {
            idea: 'A simple test idea',
            targetPath: '.',
            limit: 500
          }
        }
      };

      server.stdin?.write(JSON.stringify(toolRequest) + '\n');

      // Wait for tool response (may take a while if CLIs are available)
      const response = await waitForStdout(
        server,
        (data) => data.includes('"id":2'),
        120000 // 2 minutes for real CLI execution
      );

      // Should get a response, even if it's an error
      expect(response).toContain('"id":2');
      // Should not crash with module errors
      expect(response).not.toContain('require is not defined');
      expect(response).not.toContain('Cannot find module');
    } finally {
      server.kill();
    }
  }, 150000); // 2.5 minutes total timeout
});

describe('Configuration Validation', () => {
  it('CPU timeout (source code default) should exceed process timeout', () => {
    const fs = require('fs');
    const path = require('path');

    // Parse actual defaults from source code, not environment variables
    const cliAgentsContent = fs.readFileSync(
      path.join(ROOT_DIR, 'src/cli-agents.ts'),
      'utf8'
    );

    // Extract MAX_CPU_TIME_SEC default from source
    const cpuTimeMatch = cliAgentsContent.match(
      /MAX_CPU_TIME_SEC\s*=\s*parseInt\([^,]+['"](\d+)['"]/
    );
    expect(cpuTimeMatch).toBeTruthy();
    expect(cpuTimeMatch).toHaveLength(2);

    const sourceCpuTimeDefault = parseInt(cpuTimeMatch[1]);
    const DEFAULT_TIMEOUT = 1500000; // 25 minutes (from brutalist-server.ts)

    // Source code default must be greater than process timeout
    expect(sourceCpuTimeDefault * 1000).toBeGreaterThan(DEFAULT_TIMEOUT);

    // Should be at least 30 minutes (1800 seconds)
    expect(sourceCpuTimeDefault).toBeGreaterThanOrEqual(1800);
  });

  it('source modules use ES imports, not require', () => {
    const fs = require('fs');
    const path = require('path');

    // Check source files for require() usage
    const serverContent = fs.readFileSync(path.join(ROOT_DIR, 'src/brutalist-server.ts'), 'utf8');
    const cliContent = fs.readFileSync(path.join(ROOT_DIR, 'src/cli-agents.ts'), 'utf8');

    // Should not have require('fs') or require("fs")
    expect(serverContent).not.toMatch(/const\s+\w+\s*=\s*require\s*\(\s*['"]fs['"]\s*\)/);
    expect(cliContent).not.toMatch(/const\s+\w+\s*=\s*require\s*\(\s*['"]fs['"]\s*\)/);

    // Should use ES imports
    expect(serverContent).toMatch(/import.*from\s+['"]fs['"]/);
    expect(cliContent).toMatch(/import.*from\s+['"]fs['"]/);
  });
});
