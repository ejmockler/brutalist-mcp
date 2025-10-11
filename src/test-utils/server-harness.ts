import { BrutalistServer } from '../brutalist-server.js';
import { logger } from '../logger.js';

export interface ServerHarnessOptions {
  maxStartupTime?: number;  // Maximum time to wait for server ready (default: 30s)
  healthCheckInterval?: number;  // How often to check health (default: 100ms)
  shutdownTimeout?: number;  // Grace period for shutdown (default: 5s)
}

/**
 * Harness for deterministic server lifecycle management in tests.
 * Provides event-based readiness detection and proper cleanup.
 */
export class ServerHarness {
  private server: BrutalistServer | null = null;
  private actualPort: number | undefined;
  private baseUrl: string | undefined;
  private startTime: number | undefined;
  private httpServer: any | undefined;
  private sessionId: string | undefined;

  constructor(private options: ServerHarnessOptions = {}) {
    this.options = {
      maxStartupTime: 30000,
      healthCheckInterval: 100,
      shutdownTimeout: 5000,
      ...options
    };
  }

  /**
   * Start server and wait for it to be ready (not just started)
   */
  async start(config: any = {}): Promise<void> {
    if (this.server) {
      throw new Error('Server already started');
    }

    this.startTime = Date.now();
    logger.info('ServerHarness: Starting server...');

    try {
      // Create server instance
      this.server = new BrutalistServer({
        ...config,
        httpPort: config.httpPort ?? 0  // Use 0 for random port if not specified
      });

      // Start the server
      await this.server.start();

      // Get actual port for HTTP transport
      if (config.transport === 'http' || !config.transport) {
        this.actualPort = this.server.getActualPort();
        if (!this.actualPort) {
          throw new Error('Failed to get actual server port');
        }
        this.baseUrl = `http://localhost:${this.actualPort}`;

        // Wait for HTTP server to be ready
        await this.waitForHttpReady();
        
        // Initialize MCP connection
        await this.initializeMCP();
      }

      const startupTime = Date.now() - this.startTime;
      logger.info(`ServerHarness: Server ready in ${startupTime}ms on port ${this.actualPort}`);
    } catch (error) {
      // Cleanup on startup failure
      logger.error('ServerHarness: Startup failed:', error);
      this.cleanup();
      throw error;
    }
  }

  /**
   * Wait for HTTP server to respond to health checks
   */
  private async waitForHttpReady(): Promise<void> {
    const deadline = Date.now() + this.options.maxStartupTime!;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${this.baseUrl}/health`);

        if (response.ok) {
          const data = await response.json() as any;
          if (data.status === 'ok') {
            logger.debug('ServerHarness: Health check passed');
            return;
          }
        }
      } catch (error: any) {
        lastError = error;
        // Server not ready yet, keep trying
      }

      await new Promise(resolve => setTimeout(resolve, this.options.healthCheckInterval));
    }

    throw new Error(`Server failed to become ready within ${this.options.maxStartupTime}ms: ${lastError?.message}`);
  }

  /**
   * Parse SSE response format to extract JSON data
   */
  private parseSSEResponse(responseText: string): any {
    const lines = responseText.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          return JSON.parse(line.substring(6)); // Remove "data: " prefix
        } catch (e) {
          // Continue looking for valid JSON
        }
      }
    }
    
    throw new Error(`Failed to parse SSE response: ${responseText}`);
  }

  /**
   * Initialize MCP connection with handshake
   */
  private async initializeMCP(): Promise<void> {
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          logging: {}  // Add logging capability to support notifications
        },
        clientInfo: {
          name: 'test-client',
          version: '1.0.0'
        }
      }
    };

    const response = await this.testRequest('/mcp', {
      method: 'POST',
      body: JSON.stringify(initRequest)
    });

    // Handle SSE response format
    const responseText = await response.text();
    const jsonData = this.parseSSEResponse(responseText);
    
    if (jsonData.error) {
      throw new Error(`MCP initialization failed: ${JSON.stringify(jsonData.error)}`);
    }

    // Extract session ID from response headers
    const sessionIdHeader = response.headers.get('mcp-session-id');
    if (sessionIdHeader) {
      this.sessionId = sessionIdHeader;
      logger.debug(`MCP session ID: ${this.sessionId}`);
    }

    logger.debug('MCP server initialized successfully');
  }

  /**
   * Stop server with graceful shutdown and forced kill if needed
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    logger.info('ServerHarness: Stopping server...');
    const stopStart = Date.now();

    try {
      // Try graceful shutdown first
      if (this.httpServer) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Server shutdown timed out'));
          }, this.options.shutdownTimeout);

          this.httpServer.close((err?: Error) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Additional server cleanup if needed
      if (this.server) {
        this.server.cleanup();
      }

      const stopTime = Date.now() - stopStart;
      logger.info(`ServerHarness: Server stopped in ${stopTime}ms`);
    } catch (error) {
      logger.error('ServerHarness: Graceful shutdown failed, forcing stop:', error);
      // Force cleanup
      this.httpServer = undefined;
    } finally {
      this.server = null;
      this.actualPort = undefined;
      this.baseUrl = undefined;
    }
  }

  /**
   * Reset server state (for cleanup after failed startup)
   */
  private cleanup(): void {
    this.server = null;
    this.actualPort = undefined;
    this.baseUrl = undefined;
    this.httpServer = undefined;
    this.sessionId = undefined;
    this.startTime = undefined;
  }

  /**
   * Get the actual port the server is listening on
   */
  getPort(): number {
    if (!this.actualPort) {
      throw new Error('Server not started or port not available');
    }
    return this.actualPort;
  }

  /**
   * Get the base URL for HTTP requests
   */
  getBaseUrl(): string {
    if (!this.baseUrl) {
      throw new Error('Server not started or not using HTTP transport');
    }
    return this.baseUrl;
  }

  /**
   * Get the server instance for direct access if needed
   */
  getServer(): BrutalistServer {
    if (!this.server) {
      throw new Error('Server not started');
    }
    return this.server;
  }

  /**
   * Check if server is currently running
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Make a test request to the server
   */
  async testRequest(path: string, options: any = {}): Promise<any> {
    if (!this.baseUrl) {
      throw new Error('Server not started or not using HTTP transport');
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...options.headers
    };

    // Add session ID if available and this is an MCP request
    if (this.sessionId && path === '/mcp') {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok && !options.allowFailure) {
      const text = await response.text();
      throw new Error(`Request failed: ${response.status} ${response.statusText}\n${text}`);
    }

    return response;
  }

  /**
   * Execute an MCP tool via HTTP
   */
  async executeTool(toolName: string, args: any, progressToken?: string): Promise<any> {
    const request = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
        _meta: progressToken ? { progressToken } : undefined
      }
    };

    const response = await this.testRequest('/mcp', {
      method: 'POST',
      body: JSON.stringify(request)
    });

    // Handle SSE response format
    const responseText = await response.text();
    const jsonData = this.parseSSEResponse(responseText);
    
    if (jsonData.error) {
      throw new Error(`Tool execution failed: ${JSON.stringify(jsonData.error)}`);
    }

    return jsonData.result;
  }

  /**
   * Get diagnostic information about the server
   */
  getDiagnostics(): string {
    const lines = ['ServerHarness diagnostics:'];
    lines.push(`  Running: ${this.isRunning()}`);
    if (this.server) {
      lines.push(`  Port: ${this.actualPort}`);
      lines.push(`  Base URL: ${this.baseUrl}`);
      lines.push(`  Uptime: ${Date.now() - this.startTime!}ms`);
    }
    return lines.join('\n');
  }
}