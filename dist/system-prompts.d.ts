import { BrutalistPromptType } from './cli-agents.js';
export declare const SYSTEM_PROMPTS: Record<BrutalistPromptType, string>;
/**
 * Get the system prompt for a given analysis type.
 * Falls back to a generic brutal prompt if type is not found.
 * When mcpServers is provided, appends MCP tool-usage instructions.
 * When url is provided (design domain), injects navigation target for Playwright.
 */
export declare function getSystemPrompt(analysisType: BrutalistPromptType, mcpServers?: string[], url?: string): string;
//# sourceMappingURL=system-prompts.d.ts.map