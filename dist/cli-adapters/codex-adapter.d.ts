import type { StructuredLogger } from '../logger.js';
import type { CLIAgentOptions } from '../cli-agents.js';
import type { ModelResolver } from '../model-resolver.js';
import type { CLIProvider, CLIBuilderConfig, CLIName, DecodeResult } from './index.js';
export declare class CodexAdapter implements CLIProvider {
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
     * Extract only the agent messages from Codex JSON output.
     * Filters for item.type === 'agent_message', skipping reasoning,
     * command_execution, and error events.
     */
    decodeOutput(rawOutput: string, args: string[], log?: StructuredLogger): string;
    decode(stdout: string, stderr: string, args: string[], log?: StructuredLogger): DecodeResult;
    /**
     * Structured decode of Codex --json output.
     *
     * Codex emits NDJSON `item.completed` events. Agent text comes in
     * `item.type === 'agent_message'`. Codex error/quota state is NOT in
     * the JSON event stream — per the inline comment in extractCodexAgentMessage
     * ("error: will be in stderr"), it lands on stderr. So:
     *   - assistant text present → ok
     *   - no text + stderr matches anchored Codex quota markers → refused
     *   - no text + no markers → error (empty)
     *
     * Anchored markers operate only on stderr (the CLI's own error
     * channel), never on assistant prose. Aligned with the discipline
     * applied to Claude's error envelope.
     */
    private decodeStream;
    private extractCodexAgentMessage;
}
//# sourceMappingURL=codex-adapter.d.ts.map