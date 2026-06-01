/**
 * Domain Registry: All built-in critique domains
 *
 * These are extracted from the original TOOL_CONFIGS and elevated to first-class abstractions.
 */
import { CritiqueDomain } from '../domains/critique-domain.js';
import { ToolConfig } from '../types/tool-config.js';
export declare const DOMAINS: Record<string, CritiqueDomain>;
/**
 * Helper to get a domain by ID
 */
export declare function getDomain(id: string): CritiqueDomain | undefined;
/**
 * Helper to list all domains
 */
export declare function listDomains(): CritiqueDomain[];
/**
 * Helper to find domains by capability
 */
export declare function findDomainsByCapability(capability: string): CritiqueDomain[];
/**
 * Helper to find domains by artifact type
 */
export declare function findDomainsByArtifactType(artifactType: string): CritiqueDomain[];
/**
 * Generate a ToolConfig from a CritiqueDomain.
 * This is the canonical way to create tools - no more duplication.
 */
export declare function generateToolConfig(domain: CritiqueDomain): ToolConfig;
/**
 * Generate all tool configs from the domain registry.
 */
export declare function generateAllToolConfigs(): ToolConfig[];
//# sourceMappingURL=domains.d.ts.map