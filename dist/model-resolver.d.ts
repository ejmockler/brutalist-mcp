type CLIName = 'claude' | 'codex' | 'agy';
export declare class ModelResolver {
    private cliModels;
    private initialized;
    private initTime;
    private readonly CACHE_TTL;
    initialize(): Promise<void>;
    /** Re-read configs if cache has expired. */
    refreshIfStale(): Promise<void>;
    /**
     * Resolve a requested model for a given CLI.
     * - Returns undefined when no model was requested (let CLI use its own default).
     * - For codex, follows the migration chain to the current model name.
     */
    resolveModel(cli: CLIName, requestedModel?: string): string | undefined;
    /** Return discovered default models for each CLI. */
    getDefaults(): Record<CLIName, string | undefined>;
    /** Build a dynamic schema description for the models parameter. */
    getModelsDescription(): string;
    /** Build roster text for cli_agent_roster. */
    getRosterModelInfo(): string;
    private loadCodexConfig;
    private loadClaudeConfig;
    /**
     * Lightweight TOML parser for codex config.
     * Extracts top-level `model = "..."` and `[notice.model_migrations]` entries.
     * Not a general TOML parser — handles only the structure codex actually writes.
     */
    private parseCodexToml;
    /** Follow codex migration chain to resolve deprecated model names. */
    private followMigrationChain;
}
export {};
//# sourceMappingURL=model-resolver.d.ts.map