import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

type CLIName = 'claude' | 'codex' | 'agy';

interface CLIModelInfo {
  defaultModel?: string;
  migrations: Map<string, string>;
}

/**
 * ModelResolver — Runtime model discovery and migration resolution.
 *
 * Instead of hardcoding model lists that rot, this reads each CLI's
 * own config at startup to discover:
 *   - The user's configured default model
 *   - Codex's model migration table (old → new mappings)
 *
 * Any model string is accepted and passed through to the CLI.
 * For codex, deprecated model names are resolved through the
 * migration chain before invocation.
 *
 * agy has no discoverable config — `agy --print` is hard-pinned to
 * "Gemini 3.5 Flash (Medium)". The cliModels.agy slot exists for shape
 * conformance; defaultModel is constant.
 */
const AGY_FIXED_MODEL = 'Gemini 3.5 Flash (Medium)';

export class ModelResolver {
  private cliModels: Record<CLIName, CLIModelInfo> = {
    claude: { migrations: new Map() },
    codex: { migrations: new Map() },
    agy: { defaultModel: AGY_FIXED_MODEL, migrations: new Map() },
  };

  private initialized = false;
  private initTime = 0;
  private readonly CACHE_TTL = 300_000; // 5 minutes

  async initialize(): Promise<void> {
    const results = await Promise.allSettled([
      this.loadCodexConfig(),
      this.loadClaudeConfig(),
    ]);

    for (const r of results) {
      if (r.status === 'rejected') {
        logger.debug('ModelResolver: config load failed', r.reason);
      }
    }

    this.initialized = true;
    this.initTime = Date.now();
    logger.info('🔍 ModelResolver initialized', {
      claude: this.cliModels.claude.defaultModel || '(cli default)',
      codex: this.cliModels.codex.defaultModel || '(cli default)',
      agy: this.cliModels.agy.defaultModel,
      codexMigrations: this.cliModels.codex.migrations.size,
    });
  }

  /** Re-read configs if cache has expired. */
  async refreshIfStale(): Promise<void> {
    if (this.initialized && Date.now() - this.initTime < this.CACHE_TTL) return;
    try {
      await this.initialize();
    } catch (err) {
      logger.warn('ModelResolver: refresh failed, using stale data', err);
    }
  }

  /**
   * Resolve a requested model for a given CLI.
   * - Returns undefined when no model was requested (let CLI use its own default).
   * - For codex, follows the migration chain to the current model name.
   */
  resolveModel(cli: CLIName, requestedModel?: string): string | undefined {
    if (!requestedModel) return undefined;
    if (cli === 'codex') return this.followMigrationChain(requestedModel);
    return requestedModel;
  }

  /** Return discovered default models for each CLI. */
  getDefaults(): Record<CLIName, string | undefined> {
    return {
      claude: this.cliModels.claude.defaultModel,
      codex: this.cliModels.codex.defaultModel,
      agy: this.cliModels.agy.defaultModel,
    };
  }

  /** Build a dynamic schema description for the models parameter. */
  getModelsDescription(): string {
    const parts: string[] = [];
    for (const cli of ['claude', 'codex', 'agy'] as CLIName[]) {
      const def = this.cliModels[cli].defaultModel;
      parts.push(`${cli}: ${def ? `default ${def}` : 'uses CLI default'}`);
    }
    return `Per-CLI model override. Claude honors overrides. Codex uses the Codex CLI configured/default model unless BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE=true. Agy is hard-pinned to ${AGY_FIXED_MODEL} (no --model flag exists at runtime; field accepted but ignored). Omit to use each CLI's configured default. Current defaults — ${parts.join(', ')}`;
  }

  /** Build roster text for cli_agent_roster. */
  getRosterModelInfo(): string {
    const defaults = this.getDefaults();
    const migrations = this.cliModels.codex.migrations;

    let info = '## Model Configuration (auto-discovered)\n';
    info += `**Claude:** ${defaults.claude || '(CLI default)'}\n`;
    info += `**Codex:** ${defaults.codex || '(CLI default)'}`;
    if (migrations.size > 0) {
      info += ` — ${migrations.size} migration(s) tracked`;
    }
    info += '\n';
    info += `**Agy:** ${defaults.agy} (hard-pinned, no --model flag)\n\n`;
    info += '*Claude model overrides are passed through. Codex uses the Codex CLI configured/default model unless `BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE=true` is set; deprecated codex names are auto-resolved only when that opt-in is enabled. Agy is fixed to Flash Medium until Google ships agy issue #35.*\n';
    return info;
  }

  // ── Config parsers ──────────────────────────────────────────────

  private async loadCodexConfig(): Promise<void> {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      this.cliModels.codex = this.parseCodexToml(raw);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        logger.debug(`ModelResolver: codex config not found at ${configPath}`);
      } else {
        logger.warn(`ModelResolver: failed to read codex config: ${err?.message}`);
      }
    }
  }

  private async loadClaudeConfig(): Promise<void> {
    // Honor CLAUDE_CONFIG_DIR so default-model discovery reads the same
    // settings.json the claude binary reads (A4). Best-effort metadata
    // only — resolveModel('claude', undefined) still returns undefined for
    // the native critic, so this never gates argv routing.
    const baseDir = process.env.CLAUDE_CONFIG_DIR?.trim()
      ? process.env.CLAUDE_CONFIG_DIR.trim()
      : path.join(os.homedir(), '.claude');
    const configPath = path.join(baseDir, 'settings.json');
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const settings = JSON.parse(raw);
      if (typeof settings.model === 'string') {
        this.cliModels.claude.defaultModel = settings.model;
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        logger.debug(`ModelResolver: claude config not found at ${configPath}`);
      } else {
        logger.warn(`ModelResolver: failed to read claude config: ${err?.message}`);
      }
    }
  }

  /**
   * Lightweight TOML parser for codex config.
   * Extracts top-level `model = "..."` and `[notice.model_migrations]` entries.
   * Not a general TOML parser — handles only the structure codex actually writes.
   */
  private parseCodexToml(raw: string): CLIModelInfo {
    const info: CLIModelInfo = { migrations: new Map() };
    let inMigrations = false;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();

      // Section headers
      if (trimmed.startsWith('[')) {
        inMigrations = trimmed === '[notice.model_migrations]';

        // Any other section header ends the migrations block
        if (!inMigrations && trimmed.startsWith('[')) continue;
      }

      // Top-level model = "..."
      if (!inMigrations) {
        const topModel = trimmed.match(/^model\s*=\s*"([^"]+)"/);
        if (topModel) {
          info.defaultModel = topModel[1];
        }
        continue;
      }

      // Migration entries: "old-model" = "new-model"
      const migration = trimmed.match(/^"([^"]+)"\s*=\s*"([^"]+)"/);
      if (migration) {
        info.migrations.set(migration[1], migration[2]);
      }
    }

    return info;
  }

  /** Follow codex migration chain to resolve deprecated model names. */
  private followMigrationChain(model: string): string {
    const migrations = this.cliModels.codex.migrations;
    let current = model;
    const seen = new Set<string>();

    while (migrations.has(current) && !seen.has(current)) {
      seen.add(current);
      const next = migrations.get(current)!;
      logger.debug(`ModelResolver: migrating codex model ${current} → ${next}`);
      current = next;
    }

    if (current !== model) {
      logger.info(`🔄 Resolved deprecated codex model: ${model} → ${current}`);
    }
    return current;
  }
}
