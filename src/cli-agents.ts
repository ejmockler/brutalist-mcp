import { spawn, exec } from 'child_process';
import { promises as fs, realpathSync } from 'fs';
import { promisify } from 'util';
import path from 'path';
import { logger } from './logger.js';
import type { StructuredLogger } from './logger.js';
import { CLIAgentResponse } from './types/brutalist.js';
import { ModelResolver } from './model-resolver.js';
import {
  cleanupTempConfig,
} from './mcp-registry.js';
import { getProvider, parseNDJSON } from './cli-adapters/index.js';
import type { CLIName } from './cli-adapters/index.js';
import { GEMINI_FRONTIER_CHAIN } from './cli-adapters/gemini-adapter.js';
import type { MetricsRegistry } from './metrics/index.js';
import { CLI_SPAWN_LABELS, safeMetric } from './metrics/index.js';

/**
 * Detect errors where rotating to the next Gemini frontier tier is likely
 * to succeed. Covers two failure families:
 *
 *   1. Capacity saturation on the current tier
 *      (429 / "No capacity available" / quota / rate-limit).
 *
 *   2. Access denial on the current tier — the model exists but the
 *      user's account lacks preview-tier access. Appears as
 *      ModelNotFoundError / "Requested entity was not found" / 403 /
 *      "permission denied". In production the frontier chain is
 *      probe-tested (not user-typos), so these errors mean "this tier
 *      is unavailable to THIS caller" — which is exactly when rotation
 *      to the next tier should fire. Dropping from a pro preview down
 *      to `gemini-3-flash-preview` (the chain floor) trades pro-tier
 *      reasoning for flash-tier latency/cost while still keeping
 *      Pro-grade quality per Google's 3-Flash positioning.
 *
 * Does NOT match: auth failures (missing/invalid API key), prompt-safety
 * rejections, or subprocess crashes — these will not differ between
 * frontier tiers.
 */
function isGeminiRotatableError(error?: string): boolean {
  if (!error) return false;
  return /no capacity available|\b429\b|overloaded|rateLimitExceeded|rate limit|quota|too many requests|ModelNotFoundError|Requested entity was not found|\b403\b|permission denied|access denied/i.test(error);
}

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

    // On Windows, npm-installed CLIs (gemini, codex) are .cmd batch shims that
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
      // Other CLIs (Codex, Gemini) work fine with stdin left open
    }
  });
}

export interface CLIAgentOptions {
  workingDirectory?: string;
  timeout?: number;
  clis?: ('claude' | 'codex' | 'gemini')[];
  analysisType?: BrutalistPromptType;
  models?: {
    claude?: string;
    codex?: string;
    gemini?: string;
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
  agent: 'claude' | 'codex' | 'gemini' | 'system';
  content?: string;
  timestamp: number;
  sessionId?: string;
  metadata?: Record<string, any>;
}

export interface CLIContext {
  availableCLIs: ('claude' | 'codex' | 'gemini')[];
}

export class CLIAgentOrchestrator {
  private defaultTimeout = 1800000; // 30 minutes - complex codebases need time
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

  private extractGeminiResponse(jsonOutput: string): string {
    const provider = getProvider('gemini');
    return provider.decodeOutput(jsonOutput, ['--output-format', 'json']);
  }

  private emitThrottledStreamingEvent(
    agent: 'claude' | 'codex' | 'gemini',
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

    const availableCLIs: ('claude' | 'codex' | 'gemini')[] = [];

    // Check for available CLIs
    const cliChecks = [
      { name: 'claude' as const, command: 'claude --version' },
      { name: 'codex' as const, command: 'codex --version' },
      { name: 'gemini' as const, command: 'gemini --version' }
    ];

    // NOTE: These `--version` probes are NOT spawn attempts — they must not
    // increment `cliSpawnTotal`. Only _executeCLI counts spawns.
    const results = await Promise.allSettled(cliChecks.map(async (check) => {
      try {
        await spawnAsync(check.name, ['--version'], { timeout: CLI_CHECK_TIMEOUT });
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
    preferredCLI?: 'claude' | 'codex' | 'gemini',
    analysisType?: BrutalistPromptType
  ): 'claude' | 'codex' | 'gemini' {
    // 1. Honor explicit preference if available
    if (preferredCLI && this.cliContext.availableCLIs.includes(preferredCLI)) {
      this.emitLog().info(`✅ Using preferred CLI: ${preferredCLI}`);
      return preferredCLI;
    }

    // 2. Smart selection based on analysis type
    const selectionRules: Record<string, ('claude' | 'codex' | 'gemini')[]> = {
      'code': ['claude', 'codex', 'gemini'],
      'architecture': ['gemini', 'claude', 'codex'],
      'research': ['claude', 'gemini', 'codex'],
      'security': ['codex', 'claude', 'gemini'],
      'data': ['gemini', 'claude', 'codex'],
      'product': ['claude', 'gemini', 'codex'],
      'infrastructure': ['gemini', 'codex', 'claude'],
      'idea': ['claude', 'gemini', 'codex'],
      'debate': ['claude', 'gemini', 'codex'],
      'default': ['claude', 'gemini', 'codex']
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
    cliName: 'claude' | 'codex' | 'gemini',
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions = {},
    commandBuilder: (userPrompt: string, systemPromptSpec: string, options: CLIAgentOptions) => Promise<{ command: string; args: string[]; env?: Record<string, string>; input?: string; tempMcpConfigPath?: string; model?: string }>
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    const workingDir = options.workingDirectory || this.defaultWorkingDir;
    const timeout = options.timeout || this.defaultTimeout;
    let tempMcpConfigPath: string | undefined;
    // Hoisted so the catch branch can read `built?.model` for response
    // attribution. Undefined when commandBuilder itself threw before
    // resolving a model, which is the right semantics for the response.
    let built: Awaited<ReturnType<typeof commandBuilder>> | undefined;

    // Provider label for the spawn counter. Derived from cliName so the
    // label set stays in sync with the 'claude' | 'codex' | 'gemini' union
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
      this.emitLog().info(`🤖 Executing ${cliName.toUpperCase()} CLI`);
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
      // with MCP registry entries.
      const hasMcpConfig = !!(options.mcpServers && options.mcpServers.length > 0);
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
      // logger through decodeOutput so adapter warnings/errors carry
      // module=cli-orchestrator + operation=<provider>_spawn context.
      let finalOutput = stdout;
      const providerAdapter = getProvider(cliName);
      const decodeLog = this.log?.forOperation(`${cliName}_spawn`);
      const decodedText = providerAdapter.decodeOutput(stdout, args, decodeLog);
      if (decodedText) {
        finalOutput = decodedText;
      }

      // Fallback: If stdout is empty but stderr has content and exit was successful,
      // Claude might have written to stderr (common in non-TTY environments)
      if (!finalOutput.trim() && stderr && stderr.trim()) {
        this.emitLog().info(`📝 Using stderr as output for ${cliName} (stdout was empty)`);
        finalOutput = stderr;
      }

      // Detect CLI errors that exit 0 but contain fatal error output
      // (e.g., Gemini CLI returns exit code 0 on quota exhaustion,
      //  Codex CLI may return usage limit errors in output)
      const combinedOutput = `${finalOutput}\n${stderr}`;
      const quotaPatterns = [
        /TerminalQuotaError/i,
        /exhausted your capacity/i,
        /quota will reset/i,
        /rateLimitExceeded/i,
        /rate limit/i,
        /usage limit/i,
        /Too Many Requests/i,
        /\b429\b/,
        /token limit exceeded/i,
        /billing.*limit/i,
        /spending.*limit/i,
        /plan.*limit/i,
      ];
      const quotaMatch = quotaPatterns.find(p => p.test(combinedOutput));
      if (quotaMatch) {
        // Extract reset time if present
        const resetMatch = combinedOutput.match(/reset(?:s)? (?:in|after) (\d+h\s*\d+m(?:\s*\d+s)?)/i);
        const resetInfo = resetMatch ? ` (resets in ${resetMatch[1]})` : '';
        const errorMsg = `${cliName.toUpperCase()} quota exhausted${resetInfo}. The CLI exited 0 but returned a quota error instead of analysis output.`;
        this.emitLog().warn(`⏱️ ${errorMsg}`);

        if (options.onStreamingEvent) {
          options.onStreamingEvent({
            type: 'agent_error',
            agent: cliName,
            content: errorMsg,
            timestamp: Date.now(),
            sessionId: options.sessionId
          });
        }

        // Spawn counter: outcome=refused (quota exhaustion — CLI exited 0
        // with a quota error in stdout/stderr). Labels annotated against
        // CLI_SPAWN_LABELS so a future label-set change fails at compile
        // time. Wrapped in `safeMetric` so a label-validation throw or
        // other metric-layer exception cannot propagate into the outer
        // spawn try/catch and be misclassified as a spawn failure
        // (Cycle 3 Task CLI-B' — parity with debate's safeMetric).
        const quotaLabels: Record<(typeof CLI_SPAWN_LABELS)[number], string> = {
          provider,
          outcome: 'refused',
        };
        safeMetric(this.emitLog(), 'cliSpawnTotal.inc(refused:quota)', () => {
          this.metrics?.cliSpawnTotal.inc(quotaLabels, 1);
        });

        return {
          agent: cliName,
          success: false,
          output: '',
          error: errorMsg,
          executionTime: Date.now() - startTime,
          // Cycle 4 Task T18 (F9): match the failure-path redaction
          // parity — `command` is a diagnostic display field; the
          // static placeholder preserves the response shape without
          // leaking raw command + args (which may include Codex TOML
          // MCP overrides, Claude temp config paths, or prompt
          // fragments that crossed the trust boundary).
          command: `(redacted command for ${cliName})`,
          workingDirectory: workingDir,
          exitCode: 0,
          model: built?.model
        };
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

      // Detect rate limiting / usage limit errors across all CLIs
      const rateLimitPatterns = [
        '429', 'rate limit', 'rate_limit', 'rateLimitExceeded',
        'Too Many Requests', 'usage limit', 'usage_limit',
        'quota', 'exhausted', 'billing', 'spending limit',
        'token limit', 'plan limit',
      ];
      const errorText = `${execError.message || ''} ${execError.stdout || ''} ${execError.stderr || ''}`.toLowerCase();
      const isRateLimit = rateLimitPatterns.some(p => errorText.includes(p.toLowerCase()));
      const unsupportedCodexModel = cliName === 'codex'
        && isCodexUnsupportedChatGPTModelError(execError, options.models?.codex);

      // Classify outcome for the spawn counter. Priority: rate-limit > timeout
      // > generic failure. Timeout check uses the centralized heuristic.
      // Classification priority is unchanged; the emission is gated on
      // `spawned` so pre-spawn failures (e.g., commandBuilder throwing)
      // do NOT increment the counter (compose.py:174).
      let outcome: 'refused' | 'timeout' | 'failure';
      if (isRateLimit) {
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
      // Clean up temp MCP config file (Claude flag-file method)
      if (tempMcpConfigPath) {
        await cleanupTempConfig(tempMcpConfigPath);
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

  async executeGemini(
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    return this._executeCLI(
      'gemini',
      userPrompt,
      systemPromptSpec,
      options,
      (user, sys, opts) => this.buildCLICommand('gemini', user, sys, opts)
    );
  }

  async executeSingleCLI(
    cli: 'claude' | 'codex' | 'gemini',
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    // Wait for available slot to prevent resource exhaustion
    await this.waitForAvailableSlot();

    this.runningCLIs++;
    this.emitLog().info(`\u{1F3AF} Executing ${cli} (${this.runningCLIs}/${this.MAX_CONCURRENT_CLIS} slots used)`);

    try {
      // Gemini frontier rotation: when using the default frontier chain
      // (no caller-specified model, no env-var override), rotate through
      // GEMINI_FRONTIER_CHAIN on saturation OR access-denied failures.
      // The chain (see src/cli-adapters/gemini-adapter.ts) is two pro
      // previews followed by `gemini-3-flash-preview` as the floor. The
      // 2.5-pro fallback was removed because 3-flash ships with
      // pro-grade reasoning and is universally available; falling to it
      // beats dropping a generation back. Access-denied rotation is the
      // typical user path: pro preview tiers aren't granted to every
      // account, so the chain falls through to 3-flash. Rotation is
      // disabled when the caller or operator has explicitly chosen a
      // model (BRUTALIST_GEMINI_MODEL=... or models.gemini=...).
      const geminiRotationActive = cli === 'gemini'
        && !options.models?.gemini
        && !process.env.BRUTALIST_GEMINI_MODEL;

      if (geminiRotationActive) {
        return await this._executeGeminiWithRotation(userPrompt, systemPromptSpec, options);
      }

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

  /**
   * Gemini frontier rotation - iterate through GEMINI_FRONTIER_CHAIN on
   * rotatable failures (capacity saturation OR tier access denial).
   *
   * Only active when neither caller nor operator has chosen a model. Each
   * attempt injects the model via options.models.gemini. Per-attempt
   * failures are classified by isGeminiRotatableError(): capacity errors
   * (quota/429) AND access errors (ModelNotFoundError / permission denied)
   * both trigger rotation. On unrelated failures (auth, prompt rejection,
   * subprocess crashes) rotation stops immediately — a different model
   * will not fix those. On chain exhaustion, the last failing response
   * is returned.
   *
   * In practice the typical non-preview user trajectory is:
   *   gemini-3.1-pro-preview  -> access denied (rotate)
   *   gemini-3-pro-preview    -> access denied (rotate)
   *   gemini-3-flash-preview  -> success (3-series flash, pro-grade
   *                              reasoning, universally available as
   *                              of the model launch)
   */
  private async _executeGeminiWithRotation(
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions,
  ): Promise<CLIAgentResponse> {
    const chain = GEMINI_FRONTIER_CHAIN;
    let lastResponse: CLIAgentResponse | null = null;

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      const attemptOptions: CLIAgentOptions = {
        ...options,
        models: { ...(options.models || {}), gemini: model },
      };

      if (i > 0) {
        this.emitLog().info(`Gemini rotation: attempting tier ${i + 1}/${chain.length} (${model})`);
      }

      const response = await this._executeCLI(
        'gemini',
        userPrompt,
        systemPromptSpec,
        attemptOptions,
        (user, sys, opts) => this.buildCLICommand('gemini', user, sys, opts),
      );

      if (response.success) {
        if (i > 0) {
          this.emitLog().warn(`Gemini served by ${model} after ${i} rotation${i === 1 ? '' : 's'} (tier ${i + 1}/${chain.length})`);
        } else {
          this.emitLog().debug(`Gemini served by frontier ${model}`);
        }
        return response;
      }

      if (!isGeminiRotatableError(response.error)) {
        this.emitLog().debug(`Gemini ${model} failed with non-rotatable error; aborting rotation`, {
          errorPreview: response.error?.slice(0, 120),
        });
        return response;
      }

      this.emitLog().warn(`Gemini ${model} unavailable (capacity or access); rotating to next frontier tier`);
      lastResponse = response;
    }

    this.emitLog().error(`Gemini frontier chain exhausted (${chain.length} tiers); no tier available to this account`);
    return lastResponse!;
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
    // Filter to valid CLI agents
    const validAgents = cliAgents.filter(agent =>
      ['claude', 'codex', 'gemini'].includes(agent)
    ) as ('claude' | 'codex' | 'gemini')[];

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
    if (!['claude', 'codex', 'gemini'].includes(agent)) {
      throw new Error(`Unsupported CLI agent: ${agent}`);
    }
    
    return await this.executeSingleCLI(agent as 'claude' | 'codex' | 'gemini', userPrompt, systemPrompt, options);
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

    // Determine which CLIs to use
    let clisToUse: ('claude' | 'codex' | 'gemini')[];

    if (options.clis && options.clis.length > 0) {
      // User specified which CLIs to use - validate they're available
      const unavailable = options.clis.filter(cli => !this.cliContext.availableCLIs.includes(cli));
      if (unavailable.length > 0) {
        throw new Error(
          `Requested CLIs not available: ${unavailable.join(', ')}. ` +
          `Available: ${this.cliContext.availableCLIs.join(', ')}`
        );
      }
      // Deduplicate
      clisToUse = [...new Set(options.clis)];
      this.emitLog().info(`🎯 Using user-specified CLIs: ${clisToUse.join(', ')}`);
    } else {
      // Default: use all available CLIs
      clisToUse = [...this.cliContext.availableCLIs];
      this.emitLog().info(`📋 Using all available CLIs: ${clisToUse.join(', ')}`);
    }

    if (clisToUse.length === 0) {
      throw new Error('No CLI agents available for analysis');
    }

    const selectionMethod = options.clis ? 'user-specified' : 'all-available';
    this.emitLog().info(`📊 Executing ${clisToUse.length} CLI(s): ${clisToUse.join(', ')} (${selectionMethod})`);

    // Execute selected CLIs in parallel with allSettled for better error handling
    const promises = clisToUse.map(async (cli) => {
      try {
        const response = await this.executeSingleCLI(cli, userPrompt, systemPromptSpec, options);
        return {
          ...response,
          selectionMethod,
          analysisType
        } as CLIAgentResponse;
      } catch (error) {
        this.emitLog().error(`❌ ${cli} execution failed:`, error);
        return {
          agent: cli,
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

    this.emitLog().info(`✅ CLI analysis complete: ${responses.filter(r => r.success).length}/${responses.length} successful`);
    
    return responses;
  }


  synthesizeBrutalistFeedback(responses: CLIAgentResponse[], analysisType: string): string {
    const successfulResponses = responses.filter(r => r.success);
    const failedResponses = responses.filter(r => !r.success);

    if (successfulResponses.length === 0) {
      return `# Brutalist Analysis Failed\n\n❌ All CLI agents failed to analyze\n${failedResponses.map(r => `- ${r.agent.toUpperCase()}: ${r.error}`).join('\n')}`;
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
      const model = response.model ?? '';
      synthesis += `<!-- BRUTALIST_CLI_BEGIN cli="${response.agent}" model="${model}" exec_ms="${response.executionTime}" success="true" -->\n`;
      synthesis += `### CLI: ${response.agent.toUpperCase()} *(${model || 'default'} · ${response.executionTime}ms)*\n\n`;
      synthesis += response.output;
      synthesis += `\n\n<!-- BRUTALIST_CLI_END cli="${response.agent}" -->\n\n`;
    });

    if (failedResponses.length > 0) {
      synthesis += `## Failed Critics\n`;
      const failNoun = failedResponses.length === 1 ? 'critic' : 'critics';
      synthesis += `${failedResponses.length} ${failNoun} failed to complete their destruction:\n`;
      failedResponses.forEach(r => {
        const model = r.model ?? '';
        synthesis += `<!-- BRUTALIST_CLI_BEGIN cli="${r.agent}" model="${model}" exec_ms="${r.executionTime}" success="false" -->\n`;
        synthesis += `- **${r.agent.toUpperCase()}**: ${r.error}\n`;
        synthesis += `<!-- BRUTALIST_CLI_END cli="${r.agent}" -->\n`;
      });
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
    const sanitizedContext = context || 'No additional context provided';

    const prompts = {
      code: `Analyze the codebase at ${sanitizedContent} for issues. Context: ${sanitizedContext}`,
      codebase: `Analyze the codebase directory at ${sanitizedContent} for security vulnerabilities, performance issues, and architectural problems. Context: ${sanitizedContext}`,
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
    
    return `${specificPrompt} ${context ? `Context: ${sanitizedContext}` : ''}`;
  }
}
