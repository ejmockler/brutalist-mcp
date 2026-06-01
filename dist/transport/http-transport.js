import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { logger } from '../logger.js';
/**
 * HttpTransport - Manages HTTP server and MCP transport
 * Extracted from BrutalistServer to follow Single Responsibility Principle
 */
export class HttpTransport {
    config;
    mcpRequestHandler;
    httpServer;
    httpTransport;
    actualPort;
    shutdownHandler;
    constructor(config, mcpRequestHandler) {
        this.config = config;
        this.mcpRequestHandler = mcpRequestHandler;
    }
    /**
     * Start HTTP server with MCP transport
     */
    async start(packageVersion) {
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
        app.use((req, res, next) => {
            this.handleCORS(req, res, next);
        });
        // Route all MCP requests through the transport
        app.all('/mcp', async (req, res) => {
            try {
                await this.httpTransport.handleRequest(req, res, req.body);
            }
            catch (error) {
                logger.error("HTTP request handling failed", error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Internal server error' });
                }
            }
        });
        // Health check endpoint
        app.get('/health', (req, res) => {
            res.json({ status: 'ok', transport: 'http-streaming', version: packageVersion });
        });
        // Start the HTTP server - bind to localhost only for security
        const port = this.config.httpPort ?? 3000;
        return new Promise((resolve, reject) => {
            this.httpServer = app.listen(port, '127.0.0.1', () => {
                const actualPort = this.httpServer.address()?.port || port;
                this.actualPort = actualPort;
                logger.info(`HTTP server listening on port ${actualPort}`);
                logger.info(`MCP endpoint: http://localhost:${actualPort}/mcp`);
                logger.info(`Health check: http://localhost:${actualPort}/health`);
                resolve();
            });
            this.httpServer.on('error', (error) => {
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
    async stop() {
        if (this.httpServer) {
            return new Promise((resolve) => {
                this.httpServer.close(() => {
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
    getActualPort() {
        return this.actualPort;
    }
    /**
     * Get HTTP transport instance
     */
    getTransport() {
        return this.httpTransport;
    }
    /**
     * Cleanup method for tests - remove event listeners
     */
    cleanup() {
        if (this.shutdownHandler) {
            process.removeListener('SIGTERM', this.shutdownHandler);
            this.shutdownHandler = undefined;
        }
    }
    /**
     * Secure CORS implementation
     */
    handleCORS(req, res, next) {
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
        let allowedOrigin = null;
        if (allowWildcard) {
            // Only in development with explicit opt-in
            allowedOrigin = '*';
            logger.warn("⚠️ Using wildcard CORS - only safe in development!");
        }
        else if (!origin) {
            // No origin header (same-origin or direct server access)
            allowedOrigin = defaultDevOrigins[0]; // Default fallback
        }
        else if (allowedOrigins.includes(origin)) {
            // Explicitly allowed origin
            allowedOrigin = origin;
        }
        else {
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
            }
            else {
                res.sendStatus(403); // Forbidden for disallowed origins
            }
            return;
        }
        next();
    }
}
//# sourceMappingURL=http-transport.js.map