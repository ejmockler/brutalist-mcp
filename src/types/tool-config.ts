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
  
  /** System prompt for the brutal AI critics */
  systemPrompt: string;
  
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
  preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
  verbose: z.boolean().optional().describe("Include detailed execution information in output (default: false)"),
  
  // Model selection
  models: z.object({
    claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
    codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
    gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
  }).optional().describe("Specific models to use for each CLI agent"),
  
  // Pagination parameters for large responses
  offset: z.number().min(0).optional().describe("Character offset for response pagination (default: 0)"),
  limit: z.number().min(1000).max(100000).optional().describe("Maximum characters per response chunk (default: 90000, max: 100000)"),
  cursor: z.string().optional().describe("Pagination cursor from previous response (alternative to offset/limit)"),
  analysis_id: z.string().optional().describe("Analysis ID from previous response to retrieve cached result"),
  force_refresh: z.boolean().optional().describe("Force re-analysis even if cached result exists (default: false)")
};