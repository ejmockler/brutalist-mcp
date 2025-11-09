/**
 * Argument Space Registry: Pre-built reusable argument schemas
 *
 * Import these to avoid duplication across tool definitions.
 */

import { z } from 'zod';
import {
  ArgumentSpace,
  FILESYSTEM_ARGUMENT_SPACE,
  TEXT_INPUT_ARGUMENT_SPACE,
  FILESYSTEM_WITH_DEPTH,
  PACKAGE_MANIFEST_SPACE,
  GIT_REPOSITORY_SPACE,
  TEST_SUITE_SPACE
} from '../domains/argument-space.js';

/**
 * All built-in argument spaces
 */
export const ARGUMENT_SPACES: Record<string, ArgumentSpace> = {
  // Standard filesystem analysis
  FILESYSTEM: FILESYSTEM_ARGUMENT_SPACE,

  // Text-based input (for ideas, architecture descriptions, etc.)
  TEXT_INPUT: TEXT_INPUT_ARGUMENT_SPACE,

  // Filesystem with depth control (for directory structure analysis)
  FILESYSTEM_DEPTH: FILESYSTEM_WITH_DEPTH,

  // Package manifest analysis
  PACKAGE_MANIFEST: PACKAGE_MANIFEST_SPACE,

  // Git repository analysis
  GIT_REPOSITORY: GIT_REPOSITORY_SPACE,

  // Test suite analysis
  TEST_SUITE: TEST_SUITE_SPACE,

  // Extended text input with additional context fields
  EXTENDED_TEXT_INPUT: {
    id: 'extended_text_input',
    name: 'Extended Text Input',
    base: FILESYSTEM_ARGUMENT_SPACE.base,
    domain: TEXT_INPUT_ARGUMENT_SPACE.domain.extend({
      resources: z.string().optional().describe("Available resources (budget, team, time, skills)"),
      timeline: z.string().optional().describe("Expected timeline or deadline")
    }),
    computed: (args) => ({
      workingDirectory: args.targetPath || '.',
      contextExtensions: [args.resources, args.timeline].filter(Boolean).join('. ')
    })
  },

  // Architecture-specific arguments
  ARCHITECTURE_SPECIFIC: {
    id: 'architecture_specific',
    name: 'Architecture Specific',
    base: FILESYSTEM_ARGUMENT_SPACE.base,
    domain: TEXT_INPUT_ARGUMENT_SPACE.domain.extend({
      scale: z.string().optional().describe("Expected scale/load (users, requests, data)"),
      constraints: z.string().optional().describe("Budget, timeline, or technical constraints"),
      deployment: z.string().optional().describe("Deployment environment and strategy")
    }),
    computed: (args) => ({
      workingDirectory: args.targetPath || '.',
      scalingContext: args.scale,
      deploymentContext: args.deployment
    })
  },

  // Research-specific arguments
  RESEARCH_SPECIFIC: {
    id: 'research_specific',
    name: 'Research Specific',
    base: FILESYSTEM_ARGUMENT_SPACE.base,
    domain: TEXT_INPUT_ARGUMENT_SPACE.domain.extend({
      field: z.string().optional().describe("Research field (ML, systems, theory, etc.)"),
      claims: z.string().optional().describe("Main claims or contributions"),
      data: z.string().optional().describe("Data sources, datasets, or experimental setup")
    }),
    computed: (args) => ({
      workingDirectory: args.targetPath || '.',
      researchField: args.field,
      methodology: args.data
    })
  },

  // Security-specific arguments
  SECURITY_SPECIFIC: {
    id: 'security_specific',
    name: 'Security Specific',
    base: FILESYSTEM_ARGUMENT_SPACE.base,
    domain: TEXT_INPUT_ARGUMENT_SPACE.domain.extend({
      assets: z.string().optional().describe("Critical assets or data to protect"),
      threatModel: z.string().optional().describe("Known threats or attack vectors to consider"),
      compliance: z.string().optional().describe("Compliance requirements (GDPR, HIPAA, etc.)")
    }),
    computed: (args) => ({
      workingDirectory: args.targetPath || '.',
      criticalAssets: args.assets,
      complianceRequirements: args.compliance
    })
  },

  // Product-specific arguments
  PRODUCT_SPECIFIC: {
    id: 'product_specific',
    name: 'Product Specific',
    base: FILESYSTEM_ARGUMENT_SPACE.base,
    domain: TEXT_INPUT_ARGUMENT_SPACE.domain.extend({
      users: z.string().optional().describe("Target users or user personas"),
      competition: z.string().optional().describe("Competitive landscape or alternatives"),
      metrics: z.string().optional().describe("Success metrics or KPIs")
    }),
    computed: (args) => ({
      workingDirectory: args.targetPath || '.',
      targetUsers: args.users,
      competitiveContext: args.competition
    })
  },

  // Infrastructure-specific arguments
  INFRASTRUCTURE_SPECIFIC: {
    id: 'infrastructure_specific',
    name: 'Infrastructure Specific',
    base: FILESYSTEM_ARGUMENT_SPACE.base,
    domain: TEXT_INPUT_ARGUMENT_SPACE.domain.extend({
      scale: z.string().optional().describe("Expected scale and load patterns"),
      sla: z.string().optional().describe("SLA requirements or uptime targets"),
      budget: z.string().optional().describe("Infrastructure budget or cost constraints")
    }),
    computed: (args) => ({
      workingDirectory: args.targetPath || '.',
      loadPatterns: args.scale,
      slaRequirements: args.sla,
      costConstraints: args.budget
    })
  }
};

/**
 * Helper to get an argument space by ID
 */
export function getArgumentSpace(id: string): ArgumentSpace | undefined {
  return Object.values(ARGUMENT_SPACES).find(a => a.id === id);
}

/**
 * Helper to list all argument spaces
 */
export function listArgumentSpaces(): ArgumentSpace[] {
  return Object.values(ARGUMENT_SPACES);
}
