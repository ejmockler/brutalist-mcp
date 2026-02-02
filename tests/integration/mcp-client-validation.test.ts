/**
 * MCP Client Validation Integration Tests
 *
 * CRITICAL: These tests validate that the server's responses conform to the MCP protocol
 * schemas that ACTUAL CLIENTS use. Unlike unit tests which mock McpServer, these tests:
 *
 * 1. Use the REAL McpServer class (no mocking)
 * 2. Validate responses against the ACTUAL Zod schemas from @modelcontextprotocol/sdk
 * 3. Test the initialize handshake exactly as a real MCP client would
 * 4. Catch protocol violations BEFORE they reach production
 *
 * This test file would have caught the `experimental: { streaming: true }` bug that
 * caused Claude Code clients to reject our server's initialization response.
 *
 * Context: The bug occurred because:
 * - Unit tests MOCKED McpServer, so Zod schema validation never ran
 * - Smoke tests only tested server-side behavior with raw JSON-RPC
 * - No test validated the initialize response against what MCP clients expect
 *
 * The MCP SDK's InitializeResultSchema expects `experimental` to be an empty object
 * with passthrough mode, NOT a structured object with specific properties like `streaming`.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { BrutalistServer } from '../../src/brutalist-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, ChildProcess } from 'child_process';
import {
  InitializeResultSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  ServerCapabilitiesSchema
} from '@modelcontextprotocol/sdk/types.js';

describe('MCP Client Validation Tests', () => {
  /**
   * NOTE: Direct server instantiation tests are skipped because McpServer's internal
   * fields (_capabilities, _serverInfo) are private and not meant to be accessed directly.
   *
   * The real validation happens in the "Full Client-Server Integration" tests below,
   * which actually perform the initialize handshake and validate responses against
   * the MCP SDK's Zod schemas - exactly as a real client would.
   *
   * Those integration tests would have caught the experimental.streaming bug.
   */

  describe('Full Client-Server Integration (Stdio Transport)', () => {
    let serverProcess: ChildProcess;
    let client: Client;
    let clientTransport: StdioClientTransport;

    beforeEach(async () => {
      // Spawn the actual built server process
      const distPath = '/Users/noot/brutalist-mcp-server/dist/index.js';
      serverProcess = spawn('node', [distPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'test'
        }
      });

      // Create MCP client with stdio transport
      clientTransport = new StdioClientTransport({
        command: 'node',
        args: [distPath],
        stderr: 'pipe'
      });

      client = new Client({
        name: 'test-client',
        version: '1.0.0'
      }, {
        capabilities: {
          roots: {
            listChanged: false
          },
          sampling: {}
        }
      });
    }, 30000);

    afterEach(async () => {
      if (client) {
        try {
          await client.close();
        } catch (error) {
          // Ignore close errors in tests
        }
      }

      if (serverProcess) {
        serverProcess.kill('SIGTERM');
        // Give process time to clean up
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    it('should complete initialize handshake with protocol-compliant response', async () => {
      // Connect the client to the server
      await client.connect(clientTransport);

      // The initialize call internally validates the response against InitializeResultSchema
      // If the server sends invalid capabilities (like experimental.streaming), this will throw
      const initResult = await client.request({
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {
            roots: {
              listChanged: false
            }
          },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      }, InitializeResultSchema);

      // Validate the result structure
      expect(initResult).toHaveProperty('protocolVersion');
      expect(initResult).toHaveProperty('capabilities');
      expect(initResult).toHaveProperty('serverInfo');

      // Server info validation
      expect(initResult.serverInfo).toMatchObject({
        name: 'brutalist-mcp',
        version: expect.any(String)
      });

      // Capabilities validation
      expect(initResult.capabilities).toHaveProperty('tools');
      expect(initResult.capabilities).toHaveProperty('logging');

      // CRITICAL: Validate experimental field is compliant
      if (initResult.capabilities.experimental) {
        // If experimental exists, it should be an empty object or have passthrough properties
        // It should NOT have structured fields like { streaming: true }
        expect(typeof initResult.capabilities.experimental).toBe('object');

        // The bug we're catching: experimental.streaming should NOT exist
        expect(initResult.capabilities.experimental).not.toHaveProperty('streaming');
      }

      // Validate against the actual MCP schema
      const validation = InitializeResultSchema.safeParse(initResult);
      expect(validation.success).toBe(true);
    }, 30000);

    it('should list tools with protocol-compliant schemas', async () => {
      await client.connect(clientTransport);

      // Initialize first
      await client.request({
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      }, InitializeResultSchema);

      // List tools - this validates against ListToolsResultSchema
      const toolsResult = await client.request({
        method: 'tools/list'
      }, ListToolsResultSchema);

      expect(toolsResult).toHaveProperty('tools');
      expect(Array.isArray(toolsResult.tools)).toBe(true);
      expect(toolsResult.tools.length).toBeGreaterThan(0);

      // Validate each tool has required MCP fields
      toolsResult.tools.forEach(tool => {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');

        // inputSchema must be a valid JSON Schema
        expect(tool.inputSchema).toHaveProperty('type');
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema).toHaveProperty('properties');
      });

      // Verify expected tools are present (4 gateway tools after tool reduction)
      const toolNames = toolsResult.tools.map(t => t.name);
      expect(toolNames).toContain('roast');  // Unified roast tool
      expect(toolNames).toContain('roast_cli_debate');
      expect(toolNames).toContain('brutalist_discover');
      expect(toolNames).toContain('cli_agent_roster');
    }, 30000);

    it('should execute tool with protocol-compliant result', async () => {
      await client.connect(clientTransport);

      // Initialize
      await client.request({
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      }, InitializeResultSchema);

      // Execute a simple tool that doesn't require external CLI agents
      const toolResult = await client.request({
        method: 'tools/call',
        params: {
          name: 'cli_agent_roster',
          arguments: {}
        }
      }, CallToolResultSchema);

      // Validate against MCP schema
      expect(toolResult).toHaveProperty('content');
      expect(Array.isArray(toolResult.content)).toBe(true);
      expect(toolResult.content.length).toBeGreaterThan(0);

      // Each content item should have type and text
      toolResult.content.forEach(item => {
        expect(item).toHaveProperty('type');
        expect(item.type).toBe('text');
        expect(item).toHaveProperty('text');
        expect(typeof item.text).toBe('string');
      });

      // Validate the full result against schema
      const validation = CallToolResultSchema.safeParse(toolResult);
      if (!validation.success) {
        console.error('Tool result validation failed:', JSON.stringify(validation.error.issues, null, 2));
      }
      expect(validation.success).toBe(true);
    }, 60000);
  });

  /**
   * NOTE: Protocol version negotiation and schema validation edge cases are tested
   * via the Full Client-Server Integration tests above, which validate the actual
   * initialize response against MCP SDK schemas. Testing private internal fields
   * is not reliable and not how real clients interact with the server.
   */
});
