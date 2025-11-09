/**
 * Generated Tool Definitions
 *
 * This file demonstrates the new domain-driven architecture.
 * The same 11 tools from tool-definitions.ts, but generated from composable abstractions.
 */

import { BrutalistToolGenerator } from './generators/tool-generator.js';
import { DOMAINS } from './registry/domains.js';
import { PERSONAS } from './registry/personas.js';
import { ARGUMENT_SPACES } from './registry/argument-spaces.js';
import { ExecutionStrategies } from './domains/execution-strategy.js';
import { ToolConfig } from './types/tool-config.js';

// Initialize the generator
const generator = new BrutalistToolGenerator();

// Use the brutal critic persona for all tools (matching original behavior)
const brutalCritic = PERSONAS.BRUTAL_CRITIC;

// Use parallel critique strategy for all tools (matching original behavior)
const parallelStrategy = ExecutionStrategies.PARALLEL_CRITIQUE;

/**
 * Generate all 11 tools using the domain-driven approach
 */
export const TOOL_CONFIGS: ToolConfig[] = [
  // 1. Codebase analysis - filesystem based
  generator.generateTool(
    DOMAINS.CODEBASE,
    brutalCritic,
    ARGUMENT_SPACES.FILESYSTEM,
    parallelStrategy
  ),

  // 2. File structure - filesystem with depth
  generator.generateTool(
    DOMAINS.FILE_STRUCTURE,
    brutalCritic,
    ARGUMENT_SPACES.FILESYSTEM_DEPTH,
    parallelStrategy
  ),

  // 3. Dependencies - package manifest
  generator.generateTool(
    DOMAINS.DEPENDENCIES,
    brutalCritic,
    ARGUMENT_SPACES.PACKAGE_MANIFEST,
    parallelStrategy
  ),

  // 4. Git history - git repository
  generator.generateTool(
    DOMAINS.GIT_HISTORY,
    brutalCritic,
    ARGUMENT_SPACES.GIT_REPOSITORY,
    parallelStrategy
  ),

  // 5. Test coverage - test suite
  generator.generateTool(
    DOMAINS.TEST_COVERAGE,
    brutalCritic,
    ARGUMENT_SPACES.TEST_SUITE,
    parallelStrategy
  ),

  // 6. Idea validation - extended text input
  generator.generateTool(
    DOMAINS.IDEA,
    brutalCritic,
    ARGUMENT_SPACES.EXTENDED_TEXT_INPUT,
    parallelStrategy
  ),

  // 7. Architecture review - architecture specific
  generator.generateTool(
    DOMAINS.ARCHITECTURE,
    brutalCritic,
    ARGUMENT_SPACES.ARCHITECTURE_SPECIFIC,
    parallelStrategy
  ),

  // 8. Research methodology - research specific
  generator.generateTool(
    DOMAINS.RESEARCH,
    brutalCritic,
    ARGUMENT_SPACES.RESEARCH_SPECIFIC,
    parallelStrategy
  ),

  // 9. Security analysis - security specific
  generator.generateTool(
    DOMAINS.SECURITY,
    brutalCritic,
    ARGUMENT_SPACES.SECURITY_SPECIFIC,
    parallelStrategy
  ),

  // 10. Product review - product specific
  generator.generateTool(
    DOMAINS.PRODUCT,
    brutalCritic,
    ARGUMENT_SPACES.PRODUCT_SPECIFIC,
    parallelStrategy
  ),

  // 11. Infrastructure review - infrastructure specific
  generator.generateTool(
    DOMAINS.INFRASTRUCTURE,
    brutalCritic,
    ARGUMENT_SPACES.INFRASTRUCTURE_SPECIFIC,
    parallelStrategy
  )
];

/**
 * Example: Generate additional tool variations
 *
 * This is the power of the new architecture - trivial to add new tools.
 */

// Want a constructive version? Just change the persona:
export const CONSTRUCTIVE_TOOLS: ToolConfig[] = [
  generator.generateTool(
    DOMAINS.SECURITY,
    PERSONAS.CONSTRUCTIVE_CONSULTANT,  // Different persona!
    ARGUMENT_SPACES.SECURITY_SPECIFIC,
    parallelStrategy
  )
  // This creates: roast_security with constructive tone instead of brutal
];

// Want a debate-based analysis? Just change the strategy:
export const DEBATE_TOOLS: ToolConfig[] = [
  generator.generateTool(
    DOMAINS.ARCHITECTURE,
    brutalCritic,
    ARGUMENT_SPACES.ARCHITECTURE_SPECIFIC,
    ExecutionStrategies.ADVERSARIAL_DEBATE  // Different strategy!
  )
  // This creates: roast_architecture with agents debating instead of parallel
];

// Want composite analysis? Compose domains:
export const COMPOSITE_TOOLS: ToolConfig[] = [
  generator.composeDomainsToTool(
    [DOMAINS.SECURITY, DOMAINS.ARCHITECTURE],  // Multiple domains!
    brutalCritic,
    ARGUMENT_SPACES.ARCHITECTURE_SPECIFIC,
    parallelStrategy
  )
  // This creates: roast_security_and_architecture
];

/**
 * Compare: Adding a new tool
 *
 * OLD WAY (tool-definitions.ts):
 * - 30 lines of config
 * - Copy-paste system prompt
 * - Manually define schema
 * - Write context builder
 * - 15-30 minutes of work
 *
 * NEW WAY:
 * - Define domain (5 lines) ONCE
 * - Call generator.generateTool() (1 line)
 * - Done. 2 minutes of work.
 * - Can generate N×M×K tools from N domains, M personas, K strategies
 */

/**
 * Example: Adding a new "roast_database_design" tool
 */
/*
// 1. Define the domain (ONCE)
const DATABASE_DESIGN: CritiqueDomain = {
  id: 'database_design',
  name: 'Database Design',
  description: 'Database schema and query optimization review',
  capabilities: ['static_analysis', 'performance_profiling'],
  artifactTypes: ['code', 'text_description']
};

// 2. Generate the tool (DONE)
const databaseTool = generator.generateTool(
  DATABASE_DESIGN,
  brutalCritic,
  ARGUMENT_SPACES.TEXT_INPUT,
  parallelStrategy
);

// That's it. roast_database_design is ready to use.
*/
