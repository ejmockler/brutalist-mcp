/**
 * BrutalistToolGenerator: The magic that transforms domains into tools
 *
 * This is the compositional algebra:
 * CritiqueDomain × CriticPersona × ArgumentSpace × ExecutionStrategy = ToolConfig
 */

import { z } from 'zod';
import { CritiqueDomain, composeDomains } from '../domains/critique-domain.js';
import { CriticPersona, bindPersonaToDomain } from '../domains/critic-persona.js';
import { ArgumentSpace, inferCacheKeys, inferPrimaryArg } from '../domains/argument-space.js';
import { ExecutionStrategy } from '../domains/execution-strategy.js';
import { ToolConfig } from '../types/tool-config.js';

export class BrutalistToolGenerator {
  /**
   * Generate a single tool from domain + persona + argument space + strategy
   */
  generateTool(
    domain: CritiqueDomain,
    persona: CriticPersona,
    argSpace: ArgumentSpace,
    strategy: ExecutionStrategy
  ): ToolConfig {
    // Bind persona to domain (renders prompt template)
    const boundPersona = bindPersonaToDomain(persona, domain);
    const systemPrompt = boundPersona.promptTemplate.render(domain);

    // Merge argument schemas
    const schemaExtensions = this.buildSchemaExtensions(argSpace);

    // Infer cache keys and primary arg
    const cacheKeyFields = inferCacheKeys(argSpace);
    const primaryArgField = inferPrimaryArg(argSpace);

    // Build context function if needed
    const contextBuilder = this.buildContextBuilder(argSpace, domain);

    // Map domain ID to analysis type (for backwards compatibility)
    const analysisType = this.mapDomainToAnalysisType(domain.id) as any;

    return {
      name: `roast_${domain.id}`,
      description: this.renderDescription(domain, persona, strategy),
      analysisType,
      systemPrompt,
      schemaExtensions,
      cacheKeyFields,
      primaryArgField,
      contextBuilder: contextBuilder || undefined
    };
  }

  /**
   * Compose multiple domains into a single composite tool
   */
  composeDomainsToTool(
    domains: CritiqueDomain[],
    persona: CriticPersona,
    argSpace: ArgumentSpace,
    strategy: ExecutionStrategy
  ): ToolConfig {
    const compositeId = domains.map(d => d.id).join('_and_');
    const compositeName = domains.map(d => d.name).join(' and ');
    const compositeDomain = composeDomains(domains, compositeId, compositeName);

    return this.generateTool(compositeDomain, persona, argSpace, strategy);
  }

  /**
   * Generate multiple tools from a domain across different personas/strategies
   */
  generateVariations(
    domain: CritiqueDomain,
    personas: CriticPersona[],
    argSpace: ArgumentSpace,
    strategies: ExecutionStrategy[]
  ): ToolConfig[] {
    const tools: ToolConfig[] = [];

    for (const persona of personas) {
      for (const strategy of strategies) {
        tools.push(this.generateTool(domain, persona, argSpace, strategy));
      }
    }

    return tools;
  }

  // Private helpers

  private buildSchemaExtensions(argSpace: ArgumentSpace): Record<string, z.ZodTypeAny> {
    // Combine base + domain arguments
    const combined = argSpace.base.merge(argSpace.domain);
    return combined.shape;
  }

  private buildContextBuilder(
    argSpace: ArgumentSpace,
    domain: CritiqueDomain
  ): ((args: any) => string) | null {
    // If argument space has a computed function, use it to build context
    if (argSpace.computed) {
      return (args: any) => {
        const computed = argSpace.computed!(args);
        const parts: string[] = [];

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
    return (args: any) => {
      return args.context || '';
    };
  }

  private renderDescription(
    domain: CritiqueDomain,
    persona: CriticPersona,
    strategy: ExecutionStrategy
  ): string {
    const toneDesc = this.describeTone(persona.tone);
    const modeDesc = this.describeMode(strategy.mode);

    // Combine the flavorful intro with the domain's detailed description
    return `Deploy ${toneDesc} AI critics to ${modeDesc} your ${domain.name.toLowerCase()}. ${domain.description}.`;
  }

  private describeTone(tone: string): string {
    switch (tone) {
      case 'brutal': return 'brutal';
      case 'constructive': return 'constructive';
      case 'balanced': return 'balanced';
      case 'pedagogical': return 'pedagogical';
      default: return 'expert';
    }
  }

  private describeMode(mode: string): string {
    switch (mode) {
      case 'parallel': return 'systematically destroy';
      case 'debate': return 'debate and challenge';
      case 'sequential': return 'methodically analyze';
      case 'tournament': return 'compete to find flaws in';
      default: return 'analyze';
    }
  }

  // NOTE: This method is now unused, as domain.description is directly injected
  private describeCapabilities(capabilities: string[]): string {
    const first = capabilities[0] || 'analyze';
    return first.replace(/_/g, ' ');
  }

  private mapDomainToAnalysisType(domainId: string): string {
    // Map new domain IDs to old analysis types for backwards compatibility
    const mapping: Record<string, string> = {
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
