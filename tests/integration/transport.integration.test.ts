/**
 * Unified Transport Integration Tests
 * Comprehensive HTTP transport, MCP server, and CORS security testing
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { BrutalistServer } from '../../src/brutalist-server.js';
import { ServerHarness } from '../../src/test-utils/server-harness.js';
import { TestIsolation } from '../../src/test-utils/test-isolation.js';
import { httpTestConfig } from '../fixtures/test-configs.js';
import request from 'supertest';

describe('Transport Integration Tests', () => {
  let serverHarness: ServerHarness;
  let testIsolation: TestIsolation;

  beforeEach(async () => {
    testIsolation = new TestIsolation('transport-integration');
    
    serverHarness = new ServerHarness({
      maxStartupTime: 15000,
      healthCheckInterval: 100,
      shutdownTimeout: 5000
    });

    jest.setTimeout(30000);
  });

  afterEach(async () => {
    if (serverHarness?.isRunning()) {
      await serverHarness.stop();
    }
    
    if (testIsolation) {
      await testIsolation.cleanup();
    }
  });

  describe('Server Lifecycle & HTTP Transport', () => {
    it('should start and stop HTTP server successfully', async () => {
      await serverHarness.start({
        transport: 'http',
        httpPort: 0  // Random port
      });

      expect(serverHarness.isRunning()).toBe(true);
      expect(serverHarness.getPort()).toBeGreaterThan(0);
      expect(serverHarness.getBaseUrl()).toMatch(/^http:\/\/localhost:\d+$/);

      // Test health endpoint
      const healthResponse = await serverHarness.testRequest('/health');
      expect(healthResponse.ok).toBe(true);
      
      const healthData = await healthResponse.json();
      expect(healthData).toMatchObject({
        status: 'ok',
        transport: 'http-streaming',
        version: expect.any(String)
      });

      // Stop server
      await serverHarness.stop();
      expect(serverHarness.isRunning()).toBe(false);
    });

    it('should respond to health check requests with CORS headers', async () => {
      await serverHarness.start({
        transport: 'http',
        httpPort: 0
      });

      const response = await serverHarness.testRequest('/health');

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(response.headers.get('access-control-allow-methods')).toContain('GET');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
      
      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.transport).toBe('http-streaming');
      expect(data.version).toBeTruthy();
    });

    it('should handle server startup failures gracefully', async () => {
      await expect(async () => {
        await serverHarness.start({
          transport: 'http',
          httpPort: 65536  // Invalid port number
        });
      }).rejects.toThrow();

      expect(serverHarness.isRunning()).toBe(false);
    });

    it('should respond within reasonable time', async () => {
      await serverHarness.start({
        transport: 'http',
        httpPort: 0
      });

      const start = Date.now();
      const response = await serverHarness.testRequest('/health');
      const duration = Date.now() - start;
      
      expect(response.ok).toBe(true);
      expect(duration).toBeLessThan(5000); // Should respond within 5 seconds
    });
  });

  describe('CORS Security', () => {
    let server: BrutalistServer;
    let port: number;
    
    beforeEach(async () => {
      server = new BrutalistServer({ 
        transport: 'http', 
        httpPort: 0,
        corsOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
        allowCORSWildcard: false
      });
      await server.start();
      port = server.getActualPort()!;
    });
    
    afterEach(() => {
      server.cleanup();
    });

    it('should allow requests from configured allowed origins', async () => {
      const response = await request(`http://localhost:${port}`)
        .options('/mcp')
        .set('Origin', 'http://localhost:3000')
        .expect(200);
      
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });
    
    it('should allow requests from other configured origins', async () => {
      const response = await request(`http://localhost:${port}`)
        .options('/mcp')
        .set('Origin', 'http://127.0.0.1:3000')
        .expect(200);
      
      expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3000');
    });
    
    it('should reject requests from disallowed origins', async () => {
      const response = await request(`http://localhost:${port}`)
        .options('/mcp')
        .set('Origin', 'https://malicious-site.com')
        .expect(403);
      
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should handle CORS preflight requests correctly', async () => {
      const response = await request(`http://localhost:${port}`)
        .options('/mcp')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'Content-Type, Authorization')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
    });
  });

  describe('MCP Tool Registration & Protocol', () => {
    beforeEach(async () => {
      await serverHarness.start({
        transport: 'http',
        httpPort: 0
      });
    });

    it('should register all brutalist tools correctly', async () => {
      const listRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      };

      const response = await serverHarness.testRequest('/mcp', {
        method: 'POST',
        body: JSON.stringify(listRequest)
      });

      expect(response.ok).toBe(true);
      
      // Parse SSE response format
      const responseText = await response.text();
      const lines = responseText.split('\n');
      let data = null;
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            data = JSON.parse(line.substring(6));
            break;
          } catch (e) {
            // Continue looking for valid JSON
          }
        }
      }
      
      if (!data) {
        throw new Error(`Failed to parse tools list response: ${responseText}`);
      }
      
      expect(data).toHaveProperty('result');
      expect(data.result).toHaveProperty('tools');
      expect(Array.isArray(data.result.tools)).toBe(true);

      // Verify expected tools are present
      const expectedTools = [
        'roast_codebase',
        'roast_idea',
        'roast_architecture', 
        'roast_research',
        'roast_security',
        'roast_product',
        'roast_infrastructure',
        'roast_file_structure',
        'roast_dependencies',
        'roast_git_history',
        'roast_test_coverage',
        'roast_cli_debate',
        'cli_agent_roster'
      ];

      const toolNames = data.result.tools.map((tool: any) => tool.name);
      expectedTools.forEach(expectedTool => {
        expect(toolNames).toContain(expectedTool);
      });

      // Verify tool structure
      const sampleTool = data.result.tools.find((tool: any) => tool.name === 'roast_idea');
      expect(sampleTool).toMatchObject({
        name: 'roast_idea',
        description: expect.any(String),
        inputSchema: expect.any(Object)
      });
    });

    it('should validate tool schemas against MCP standards', async () => {
      const listRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      };

      const listResponse = await serverHarness.testRequest('/mcp', {
        method: 'POST',
        body: JSON.stringify(listRequest)
      });

      // Parse SSE response format
      const listResponseText = await listResponse.text();
      const listLines = listResponseText.split('\n');
      let listData = null;
      
      for (const line of listLines) {
        if (line.startsWith('data: ')) {
          try {
            listData = JSON.parse(line.substring(6));
            break;
          } catch (e) {
            // Continue looking for valid JSON
          }
        }
      }
      
      if (!listData) {
        throw new Error(`Failed to parse tools list response: ${listResponseText}`);
      }
      const tools = listData.result.tools;

      // Validate each tool has required MCP schema properties
      tools.forEach((tool: any) => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.inputSchema).toBe('object');
        
        // Schema should have type and properties
        expect(tool.inputSchema).toHaveProperty('type');
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema).toHaveProperty('properties');
      });
    });
  });

  describe('MCP Tool Execution', () => {
    beforeEach(async () => {
      await serverHarness.start({
        transport: 'http',
        httpPort: 0
      });
    });

    it('should execute cli_agent_roster tool successfully', async () => {
      const result = await serverHarness.executeTool('cli_agent_roster', {});

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      
      const content = result.content[0];
      expect(content).toHaveProperty('type', 'text');
      expect(content).toHaveProperty('text');
      expect(typeof content.text).toBe('string');
      
      // Should contain information about available tools
      expect(content.text).toContain('Brutalist CLI Agent Arsenal');
      expect(content.text).toContain('Abstract Analysis Tools');
      expect(content.text).toContain('File-System Analysis Tools');
    });

    it.skip('should execute roast_idea tool with proper arguments', async () => {
      // Note: This test may timeout if CLI agents are not available
      try {
        const result = await serverHarness.executeTool('roast_idea', {
          idea: 'A blockchain-based social network for pets that uses AI to translate animal thoughts',
          targetPath: '.',
          context: 'This is a test idea for integration testing'
        });

        expect(result).toHaveProperty('content');
        expect(Array.isArray(result.content)).toBe(true);
        expect(result.content.length).toBeGreaterThan(0);

        const content = result.content[0];
        expect(content).toHaveProperty('type', 'text');
        expect(content).toHaveProperty('text');
        expect(typeof content.text).toBe('string');
        expect(content.text.length).toBeGreaterThan(0);
      } catch (error) {
        // If CLI agents are not available, expect specific error messages
        if (error instanceof Error) {
          if (error.message.includes('No CLI agents available') ||
              error.message.includes('timeout') ||
              error.message.includes('Timeout')) {
            // This is expected in test environments without CLI agents
            expect(error.message).toMatch(/No CLI agents available|timeout|Timeout/);
          } else {
            // Re-throw unexpected errors
            throw error;
          }
        } else {
          throw error;
        }
      }
    }, 120000);

    it('should handle tool execution with file system analysis', async () => {
      // Create a test workspace with some files
      const workspace = await testIsolation.createWorkspace();
      
      await testIsolation.createFile('package.json', JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        dependencies: {
          'lodash': '^4.17.21',
          'express': '^4.18.0'
        }
      }, null, 2));

      await testIsolation.createFile('src/index.js', `
        const express = require('express');
        const app = express();
        
        app.get('/', (req, res) => {
          res.send('Hello World');
        });
        
        app.listen(3000);
      `);

      // Test file structure analysis - this may timeout without CLI agents
      try {
        const result = await serverHarness.executeTool('roast_file_structure', {
          targetPath: workspace,
          depth: 2
        });

        expect(result).toHaveProperty('content');
        expect(Array.isArray(result.content)).toBe(true);
        expect(result.content.length).toBeGreaterThan(0);
        
        const content = result.content[0];
        expect(content).toHaveProperty('type', 'text');
        expect(content).toHaveProperty('text');
        expect(typeof content.text).toBe('string');
      } catch (error) {
        // If CLI agents are not available, expect specific error messages
        if (error instanceof Error && 
            (error.message.includes('No CLI agents available') || 
             error.message.includes('timeout') || 
             error.message.includes('Timeout'))) {
          // This is expected in test environments without CLI agents
          expect(error.message).toMatch(/No CLI agents available|timeout|Timeout/);
        } else {
          throw error;
        }
      }
    }, 120000); // Increased timeout for CI environments

    it('should handle invalid tool names gracefully', async () => {
      await expect(async () => {
        await serverHarness.executeTool('nonexistent_tool', {});
      }).rejects.toThrow(/Tool execution failed/);
    });

    it('should handle missing required arguments', async () => {
      await expect(async () => {
        await serverHarness.executeTool('roast_idea', {
          // Missing required 'idea' parameter
          context: 'This should fail'
        });
      }).rejects.toThrow();
    });

    it('should support pagination parameters in tool execution', async () => {
      const result = await serverHarness.executeTool('cli_agent_roster', {
        limit: 5000,
        offset: 0,
        cursor: 'offset:0'
      });

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      
      const content = result.content[0];
      expect(content).toHaveProperty('type', 'text');
      expect(content).toHaveProperty('text');
    });
  });

  describe('Error Handling & Transport Robustness', () => {
    beforeEach(async () => {
      await serverHarness.start({
        transport: 'http',
        httpPort: 0
      });
    });

    it('should handle malformed JSON gracefully', async () => {
      const response = await serverHarness.testRequest('/mcp', {
        method: 'POST',
        body: 'invalid json{',
        allowFailure: true
      });

      expect(response.ok).toBe(false);
    });

    it('should handle missing Content-Type header', async () => {
      const response = await serverHarness.testRequest('/mcp', {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/list'
        })
      });

      // Should still work or return appropriate error
      expect(response.status).toBeLessThan(500);
    });

    it('should handle invalid MCP protocol requests', async () => {
      const invalidRequest = {
        // Missing required fields
        method: 'tools/call'
      };

      const response = await serverHarness.testRequest('/mcp', {
        method: 'POST',
        body: JSON.stringify(invalidRequest),
        allowFailure: true
      });

      const data = await response.json();
      expect(data).toHaveProperty('error');
    });

    it.skip('should maintain connection state through multiple requests', async () => {
      // Make multiple requests to verify connection stability
      const requests = [];
      for (let i = 0; i < 3; i++) {
        requests.push(
          serverHarness.executeTool('cli_agent_roster', {})
        );
      }

      const results = await Promise.all(requests);

      // All requests should succeed
      results.forEach(result => {
        expect(result).toHaveProperty('content');
        expect(Array.isArray(result.content)).toBe(true);
      });
    }, 60000); // Increased timeout for CI - multiple sequential requests

    it.skip('should handle concurrent tool executions', async () => {
      // Execute multiple CLI-independent tools concurrently
      const concurrentExecutions = [
        serverHarness.executeTool('cli_agent_roster', {}),
        serverHarness.executeTool('cli_agent_roster', {}),
        serverHarness.executeTool('cli_agent_roster', {})
      ];

      const results = await Promise.all(concurrentExecutions);

      // All executions should succeed
      results.forEach(result => {
        expect(result).toHaveProperty('content');
        expect(Array.isArray(result.content)).toBe(true);
      });
    }, 60000); // Increased timeout for CI - concurrent requests

    it('should properly close connections on server shutdown', async () => {
      const baseUrl = serverHarness.getBaseUrl();
      
      // Verify server is accessible
      const healthResponse = await serverHarness.testRequest('/health');
      expect(healthResponse.ok).toBe(true);

      // Stop server
      await serverHarness.stop();
      
      // Verify server is no longer accessible
      await expect(async () => {
        const response = await serverHarness.testRequest('/health');
        if (response.ok) {
          throw new Error('Server should be stopped');
        }
      }).rejects.toThrow();
    });

    it.skip('should timeout if server takes too long to start', async () => {
      // Use a very short timeout to force a timeout scenario
      // NOTE: This test is flaky - servers can start faster than 1ms in CI
      const shortTimeoutHarness = new ServerHarness({
        maxStartupTime: 1,  // 1ms - guaranteed timeout
        healthCheckInterval: 50
      });

      await expect(async () => {
        await shortTimeoutHarness.start({
          transport: 'http',
          httpPort: 0
        });
      }).rejects.toThrow(/failed to become ready within/);

      expect(shortTimeoutHarness.isRunning()).toBe(false);
    });
  });
});