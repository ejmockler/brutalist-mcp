import { z, ZodRawShape } from 'zod';
import { BrutalistPromptType } from '../cli-agents.js';

/**
 * Configuration for a brutalist roast tool
 */
export interface ToolConfig {
  /** Tool name (e.g., "roast_codebase") */
  name: string;
  
  /** Tool description shown to users */
  description: string;
  
  /** Analysis type for CLI orchestrator */
  analysisType: BrutalistPromptType;

  /** @deprecated System prompts now live in system-prompts.ts and are retrieved at execution time */
  systemPrompt?: string;
  
  /** Tool-specific schema extensions beyond base parameters */
  schemaExtensions: ZodRawShape;
  
  /** Fields to include in cache key generation */
  cacheKeyFields: string[];
  
  /** Optional custom context builder */
  contextBuilder?: (args: any) => string;
  
  /** Primary argument field name (targetPath, idea, etc.) */
  primaryArgField: string;
}

/**
 * Shared base schema for all roast tools
 */
export const BASE_ROAST_SCHEMA = {
  // Context and execution parameters
  context: z.string().optional().describe("Additional context about the analysis"),
  workingDirectory: z.string().optional().describe("Working directory to execute from"),
  clis: z.array(z.enum(["claude", "codex", "gemini"])).min(1).max(3).optional().describe("CLI agents to use (default: all available). Example: ['claude', 'gemini']"),
  verbose: z.boolean().optional().describe("Include detailed execution information in output (default: false)"),

  // Model selection - defaults prioritize frontier models with high capacity
  models: z.object({
    claude: z.string().optional().describe("Claude model: opus (recommended), sonnet, haiku, or full name like claude-opus-4-1-20250805. Default: user's configured model"),
    codex: z.string().optional().describe("Codex model: gpt-5.1-codex-max (recommended), gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5-codex, gpt-5, o4-mini. Default: gpt-5.1-codex-max"),
    gemini: z.string().optional().describe("Gemini model: gemini-3-pro-preview (recommended), gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite. Default: gemini-3-pro-preview")
  }).optional().describe("Specific models to use for each CLI agent - defaults use frontier models with highest capacity"),

  // Pagination and conversation continuation
  offset: z.number().min(0).optional().describe("Pagination offset (default: 0)"),
  limit: z.number().min(1000).max(100000).optional().describe("Max chars/chunk (default: 90000)"),
  cursor: z.string().optional().describe("Pagination cursor"),
  context_id: z.string().optional().describe("Context ID from previous response to resume the conversation"),
  resume: z.boolean().optional().describe("Continue conversation with history injection (requires context_id)"),
  force_refresh: z.boolean().optional().describe("Ignore cache")
};