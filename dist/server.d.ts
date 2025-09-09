import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GeminiServerConfig } from "./types/index.js";
export declare class GeminiServer {
    server: McpServer;
    config: GeminiServerConfig;
    private readonly AVAILABLE_MODELS;
    constructor(config?: GeminiServerConfig);
    start(): Promise<void>;
    private registerTools;
    private executeGeminiPrompt;
}
//# sourceMappingURL=server.d.ts.map