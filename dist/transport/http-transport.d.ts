import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BrutalistServerConfig } from '../types/brutalist.js';
/**
 * HttpTransport - Manages HTTP server and MCP transport
 * Extracted from BrutalistServer to follow Single Responsibility Principle
 */
export declare class HttpTransport {
    private config;
    private mcpRequestHandler;
    private httpServer?;
    private httpTransport?;
    private actualPort?;
    private shutdownHandler?;
    constructor(config: BrutalistServerConfig, mcpRequestHandler: (transport: StreamableHTTPServerTransport) => void);
    /**
     * Start HTTP server with MCP transport
     */
    start(packageVersion: string): Promise<void>;
    /**
     * Stop the HTTP server gracefully
     */
    stop(): Promise<void>;
    /**
     * Get actual listening port (useful for tests)
     */
    getActualPort(): number | undefined;
    /**
     * Get HTTP transport instance
     */
    getTransport(): StreamableHTTPServerTransport | undefined;
    /**
     * Cleanup method for tests - remove event listeners
     */
    cleanup(): void;
    /**
     * Secure CORS implementation
     */
    private handleCORS;
}
//# sourceMappingURL=http-transport.d.ts.map