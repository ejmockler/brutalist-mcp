import type { StructuredLogger } from '../logger.js';
import type { CLIAgentOptions } from '../cli-agents.js';
import type { ModelResolver } from '../model-resolver.js';
import type { CLIProvider, CLIBuilderConfig, CLIName, DecodeResult } from './index.js';
export declare class ClaudeAdapter implements CLIProvider {
    readonly name: CLIName;
    getConfig(): CLIBuilderConfig;
    buildCommand(userPrompt: string, systemPrompt: string, options: CLIAgentOptions, modelResolver: ModelResolver, secureEnv: Record<string, string>): Promise<{
        command: string;
        args: string[];
        input: string;
        env: Record<string, string>;
        tempMcpConfigPath?: string;
        model?: string;
    }>;
    /**
     * Decode Claude's stream-json NDJSON output into plain text.
     * Extracts text content blocks from all 'assistant' events across all turns.
     * Skips system events, user events (tool results with raw file contents), and
     * tool_use content blocks within assistant events.
     * Falls back to 'result' event if no assistant text was captured.
     */
    decodeOutput(rawOutput: string, args: string[], log?: StructuredLogger): string;
    decode(stdout: string, _stderr: string, args: string[], log?: StructuredLogger): DecodeResult;
    /**
     * Structured decode of stream-json output.
     *
     * Refusal classification is keyed on `result.subtype` / `is_error` —
     * the binary's own protocol-level signal. Quota classification looks
     * at anchored Anthropic markers ONLY in the error-envelope `result`
     * field (already scoped to a known-error pathway), never in the
     * accumulated assistant text.
     */
    private decodeStream;
}
//# sourceMappingURL=claude-adapter.d.ts.map