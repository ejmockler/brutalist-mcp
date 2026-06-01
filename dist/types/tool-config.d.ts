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
export declare const BASE_ROAST_SCHEMA: {
    context: z.ZodOptional<z.ZodString>;
    workingDirectory: z.ZodOptional<z.ZodString>;
    clis: z.ZodOptional<z.ZodArray<z.ZodEnum<["codex", "claude", "agy"]>, "many">>;
    verbose: z.ZodOptional<z.ZodBoolean>;
    models: z.ZodOptional<z.ZodObject<{
        claude: z.ZodOptional<z.ZodString>;
        codex: z.ZodOptional<z.ZodString>;
        agy: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        claude?: string | undefined;
        codex?: string | undefined;
        agy?: string | undefined;
    }, {
        claude?: string | undefined;
        codex?: string | undefined;
        agy?: string | undefined;
    }>>;
    offset: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
    context_id: z.ZodOptional<z.ZodString>;
    resume: z.ZodOptional<z.ZodBoolean>;
    force_refresh: z.ZodOptional<z.ZodBoolean>;
};
//# sourceMappingURL=tool-config.d.ts.map