import { spawn, exec } from 'child_process';
import { promises as fs, realpathSync, readFileSync } from 'fs';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';
import type { StructuredLogger } from './logger.js';
import { CLIAgentResponse } from './types/brutalist.js';
import { ModelResolver } from './model-resolver.js';
import { cleanupTempConfig } from './mcp-registry.js';
import { getProvider, parseNDJSON } from './cli-adapters/index.js';
import type { CLIName } from './cli-adapters/index.js';
import { AGY_BINARY } from './cli-adapters/agy-adapter.js';
import type { MetricsRegistry } from './metrics/index.js';
import { CLI_SPAWN_LABELS, safeMetric } from './metrics/index.js';

function sanitizeModelNameForMessage(model?: string): string {
  if (!model) return 'requested model';
  const bounded = model.slice(0, 80);
  const sanitized = bounded.replace(/[^a-zA-Z0-9._:-]/g, '?');
  return sanitized || 'requested model';
}

function isCodexUnsupportedChatGPTModelError(error: ChildProcessError, requestedModel?: string): boolean {
  if (!requestedModel) return false;
  const combined = `${error.message || ''}\n${error.stdout || ''}\n${error.stderr || ''}`;
  return /model['"\\\s:A-Za-z0-9._-]*not supported when using Codex with a ChatGPT account/i.test(combined);
}

function isCodexUnsupportedModelResponse(response: CLIAgentResponse, requestedModel?: string): boolean {
  if (response.agent !== 'codex' || response.success || !requestedModel || !response.error) {
    return false;
  }
  return response.error.includes(`CODEX model "${sanitizeModelNameForMessage(requestedModel)}" is not supported`);
}

interface ChildProcessError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Sanitize a caller-supplied client id into a stable attribution key.
 *
 * CONTRACT — the CORE transform (trim → slice(0,80) → replace
 * /[^a-zA-Z0-9._:-]/g with '-') MUST stay byte-for-byte identical to
 * packages/github-action/src/index.ts's sanitizeClientId. The end-to-end
 * attribution depends on it: the action sanitizes the id into both
 * knownClientIds AND BRUTALIST_CLAUDE_CLIENTS[].id, the mcp-server (here)
 * re-sanitizes and emits it, and the orchestrator clamps the emitted id
 * against the known set. Any divergence in the CORE transform silently
 * breaks clientId attribution. The two implementations intentionally
 * differ ONLY in the empty-result fallback (mcp-server → 'client',
 * action → 'custom-claude'); a characterization test in BOTH packages
 * pins the shared transform table so drift breaks a test.
 */
export function sanitizeClientId(id: string): string {
  const bounded = id.trim().slice(0, 80);
  const sanitized = bounded.replace(/[^a-zA-Z0-9._:-]/g, '-');
  return sanitized || 'client';
}

/**
 * Make a value safe to embed in a BRUTALIST_CLI_* HTML-comment marker.
 * A literal `-->` (or a CR/LF) in `model`/`error` would close the comment
 * early and corrupt the marker stream the orchestrator brain parses. We
 * neutralize `-->` (the only ASCII close-comment sequence) and collapse
 * any newline/CR run to a single space. Otherwise lossless — normal text
 * is untouched.
 */
function sanitizeMarkerField(value: string): string {
  return value.replace(/-->/g, '--&gt;').replace(/[\r\n]+/g, ' ');
}

/**
 * Cap on custom Claude clients accepted from the BRUTALIST_CLAUDE_CLIENTS env
 * array — parity with the roast `clients[]` schema cap (tool-config.ts
 * `.max(16)`) and the GitHub Action's MAX_CUSTOM_CLAUDE_CLIENTS. Guards against
 * a runaway operator-supplied array spawning an unbounded number of processes.
 */
export const MAX_CLAUDE_CLIENTS = 16;

export function parseDefaultClientsFromEnv(log: StructuredLogger): CLIClientSpec[] {
  const raw = process.env.BRUTALIST_CLAUDE_CLIENTS;
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log.warn('Ignoring BRUTALIST_CLAUDE_CLIENTS because it is not a JSON array');
      return [];
    }
    const clients: CLIClientSpec[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as Partial<CLIClientSpec>;
      if (typeof candidate.id !== 'string' || !candidate.id.trim()) continue;
      const provider = candidate.provider ?? 'claude';
      if (!['claude', 'codex', 'agy'].includes(provider)) continue;
      // C2 (env path): custom-endpoint routing is claude-only. The Zod
      // schema fails-fast for the tool-arg path; here (raw operator JSON,
      // no user to return an error to) we warn-and-strip the offending
      // entry rather than silently honoring fields the adapter ignores.
      if (
        provider !== 'claude' &&
        ROUTING_FIELDS.some((f) => (candidate as Record<string, unknown>)[f] !== undefined)
      ) {
        log.warn(
          'Dropping non-claude BRUTALIST_CLAUDE_CLIENTS entry carrying claude-only routing fields',
          { id: candidate.id, provider },
        );
        continue;
      }
      clients.push({
        ...candidate,
        id: sanitizeClientId(candidate.id),
        provider,
      } as CLIClientSpec);
    }
    if (clients.length > MAX_CLAUDE_CLIENTS) {
      log.warn(
        `BRUTALIST_CLAUDE_CLIENTS has ${clients.length} entries; capping to ${MAX_CLAUDE_CLIENTS}.`,
      );
      return clients.slice(0, MAX_CLAUDE_CLIENTS);
    }
    return clients;
  } catch (error) {
    log.warn('Ignoring invalid BRUTALIST_CLAUDE_CLIENTS JSON', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// Custom-endpoint routing fields that are only meaningful for the claude
// provider (the claude binary is the only Anthropic-API gateway client).
// Used to fail-fast (schema) / warn-and-strip (env) for codex/agy clients.
const ROUTING_FIELDS = [
  'model',
  'smallFastModel',
  'baseUrl',
  'authToken',
  'authTokenEnv',
  'configDir',
  'env',
  'includeProcessAuth',
  'containment',
] as const;

/**
 * Routing classification for a Claude-provider client. A client is "routed"
 * — pointed at a custom Anthropic-compatible endpoint such as a GLM gateway
 * — when it carries ANY routing signal: a base URL (typed field or via
 * env.ANTHROPIC_BASE_URL), a bearer token, or an explicit opt-out of
 * process-auth inheritance. Routed clients are isolated-by-default (no
 * native credential inheritance) and hardened-by-default (no web egress /
 * MCP). Everything else is "native". One predicate gates BOTH auth
 * isolation and tool containment so a client can never be isolated-for-auth
 * but not-hardened-for-tools (or vice versa).
 */
export function classifyRouting(c?: CLIClientSpec): 'native' | 'routed' {
  if (!c) return 'native';
  if (
    c.baseUrl ||
    c.authToken ||
    c.authTokenEnv ||
    c.env?.ANTHROPIC_BASE_URL ||
    c.env?.ANTHROPIC_AUTH_TOKEN ||
    c.includeProcessAuth === false
  ) {
    return 'routed';
  }
  return 'native';
}

export function isRoutedClient(c?: CLIClientSpec): boolean {
  return classifyRouting(c) === 'routed';
}

/** Per-client isolated CLAUDE_CONFIG_DIR under the user's home. */
function defaultConfigDirFor(id: string): string {
  return path.join(os.homedir(), '.brutalist', 'claude-clients', sanitizeClientId(id));
}

function resolveClientAuthToken(
  c: CLIClientSpec,
  procEnv: NodeJS.ProcessEnv,
): string | undefined {
  if (c.authToken) return c.authToken;
  if (c.authTokenEnv) return procEnv[c.authTokenEnv];
  return undefined;
}

/**
 * Resolve a raw client spec into a normalized spec the claude adapter can
 * consume branchlessly. Stamps routingMode + the auth-inheritance,
 * small-fast-model, and config-dir decisions ONCE, so every consumer (the
 * adapter env overlay, the pre-flight probe, and config-dir provisioning)
 * shares a single source of truth. Non-claude providers pass through
 * untouched; the function is idempotent for them.
 */
export function normalizeClaudeClient(
  c: CLIClientSpec,
  procEnv: NodeJS.ProcessEnv,
  log: StructuredLogger,
): CLIClientSpec {
  if (c.provider !== 'claude') return c;
  if (classifyRouting(c) === 'native') {
    return { ...c, routingMode: 'native', inheritNativeAuth: true };
  }
  // Routed: isolated by default. Native auth only on explicit opt-in.
  const inheritNativeAuth = c.includeProcessAuth === true;
  const resolvedAuthToken = resolveClientAuthToken(c, procEnv);
  if (!resolvedAuthToken && !inheritNativeAuth) {
    log.warn(
      'Routed Claude client has no auth token (authToken/authTokenEnv unset, includeProcessAuth!==true)',
      { clientId: c.id },
    );
  }
  return {
    ...c,
    routingMode: 'routed',
    inheritNativeAuth,
    resolvedAuthToken,
    // A3: never fall through to Claude's built-in haiku small-fast model
    // name on a gateway that doesn't know it.
    resolvedSmallFastModel: c.smallFastModel ?? c.model,
    // A4: isolate state so concurrent claude processes never contend on
    // the shared ~/.claude dir.
    resolvedConfigDir: c.configDir ?? defaultConfigDirFor(c.id),
  };
}

/**
 * Pre-flight a routed Claude client's gateway: is the endpoint reachable
 * and does the token authenticate? A read-only GET to <baseUrl>/v1/models,
 * bounded by CLI_CHECK_TIMEOUT. Diff content is NEVER sent. Converts a
 * dead/401 gateway from a full per-critic-timeout silent failure into an
 * immediate attributed error (D1). Never throws into the panel. A non-
 * auth HTTP response (incl. 404 from a gateway lacking /v1/models) counts
 * as reachable so we don't false-fail a working endpoint.
 */
async function preflightRoutedClient(
  client: CLIClientSpec,
  log: StructuredLogger,
): Promise<{ ok: true } | { ok: false; reason: 'auth' | 'unreachable' | 'unknown'; detail: string }> {
  // Routed only via includeProcessAuth:false (no endpoint) — nothing to probe.
  if (!client.baseUrl) return { ok: true };
  // Feature-detect fetch + AbortSignal.timeout (Node 18+ / 17.3+). On an
  // older runtime, skip the probe rather than let a missing global be caught
  // below and masquerade as an 'unreachable' gateway (which would falsely
  // kill every routed client). The real spawn still runs.
  if (typeof fetch !== 'function' || typeof (AbortSignal as { timeout?: unknown })?.timeout !== 'function') {
    return { ok: true };
  }
  const token = client.resolvedAuthToken ?? resolveClientAuthToken(client, process.env);
  const url = `${client.baseUrl.replace(/\/+$/, '')}/v1/models`;
  try {
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['x-api-key'] = token;
    }
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(CLI_CHECK_TIMEOUT),
    });
    // Only treat 401/403 as a real auth failure when we actually PRESENTED a
    // token. A client inheriting native auth (includeProcessAuth, no typed
    // token) sends no header here, so a 401 just means "endpoint wants auth
    // we didn't probe with" — not a failure; the real spawn authenticates via
    // the inherited credential / CLAUDE_CONFIG_DIR.
    if (token && (res.status === 401 || res.status === 403)) {
      return { ok: false, reason: 'auth', detail: `gateway returned ${res.status}` };
    }
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.warn('Routed client pre-flight probe failed', { clientId: client.id, error: msg });
    return { ok: false, reason: 'unreachable', detail: msg };
  }
}

export type BrutalistPromptType =
  | 'code'
  | 'codebase'
  | 'architecture'
  | 'idea'
  | 'research'
  | 'data'
  | 'security'
  | 'product'
  | 'infrastructure'
  | 'debate'
  | 'dependencies'
  | 'fileStructure'
  | 'gitHistory'
  | 'testCoverage'
  | 'design'
  | 'legal';

// Configurable timeouts and limits
const DEFAULT_TIMEOUT = parseInt(process.env.BRUTALIST_TIMEOUT || '1800000', 10); // 30 minutes default
const CLI_CHECK_TIMEOUT = parseInt(process.env.BRUTALIST_CLI_CHECK_TIMEOUT || '5000', 10); // 5 seconds for CLI checks
const MAX_BUFFER_SIZE = parseInt(process.env.BRUTALIST_MAX_BUFFER || String(10 * 1024 * 1024), 10); // 10MB default
const MAX_CONCURRENT_CLIS = parseInt(process.env.BRUTALIST_MAX_CONCURRENT || '3', 10); // 3 concurrent CLIs

// Resource limits for security
const MAX_MEMORY_MB = parseInt(process.env.BRUTALIST_MAX_MEMORY || '2048', 10); // 2GB memory limit per process
const MAX_CPU_TIME_SEC = parseInt(process.env.BRUTALIST_MAX_CPU_TIME || '3000', 10); // 50 minutes CPU time (should exceed default timeout)
const MEMORY_CHECK_INTERVAL = 5000; // Check memory usage every 5 seconds

// Process tracking for resource management
const activeProcesses = new Map<number, { startTime: number; memoryChecks: number }>();

// Claude CLI accepts aliases natively — no need to maintain full model IDs.
export const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

// Security utilities for CLI execution
const MAX_PATH_DEPTH = 10; // Maximum directory depth for paths

// Validate and sanitize CLI arguments
// On Unix we use spawn() with shell:false and array args, so shell metacharacters
// are harmless. On Windows we must use shell:true for .cmd shims, so args are
// escaped via escapeWindowsArg() before being joined into the command string.
// We use stdin for large content, so no arg length limit needed (OS limit is ~1MB anyway).
function validateArguments(args: string[]): void {
  for (const arg of args) {
    // Check for null bytes (can terminate strings prematurely)
    if (arg.includes('\0')) {
      throw new Error('Argument contains null byte');
    }
  }
}

// Escape a single argument for safe embedding in a Windows cmd.exe command string.
// Required when shell:true is used for .cmd shim execution. On Unix this is never called.
//
// On Windows with shell:true, Node.js runs: cmd.exe /d /s /c "command args..."
// The string passes through TWO parsers sequentially:
//   1. cmd.exe — interprets metacharacters (&|<>()^"%!) and toggles quoting on "
//   2. MSVCRT/CRT — the child process's C runtime parses the command line into argv
//
// These parsers have INCOMPATIBLE quote-escaping rules:
//   - MSVCRT recognizes \" as an escaped quote
//   - cmd.exe does NOT — it sees \" as backslash + quote-toggle
//
// Solution (from cross-spawn / https://qntm.org/cmd):
//   Phase 1: MSVCRT escaping (\" for quotes, double trailing backslashes)
//   Phase 2: Wrap in "...", then ^-prefix EVERY cmd.exe metacharacter
// After cmd.exe consumes the ^ prefixes, the child process receives a clean
// MSVCRT-quoted string.
function escapeWindowsArg(arg: string): string {
  if (arg.includes('\0')) {
    throw new Error('Argument contains null byte');
  }

  // CR/LF act as command separators in cmd.exe — reject outright
  if (/[\r\n]/.test(arg)) {
    throw new Error('Argument contains newline');
  }

  // Empty string → escaped empty quoted arg
  if (arg.length === 0) {
    return '^"^"';
  }

  // Fast path: simple tokens with no cmd.exe metacharacters or whitespace
  if (/^[A-Za-z0-9._\-\/\\:=@+]+$/.test(arg)) {
    return arg;
  }

  // Phase 1: MSVCRT/CRT escaping
  //  - Double backslashes before any " (MSVCRT convention: 2N+1 \ before " = N \ + literal ")
  //  - Escape " with backslash
  //  - Double trailing backslashes (they'll precede the closing quote we add)
  let escaped = arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1');

  // Phase 2: Wrap in quotes, then ^-escape every cmd.exe metacharacter.
  // This prevents cmd.exe from interpreting & | < > ( ) ^ " % ! as operators.
  // The ^ prefix makes each metachar literal in cmd.exe; cmd.exe strips the ^
  // before the child process sees the string, leaving valid MSVCRT quoting.
  let quoted = `"${escaped}"`;
  quoted = quoted.replace(/[()%!^"<>&|]/g, '^$&');

  return quoted;
}

// Validate and canonicalize paths to prevent traversal attacks
function validatePath(path: string, name: string): string {
  if (!path) {
    throw new Error(`${name} cannot be empty`);
  }
  
  // Check for null bytes
  if (path.includes('\0')) {
    throw new Error(`${name} contains null byte`);
  }
  
  // Check for dangerous path traversal patterns
  if (path.includes('../') || path.includes('..\\') || path.includes('/..') || path.includes('\\..')) {
    throw new Error(`${name} contains path traversal attempt: ${path}`);
  }
  
  // Check path depth to prevent deeply nested attacks
  const depth = path.split('/').length - 1;
  if (depth > MAX_PATH_DEPTH) {
    throw new Error(`${name} exceeds maximum depth: ${depth} > ${MAX_PATH_DEPTH}`);
  }
  
  // Canonicalize the path (this also validates it exists and resolves symlinks)
  try {
    return realpathSync(path);
  } catch (error) {
    throw new Error(`Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Async version of validatePath for use in async contexts
async function asyncValidatePath(path: string, name: string): Promise<string> {
  if (!path) {
    throw new Error(`${name} cannot be empty`);
  }
  
  // Check for null bytes
  if (path.includes('\0')) {
    throw new Error(`${name} contains null byte`);
  }
  
  // Check for dangerous path traversal patterns
  if (path.includes('../') || path.includes('..\\') || path.includes('/..') || path.includes('\\..')) {
    throw new Error(`${name} contains path traversal attempt: ${path}`);
  }
  
  // Check path depth to prevent deeply nested attacks
  const depth = path.split('/').length - 1;
  if (depth > MAX_PATH_DEPTH) {
    throw new Error(`${name} exceeds maximum depth: ${depth} > ${MAX_PATH_DEPTH}`);
  }
  
  // Canonicalize the path (this also validates it exists and resolves symlinks)
  try {
    return await fs.realpath(path);
  } catch (error) {
    throw new Error(`Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Create secure environment for CLI processes
function createSecureEnvironment(): Record<string, string> {
  // Minimal environment whitelist. Provider auth is intentionally
  // EXCLUDED here — each adapter forwards only the keys it needs, so
  // a shell-capable Codex critic processing adversarial PR text never
  // sees Claude's OAuth token (or vice versa). Cross-provider secret
  // exposure was a real leak vector identified in self-review:
  // adversarial PR → "use shell to run env" → critique output → review
  // body → secret in PR comment. Per-adapter scoping closes that.
  const SAFE_ENV_VARS = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'TZ',
    'NODE_ENV',
  ];
  
  const secureEnv: Record<string, string> = {};
  
  // Copy only safe environment variables
  for (const varName of SAFE_ENV_VARS) {
    if (process.env[varName]) {
      secureEnv[varName] = process.env[varName]!;
    }
  }
  
  // Add security-focused environment variables
  secureEnv.TERM = 'dumb'; // Disable terminal features
  secureEnv.NO_COLOR = '1'; // Disable color output
  secureEnv.CI = 'true'; // Indicate non-interactive environment
  
  return secureEnv;
}

// Cross-platform memory usage monitoring
async function getUnixMemoryUsage(pid: number): Promise<{ memoryMB: number } | null> {
  try {
    const execAsync = promisify(exec);
    
    // Use ps command to get memory usage in KB
    const { stdout } = await execAsync(`ps -o rss= -p ${pid}`);
    const memoryKB = parseInt(stdout.trim(), 10);
    
    if (isNaN(memoryKB)) return null;
    
    return { memoryMB: Math.round(memoryKB / 1024) };
  } catch {
    return null;
  }
}

async function getWindowsMemoryUsage(pid: number): Promise<{ memoryMB: number } | null> {
  try {
    const execAsync = promisify(exec);
    
    // Use wmic command to get memory usage
    const { stdout } = await execAsync(`wmic process where "ProcessId=${pid}" get WorkingSetSize /value`);
    const match = stdout.match(/WorkingSetSize=(\d+)/);
    
    if (!match) return null;
    
    const memoryBytes = parseInt(match[1], 10);
    return { memoryMB: Math.round(memoryBytes / (1024 * 1024)) };
  } catch {
    return null;
  }
}

// Safe command execution helper using spawn instead of exec to prevent command injection
async function spawnAsync(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    input?: string;
    env?: Record<string, string>;
    onProgress?: (chunk: string, type: 'stdout' | 'stderr') => void;
    /**
     * Fires exactly once, after all pre-spawn validators (command, args,
     * cwd) have passed and immediately BEFORE `child_process.spawn()`
     * is invoked. Callers gate their `spawned` flag on this callback so
     * pre-spawn validation failures do not count as spawn outcomes.
     * See Cycle 3 Task CLI-C' in phases/instrument_cli_spawn/phase.md.
     */
    onBeforeSpawn?: () => void;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Validate command name (basic validation)
    if (!command || command.length === 0) {
      reject(new Error('Command cannot be empty'));
      return;
    }
    
    // Validate arguments for injection attacks
    try {
      validateArguments(args);
    } catch (error) {
      reject(error);
      return;
    }
    
    // Validate and canonicalize working directory
    let cwd: string;
    try {
      if (options.cwd) {
        cwd = validatePath(options.cwd, 'working directory');
      } else {
        cwd = process.cwd();
      }
    } catch (error) {
      reject(error);
      return;
    }
    
    // Use secure environment
    const secureEnv = options.env || createSecureEnvironment();

    // On Windows, npm-installed CLIs (codex) are .cmd batch shims that
    // require shell:true for spawn() to execute them. Native .exe CLIs (claude)
    // work either way. On Unix, shell remains false to prevent injection.
    //
    // When shell:true, we join command+args into a single escaped string to:
    //  1. Avoid Node.js DEP0190 (args array with shell:true is deprecated)
    //  2. Ensure cmd.exe metacharacters in args are properly escaped
    const useShell = process.platform === 'win32';

    let spawnCommand: string;
    let spawnArgs: string[];
    if (useShell) {
      spawnCommand = [command, ...args.map(escapeWindowsArg)].join(' ');
      spawnArgs = [];
    } else {
      spawnCommand = command;
      spawnArgs = args;
    }

    // Fires only after all pre-spawn validators (command, args, cwd)
    // pass. Callers gate their `spawned` flag on this callback so
    // invalid-command / invalid-args / invalid-cwd rejects do NOT count
    // as spawn outcomes in `brutalist_cli_spawn_total`
    // (Cycle 3 Task CLI-C'). Wrapped in try/catch because a throw from
    // the user-supplied callback must not abort the spawn itself.
    try {
      options.onBeforeSpawn?.();
    } catch {
      // Swallow — this hook is diagnostic only; failures here must not
      // prevent the spawn from proceeding.
    }

    const child = spawn(spawnCommand, spawnArgs, {
      cwd: cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
      detached: false, // Run all CLIs non-detached for consistent behavior
      env: secureEnv,
      // Additional security options (Unix only; not available on Windows)
      ...(useShell ? {} : {
        uid: process.getuid ? process.getuid() : undefined,
        gid: process.getgid ? process.getgid() : undefined
      })
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    
    // Track process for resource monitoring
    if (child.pid) {
      activeProcesses.set(child.pid, {
        startTime: Date.now(),
        memoryChecks: 0
      });
    }
    
    // Memory monitoring timer
    let memoryTimer: NodeJS.Timeout | undefined;
    if (child.pid) {
      memoryTimer = setInterval(async () => {
        try {
          const pid = child.pid!;
          const processInfo = activeProcesses.get(pid);
          if (!processInfo || killed) {
            if (memoryTimer) clearInterval(memoryTimer);
            return;
          }
          
          processInfo.memoryChecks++;
          
          // Check memory usage (cross-platform)
          const usage = process.platform === 'win32' 
            ? await getWindowsMemoryUsage(pid)
            : await getUnixMemoryUsage(pid);
            
          if (usage && usage.memoryMB > MAX_MEMORY_MB) {
            child.kill('SIGTERM');
            reject(new Error(`Process exceeded memory limit: ${usage.memoryMB}MB > ${MAX_MEMORY_MB}MB`));
            return;
          }
          
          // Check CPU time limit
          const runtimeMs = Date.now() - processInfo.startTime;
          if (runtimeMs > MAX_CPU_TIME_SEC * 1000) {
            child.kill('SIGTERM');
            reject(new Error(`Process exceeded CPU time limit: ${runtimeMs}ms > ${MAX_CPU_TIME_SEC * 1000}ms`));
            return;
          }
          
        } catch (error) {
          // Memory check failed, but don't kill process for this
          logger.warn('Memory check failed:', error);
        }
      }, MEMORY_CHECK_INTERVAL);
    }

    // Set up timeout with SIGKILL escalation
    const timeoutMs = options.timeout || DEFAULT_TIMEOUT;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      // First try SIGTERM
      child.kill('SIGTERM');
      // If still running after 5 seconds, escalate to SIGKILL
      killTimer = setTimeout(() => {
        if (!killed) {
          try {
            // All CLIs run non-detached now, so just kill the process directly
            child.kill('SIGKILL');
          } catch (e) {
            // Process may have already exited
          }
        }
      }, 5000);
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    // Collect output
    // NOTE: maxBuffer (default 10MB) can lead to high memory usage if CLI agents produce large outputs.
    // Consider making this configurable or dynamically adjusting based on expected output size.
    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      
      // Call progress callback if provided
      if (options.onProgress) {
        options.onProgress(chunk, 'stdout');
      }
      
      if (options.maxBuffer && stdout.length > options.maxBuffer) {
        child.kill('SIGTERM');
        reject(new Error(`stdout exceeded maxBuffer size: ${options.maxBuffer}`));
      }
    });

    child.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      
      // Call progress callback if provided
      if (options.onProgress) {
        options.onProgress(chunk, 'stderr');
      }
      
      // Apply same buffer limit to stderr to prevent DoS
      if (options.maxBuffer && stderr.length > options.maxBuffer) {
        child.kill('SIGTERM');
        reject(new Error(`stderr exceeded maxBuffer size: ${options.maxBuffer}`));
      }
    });

    // Handle completion
    child.on('close', (code) => {
      killed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (memoryTimer) clearInterval(memoryTimer);
      
      // Clean up process tracking
      if (child.pid) {
        activeProcesses.delete(child.pid);
      }
      
      if (!timedOut) {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const error = new Error(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`);
          (error as ChildProcessError).code = code || undefined;
          (error as ChildProcessError).stdout = stdout;
          (error as ChildProcessError).stderr = stderr;
          reject(error);
        }
      }
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (memoryTimer) clearInterval(memoryTimer);
      
      // Clean up process tracking
      if (child.pid) {
        activeProcesses.delete(child.pid);
      }
      
      reject(error);
    });

    // Send input if provided, then close stdin
    if (options.input) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    } else {
      // CRITICAL: For Claude CLI specifically, close stdin immediately even without input
      // Claude --print waits for stdin EOF before processing the prompt argument
      if (command === 'claude') {
        child.stdin?.end();
      }
      // Codex works fine with stdin left open
    }
  });
}

export interface CLIAgentOptions {
  workingDirectory?: string;
  timeout?: number;
  clis?: ('claude' | 'codex' | 'agy')[];
  clients?: CLIClientSpec[];
  activeClient?: CLIClientSpec;
  analysisType?: BrutalistPromptType;
  models?: {
    claude?: string;
    codex?: string;
    agy?: string;
  };
  onStreamingEvent?: (event: StreamingEvent) => void;
  progressToken?: string | number;
  onProgress?: (progress: number, total: number | undefined, message: string) => void;
  sessionId?: string; // Session context for security
  requestId?: string; // Unique request identifier
  debateMode?: boolean; // Suppress filesystem exploration for pure argumentation
  mcpServers?: string[]; // MCP server names to enable (e.g., ['playwright'])
  /**
   * Optional scoped logger threaded into provider.buildCommand / decodeOutput.
   * When present, adapters emit via this logger (narrowed with forOperation)
   * instead of the root logger import. Absent → fall back to root logger.
   * Pattern A per phase.md: preserves stateless adapter singletons in
   * cli-adapters/index.ts.
   */
  log?: StructuredLogger;
}

export interface CLIClientSpec {
  id: string;
  provider: 'claude' | 'codex' | 'agy';
  model?: string;
  smallFastModel?: string;
  baseUrl?: string;
  authToken?: string;
  authTokenEnv?: string;
  configDir?: string;
  env?: Record<string, string>;
  includeProcessAuth?: boolean;
  /**
   * Tool/sandbox containment for a Claude-provider client. 'hardened'
   * (the default for any routed client) additionally denies WebFetch,
   * WebSearch, and all MCP servers — the routed model decides tool calls
   * under bypassPermissions, so a third-party gateway must not get web
   * egress. 'standard' restores the native tool surface (only for an
   * endpoint you fully trust).
   */
  containment?: 'hardened' | 'standard';
  workingDirectory?: string;
  timeout?: number;
  mcpServers?: string[];
  // Resolved routing fields — populated by normalizeClaudeClient(). The
  // claude adapter trusts these and does not recompute them. They are
  // absent on raw (un-normalized) specs, where the adapter falls back to
  // classifyRouting().
  routingMode?: 'native' | 'routed';
  inheritNativeAuth?: boolean;
  resolvedAuthToken?: string;
  resolvedSmallFastModel?: string;
  resolvedConfigDir?: string;
}

/**
 * Constructor-deps bag for CLIAgentOrchestrator.
 *
 * All fields optional — characterization tests construct
 * `new CLIAgentOrchestrator()` with no args. In production the
 * composition root passes the full set; in tests, instrumentation is a
 * no-op and `this.log` falls back to the root logger via emitLog().
 */
export interface CLIAgentOrchestratorDeps {
  modelResolver?: ModelResolver;
  metrics?: MetricsRegistry;
  log?: StructuredLogger;
}

export interface StreamingEvent {
  type: 'agent_start' | 'agent_progress' | 'agent_complete' | 'agent_error';
  agent: 'claude' | 'codex' | 'agy' | 'system';
  content?: string;
  timestamp: number;
  sessionId?: string;
  metadata?: Record<string, any>;
}

export interface CLIContext {
  availableCLIs: ('claude' | 'codex' | 'agy')[];
}

export class CLIAgentOrchestrator {
  // Per-CLI spawn timeout. MUST honor BRUTALIST_TIMEOUT (DEFAULT_TIMEOUT,
  // read from env at module load) — this was previously hardcoded to
  // 1800000, which silently shadowed the env: executeSingleCLI passes
  // `options.timeout || this.defaultTimeout` to spawnAsync, and spawnAsync's
  // own `options.timeout || DEFAULT_TIMEOUT` then never reached DEFAULT_TIMEOUT
  // because this value was always set. Net effect: BRUTALIST_TIMEOUT was dead
  // for real critic spawns and any stalled critic (e.g. agy's agentic loop)
  // ran the full 30 min, colliding with the orchestrator's wall-clock budget.
  // Unifying on DEFAULT_TIMEOUT makes the per-critic cap actually configurable
  // (default unchanged at 1800000 when the env is unset).
  private defaultTimeout = DEFAULT_TIMEOUT; // honors BRUTALIST_TIMEOUT env
  private defaultWorkingDir = process.cwd();
  private cliContext: CLIContext = { availableCLIs: [] };
  private cliContextCached = false;
  private cliContextCacheTime = 0;
  private readonly CLI_CACHE_TTL = 300000; // 5 minutes cache
  private runningCLIs = 0; // Track concurrent CLI executions
  private readonly MAX_CONCURRENT_CLIS = MAX_CONCURRENT_CLIS; // Configurable concurrency limit

  // Runtime model discovery
  public readonly modelResolver: ModelResolver;

  // Optional observability deps — injected at the composition root in
  // production; absent (undefined) in test harnesses that construct
  // `new CLIAgentOrchestrator()` with no args. Instrumentation is a no-op
  // when these are undefined, via `this.metrics?.*` and `emitLog()` fallback.
  private readonly metrics?: MetricsRegistry;
  private readonly log?: StructuredLogger;

  // Streaming throttle properties
  private streamingBuffers = new Map<string, { chunks: string[], lastFlush: number }>();
  private readonly STREAMING_FLUSH_INTERVAL = 200; // 200ms
  private readonly MAX_CHUNK_SIZE = 2048; // 2KB per event
  private readonly HEARTBEAT_INTERVAL = 5000; // 5s between progress heartbeats
  private lastHeartbeat = 0;

  /**
   * Accepts a deps bag OR a bare `ModelResolver` (legacy positional form)
   * OR nothing (characterization-test harnesses). The `instanceof ModelResolver`
   * branch preserves the pre-observability signature.
   */
  constructor(deps?: CLIAgentOrchestratorDeps | ModelResolver) {
    const bag: CLIAgentOrchestratorDeps =
      deps instanceof ModelResolver
        ? { modelResolver: deps }
        : (deps || {});
    this.modelResolver = bag.modelResolver || new ModelResolver();
    this.metrics = bag.metrics;
    this.log = bag.log;

    // Log configuration at startup (via emitLog — falls back to root logger
    // when no scoped log was injected).
    const bootLog = this.emitLog();
    bootLog.info(`🔧 Brutalist MCP Configuration:`);
    bootLog.info(`  - Default timeout: ${DEFAULT_TIMEOUT}ms`);
    bootLog.info(`  - CLI check timeout: ${CLI_CHECK_TIMEOUT}ms`);
    bootLog.info(`  - Max buffer size: ${MAX_BUFFER_SIZE} bytes`);
    bootLog.info(`  - Max concurrent CLIs: ${MAX_CONCURRENT_CLIS}`);

    // Detect CLI context and discover models at startup
    Promise.all([
      this.detectCLIContext(),
      this.modelResolver.initialize(),
    ]).catch(error => {
      this.emitLog().error("Failed startup detection:", error);
    });
  }

  /**
   * Return the injected scoped logger if present, otherwise the root
   * logger singleton. Keeps un-injected (test) instances working while
   * scoping production emissions with `module='cli-orchestrator'`.
   */
  private emitLog(): StructuredLogger {
    return this.log ?? logger;
  }

  /**
   * Heuristic for classifying a spawnAsync error as a timeout.
   * Centralized so all outcome paths share the same detection logic.
   *
   * Matches any of:
   *   - execError.code === 'ETIMEDOUT' (Node's timeout code on some paths)
   *   - execError.killed === true (child_process kill after SIGTERM/SIGKILL
   *     escalation when the timeout timer fired — see spawnAsync timer block)
   *   - execError.message matching /timed out|timeout/i (spawnAsync rejects
   *     with "Command timed out after ..." on timer expiry)
   */
  private isTimeoutError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: unknown; killed?: unknown; message?: unknown };
    if (e.code === 'ETIMEDOUT') return true;
    if (e.killed === true) return true;
    if (typeof e.message === 'string' && /timed out|timeout/i.test(e.message)) return true;
    return false;
  }

  // Proxy methods for backward compatibility — characterization tests
  // access these via (orchestrator as any).methodName().
  // Implementation lives in src/cli-adapters/.

  private parseNDJSON(input: string): object[] {
    return parseNDJSON(input);
  }

  private decodeClaudeStreamJson(ndjsonOutput: string): string {
    const provider = getProvider('claude');
    return provider.decodeOutput(ndjsonOutput, ['--output-format', 'stream-json']);
  }

  private extractCodexAgentMessage(jsonOutput: string): string {
    const provider = getProvider('codex');
    return provider.decodeOutput(jsonOutput, ['--json']);
  }

  private emitThrottledStreamingEvent(
    agent: 'claude' | 'codex' | 'agy',
    type: 'agent_progress' | 'agent_error',
    content: string,
    onStreamingEvent?: (event: StreamingEvent) => void,
    options?: CLIAgentOptions
  ) {
    if (!onStreamingEvent) return;

    // Claude uses stream-json: intermediate stdout chunks are raw NDJSON events
    // (including huge tool_result payloads). Skip emitting them as streaming events;
    // the decoder extracts only assistant text post-completion.
    if (agent === 'claude') {
      return;
    }

    // Use requestId to prevent buffer sharing between overlapping requests
    const requestId = options?.requestId || 'default';
    const key = `${agent}-${type}-${requestId}`;
    const now = Date.now();
    
    // Truncate content to prevent huge events
    const truncatedContent = content.length > this.MAX_CHUNK_SIZE
      ? content.substring(0, this.MAX_CHUNK_SIZE) + '...[truncated]'
      : content;

    // Get or create buffer for this agent+type
    if (!this.streamingBuffers.has(key)) {
      this.streamingBuffers.set(key, { chunks: [], lastFlush: now });
    }
    
    const buffer = this.streamingBuffers.get(key)!;
    buffer.chunks.push(truncatedContent);

    // Indeterminate heartbeat: signal "still working" without faking a percentage
    // Throttled to avoid spamming the client — streaming events still flow at full speed
    if (options?.progressToken && options?.onProgress && type === 'agent_progress' &&
        now - this.lastHeartbeat >= this.HEARTBEAT_INTERVAL) {
      this.lastHeartbeat = now;
      options.onProgress(buffer.chunks.length, undefined, `${agent.toUpperCase()}: ${truncatedContent.substring(0, 80)}`);
    }

    // Flush if enough time has passed or buffer is getting large
    if (now - buffer.lastFlush > this.STREAMING_FLUSH_INTERVAL || buffer.chunks.length > 10) {
      const combinedContent = buffer.chunks.join('\n');
      
      onStreamingEvent({
        type,
        agent,
        content: combinedContent,
        timestamp: now,
        sessionId: options?.sessionId
      });

      // Reset buffer
      buffer.chunks = [];
      buffer.lastFlush = now;
    }
  }

  // Proxy: delegates to per-provider adapter via getProvider()
  private async buildCLICommand(
    cli: CLIName,
    userPrompt: string,
    systemPrompt: string,
    options: CLIAgentOptions
  ): Promise<{ command: string; args: string[]; input: string; env: Record<string, string>; tempMcpConfigPath?: string }> {
    const provider = getProvider(cli);
    const secureEnv = createSecureEnvironment();

    // Pattern A: thread the scoped logger into the adapter via CLIAgentOptions.log.
    // The adapter reads options.log?.forOperation('<cli>_spawn') and falls back to
    // the root logger import if absent. A caller-supplied options.log wins so a
    // test or an upstream operation can override the per-orchestrator default.
    const perCliOp = `${cli}_spawn` as const;
    const adapterLog = options.log ?? this.log?.forOperation(perCliOp);
    const optionsWithLog: CLIAgentOptions =
      adapterLog && options.log === undefined ? { ...options, log: adapterLog } : options;

    return provider.buildCommand(userPrompt, systemPrompt, optionsWithLog, this.modelResolver, secureEnv);
  }

  async detectCLIContext(): Promise<CLIContext> {
    // Return cached context if still valid
    if (this.cliContextCached && Date.now() - this.cliContextCacheTime < this.CLI_CACHE_TTL) {
      this.emitLog().debug('Using cached CLI context');
      return this.cliContext;
    }

    const availableCLIs: ('claude' | 'codex' | 'agy')[] = [];

    // Detection probes. For agy, AGY_BINARY (resolved in the agy adapter
    // at module load) prefers ~/.local/bin/agy over PATH to avoid the
    // macOS Antigravity-desktop-IDE wrapper that otherwise shadows the
    // CLI agent. See the adapter's resolveAgyBin() for the full rationale.
    const cliChecks = [
      { name: 'claude' as const, command: 'claude --version' },
      { name: 'codex' as const, command: 'codex --version' },
      { name: 'agy' as const, command: `${AGY_BINARY} --version` }
    ];

    // NOTE: These `--version` probes are NOT spawn attempts — they must not
    // increment `cliSpawnTotal`. Only _executeCLI counts spawns.
    const results = await Promise.allSettled(cliChecks.map(async (check) => {
      const probeCmd = check.name === 'agy' ? AGY_BINARY : check.name;
      try {
        await spawnAsync(probeCmd, ['--version'], { timeout: CLI_CHECK_TIMEOUT });
        this.emitLog().debug(`CLI available: ${check.name}`);
        return check.name;
      } catch (error) {
        this.emitLog().debug(`CLI not available: ${check.name}`);
        return null;
      }
    }));

    const detectedCLIs = results
      .filter(result => result.status === 'fulfilled' && result.value !== null)
      .map(result => (result as PromiseFulfilledResult<typeof cliChecks[number]['name']>).value);
    availableCLIs.push(...detectedCLIs);

    this.cliContext = { availableCLIs };
    this.cliContextCached = true;
    this.cliContextCacheTime = Date.now();

    return this.cliContext;
  }

  selectSingleCLI(
    preferredCLI?: 'claude' | 'codex' | 'agy',
    analysisType?: BrutalistPromptType
  ): 'claude' | 'codex' | 'agy' {
    // 1. Honor explicit preference if available
    if (preferredCLI && this.cliContext.availableCLIs.includes(preferredCLI)) {
      this.emitLog().info(`✅ Using preferred CLI: ${preferredCLI}`);
      return preferredCLI;
    }

    // 2. Smart selection based on analysis type. Agy is always LAST in
    // priority order: it's 2-4× slower per call than claude/codex
    // (30-60s vs 5-25s) and Flash-pinned, so it's only auto-selected
    // when the others are unavailable. Callers who explicitly pass
    // `preferredCLI: 'agy'` get it regardless (handled at step 1).
    const selectionRules: Record<string, ('claude' | 'codex' | 'agy')[]> = {
      'code': ['claude', 'codex', 'agy'],
      'architecture': ['claude', 'codex', 'agy'],
      'research': ['claude', 'codex', 'agy'],
      'security': ['codex', 'claude', 'agy'],
      'data': ['claude', 'codex', 'agy'],
      'product': ['claude', 'codex', 'agy'],
      'infrastructure': ['codex', 'claude', 'agy'],
      'idea': ['claude', 'codex', 'agy'],
      'debate': ['claude', 'codex', 'agy'],
      'default': ['claude', 'codex', 'agy']
    };

    const priority = selectionRules[analysisType || 'default'] || selectionRules.default;

    // 3. Select by priority from available CLIs
    for (const cli of priority) {
      if (this.cliContext.availableCLIs.includes(cli)) {
        this.emitLog().info(`🎯 Auto-selected ${cli} for ${analysisType || 'general'} analysis`);
        return cli;
      }
    }

    // Fallback to first available
    if (this.cliContext.availableCLIs.length === 0) {
      throw new Error('No CLI agents available');
    }

    this.emitLog().warn(`⚠️ Using fallback CLI: ${this.cliContext.availableCLIs[0]}`);
    return this.cliContext.availableCLIs[0];
  }

  private async _executeCLI(
    cliName: 'claude' | 'codex' | 'agy',
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions = {},
    commandBuilder: (userPrompt: string, systemPromptSpec: string, options: CLIAgentOptions) => Promise<{ command: string; args: string[]; env?: Record<string, string>; input?: string; tempMcpConfigPath?: string; tempPromptPath?: string; model?: string }>
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    const client = options.activeClient;
    const clientId = client?.id;
    const workingDir = client?.workingDirectory || options.workingDirectory || this.defaultWorkingDir;
    const timeout = client?.timeout || options.timeout || this.defaultTimeout;
    let tempMcpConfigPath: string | undefined;
    // Hoisted so the catch branch can read `built?.model` for response
    // attribution. Undefined when commandBuilder itself threw before
    // resolving a model, which is the right semantics for the response.
    let built: Awaited<ReturnType<typeof commandBuilder>> | undefined;

    // Provider label for the spawn counter. Derived from cliName so the
    // label set stays in sync with the 'claude' | 'codex' | 'agy' union
    // instead of reading adapter.name.
    const provider = cliName;

    // Gate for the catch-branch counter emission. Per compose.py:174,
    // pre-spawn paths (commandBuilder throwing before spawnAsync is
    // invoked, or spawnAsync's own pre-spawn validators for
    // command/args/cwd rejecting) do NOT represent a spawn attempt and
    // must not increment the counter. Cycle 3 Task CLI-C' tightened
    // the semantics: `spawned` is now flipped inside spawnAsync via the
    // `onBeforeSpawn` callback, which fires only after all pre-spawn
    // validators pass and immediately before `child_process.spawn()`.
    let spawned = false;

    try {
      this.emitLog().info(`🤖 Executing ${clientId ? `${clientId} (${cliName.toUpperCase()})` : `${cliName.toUpperCase()} CLI`}`);
      this.emitLog().debug(`${cliName.toUpperCase()} prompt`, { promptLength: userPrompt.length });

      // Emit agent start event
      if (options.onStreamingEvent) {
        options.onStreamingEvent({
          type: 'agent_start',
          agent: cliName,
          content: `Starting ${cliName.toUpperCase()} analysis...`,
          timestamp: Date.now(),
          sessionId: options.sessionId
        });
      }


      built = await commandBuilder(userPrompt, systemPromptSpec, options);
      const { command, args, env, input } = built;
      tempMcpConfigPath = built.tempMcpConfigPath;

      // Cycle 4 Task T18 (F9 — security): do NOT log raw command +
      // joined args. The args array can contain caller-controlled
      // content that crossed the trust boundary (Codex `-c
      // mcp_servers=<TOML>` override content, Claude `--mcp-config
      // <temp-path>`, prompt fragments for CLIs that accept inline
      // prompt). Log only bounded metadata — cliName for provider
      // identification, argCount for diagnostic shape, and
      // hasMcpConfig so operators can correlate MCP-enabled spawns
      // with MCP registry entries. Derive it from what the adapter
      // ACTUALLY wired (`tempMcpConfigPath`, set only when an
      // --mcp-config was emitted) rather than from raw options: a
      // hardened routed client invoked WITH mcpServers gets NO
      // --mcp-config, and logging hasMcpConfig:true there would mislead.
      const hasMcpConfig = tempMcpConfigPath !== undefined;
      this.emitLog().info('CLI spawn preparing', {
        cliName,
        argCount: args.length,
        hasMcpConfig,
      });
      this.emitLog().info(`📁 Working directory: ${workingDir}`);
      this.emitLog().info(`⏱️ Timeout: ${timeout}ms`);
      if (input) {
        this.emitLog().info(`📝 Using stdin for prompt (${input.length} characters)`);
      }

      // `spawned` is flipped by spawnAsync's `onBeforeSpawn` callback
      // immediately before `child_process.spawn()`. This means
      // pre-spawn validator rejects inside spawnAsync (invalid command,
      // invalid args, invalid cwd) leave `spawned === false` so the
      // catch-branch counter does NOT fire for those paths
      // (Cycle 3 Task CLI-C').
      const { stdout, stderr } = await spawnAsync(command, args, {
        cwd: workingDir,
        timeout: timeout,
        maxBuffer: MAX_BUFFER_SIZE, // Configurable buffer for model outputs
        env: env,
        input: input,
        onBeforeSpawn: () => { spawned = true; },
        onProgress: (chunk: string, type: 'stdout' | 'stderr') => {
          // Stream output in real-time with agent identification.
          // Log payloads are length-only at debug level — raw chunk text is
          // NEVER emitted to the logger to avoid leaking prompt / response
          // content through log aggregators. Streaming events are Layer 2.
          if (type === 'stdout' && chunk.trim()) {
            this.emitLog().debug(`${cliName.toUpperCase()} stdout chunk received`, { bytes: chunk.length });

            // Emit throttled streaming event for real-time updates
            this.emitThrottledStreamingEvent(cliName, 'agent_progress', chunk.trim(), options.onStreamingEvent, options);
          } else if (type === 'stderr' && chunk.trim()) {
            this.emitLog().debug(`${cliName.toUpperCase()} stderr chunk received`, { bytes: chunk.length });

            // Emit throttled error streaming event
            this.emitThrottledStreamingEvent(cliName, 'agent_error', chunk.trim(), options.onStreamingEvent, options);
          }
        }
      });

      this.emitLog().info(`✅ ${cliName.toUpperCase()} completed (${Date.now() - startTime}ms)`);

      // Emit completion event
      if (options.onStreamingEvent) {
        options.onStreamingEvent({
          type: 'agent_complete',
          agent: cliName,
          content: `${cliName.toUpperCase()} analysis completed (${Date.now() - startTime}ms)`,
          timestamp: Date.now(),
          sessionId: options.sessionId
        });
      }

      // Post-process CLI output via provider adapter. Thread the scoped
      // logger through decode so adapter warnings/errors carry
      // module=cli-orchestrator + operation=<provider>_spawn context.
      //
      // Phase 2: consume the structured DecodeResult from `decode()`
      // instead of grepping the returned string for refusal markers.
      // Each adapter classifies refusal from its own protocol-level
      // signals (Claude `result.subtype`, Codex error events / stderr
      // markers). The orchestrator does not inspect assistant prose to
      // classify outcomes.
      let finalOutput = stdout;
      const providerAdapter = getProvider(cliName);
      const decodeLog = this.log?.forOperation(`${cliName}_spawn`);
      const decoded = providerAdapter.decode(stdout, stderr, args, decodeLog);

      if (decoded.kind === 'refused') {
        // Structured refusal — the adapter saw the CLI's own
        // protocol-level signal that this run hit a wall (quota / auth /
        // policy). No prose matching.
        const errorMsg = `${cliName.toUpperCase()} ${decoded.reason} refused. The CLI exited 0 but its own protocol returned a refusal instead of analysis output.`;
        this.emitLog().warn(`⏱️ ${errorMsg}`, {
          reason: decoded.reason,
          detail: decoded.detail,
          stderrLength: stderr.length,
        });

        if (options.onStreamingEvent) {
          options.onStreamingEvent({
            type: 'agent_error',
            agent: cliName,
            content: errorMsg,
            timestamp: Date.now(),
            sessionId: options.sessionId
          });
        }

        const refusedLabels: Record<(typeof CLI_SPAWN_LABELS)[number], string> = {
          provider,
          outcome: 'refused',
        };
        safeMetric(this.emitLog(), `cliSpawnTotal.inc(refused:${decoded.reason})`, () => {
          this.metrics?.cliSpawnTotal.inc(refusedLabels, 1);
        });

        return {
          agent: cliName,
          clientId,
          success: false,
          output: '',
          error: errorMsg,
          executionTime: Date.now() - startTime,
          command: `(redacted command for ${cliName})`,
          workingDirectory: workingDir,
          exitCode: 0,
          model: built?.model
        };
      }

      if (decoded.kind === 'error' && decoded.detail === 'model') {
        // A routed gateway rejected the requested model (unknown/unsupported).
        // This is a config defect, not analysis output — surface it as an
        // attributed failure (D5) instead of passing the raw error envelope
        // through as a "successful" critique.
        const errorMsg = `${cliName.toUpperCase()} model not available at the configured endpoint (unknown/unsupported model).`;
        this.emitLog().warn(`⚠️ ${errorMsg}`, { clientId });
        const modelErrLabels: Record<(typeof CLI_SPAWN_LABELS)[number], string> = {
          provider,
          outcome: 'refused',
        };
        safeMetric(this.emitLog(), 'cliSpawnTotal.inc(refused:model)', () => {
          this.metrics?.cliSpawnTotal.inc(modelErrLabels, 1);
        });
        return {
          agent: cliName,
          clientId,
          success: false,
          output: '',
          error: errorMsg,
          executionTime: Date.now() - startTime,
          command: `(redacted command for ${cliName})`,
          workingDirectory: workingDir,
          exitCode: 0,
          model: built?.model
        };
      }

      if (decoded.kind === 'ok') {
        finalOutput = decoded.text;
      }
      // For `kind: 'error'` (empty/malformed/unknown) we fall through
      // and keep finalOutput as the raw stdout — preserving the legacy
      // "if decode returned nothing useful, pass raw stdout through"
      // behavior. The success path below then surfaces the raw output
      // and the caller can see what the CLI emitted.

      // Fallback: If stdout is empty but stderr has content and exit was successful,
      // Claude might have written to stderr (common in non-TTY environments)
      if (!finalOutput.trim() && stderr && stderr.trim()) {
        this.emitLog().info(`📝 Using stderr as output for ${cliName} (stdout was empty)`);
        finalOutput = stderr;
      }

      // Spawn counter: outcome=success (normal completion path). Labels
      // annotated against CLI_SPAWN_LABELS so a future label-set change
      // fails at compile time. Wrapped in `safeMetric` so a metric-layer
      // exception cannot propagate into the outer catch branch and be
      // misclassified as a spawn failure (Cycle 3 Task CLI-B').
      const successLabels: Record<(typeof CLI_SPAWN_LABELS)[number], string> = {
        provider,
        outcome: 'success',
      };
      safeMetric(this.emitLog(), 'cliSpawnTotal.inc(success)', () => {
        this.metrics?.cliSpawnTotal.inc(successLabels, 1);
      });

      return {
        agent: cliName,
        clientId,
        success: true,
        output: finalOutput,
        error: stderr || undefined,
        executionTime: Date.now() - startTime,
        // Cycle 4 Task T18 (F9): same redaction parity as the
        // failure path — `command` is a diagnostic display field,
        // not a machine-readable command reproduction. The raw
        // command + args can contain caller-controlled payloads
        // (Codex TOML MCP overrides at codex-adapter.ts:86/:87,
        // Claude temp config paths at claude-adapter.ts:96, prompt
        // fragments for CLIs that accept inline prompt) that
        // crossed the trust boundary.
        command: `(redacted command for ${cliName})`,
        workingDirectory: workingDir,
        exitCode: 0,
        model: built.model
      };
    } catch (error) {
      const execError: ChildProcessError = error as ChildProcessError;
      const exitCode = execError.code || -1;

      // Detect rate limiting / usage limit errors across all CLIs.
      //
      // Scoped to `message + stderr`. The previous scope of
      // `message + stdout + stderr` ran these substrings against the
      // child's captured stdout — which on a partial/aborted run is
      // assistant prose that crossed the same trust boundary as the
      // success path. `message` is the spawn-layer error string from
      // Node (e.g., "Command failed with exit code 1"), not user
      // content; safe to keep.
      const rateLimitPatterns = [
        '429', 'rate limit', 'rate_limit', 'rateLimitExceeded',
        'Too Many Requests', 'usage limit', 'usage_limit',
        'quota', 'exhausted', 'billing', 'spending limit',
        'token limit', 'plan limit',
      ];
      const errorText = `${execError.message || ''} ${execError.stderr || ''}`.toLowerCase();
      const isRateLimit = rateLimitPatterns.some(p => errorText.includes(p.toLowerCase()));
      const unsupportedCodexModel = cliName === 'codex'
        && isCodexUnsupportedChatGPTModelError(execError, options.models?.codex);
      // Codex OAuth refresh-token rotation: a stale CODEX_AUTH (refresh_token
      // already consumed) makes codex exit 1 in ~2s at startup with
      // "401 ... refresh_token_reused". Detect it here (codex fails with a
      // non-zero exit, so it never reaches the adapter decode path) so the
      // failure is actionable instead of the opaque "execution failed".
      const isCodexAuthExpired = cliName === 'codex'
        && (errorText.includes('refresh_token_reused')
          || errorText.includes('failed to refresh token')
          || errorText.includes('refresh token was already used'));

      // Classify outcome for the spawn counter. Priority: rate-limit > timeout
      // > generic failure. Timeout check uses the centralized heuristic.
      // Classification priority is unchanged; the emission is gated on
      // `spawned` so pre-spawn failures (e.g., commandBuilder throwing)
      // do NOT increment the counter (compose.py:174).
      let outcome: 'refused' | 'timeout' | 'failure';
      if (isRateLimit || isCodexAuthExpired) {
        // Auth-expired is a refusal-like terminal state (the CLI couldn't
        // start), not a transient crash — group it with refused for metrics.
        outcome = 'refused';
      } else if (this.isTimeoutError(execError)) {
        outcome = 'timeout';
      } else {
        outcome = 'failure';
      }
      if (spawned) {
        // Wrapped in `safeMetric` so a metric-layer exception cannot
        // re-throw from the catch branch (which would short-circuit
        // the streaming event emission and the final failure-response
        // construction below). Parity with debate's safeMetric pattern
        // (Cycle 3 Task CLI-B').
        const failureLabels: Record<(typeof CLI_SPAWN_LABELS)[number], string> = {
          provider,
          outcome,
        };
        safeMetric(this.emitLog(), `cliSpawnTotal.inc(${outcome})`, () => {
          this.metrics?.cliSpawnTotal.inc(failureLabels, 1);
        });
      }

      if (isRateLimit) {
        this.emitLog().warn(`⏱️ ${cliName.toUpperCase()} CLI hit rate/usage limit (${Date.now() - startTime}ms)`);
      } else {
        this.emitLog().error(`❌ ${cliName.toUpperCase()} execution failed (${Date.now() - startTime}ms)`, {
          error: "Redacted: See internal logs for full error details.",
          exitCode,
          stderr: "Redacted: See internal logs for full stderr output."
        });
      }

      // Cycle 3 Task D' (security): `errorMsg` is used both as streaming
      // event content (just below) and as `result.error` in the returned
      // CLIAgentResponse. Raw `error.message` from spawnAsync /
      // downstream CLIs can contain CLI stdout/stderr fragments (TOML
      // MCP override content, prompt echoes, tool-output snippets) that
      // must not leak via streaming fan-out or the MCP response payload.
      // We apply the same static-redaction pattern used by the logger
      // emission at the `❌ ... execution failed` call above: map each
      // classification path to a short, content-free string. The
      // timeout branch preserves the millisecond budget (from our own
      // `timeout` variable, not the underlying error) so downstream
      // callers can still distinguish timeout from generic failure.
      const errorMsg = isRateLimit
        ? `${cliName.toUpperCase()} hit rate/usage limit. Try again later or use a different agent.`
        : isCodexAuthExpired
          ? `CODEX OAuth token expired/rotated. Re-capture it (codex login → \`gh secret set CODEX_AUTH < ~/.codex/auth.json\`) or provision OPENAI_API_KEY.`
          : unsupportedCodexModel
            ? `${cliName.toUpperCase()} model "${sanitizeModelNameForMessage(options.models?.codex)}" is not supported by this Codex account.`
            : this.isTimeoutError(execError)
              ? `${cliName.toUpperCase()} execution timed out after ${timeout}ms. See internal logs for details.`
              : `${cliName.toUpperCase()} execution failed. See internal logs for details.`;

      // Emit error event. The content derives from the redacted
      // `errorMsg` above, never from `error.message` directly, so
      // streaming observers (HTTP SSE, MCP notifications) do not
      // receive raw CLI payload fragments.
      if (options.onStreamingEvent) {
        options.onStreamingEvent({
          type: 'agent_error',
          agent: cliName,
          content: `${cliName.toUpperCase()} failed: ${errorMsg}`,
          timestamp: Date.now(),
          sessionId: options.sessionId
        });
      }

      return {
        agent: cliName,
        clientId,
        success: false,
        output: '',
        error: errorMsg,
        executionTime: Date.now() - startTime,
        command: `(redacted command for ${cliName})`,
        workingDirectory: workingDir,
        exitCode,
        model: built?.model
      };
    } finally {
      // Clean up the temp MCP config file when the Claude adapter
      // wrote one. The Claude path always uses `writeClaudeMcpConfigSecure`
      // when MCP is enabled, so `tempMcpConfigPath` is set whenever the
      // run had `--mcp-config <path>` on argv. When MCP is disabled
      // (no servers requested) the adapter never writes a file and
      // this finally is a no-op.
      if (tempMcpConfigPath) {
        await cleanupTempConfig(tempMcpConfigPath);
      }
      // Clean up the agy oversized-prompt spill file (scratch dir). Reuses
      // cleanupTempConfig's ENOENT-tolerant unlink. `built` is hoisted, so
      // this runs whether the spawn succeeded, failed, or threw.
      if (built?.tempPromptPath) {
        await cleanupTempConfig(built.tempPromptPath);
      }
    }
  }

  // Per-provider execution methods — thin wrappers via adapter dispatch.
  // Retained for backward compatibility (tests may reference these).
  async executeClaudeCode(
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    return this._executeCLI(
      'claude',
      userPrompt,
      systemPromptSpec,
      options,
      (user, sys, opts) => this.buildCLICommand('claude', user, sys, opts)
    );
  }

  async executeCodex(
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    return this._executeCLI(
      'codex',
      userPrompt,
      systemPromptSpec,
      options,
      (user, sys, opts) => this.buildCLICommand('codex', user, sys, opts)
    );
  }

  async executeSingleCLI(
    cli: 'claude' | 'codex' | 'agy',
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    // Wait for available slot to prevent resource exhaustion
    await this.waitForAvailableSlot();

    this.runningCLIs++;
    this.emitLog().info(`\u{1F3AF} Executing ${cli} (${this.runningCLIs}/${this.MAX_CONCURRENT_CLIS} slots used)`);

    try {
      // Dispatch to adapter via buildCLICommand (which delegates to provider)
      const response = await this._executeCLI(
        cli,
        userPrompt,
        systemPromptSpec,
        options,
        (user, sys, opts) => this.buildCLICommand(cli, user, sys, opts)
      );

      const requestedCodexModel = options.models?.codex;
      if (cli === 'codex' && isCodexUnsupportedModelResponse(response, requestedCodexModel)) {
        this.emitLog().warn('Codex model unsupported for this account; retrying with CLI default', {
          requestedModel: sanitizeModelNameForMessage(requestedCodexModel),
        });

        const fallbackModels = { ...(options.models || {}) };
        delete fallbackModels.codex;
        const fallbackOptions: CLIAgentOptions = {
          ...options,
          models: Object.keys(fallbackModels).length > 0 ? fallbackModels : undefined,
        };

        const fallback = await this._executeCLI(
          cli,
          userPrompt,
          systemPromptSpec,
          fallbackOptions,
          (user, sys, opts) => this.buildCLICommand(cli, user, sys, opts)
        );

        if (fallback.success) {
          const note = `Codex model "${sanitizeModelNameForMessage(requestedCodexModel)}" is not available for this account; retried with the Codex CLI default.`;
          fallback.output = fallback.output ? `${note}\n\n${fallback.output}` : note;
        } else {
          fallback.error = `${response.error} Retried with the Codex CLI default, which also failed: ${fallback.error || 'unknown error'}`;
        }
        return fallback;
      }

      return response;
    } finally {
      this.runningCLIs--;
      this.emitLog().info(`\u2705 Released CLI slot (${this.runningCLIs}/${this.MAX_CONCURRENT_CLIS} slots used)`);
    }
  }

  private async waitForAvailableSlot(): Promise<void> {
    let waitTime = 100; // Start with 100ms wait time
    while (this.runningCLIs >= this.MAX_CONCURRENT_CLIS) {
      this.emitLog().info(`⏳ Waiting for available CLI slot (${this.runningCLIs}/${this.MAX_CONCURRENT_CLIS} in use). Next check in ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      waitTime = Math.min(waitTime * 2, 5000); // Exponential backoff, max 5 seconds
    }
  }

  async executeCLIAgents(
    cliAgents: string[],
    systemPrompt: string,
    userPrompt: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse[]> {
    const validAgents = cliAgents.filter(agent =>
      ['claude', 'codex', 'agy'].includes(agent)
    ) as ('claude' | 'codex' | 'agy')[];

    if (validAgents.length === 0) {
      return [];
    }

    // Execute all CLIs in parallel with Promise.allSettled
    const promises = validAgents.map(async (agent) => {
      try {
        return await this.executeCLIAgent(agent, systemPrompt, userPrompt, options);
      } catch (error) {
        return {
          agent,
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error),
          executionTime: 0,
          command: `${agent} execution failed`,
          workingDirectory: options.workingDirectory || process.cwd(),
          exitCode: -1
        } as CLIAgentResponse;
      }
    });

    const results = await Promise.allSettled(promises);
    return results
      .filter((result): result is PromiseFulfilledResult<CLIAgentResponse> =>
        result.status === 'fulfilled'
      )
      .map(result => result.value);
  }

  async executeCLIAgent(
    agent: string,
    systemPrompt: string,
    userPrompt: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    if (!['claude', 'codex', 'agy'].includes(agent)) {
      throw new Error(`Unsupported CLI agent: ${agent}`);
    }

    return await this.executeSingleCLI(agent as 'claude' | 'codex' | 'agy', userPrompt, systemPrompt, options);
  }

  async executeBrutalistAnalysis(
    analysisType: BrutalistPromptType,
    primaryContent: string,
    systemPromptSpec: string,
    context?: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse[]> {
    // Only validate filesystem paths for tools that actually operate on files/directories
    // NOTE: Must match BrutalistPromptType values (camelCase)
    const filesystemTools = ['codebase', 'fileStructure', 'dependencies', 'gitHistory', 'testCoverage'];

    this.emitLog().debug(`Validation check: analysisType="${analysisType}", isFilesystemTool=${filesystemTools.includes(analysisType)}`);

    try {
      if (filesystemTools.includes(analysisType) && primaryContent && primaryContent.trim() !== '') {
        this.emitLog().debug(`Validating path: "${primaryContent}"`);
        await asyncValidatePath(primaryContent, 'targetPath');
      }
    } catch (error) {
      this.emitLog().error(`Path validation failed: ${error}`);
      throw new Error(`Security validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Validate workingDirectory if provided
    try {
      if (options.workingDirectory) {
        await asyncValidatePath(options.workingDirectory, 'workingDirectory');
      }
    } catch (error) {
      throw new Error(`Security validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    const userPrompt = this.constructUserPrompt(analysisType, primaryContent, context);

    const explicitClients = options.clients && options.clients.length > 0
      ? options.clients.map((client) => ({
          ...client,
          id: sanitizeClientId(client.id),
        }))
      : undefined;
    const envClients = explicitClients ? [] : parseDefaultClientsFromEnv(this.emitLog());

    // C1: native critic selection is computed INDEPENDENTLY of clients[].
    // clients[] is ADDITIVE — to run only the named clients, pass an
    // explicit empty clis:[]. Omitting clis => all available native CLIs.
    let clisToUse: ('claude' | 'codex' | 'agy')[];
    if (options.clis) {
      // Explicit (possibly empty) native selection — validate availability.
      const unavailable = options.clis.filter(cli => !this.cliContext.availableCLIs.includes(cli));
      if (unavailable.length > 0) {
        throw new Error(
          `Requested CLIs not available: ${unavailable.join(', ')}. ` +
          `Available: ${this.cliContext.availableCLIs.join(', ')}`
        );
      }
      clisToUse = [...new Set(options.clis)];
    } else {
      clisToUse = [...this.cliContext.availableCLIs];
    }

    const executionSpecs: CLIClientSpec[] = [
      ...clisToUse.map((cli) => ({ id: cli, provider: cli } as CLIClientSpec)),
      ...(explicitClients ?? []),
      ...envClients,
    ];

    // C4: dedup by id, keep-first. Guards against a routed client
    // impersonating a native one (e.g. {id:'claude', baseUrl:...}) — the
    // real native critic wins and the duplicate is dropped.
    const seenIds = new Set<string>();
    const dedupedSpecs = executionSpecs.filter((s) => {
      if (seenIds.has(s.id)) {
        this.emitLog().warn(`Dropping duplicate CLI client id: ${s.id}`);
        return false;
      }
      seenIds.add(s.id);
      return true;
    });

    const unavailableClients = dedupedSpecs.filter(
      (client) => !this.cliContext.availableCLIs.includes(client.provider)
    );
    if (unavailableClients.length > 0) {
      throw new Error(
        `Requested CLI clients not available: ${unavailableClients.map(c => `${c.id} (${c.provider})`).join(', ')}. ` +
        `Available: ${this.cliContext.availableCLIs.join(', ')}`
      );
    }

    if (dedupedSpecs.length === 0) {
      throw new Error('No CLI agents available for analysis');
    }

    // A4: normalize routing once (auth isolation, small-fast-model, config
    // dir) and provision per-client isolated config dirs so concurrent
    // claude processes never contend on the shared ~/.claude state.
    const normalizedSpecs = dedupedSpecs.map((s) => normalizeClaudeClient(s, process.env, this.emitLog()));
    await Promise.all(
      normalizedSpecs
        .filter((s) => s.routingMode === 'routed' && s.resolvedConfigDir && !s.configDir)
        .map((s) => fs.mkdir(s.resolvedConfigDir!, { recursive: true, mode: 0o700 }).catch((e) =>
          this.emitLog().warn('Failed to provision client configDir', { clientId: s.id, error: String(e) })
        ))
    );

    const selectionMethod = explicitClients ? 'client-specified' : (options.clis ? 'user-specified' : 'all-available');

    // D1: pre-flight routed clients (reachability + auth) so a dead/401
    // gateway fails fast WITH attribution instead of burning the full
    // per-critic timeout — which in the action would repeat per diff chunk.
    const probes = await Promise.all(
      normalizedSpecs
        .filter((s) => isRoutedClient(s))
        .map(async (s) => ({ s, result: await preflightRoutedClient(s, this.emitLog()) }))
    );
    const deadProbes = probes.filter((p) => !p.result.ok);
    const deadIds = new Set(deadProbes.map((p) => p.s.id));
    const liveSpecs = normalizedSpecs.filter((s) => !deadIds.has(s.id));
    const preflightFailures: CLIAgentResponse[] = deadProbes.map(({ s, result }) => ({
      agent: s.provider,
      clientId: s.id,
      success: false,
      output: '',
      error: `pre-flight ${(result as { reason: string; detail: string }).reason}: ${(result as { detail: string }).detail}`,
      executionTime: 0,
      selectionMethod,
      analysisType,
    } as CLIAgentResponse));
    if (deadProbes.length > 0) {
      this.emitLog().warn(`⚠️ ${deadProbes.length} routed client(s) failed pre-flight: ${deadProbes.map(p => p.s.id).join(', ')}`);
    }

    this.emitLog().info(`📊 Executing ${liveSpecs.length} CLI client(s): ${liveSpecs.map(c => `${c.id}:${c.provider}`).join(', ')} (${selectionMethod})`);

    // Execute selected CLIs in parallel with allSettled for better error handling
    const promises = liveSpecs.map(async (client) => {
      const cli = client.provider;
      try {
        const response = await this.executeSingleCLI(cli, userPrompt, systemPromptSpec, {
          ...options,
          activeClient: client,
          workingDirectory: client.workingDirectory || options.workingDirectory,
          timeout: client.timeout || options.timeout,
          mcpServers: client.mcpServers || options.mcpServers,
        });
        return {
          ...response,
          selectionMethod,
          analysisType
        } as CLIAgentResponse;
      } catch (error) {
        this.emitLog().error(`❌ ${cli} execution failed:`, error);
        return {
          agent: cli,
          clientId: client.id,
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error),
          executionTime: 0,
          selectionMethod,
          analysisType
        } as CLIAgentResponse;
      }
    });

    // Use allSettled to handle partial failures gracefully
    const results = await Promise.allSettled(promises);
    const responses: CLIAgentResponse[] = results
      .filter(result => result.status === 'fulfilled')
      .map(result => (result as PromiseFulfilledResult<CLIAgentResponse>).value);

    // Surface pre-flight failures as attributed failed critics alongside
    // the live runs so the orchestrator/summary names the dead client.
    const allResponses = [...responses, ...preflightFailures];

    this.emitLog().info(`✅ CLI analysis complete: ${allResponses.filter(r => r.success).length}/${allResponses.length} successful`);

    return allResponses;
  }


  /**
   * Render the per-critic failure blocks shared by the all-failed and
   * partial-failure synthesis paths. Emits the canonical
   * BRUTALIST_CLI_BEGIN / optional BRUTALIST_CLI_CLIENT / END markers so a
   * failure is attributed to its named client — a lone GLM failure must not
   * read as bare CLAUDE (D4) — and shows "glm (CLAUDE)" only when the client
   * id differs from the provider (no redundant "claude (CLAUDE)").
   */
  private renderFailedCriticBlocks(failed: CLIAgentResponse[]): string {
    return failed.map(r => {
      const model = sanitizeMarkerField(r.model ?? '');
      const clientId = r.clientId ?? r.agent;
      const display = clientId === r.agent
        ? r.agent.toUpperCase()
        : `${clientId} (${r.agent.toUpperCase()})`;
      let block = `<!-- BRUTALIST_CLI_BEGIN cli="${r.agent}" model="${model}" exec_ms="${r.executionTime}" success="false" -->\n`;
      if (clientId !== r.agent) {
        block += `<!-- BRUTALIST_CLI_CLIENT id="${clientId}" -->\n`;
      }
      block += `- **${display}**: ${sanitizeMarkerField(r.error ?? '')}\n`;
      block += `<!-- BRUTALIST_CLI_END cli="${r.agent}" -->\n`;
      return block;
    }).join('');
  }

  synthesizeBrutalistFeedback(responses: CLIAgentResponse[], analysisType: string): string {
    const successfulResponses = responses.filter(r => r.success);
    const failedResponses = responses.filter(r => !r.success);

    if (successfulResponses.length === 0) {
      return `# Brutalist Analysis Failed\n\n❌ All CLI agents failed to analyze\n\n${this.renderFailedCriticBlocks(failedResponses)}`.trim();
    }

    const noun = successfulResponses.length === 1 ? 'critic' : 'critics';
    let synthesis = `${successfulResponses.length} AI ${noun} have systematically demolished your work.\n\n`;

    // Deterministic per-CLI section delimiters. Downstream parsers
    // (orchestrators extracting Finding[] from MCP responses) match the
    // BRUTALIST_CLI_BEGIN/END HTML comments instead of regex-fragile
    // ordinal headers like "## Critic 1: CLAUDE". The metadata in the
    // BEGIN comment (cli, model, exec_ms, success) is the canonical
    // source of truth; the markdown header below it is for human display.
    successfulResponses.forEach((response) => {
      const model = sanitizeMarkerField(response.model ?? '');
      const clientId = response.clientId ?? response.agent;
      synthesis += `<!-- BRUTALIST_CLI_BEGIN cli="${response.agent}" model="${model}" exec_ms="${response.executionTime}" success="true" -->\n`;
      if (clientId !== response.agent) {
        synthesis += `<!-- BRUTALIST_CLI_CLIENT id="${clientId}" -->\n`;
      }
      const displayName = clientId === response.agent
        ? response.agent.toUpperCase()
        : `${clientId} (${response.agent.toUpperCase()})`;
      synthesis += `### CLI: ${displayName} *(${model || 'default'} · ${response.executionTime}ms)*\n\n`;
      synthesis += response.output;
      synthesis += `\n\n<!-- BRUTALIST_CLI_END cli="${response.agent}" -->\n\n`;
    });

    if (failedResponses.length > 0) {
      synthesis += `## Failed Critics\n`;
      const failNoun = failedResponses.length === 1 ? 'critic' : 'critics';
      synthesis += `${failedResponses.length} ${failNoun} failed to complete their destruction:\n`;
      synthesis += this.renderFailedCriticBlocks(failedResponses);
      synthesis += '\n';
    }

    return synthesis.trim();
  }

  private constructUserPrompt(
    analysisType: string, 
    primaryContent: string, 
    context?: string
  ): string {
    // Trust CLI tools to handle their own security
    const sanitizedContent = primaryContent;

    // Deterministic diff scoping. The orchestrator injects the PR diff so
    // scoping does NOT depend on the brain relaying the diff verbatim in the
    // roast `context` arg. Without this, a brain that paraphrases the diff
    // leaves critics — especially agy's agentic loop — auditing the WHOLE
    // repo until the per-critic timeout (observed: agy hit the 900s cap on a
    // one-file change). If the brain already supplied a diff in `context`,
    // keep it; otherwise fold in the injected one.
    //
    // Channel preference: BRUTALIST_PR_DIFF_FILE (a path) over the legacy
    // BRUTALIST_PR_DIFF (inline). The file form exists because a large diff
    // (max-diff-chars defaults to 2,000,000) cannot ride in an env var — a
    // single env string is OS-capped at ~128 KB (MAX_ARG_STRLEN), so an
    // inline multi-MB diff makes the spawn of THIS very subprocess throw
    // `spawn E2BIG`. Reading it from a file sidesteps that ceiling. The
    // inline var remains a fallback for small diffs / older orchestrators.
    let injectedDiff = '';
    const injectedDiffFile = (process.env.BRUTALIST_PR_DIFF_FILE || '').trim();
    if (injectedDiffFile) {
      try {
        injectedDiff = readFileSync(injectedDiffFile, 'utf-8').trim();
      } catch (e) {
        this.emitLog().warn('Failed to read BRUTALIST_PR_DIFF_FILE; falling back to inline diff', {
          code: (e as NodeJS.ErrnoException)?.code ?? 'unknown',
        });
      }
    }
    if (!injectedDiff) {
      injectedDiff = (process.env.BRUTALIST_PR_DIFF || '').trim();
    }
    const contextHasDiff = !!context && (/diff --git /.test(context) || /(^|\n)@@ .+ @@/.test(context));
    const effectiveContext = (!contextHasDiff && injectedDiff)
      ? (context ? `${context}\n\n${injectedDiff}` : injectedDiff)
      : context;
    const sanitizedContext = effectiveContext || 'No additional context provided';

    // A unified diff marks this as a change/PR review. Direct critics to
    // focus on the changed files instead of auditing the whole tree:
    // "Analyze the codebase directory" otherwise makes every critic
    // (claude/codex/agy) explore the entire repo agentically. Scoping here
    // covers ALL critics (the agy adapter adds further anti-wander framing).
    const hasDiff = !!effectiveContext && (/diff --git /.test(effectiveContext) || /(^|\n)@@ .+ @@/.test(effectiveContext));

    const prompts = {
      code: hasDiff
        ? `Review the code change for issues. The code is at ${sanitizedContent}; read the changed files there for context, but scope your review to what the change touches — do not audit the whole codebase.`
        : `Analyze the codebase at ${sanitizedContent} for issues.`,
      codebase: hasDiff
        ? `Review the code change for security vulnerabilities, performance issues, and architectural problems. The repository is at ${sanitizedContent}; read the changed files there for context, but scope your review to what the change touches — do not audit the entire codebase.`
        : `Analyze the codebase directory at ${sanitizedContent} for security vulnerabilities, performance issues, and architectural problems.`,
      architecture: `Review the architecture: ${sanitizedContent}. Find every scaling failure and cost explosion.`,
      idea: `Analyze this idea: ${sanitizedContent}. Find where imagination fails to become reality.`,
      research: `Review this research: ${sanitizedContent}. Find every methodological flaw and reproducibility issue.`,
      data: `Analyze this data/model: ${sanitizedContent}. Find every overfitting issue, bias, and correlation fallacy.`,
      security: `Security audit of: ${sanitizedContent}. Find every attack vector and vulnerability.`,
      product: `Product review: ${sanitizedContent}. Find every UX disaster and adoption barrier.`,
      infrastructure: `Infrastructure review: ${sanitizedContent}. Find every single point of failure.`,
      debate: `Debate topic: ${sanitizedContent}. Take opposing positions and argue until truth emerges.`,
      fileStructure: `Analyze the directory structure at ${sanitizedContent}. Find organizational disasters and naming failures.`,
      dependencies: `Analyze dependencies at ${sanitizedContent}. Find version conflicts and security vulnerabilities.`,
      gitHistory: `Analyze git history at ${sanitizedContent}. Find commit disasters and workflow failures.`,
      testCoverage: `Analyze test coverage at ${sanitizedContent}. Find testing gaps and quality issues.`
    };

    const specificPrompt = prompts[analysisType as keyof typeof prompts] || `Analyze ${sanitizedContent} for ${analysisType} issues.`;

    return `${specificPrompt} ${effectiveContext ? `Context: ${sanitizedContext}` : ''}`;
  }
}
