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
    validate?: (args: any) => {
        valid: boolean;
        errors?: string[];
    };
}
/**
 * Standard base arguments shared by all tools
 */
export declare const BASE_ARGUMENTS: z.ZodObject<{
    context: z.ZodOptional<z.ZodString>;
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
    clis: z.ZodOptional<z.ZodArray<z.ZodEnum<["codex", "claude", "agy"]>, "many">>;
    force_refresh: z.ZodOptional<z.ZodBoolean>;
    context_id: z.ZodOptional<z.ZodString>;
    resume: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
    verbose: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    context?: string | undefined;
    models?: {
        claude?: string | undefined;
        codex?: string | undefined;
        agy?: string | undefined;
    } | undefined;
    clis?: ("claude" | "codex" | "agy")[] | undefined;
    force_refresh?: boolean | undefined;
    context_id?: string | undefined;
    resume?: boolean | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    cursor?: string | undefined;
    verbose?: boolean | undefined;
}, {
    context?: string | undefined;
    models?: {
        claude?: string | undefined;
        codex?: string | undefined;
        agy?: string | undefined;
    } | undefined;
    clis?: ("claude" | "codex" | "agy")[] | undefined;
    force_refresh?: boolean | undefined;
    context_id?: string | undefined;
    resume?: boolean | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    cursor?: string | undefined;
    verbose?: boolean | undefined;
}>;
/**
 * Common argument space: Filesystem-based analysis
 */
export declare const FILESYSTEM_ARGUMENT_SPACE: ArgumentSpace;
/**
 * Common argument space: Text-based input
 */
export declare const TEXT_INPUT_ARGUMENT_SPACE: ArgumentSpace;
/**
 * Argument space: Filesystem with depth control
 */
export declare const FILESYSTEM_WITH_DEPTH: ArgumentSpace;
/**
 * Argument space: Package manifest analysis
 */
export declare const PACKAGE_MANIFEST_SPACE: ArgumentSpace;
/**
 * Argument space: Git repository analysis
 */
export declare const GIT_REPOSITORY_SPACE: ArgumentSpace;
/**
 * Argument space: Test suite analysis
 */
export declare const TEST_SUITE_SPACE: ArgumentSpace;
/**
 * Helper to merge multiple argument spaces
 */
export declare function mergeArgumentSpaces(...spaces: ArgumentSpace[]): ArgumentSpace;
/**
 * Helper to infer cache key fields from an argument space
 *
 * NOTE: Excludes pagination/continuation fields (context_id, resume, offset, limit, cursor, force_refresh)
 * as these don't affect the actual analysis content.
 */
export declare function inferCacheKeys(space: ArgumentSpace): string[];
/**
 * Helper to infer the primary argument field
 */
export declare function inferPrimaryArg(space: ArgumentSpace): string;
//# sourceMappingURL=argument-space.d.ts.map