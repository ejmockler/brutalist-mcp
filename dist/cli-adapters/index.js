// Re-export shared utilities
export { parseNDJSON } from './shared.js';
// ── Provider Registry ──────────────────────────────────────────────────────
import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { AgyAdapter } from './agy-adapter.js';
const providers = {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    agy: new AgyAdapter(),
};
/**
 * Get a provider adapter by name.
 * Throws if the provider name is not recognized.
 */
export function getProvider(name) {
    const provider = providers[name];
    if (!provider) {
        throw new Error(`Unknown CLI provider: ${name}`);
    }
    return provider;
}
/**
 * Get all registered provider names.
 */
export function getProviderNames() {
    return Object.keys(providers);
}
//# sourceMappingURL=index.js.map