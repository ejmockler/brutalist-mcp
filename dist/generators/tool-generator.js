/**
 * BrutalistToolGenerator: The magic that transforms domains into tools
 *
 * This is the compositional algebra:
 * CritiqueDomain × CriticPersona × ArgumentSpace × ExecutionStrategy = ToolConfig
 */
import { composeDomains } from '../domains/critique-domain.js';
import { inferCacheKeys, inferPrimaryArg } from '../domains/argument-space.js';
export class BrutalistToolGenerator {
    /**
     * Generate a single tool from domain + persona + argument space + strategy
     */
    generateTool(domain, persona, argSpace, strategy) {
        // System prompts are now retrieved at execution time from system-prompts.ts
        // This reduces MCP initialization context and separates schema from execution concerns
        // Note: Still generate systemPrompt for backwards compatibility with old tool-definitions.ts,
        // but it's optional in ToolConfig. New code should use getSystemPrompt(analysisType).
        // Merge argument schemas
        const schemaExtensions = this.buildSchemaExtensions(argSpace);
        // Infer cache keys and primary arg
        const cacheKeyFields = inferCacheKeys(argSpace);
        const primaryArgField = inferPrimaryArg(argSpace);
        // Build context function if needed
        const contextBuilder = this.buildContextBuilder(argSpace, domain);
        // Map domain ID to analysis type (for backwards compatibility)
        const analysisType = this.mapDomainToAnalysisType(domain.id);
        return {
            name: `roast_${domain.id}`,
            description: this.renderDescription(domain, persona, strategy),
            analysisType,
            // systemPrompt omitted - retrieved at execution time via getSystemPrompt()
            schemaExtensions,
            cacheKeyFields,
            primaryArgField,
            contextBuilder: contextBuilder || undefined
        };
    }
    /**
     * Compose multiple domains into a single composite tool
     */
    composeDomainsToTool(domains, persona, argSpace, strategy) {
        const compositeId = domains.map(d => d.id).join('_and_');
        const compositeName = domains.map(d => d.name).join(' and ');
        const compositeDomain = composeDomains(domains, compositeId, compositeName);
        return this.generateTool(compositeDomain, persona, argSpace, strategy);
    }
    /**
     * Generate multiple tools from a domain across different personas/strategies
     */
    generateVariations(domain, personas, argSpace, strategies) {
        const tools = [];
        for (const persona of personas) {
            for (const strategy of strategies) {
                tools.push(this.generateTool(domain, persona, argSpace, strategy));
            }
        }
        return tools;
    }
    // Private helpers
    buildSchemaExtensions(argSpace) {
        // Combine base + domain arguments
        const combined = argSpace.base.merge(argSpace.domain);
        return combined.shape;
    }
    buildContextBuilder(argSpace, domain) {
        // If argument space has a computed function, use it to build context
        if (argSpace.computed) {
            return (args) => {
                const computed = argSpace.computed(args);
                const parts = [];
                // Add analysis type
                parts.push(`${domain.name} analysis`);
                // Add notable computed values
                for (const [key, value] of Object.entries(computed)) {
                    if (value && key !== 'workingDirectory') {
                        parts.push(`${key}: ${value}`);
                    }
                }
                // Add user context if provided
                if (args.context) {
                    parts.push(args.context);
                }
                return parts.join('. ');
            };
        }
        // Simple context builder for basic cases
        return (args) => {
            return args.context || '';
        };
    }
    renderDescription(domain, persona, strategy) {
        const toneDesc = this.describeTone(persona.tone);
        const modeDesc = this.describeMode(strategy.mode);
        // Combine the flavorful intro with the domain's detailed description
        return `Deploy ${toneDesc} AI critics to ${modeDesc} your ${domain.name.toLowerCase()}. ${domain.description}.`;
    }
    describeTone(tone) {
        switch (tone) {
            case 'brutal': return 'brutal';
            case 'constructive': return 'constructive';
            case 'balanced': return 'balanced';
            case 'pedagogical': return 'pedagogical';
            default: return 'expert';
        }
    }
    describeMode(mode) {
        switch (mode) {
            case 'parallel': return 'systematically destroy';
            case 'debate': return 'debate and challenge';
            case 'sequential': return 'methodically analyze';
            case 'tournament': return 'compete to find flaws in';
            default: return 'analyze';
        }
    }
    // NOTE: This method is now unused, as domain.description is directly injected
    describeCapabilities(capabilities) {
        const first = capabilities[0] || 'analyze';
        return first.replace(/_/g, ' ');
    }
    mapDomainToAnalysisType(domainId) {
        // Map new domain IDs to old analysis types for backwards compatibility
        const mapping = {
            'codebase': 'codebase',
            'file_structure': 'fileStructure',
            'dependencies': 'dependencies',
            'git_history': 'gitHistory',
            'test_coverage': 'testCoverage',
            'idea': 'idea',
            'architecture': 'architecture',
            'research': 'research',
            'security': 'security',
            'product': 'product',
            'infrastructure': 'infrastructure'
        };
        return mapping[domainId] || domainId;
    }
}
//# sourceMappingURL=tool-generator.js.map