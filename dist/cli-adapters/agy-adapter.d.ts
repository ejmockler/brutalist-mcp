import type { StructuredLogger } from '../logger.js';
import type { CLIAgentOptions } from '../cli-agents.js';
import type { ModelResolver } from '../model-resolver.js';
import type { CLIProvider, CLIBuilderConfig, CLIName, DecodeResult } from './index.js';
export declare const AGY_BINARY: string;
export declare class AgyAdapter implements CLIProvider {
    readonly name: CLIName;
    getConfig(): CLIBuilderConfig;
    buildCommand(userPrompt: string, systemPrompt: string, options: CLIAgentOptions, _modelResolver: ModelResolver, secureEnv: Record<string, string>): Promise<{
        command: string;
        args: string[];
        input: string;
        env: Record<string, string>;
        tempMcpConfigPath?: string;
        model?: string;
    }>;
    /**
     * Decode raw agy stdout into a structured outcome.
     *
     * agy stdout in --print mode is clean text/Markdown with 0 ANSI
     * escape bytes (verified empirically). Refusals are baked into the
     * stdout stream with anchored prefixes — we match those without
     * grepping the full text for loose patterns (which would re-introduce
     * the prose-as-signal antipattern that commit 086a38f explicitly
     * removed for claude/codex).
     */
    decode(stdout: string, _stderr: string, _args: string[], log?: StructuredLogger): DecodeResult;
    decodeOutput(rawOutput: string, args: string[], log?: StructuredLogger): string;
}
//# sourceMappingURL=agy-adapter.d.ts.map