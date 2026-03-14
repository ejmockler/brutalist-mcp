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

  // Model selection — pass any model the CLI supports; omit to use CLI's configured default.
  // Deprecated codex model names are auto-resolved through the migration chain.
  models: z.object({
    claude: z.string().optional().describe("Any Claude model (e.g. opus, sonnet, haiku, or full ID). Omit for CLI default."),
    codex: z.string().optional().describe("Any Codex model. Deprecated names auto-resolve via migration chain. Omit for CLI default."),
    gemini: z.string().optional().describe("Any Gemini model. Omit for CLI default.")
  }).optional().describe("Per-CLI model override. Omit to use each CLI's configured default."),

  // Pagination and conversation continuation
  offset: z.number().min(0).optional().describe("Pagination offset (default: 0)"),
  limit: z.number().min(1000).max(100000).optional().describe("Max chars/chunk (default: 90000)"),
  cursor: z.string().optional().describe("Pagination cursor"),
  context_id: z.string().optional().describe("Context ID from previous response to resume the conversation"),
  resume: z.boolean().optional().describe("Continue conversation with history injection (requires context_id)"),
  force_refresh: z.boolean().optional().describe("Ignore cache")
};