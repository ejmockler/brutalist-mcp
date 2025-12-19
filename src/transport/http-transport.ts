import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { logger } from '../logger.js';
import { BrutalistServerConfig } from '../types/brutalist.js';

/**
 * HttpTransport - Manages HTTP server and MCP transport
 * Extracted from BrutalistServer to follow Single Responsibility Principle
 */
export class HttpTransport {
  private httpServer?: any;
  private httpTransport?: StreamableHTTPServerTransport;
  private actualPort?: number;
  private shutdownHandler?: () => void;

  constructor(
    private config: BrutalistServerConfig,
    private mcpRequestHandler: (transport: StreamableHTTPServerTransport) => void
  ) {}

  /**
   * Start HTTP server with MCP transport
   */
  public async start(packageVersion: string): Promise<void> {
    logger.info(`Starting with HTTP streaming transport on port ${this.config.httpPort}`);

    // Create HTTP transport with streaming support
    this.httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false, // Force SSE streaming
      onsessioninitialized: (sessionId) => {
        logger.info(`New session initialized: ${sessionId}`);
      },
      onsessionclosed: (sessionId) => {
        logger.info(`Session closed: ${sessionId}`);
      }
    });

    // Notify caller to connect MCP server to transport
    this.mcpRequestHandler(this.httpTransport);

    // Create Express app for HTTP handling
    const app = express();
    app.use(express.json({ limit: '10mb' })); // Add JSON size limit for security

    // Apply CORS middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      this.handleCORS(req, res, next);
    });

    // Route all MCP requests through the transport
    app.all('/mcp', async (req: Request, res: Response) => {
      try {
        await this.httpTransport!.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error("HTTP request handling failed", error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    });

    // Health check endpoint
    app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', transport: 'http-streaming', version: packageVersion });
    });

    // Start the HTTP server - bind to localhost only for security
    const port = this.config.httpPort ?? 3000;

    return new Promise<void>((resolve, reject) => {
      this.httpServer = app.listen(port, '127.0.0.1', () => {
        const actualPort = (this.httpServer.address() as any)?.port || port;
        this.actualPort = actualPort;
        logger.info(`HTTP server listening on port ${actualPort}`);
        logger.info(`MCP endpoint: http://localhost:${actualPort}/mcp`);
        logger.info(`Health check: http://localhost:${actualPort}/health`);
        resolve();
      });

      this.httpServer.on('error', (error: Error) => {
        logger.error('HTTP server failed to start', error);
        reject(error);
      });

      // Handle graceful shutdown - avoid duplicate listeners
      if (!this.shutdownHandler) {
        this.shutdownHandler = () => {
          logger.info('Received SIGTERM, shutting down gracefully');
          this.httpServer?.close(() => {
            logger.info('HTTP server closed');
            process.exit(0);
          });
        };
        process.on('SIGTERM', this.shutdownHandler);
      }
    });
  }

  /**
   * Stop the HTTP server gracefully
   */
  public async stop(): Promise<void> {
    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => {
          logger.info('HTTP server stopped');
          this.httpServer = undefined;
          this.actualPort = undefined;
          resolve();
        });
      });
    }
  }

  /**
   * Get actual listening port (useful for tests)
   */
  public getActualPort(): number | undefined {
    return this.actualPort;
  }

  /**
   * Get HTTP transport instance
   */
  public getTransport(): StreamableHTTPServerTransport | undefined {
    return this.httpTransport;
  }

  /**
   * Cleanup method for tests - remove event listeners
   */
  public cleanup(): void {
    if (this.shutdownHandler) {
      process.removeListener('SIGTERM', this.shutdownHandler);
      this.shutdownHandler = undefined;
    }
  }

  /**
   * Secure CORS implementation
   */
  private handleCORS(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    const isProduction = process.env.NODE_ENV === 'production';

    // Define safe default origins for development
    const defaultDevOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://localhost:3001',
      'http://127.0.0.1:3001'
    ];

    // Get allowed origins from config or use defaults
    const allowedOrigins = this.config.corsOrigins || defaultDevOrigins;
    const allowWildcard = this.config.allowCORSWildcard === true && !isProduction;

    // Determine if origin is allowed
    let allowedOrigin: string | null = null;

    if (allowWildcard) {
      // Only in development with explicit opt-in
      allowedOrigin = '*';
      logger.warn("⚠️ Using wildcard CORS - only safe in development!");
    } else if (!origin) {
      // No origin header (same-origin or direct server access)
      allowedOrigin = defaultDevOrigins[0]; // Default fallback
    } else if (allowedOrigins.includes(origin)) {
      // Explicitly allowed origin
      allowedOrigin = origin;
    } else {
      // Rejected origin
      logger.warn(`🚫 CORS rejected origin: ${origin}`);
      allowedOrigin = null;
    }

    // Set headers only if origin is allowed
    if (allowedOrigin) {
      res.header('Access-Control-Allow-Origin', allowedOrigin);
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
      res.header('Access-Control-Allow-Credentials', 'false'); // Explicit false
    }

    if (req.method === 'OPTIONS') {
      if (allowedOrigin) {
        res.sendStatus(200);
      } else {
        res.sendStatus(403); // Forbidden for disallowed origins
      }
      return;
    }

    next();
  }
}
