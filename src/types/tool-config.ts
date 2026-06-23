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
  clis: z.array(z.enum(["codex", "claude", "agy"])).min(0).max(3).optional().describe("Subset of native critics to run. [] = run ONLY the named clients[] (no default critics); omit to run all available."),
  verbose: z.boolean().optional().describe("Include detailed execution information in output (default: false)"),

  // Model selection — Claude honors overrides; Codex normally uses its own CLI
  // config/default so stale tool-call tags do not override newer local Codex
  // configuration. agy has no --model flag at runtime (Flash-pinned in
  // --print mode); the field is accepted but ignored.
  models: z.object({
    claude: z.string().optional().describe("Any Claude model (e.g. opus, sonnet, haiku, or full ID). Omit for CLI default."),
    codex: z.string().optional().describe("Codex override. Ignored unless BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE=true; omit for Codex CLI configured/default model."),
    agy: z.string().optional().describe("Agy model label. Brutalist writes this to ~/.gemini/antigravity-cli/settings.json under flock(2) before each agy invocation and restores the prior value after. Supported labels: \"Gemini 3.5 Flash (High|Medium)\" (always available), \"Gemini 3.1 Pro (High|Low)\", \"Claude Sonnet 4.6 (Thinking)\", \"Claude Opus 4.6 (Thinking)\", \"GPT-OSS 120B (Medium)\" (Pro/Claude/GPT-OSS tiers require Antigravity entitlement). Invalid labels silently fall back to Flash Medium.")
  }).optional().describe("Per-CLI model override. Claude honors overrides. Codex uses the Codex CLI configured/default model unless BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE=true. Agy field reserved (no runtime --model flag). Omit to use each CLI's configured default."),
  clients: z.array(z.object({
    id: z.string().min(1).max(80).describe("Stable display id for this CLI client, e.g. claude-native or glm."),
    provider: z.enum(["claude", "codex", "agy"]).default("claude").describe("Underlying CLI provider."),
    model: z.string().optional().describe("Per-client model override."),
    smallFastModel: z.string().optional().describe("Claude Code small/fast model override for ANTHROPIC_SMALL_FAST_MODEL. Defaults to `model` for routed clients so a gateway never sees Claude's built-in haiku name."),
    baseUrl: z.string().url().refine(
      (u) => { try { const p = new URL(u).protocol; return p === 'https:' || p === 'http:'; } catch { return false; } },
      { message: "baseUrl must use http(s) — the prompt, diff, and token are sent there." },
    ).optional().describe("Claude-compatible endpoint base URL for ANTHROPIC_BASE_URL (http(s) only). Presence marks the client 'routed': isolated from native credentials and hardened (no web egress/MCP) by default."),
    authToken: z.string().optional().describe("Bearer token for ANTHROPIC_AUTH_TOKEN. Prefer authTokenEnv for shared configs."),
    authTokenEnv: z.string().optional().describe("Environment variable name containing the bearer token."),
    configDir: z.string().optional().describe("Per-client CLAUDE_CONFIG_DIR for Claude Code state isolation. Defaults to ~/.brutalist/claude-clients/<id> for routed clients."),
    env: z.record(z.string()).optional().describe("Additional per-client environment variables (applied last; override resolved values)."),
    includeProcessAuth: z.boolean().optional().describe("Routed clients are isolated by default (no native Claude credentials). Set true to ALSO inherit the process ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN into this client; set false to force isolation on an otherwise-native client."),
    containment: z.enum(["hardened", "standard"]).optional().describe("Tool/sandbox policy. 'hardened' (DEFAULT for any routed/custom-endpoint client) additionally denies WebFetch, WebSearch, and all MCP servers. 'standard' restores the native tool surface — only for an endpoint you fully trust."),
    workingDirectory: z.string().optional(),
    timeout: z.number().int().positive().optional(),
    mcpServers: z.array(z.string()).optional()
  }).superRefine((c, ctx) => {
    // C2: custom-endpoint routing is claude-only. codex/agy adapters ignore
    // these fields entirely, so accepting them would silently no-op.
    if (c.provider && c.provider !== "claude") {
      for (const f of ["model", "smallFastModel", "baseUrl", "authToken", "authTokenEnv", "configDir", "env", "includeProcessAuth", "containment"] as const) {
        if ((c as Record<string, unknown>)[f] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `'${f}' is only valid for provider 'claude'; provider '${c.provider}' ignores custom-endpoint routing.`,
            path: [f],
          });
        }
      }
    }
  })).max(16).optional().describe("Named CLI clients to run, ADDITIVE to the native critics (use clis:[] to run ONLY these). Allows multiple isolated Claude Code clients (up to 16), including custom Anthropic-compatible endpoints, in one roast."),

  // Pagination and conversation continuation
  offset: z.number().min(0).optional().describe("Pagination offset (default: 0)"),
  limit: z.number().min(1000).max(100000).optional().describe("Max chars/chunk (default: 90000)"),
  cursor: z.string().optional().describe("Pagination cursor"),
  context_id: z.string().optional().describe("Context ID from previous response for cached pagination or conversation continuation"),
  resume: z.boolean().optional().describe("Continue conversation with a new prompt and history injection; omit for pagination/page reads"),
  force_refresh: z.boolean().optional().describe("Ignore cache")
};
