import { ToolConfig } from './types/tool-config.js';
/**
 * Get all tool configurations.
 * Uses lazy loading - configs are generated on first access and cached.
 */
export declare function getToolConfigs(): ToolConfig[];
/**
 * Get a single tool configuration by domain ID (e.g., 'codebase', 'security').
 * More efficient when you only need one tool.
 */
export declare function getToolConfigByDomain(domainId: string): ToolConfig | undefined;
/**
 * Get available domain IDs.
 */
export declare function getAvailableDomains(): string[];
/**
 * Clear cached configs (for testing or dynamic reload).
 */
export declare function clearToolConfigCache(): void;
/**
 * @deprecated Use getToolConfigs() for lazy loading.
 * This eager export is kept for backwards compatibility.
 */
export declare const TOOL_CONFIGS: ToolConfig[];
//# sourceMappingURL=tool-definitions.d.ts.map