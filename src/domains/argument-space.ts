/**
 * Core abstraction: ArgumentSpace
 *
 * Defines the parameter schema for a tool - what arguments it accepts.
 * Argument spaces are composable and reusable across tools.
 */

import { z } from 'zod';

export interface ArgumentSpace {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Base arguments that all tools share */
  base: z.ZodObject<any>;

  /** Domain-specific arguments */
  domain: z.ZodObject<any>;

  /** Optional: compute additional arguments from user input */
  computed?: (args: any) => Record<string, any>;

  /** Optional: validate arguments beyond schema */
  validate?: (args: any) => { valid: boolean; errors?: string[] };
}

/**
 * Standard base arguments shared by all tools
 */
export const BASE_ARGUMENTS = z.object({
  context: z.string().optional().describe("Additional context"),

  models: z.object({
    claude: z.string().optional(),
    codex: z.string().optional(),
    gemini: z.string().optional()
  }).optional().describe("Specific models per agent"),

  preferredCLI: z.enum(['claude', 'codex', 'gemini']).optional()
    .describe("Preferred CLI agent"),

  force_refresh: z.boolean().optional()
    .describe("Ignore cache"),

  context_id: z.string().optional()
    .describe("Context ID from previous response for pagination or conversation continuation"),

  resume: z.boolean().optional()
    .describe("Continue conversation with history injection (requires context_id)"),

  limit: z.number().min(1000).max(100000).optional()
    .describe("Max chars/chunk (default: 90000)"),

  offset: z.number().min(0).optional()
    .describe("Pagination offset"),

  cursor: z.string().optional()
    .describe("Pagination cursor"),

  verbose: z.boolean().optional()
    .describe("Detailed output")
});

/**
 * Common argument space: Filesystem-based analysis
 */
export const FILESYSTEM_ARGUMENT_SPACE: ArgumentSpace = {
  id: 'filesystem',
  name: 'Filesystem Analysis',
  base: BASE_ARGUMENTS,
  domain: z.object({
    targetPath: z.string().describe("Path to analyze")
  }),
  computed: (args) => ({
    workingDirectory: args.targetPath
  })
};

/**
 * Common argument space: Text-based input
 */
export const TEXT_INPUT_ARGUMENT_SPACE: ArgumentSpace = {
  id: 'text_input',
  name: 'Text Input',
  base: BASE_ARGUMENTS,
  domain: z.object({
    content: z.string().describe("Text to analyze"),
    targetPath: z.string().describe("Working dir (default: '.')")
  }),
  computed: (args) => ({
    workingDirectory: args.targetPath || '.'
  })
};

/**
 * Argument space: Filesystem with depth control
 */
export const FILESYSTEM_WITH_DEPTH: ArgumentSpace = {
  id: 'filesystem_depth',
  name: 'Filesystem with Depth Control',
  base: BASE_ARGUMENTS,
  domain: z.object({
    targetPath: z.string().describe("Path to analyze"),
    depth: z.number().optional().describe("Max depth (default: 3)")
  }),
  computed: (args) => ({
    workingDirectory: args.targetPath,
    analysisDepth: args.depth || 3
  })
};

/**
 * Argument space: Package manifest analysis
 */
export const PACKAGE_MANIFEST_SPACE: ArgumentSpace = {
  id: 'package_manifest',
  name: 'Package Manifest',
  base: BASE_ARGUMENTS,
  domain: z.object({
    targetPath: z.string().describe("Package file path (package.json, etc.)"),
    includeDevDeps: z.boolean().optional().describe("Include dev dependencies (default: true)")
  }),
  computed: (args) => ({
    workingDirectory: require('path').dirname(args.targetPath),
    analyzeDevDependencies: args.includeDevDeps !== false
  })
};

/**
 * Argument space: Git repository analysis
 */
export const GIT_REPOSITORY_SPACE: ArgumentSpace = {
  id: 'git_repository',
  name: 'Git Repository',
  base: BASE_ARGUMENTS,
  domain: z.object({
    targetPath: z.string().describe("Repo path"),
    commitRange: z.string().optional().describe("Commit range (default: last 20)")
  }),
  computed: (args) => ({
    workingDirectory: args.targetPath,
    gitRange: args.commitRange || 'HEAD~20..HEAD'
  })
};

/**
 * Argument space: Test suite analysis
 */
export const TEST_SUITE_SPACE: ArgumentSpace = {
  id: 'test_suite',
  name: 'Test Suite',
  base: BASE_ARGUMENTS,
  domain: z.object({
    targetPath: z.string().describe("Test dir or config"),
    runCoverage: z.boolean().optional().describe("Run coverage (default: true)")
  }),
  computed: (args) => ({
    workingDirectory: args.targetPath,
    executeCoverage: args.runCoverage !== false
  })
};

/**
 * Helper to merge multiple argument spaces
 */
export function mergeArgumentSpaces(...spaces: ArgumentSpace[]): ArgumentSpace {
  const merged: any = {
    id: spaces.map(s => s.id).join('_'),
    name: spaces.map(s => s.name).join(' + '),
    base: BASE_ARGUMENTS,
    domain: z.object({})
  };

  // Merge domain schemas
  for (const space of spaces) {
    merged.domain = merged.domain.merge(space.domain);
  }

  // Combine computed functions
  merged.computed = (args: any) => {
    let result = {};
    for (const space of spaces) {
      if (space.computed) {
        result = { ...result, ...space.computed(args) };
      }
    }
    return result;
  };

  return merged;
}

/**
 * Helper to infer cache key fields from an argument space
 *
 * NOTE: Excludes pagination/continuation fields (context_id, resume, offset, limit, cursor, force_refresh)
 * as these don't affect the actual analysis content.
 */
export function inferCacheKeys(space: ArgumentSpace): string[] {
  const keys: string[] = [];

  // Always include these base fields if present (excludes pagination/continuation params)
  const baseKeys = ['context', 'models', 'preferredCLI'];
  keys.push(...baseKeys);

  // Add all domain-specific fields
  const domainShape = space.domain.shape;
  keys.push(...Object.keys(domainShape));

  return keys;
}

/**
 * Helper to infer the primary argument field
 */
export function inferPrimaryArg(space: ArgumentSpace): string {
  const domainKeys = Object.keys(space.domain.shape);

  // Prefer these field names in order
  const preferred = ['targetPath', 'content', 'idea', 'system', 'architecture', 'research', 'product', 'infrastructure'];

  for (const key of preferred) {
    if (domainKeys.includes(key)) {
      return key;
    }
  }

  // Fallback to first domain key
  return domainKeys[0] || 'targetPath';
}
