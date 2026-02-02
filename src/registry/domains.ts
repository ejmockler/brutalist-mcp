/**
 * Domain Registry: All built-in critique domains
 *
 * These are extracted from the original TOOL_CONFIGS and elevated to first-class abstractions.
 */

import { z } from 'zod';
import { CritiqueDomain } from '../domains/critique-domain.js';
import { ToolConfig } from '../types/tool-config.js';
import { ARGUMENT_SPACES } from './argument-spaces.js';

export const DOMAINS: Record<string, CritiqueDomain> = {
  CODEBASE: {
    id: 'codebase',
    name: 'Codebase Analysis',
    description: 'Comprehensive codebase review for architecture, security, and maintainability',
    capabilities: [
      'static_analysis',
      'security_scanning',
      'performance_profiling',
      'scalability_analysis'
    ],
    artifactTypes: ['code', 'directory_structure'],
    inputType: 'filesystem',
    requiredFields: ['targetPath'],
    optionalFields: [],
    argumentSpaceId: 'FILESYSTEM',
    promptType: 'codebase',
    keywords: ['code', 'codebase', 'review', 'audit', 'quality']
  },

  FILE_STRUCTURE: {
    id: 'file_structure',
    name: 'File Organization',
    description: 'File and directory structure organization review',
    capabilities: ['static_analysis'],
    artifactTypes: ['directory_structure'],
    inputType: 'filesystem',
    requiredFields: ['targetPath'],
    optionalFields: ['depth'],
    argumentSpaceId: 'FILESYSTEM_DEPTH',
    promptType: 'fileStructure',
    keywords: ['files', 'structure', 'organization', 'directory']
  },

  DEPENDENCIES: {
    id: 'dependencies',
    name: 'Dependency Management',
    description: 'Package dependency analysis for security and version conflicts',
    capabilities: ['security_scanning', 'compliance_audit'],
    artifactTypes: ['package_manifest'],
    inputType: 'filesystem',
    requiredFields: ['targetPath'],
    optionalFields: ['includeDevDeps'],
    argumentSpaceId: 'PACKAGE_MANIFEST',
    promptType: 'dependencies',
    keywords: ['dependencies', 'packages', 'npm', 'security', 'versions']
  },

  GIT_HISTORY: {
    id: 'git_history',
    name: 'Git History',
    description: 'Version control history and workflow analysis',
    capabilities: ['static_analysis'],
    artifactTypes: ['git_history'],
    inputType: 'filesystem',
    requiredFields: ['targetPath'],
    optionalFields: ['commitRange'],
    argumentSpaceId: 'GIT_REPOSITORY',
    promptType: 'gitHistory',
    keywords: ['git', 'commits', 'history', 'workflow']
  },

  TEST_COVERAGE: {
    id: 'test_coverage',
    name: 'Test Coverage',
    description: 'Testing strategy and coverage analysis',
    capabilities: ['static_analysis'],
    artifactTypes: ['test_suite', 'code'],
    inputType: 'filesystem',
    requiredFields: ['targetPath'],
    optionalFields: ['runCoverage'],
    argumentSpaceId: 'TEST_SUITE',
    promptType: 'testCoverage',
    keywords: ['tests', 'coverage', 'testing', 'quality']
  },

  IDEA: {
    id: 'idea',
    name: 'Idea Validation',
    description: 'Business and technical idea feasibility analysis',
    capabilities: ['threat_modeling', 'scalability_analysis', 'cost_estimation'],
    artifactTypes: ['text_description'],
    inputType: 'content',
    requiredFields: ['content', 'targetPath'],
    optionalFields: ['resources', 'timeline'],
    argumentSpaceId: 'EXTENDED_TEXT_INPUT',
    promptType: 'idea',
    keywords: ['idea', 'startup', 'concept', 'feasibility']
  },

  ARCHITECTURE: {
    id: 'architecture',
    name: 'Architecture Review',
    description: 'System architecture design and scalability review',
    capabilities: [
      'scalability_analysis',
      'cost_estimation',
      'performance_profiling',
      'threat_modeling'
    ],
    artifactTypes: ['architecture_diagram', 'text_description', 'code'],
    inputType: 'content',
    requiredFields: ['content', 'targetPath'],
    optionalFields: ['scale', 'constraints', 'deployment'],
    argumentSpaceId: 'ARCHITECTURE_SPECIFIC',
    promptType: 'architecture',
    keywords: ['architecture', 'design', 'system', 'scale']
  },

  RESEARCH: {
    id: 'research',
    name: 'Research Methodology',
    description: 'Academic research methodology and statistical validity review',
    capabilities: ['static_analysis'],
    artifactTypes: ['text_description', 'documentation'],
    inputType: 'content',
    requiredFields: ['content', 'targetPath'],
    optionalFields: ['field', 'claims', 'data'],
    argumentSpaceId: 'RESEARCH_SPECIFIC',
    promptType: 'research',
    keywords: ['research', 'methodology', 'academic', 'statistics']
  },

  SECURITY: {
    id: 'security',
    name: 'Security Analysis',
    description: 'Security vulnerability and threat analysis',
    capabilities: [
      'penetration_testing',
      'threat_modeling',
      'security_scanning',
      'compliance_audit'
    ],
    artifactTypes: ['code', 'architecture_diagram', 'api_spec', 'deployment_config'],
    inputType: 'content',
    requiredFields: ['content', 'targetPath'],
    optionalFields: ['assets', 'threatModel', 'compliance'],
    argumentSpaceId: 'SECURITY_SPECIFIC',
    promptType: 'security',
    keywords: ['security', 'vulnerability', 'threat', 'pentest']
  },

  PRODUCT: {
    id: 'product',
    name: 'Product Review',
    description: 'Product design and user experience analysis',
    capabilities: ['usability_review', 'threat_modeling'],
    artifactTypes: ['text_description', 'documentation', 'code'],
    inputType: 'content',
    requiredFields: ['content', 'targetPath'],
    optionalFields: ['users', 'competition', 'metrics'],
    argumentSpaceId: 'PRODUCT_SPECIFIC',
    promptType: 'product',
    keywords: ['product', 'ux', 'user', 'market']
  },

  INFRASTRUCTURE: {
    id: 'infrastructure',
    name: 'Infrastructure Review',
    description: 'Infrastructure design and operations review',
    capabilities: [
      'scalability_analysis',
      'cost_estimation',
      'threat_modeling',
      'performance_profiling'
    ],
    artifactTypes: ['deployment_config', 'text_description', 'architecture_diagram'],
    inputType: 'content',
    requiredFields: ['content', 'targetPath'],
    optionalFields: ['scale', 'sla', 'budget'],
    argumentSpaceId: 'INFRASTRUCTURE_SPECIFIC',
    promptType: 'infrastructure',
    keywords: ['infrastructure', 'devops', 'cloud', 'operations']
  }
};

/**
 * Helper to get a domain by ID
 */
export function getDomain(id: string): CritiqueDomain | undefined {
  return Object.values(DOMAINS).find(d => d.id === id);
}

/**
 * Helper to list all domains
 */
export function listDomains(): CritiqueDomain[] {
  return Object.values(DOMAINS);
}

/**
 * Helper to find domains by capability
 */
export function findDomainsByCapability(capability: string): CritiqueDomain[] {
  return Object.values(DOMAINS).filter(d =>
    d.capabilities.includes(capability as any)
  );
}

/**
 * Helper to find domains by artifact type
 */
export function findDomainsByArtifactType(artifactType: string): CritiqueDomain[] {
  return Object.values(DOMAINS).filter(d =>
    d.artifactTypes.includes(artifactType as any)
  );
}

/**
 * Create a context builder function based on domain configuration
 */
function createContextBuilder(domain: CritiqueDomain, argSpace: any): ((args: any) => string) | undefined {
  // Special case: file_structure has a custom format
  if (domain.id === 'file_structure') {
    return (args: any) => `Project structure analysis (depth: ${args.depth || 3}). ${args.context || ''}`;
  }

  // Special case: dependencies has a prefix
  if (domain.id === 'dependencies') {
    return (args: any) => `Dependency analysis${args.includeDevDeps === false ? ' (production only)' : ''}. ${args.context || ''}`;
  }

  // Special case: git_history has a custom format
  if (domain.id === 'git_history') {
    return (args: any) => `Git history analysis${args.commitRange ? ` for ${args.commitRange}` : ' (last 20 commits)'}. ${args.context || ''}`;
  }

  // Special case: test_coverage has a custom format
  if (domain.id === 'test_coverage') {
    return (args: any) => `Test coverage analysis${args.runCoverage === false ? ' (static analysis only)' : ''}. ${args.context || ''}`;
  }

  // Field label overrides for better readability
  const labelOverrides: Record<string, string> = {
    threatModel: 'Threats',
    includeDevDeps: 'Include Dev Dependencies',
    runCoverage: 'Run Coverage'
  };

  // For domains with optional fields, build context from those fields
  if (domain.optionalFields.length > 0) {
    return (args: any) => {
      let ctx = args.context || '';

      // Add optional fields with human-readable labels
      for (const field of domain.optionalFields) {
        if (args[field]) {
          // Use override label if available, otherwise convert camelCase to Title Case
          const label = labelOverrides[field] ||
            (field.charAt(0).toUpperCase() + field.slice(1).replace(/([A-Z])/g, ' $1'));
          ctx += ` ${label}: ${args[field]}.`;
        }
      }

      return ctx.trim();
    };
  }

  // No context builder needed for simple domains
  return undefined;
}

/**
 * Generate a ToolConfig from a CritiqueDomain.
 * This is the canonical way to create tools - no more duplication.
 */
export function generateToolConfig(domain: CritiqueDomain): ToolConfig {
  const argSpace = ARGUMENT_SPACES[domain.argumentSpaceId];
  if (!argSpace) {
    throw new Error(`Unknown argument space: ${domain.argumentSpaceId}`);
  }

  // Build schema extensions from argument space DOMAIN fields only
  // BASE_ROAST_SCHEMA is merged separately in brutalist-server.ts
  const schemaExtensions = { ...argSpace.domain.shape };

  // Build context builder based on domain type
  const contextBuilder = createContextBuilder(domain, argSpace);

  return {
    name: `roast_${domain.id}`,
    description: `Deploy brutal AI critics to systematically destroy your ${domain.name.toLowerCase()}. ${domain.description}.`,
    analysisType: domain.promptType as any,
    schemaExtensions,
    cacheKeyFields: [...domain.requiredFields, ...domain.optionalFields, 'context', 'clis', 'models'],
    primaryArgField: domain.inputType === 'filesystem' ? 'targetPath' : 'content',
    contextBuilder
  };
}

/**
 * Generate all tool configs from the domain registry.
 */
export function generateAllToolConfigs(): ToolConfig[] {
  return Object.values(DOMAINS).map(generateToolConfig);
}
