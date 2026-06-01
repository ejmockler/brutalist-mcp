import { generateAllToolConfigs, getDomain, generateToolConfig, DOMAINS } from './registry/domains.js';
/**
 * Tool configurations - now generated from the domain registry.
 * This maintains backwards compatibility while eliminating duplication.
 *
 * LAZY LOADING: Configs are generated on first access and cached.
 */
let _cachedToolConfigs = null;
/**
 * Get all tool configurations.
 * Uses lazy loading - configs are generated on first access and cached.
 */
export function getToolConfigs() {
    if (!_cachedToolConfigs) {
        _cachedToolConfigs = generateAllToolConfigs();
    }
    return _cachedToolConfigs;
}
/**
 * Get a single tool configuration by domain ID (e.g., 'codebase', 'security').
 * More efficient when you only need one tool.
 */
export function getToolConfigByDomain(domainId) {
    const domain = getDomain(domainId);
    if (!domain)
        return undefined;
    return generateToolConfig(domain);
}
/**
 * Get available domain IDs.
 */
export function getAvailableDomains() {
    return Object.values(DOMAINS).map(d => d.id);
}
/**
 * Clear cached configs (for testing or dynamic reload).
 */
export function clearToolConfigCache() {
    _cachedToolConfigs = null;
}
/**
 * @deprecated Use getToolConfigs() for lazy loading.
 * This eager export is kept for backwards compatibility.
 */
export const TOOL_CONFIGS = generateAllToolConfigs();
//# sourceMappingURL=tool-definitions.js.map