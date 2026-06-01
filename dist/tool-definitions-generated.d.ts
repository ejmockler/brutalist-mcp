/**
 * Generated Tool Definitions
 *
 * This file demonstrates the new domain-driven architecture.
 * The same 11 tools from tool-definitions.ts, but generated from composable abstractions.
 */
import { ToolConfig } from './types/tool-config.js';
/**
 * Generate all 11 tools using the domain-driven approach
 */
export declare const TOOL_CONFIGS: ToolConfig[];
/**
 * Example: Generate additional tool variations
 *
 * This is the power of the new architecture - trivial to add new tools.
 */
export declare const CONSTRUCTIVE_TOOLS: ToolConfig[];
export declare const DEBATE_TOOLS: ToolConfig[];
export declare const COMPOSITE_TOOLS: ToolConfig[];
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
//# sourceMappingURL=tool-definitions-generated.d.ts.map