/**
 * BrutalistToolGenerator: The magic that transforms domains into tools
 *
 * This is the compositional algebra:
 * CritiqueDomain × CriticPersona × ArgumentSpace × ExecutionStrategy = ToolConfig
 */
import { CritiqueDomain } from '../domains/critique-domain.js';
import { CriticPersona } from '../domains/critic-persona.js';
import { ArgumentSpace } from '../domains/argument-space.js';
import { ExecutionStrategy } from '../domains/execution-strategy.js';
import { ToolConfig } from '../types/tool-config.js';
export declare class BrutalistToolGenerator {
    /**
     * Generate a single tool from domain + persona + argument space + strategy
     */
    generateTool(domain: CritiqueDomain, persona: CriticPersona, argSpace: ArgumentSpace, strategy: ExecutionStrategy): ToolConfig;
    /**
     * Compose multiple domains into a single composite tool
     */
    composeDomainsToTool(domains: CritiqueDomain[], persona: CriticPersona, argSpace: ArgumentSpace, strategy: ExecutionStrategy): ToolConfig;
    /**
     * Generate multiple tools from a domain across different personas/strategies
     */
    generateVariations(domain: CritiqueDomain, personas: CriticPersona[], argSpace: ArgumentSpace, strategies: ExecutionStrategy[]): ToolConfig[];
    private buildSchemaExtensions;
    private buildContextBuilder;
    private renderDescription;
    private describeTone;
    private describeMode;
    private describeCapabilities;
    private mapDomainToAnalysisType;
}
//# sourceMappingURL=tool-generator.d.ts.map