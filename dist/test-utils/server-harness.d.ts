import { BrutalistServer } from '../brutalist-server.js';
export interface ServerHarnessOptions {
    maxStartupTime?: number;
    healthCheckInterval?: number;
    shutdownTimeout?: number;
}
/**
 * Harness for deterministic server lifecycle management in tests.
 * Provides event-based readiness detection and proper cleanup.
 */
export declare class ServerHarness {
    private options;
    private server;
    private actualPort;
    private baseUrl;
    private startTime;
    private httpServer;
    private sessionId;
    constructor(options?: ServerHarnessOptions);
    /**
     * Start server and wait for it to be ready (not just started)
     */
    start(config?: any): Promise<void>;
    /**
     * Wait for HTTP server to respond to health checks
     */
    private waitForHttpReady;
    /**
     * Parse SSE response format to extract JSON data
     */
    private parseSSEResponse;
    /**
     * Initialize MCP connection with handshake
     */
    private initializeMCP;
    /**
     * Stop server with graceful shutdown and forced kill if needed
     */
    stop(): Promise<void>;
    /**
     * Reset server state (for cleanup after failed startup)
     */
    private cleanup;
    /**
     * Get the actual port the server is listening on
     */
    getPort(): number;
    /**
     * Get the base URL for HTTP requests
     */
    getBaseUrl(): string;
    /**
     * Get the server instance for direct access if needed
     */
    getServer(): BrutalistServer;
    /**
     * Check if server is currently running
     */
    isRunning(): boolean;
    /**
     * Make a test request to the server
     */
    testRequest(path: string, options?: any): Promise<any>;
    /**
     * Execute an MCP tool via HTTP
     */
    executeTool(toolName: string, args: any, progressToken?: string): Promise<any>;
    /**
     * Get diagnostic information about the server
     */
    getDiagnostics(): string;
}
//# sourceMappingURL=server-harness.d.ts.map