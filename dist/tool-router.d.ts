import { ToolConfig } from './types/tool-config.js';
/**
 * Filter tools by intent string.
 * Returns top 3 most relevant tools, or all tools if no intent provided.
 */
export declare function filterToolsByIntent(intent?: string): ToolConfig[];
/**
 * Get domain IDs that match an intent.
 * Useful for logging and debugging.
 */
export declare function getMatchingDomainIds(intent: string): string[];
//# sourceMappingURL=tool-router.d.ts.map