/**
 * Domain Registry: All built-in critique domains
 *
 * These are extracted from the original TOOL_CONFIGS and elevated to first-class abstractions.
 */

import { CritiqueDomain } from '../domains/critique-domain.js';

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
    artifactTypes: ['code', 'directory_structure']
  },

  FILE_STRUCTURE: {
    id: 'file_structure',
    name: 'File Organization',
    description: 'File and directory structure organization review',
    capabilities: ['static_analysis'],
    artifactTypes: ['directory_structure']
  },

  DEPENDENCIES: {
    id: 'dependencies',
    name: 'Dependency Management',
    description: 'Package dependency analysis for security and version conflicts',
    capabilities: ['security_scanning', 'compliance_audit'],
    artifactTypes: ['package_manifest']
  },

  GIT_HISTORY: {
    id: 'git_history',
    name: 'Git History',
    description: 'Version control history and workflow analysis',
    capabilities: ['static_analysis'],
    artifactTypes: ['git_history']
  },

  TEST_COVERAGE: {
    id: 'test_coverage',
    name: 'Test Coverage',
    description: 'Testing strategy and coverage analysis',
    capabilities: ['static_analysis'],
    artifactTypes: ['test_suite', 'code']
  },

  IDEA: {
    id: 'idea',
    name: 'Idea Validation',
    description: 'Business and technical idea feasibility analysis',
    capabilities: ['threat_modeling', 'scalability_analysis', 'cost_estimation'],
    artifactTypes: ['text_description']
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
    artifactTypes: ['architecture_diagram', 'text_description', 'code']
  },

  RESEARCH: {
    id: 'research',
    name: 'Research Methodology',
    description: 'Academic research methodology and statistical validity review',
    capabilities: ['static_analysis'],
    artifactTypes: ['text_description', 'documentation']
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
    artifactTypes: ['code', 'architecture_diagram', 'api_spec', 'deployment_config']
  },

  PRODUCT: {
    id: 'product',
    name: 'Product Review',
    description: 'Product design and user experience analysis',
    capabilities: ['usability_review', 'threat_modeling'],
    artifactTypes: ['text_description', 'documentation', 'code']
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
    artifactTypes: ['deployment_config', 'text_description', 'architecture_diagram']
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
