import { spawn, exec } from 'child_process';
import { realpathSync } from 'fs';
import { promisify } from 'util';
import path from 'path';
import { logger } from './logger.js';
import { CLIAgentResponse } from './types/brutalist.js';

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
  | 'testCoverage';

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

// Available models for each CLI - prioritizing frontier models with high capacity
export const AVAILABLE_MODELS = {
  claude: {
    default: undefined, // Uses user's configured model (respects preferences)
    aliases: ['opus', 'sonnet', 'haiku'],
    full: ['claude-opus-4-1-20250805', 'claude-sonnet-4-20250514'],
    recommended: 'opus' // Highest capacity Claude model
  },
  codex: {
    default: undefined, // Uses Codex CLI's default model (stays current automatically)
    models: ['gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5-codex', 'gpt-5', 'o4-mini'],
    recommended: 'gpt-5.1-codex-max' // Current frontier model with compaction
  },
  gemini: {
    default: undefined, // Uses Gemini CLI's default model (stays current automatically)
    models: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    recommended: 'gemini-3-pro-preview' // Current #1 on LMArena
  }
} as const;

// Security utilities for CLI execution
const MAX_PATH_DEPTH = 10; // Maximum directory depth for paths

// Validate and sanitize CLI arguments
// Note: We use spawn() with shell:false and array args, so we don't need to block
// punctuation characters. Only block truly dangerous patterns (null bytes).
// We use stdin for large content, so no arg length limit needed (OS limit is ~1MB anyway).
function validateArguments(args: string[]): void {
  for (const arg of args) {
    // Check for null bytes (can terminate strings prematurely)
    if (arg.includes('\0')) {
      throw new Error('Argument contains null byte');
    }
  }
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

// Create secure environment for CLI processes
function createSecureEnvironment(): Record<string, string> {
  // Minimal environment whitelist
  const SAFE_ENV_VARS = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'TZ',
    'NODE_ENV'
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

    const child = spawn(command, args, {
      cwd: cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, // CRITICAL: disable shell to prevent injection
      detached: false, // Run all CLIs non-detached for consistent behavior
      env: secureEnv,
      // Additional security options
      uid: process.getuid ? process.getuid() : undefined, // Maintain current user ID
      gid: process.getgid ? process.getgid() : undefined  // Maintain current group ID
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
  preferredCLI?: 'claude' | 'codex' | 'gemini';
  analysisType?: BrutalistPromptType;
  models?: {
    claude?: string;
    codex?: string;
    gemini?: string;
  };
  onStreamingEvent?: (event: StreamingEvent) => void;
  progressToken?: string | number;
  onProgress?: (progress: number, total: number, message: string) => void;
  sessionId?: string; // Session context for security
  requestId?: string; // Unique request identifier
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
  
  // Streaming throttle properties
  private streamingBuffers = new Map<string, { chunks: string[], lastFlush: number }>();
  private readonly STREAMING_FLUSH_INTERVAL = 200; // 200ms
  private readonly MAX_CHUNK_SIZE = 2048; // 2KB per event

  constructor() {
    // Log configuration at startup
    logger.info(`🔧 Brutalist MCP Configuration:`);
    logger.info(`  - Default timeout: ${DEFAULT_TIMEOUT}ms`);
    logger.info(`  - CLI check timeout: ${CLI_CHECK_TIMEOUT}ms`);
    logger.info(`  - Max buffer size: ${MAX_BUFFER_SIZE} bytes`);
    logger.info(`  - Max concurrent CLIs: ${MAX_CONCURRENT_CLIS}`);
    
    // Detect CLI context at startup and cache it
    this.detectCLIContext().catch(error => {
      logger.error("Failed to detect CLI context at startup:", error);
    });
  }

  private parseClaudeStreamOutput(chunk: string, options: CLIAgentOptions): string | null {
    // Parse Claude's stream-json output to extract only model content
    try {
      const jsonChunk = JSON.parse(chunk.trim());
      
      if (jsonChunk.type === 'assistant' && jsonChunk.message?.content) {
        // Extract text content from assistant messages
        const textContent = jsonChunk.message.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
        
        if (textContent.trim()) {
          return textContent;
        }
      }
      
      // Ignore system messages, init messages, etc.
      return null;
    } catch (e) {
      // Not JSON, return as-is for non-streaming mode
      return chunk;
    }
  }
  
  // Decode Claude's stream-json NDJSON output into plain text
  private decodeClaudeStreamJson(ndjsonOutput: string): string {
    if (!ndjsonOutput || !ndjsonOutput.trim()) {
      return '';
    }
    
    const textParts: string[] = [];
    const lines = ndjsonOutput.split('\n');
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const event = JSON.parse(line);
        
        // Handle different event types from Claude's stream-json format
        if (event.type === 'message' && event.message?.content) {
          // Full message event
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === 'text' && item.text) {
                textParts.push(item.text);
              }
            }
          }
        } else if (event.type === 'content_block_delta' && event.delta?.text) {
          // Incremental text delta
          textParts.push(event.delta.text);
        } else if (event.type === 'assistant' && event.message?.content) {
          // Assistant message format (same as parseClaudeStreamOutput)
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === 'text' && item.text) {
                textParts.push(item.text);
              }
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
        continue;
      }
    }
    
    return textParts.join('');
  }

  // Extract only the agent messages from Codex JSON output (no thinking, no file reads, no commands)
  private extractCodexAgentMessage(jsonOutput: string): string {
    if (!jsonOutput || !jsonOutput.trim()) {
      logger.debug('extractCodexAgentMessage: empty input');
      return '';
    }

    const agentMessages: string[] = [];
    const lines = jsonOutput.split('\n');

    logger.debug(`extractCodexAgentMessage: processing ${lines.length} lines`);

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);

        logger.debug(`extractCodexAgentMessage: parsed event type=${event.type}, item.type=${event.item?.type}`);

        // Codex --json outputs events with structure: {"type":"item.completed","item":{...}}
        // Only extract agent_message type - this is the actual response
        if (event.type === 'item.completed' && event.item) {
          if (event.item.type === 'agent_message' && event.item.text) {
            // Agent's actual response text
            logger.info(`✅ extractCodexAgentMessage: found agent_message with ${event.item.text.length} chars`);
            agentMessages.push(event.item.text);
          }
          // Skip all other types:
          // - reasoning: internal thinking steps
          // - command_execution: file reads, bash commands
          // - error: will be in stderr
        }
      } catch (e) {
        // Skip non-JSON lines (config output, prompts, etc.)
        logger.debug(`extractCodexAgentMessage: failed to parse line: ${line.substring(0, 50)}`);
        continue;
      }
    }

    const result = agentMessages.join('\n\n').trim();
    logger.info(`extractCodexAgentMessage: extracted ${agentMessages.length} messages, total ${result.length} chars`);
    return result;
  }

  private emitThrottledStreamingEvent(
    agent: 'claude' | 'codex' | 'gemini',
    type: 'agent_progress' | 'agent_error',
    content: string,
    onStreamingEvent?: (event: StreamingEvent) => void,
    options?: CLIAgentOptions
  ) {
    if (!onStreamingEvent) return;

    // Filter Claude stream output to only show model content
    let processedContent = content;
    if (agent === 'claude' && options?.progressToken) {
      const filtered = this.parseClaudeStreamOutput(content, options);
      if (!filtered) return; // Skip non-content events
      processedContent = filtered;
    }

    // Use requestId to prevent buffer sharing between overlapping requests
    const requestId = options?.requestId || 'default';
    const key = `${agent}-${type}-${requestId}`;
    const now = Date.now();
    
    // Truncate content to prevent huge events
    const truncatedContent = processedContent.length > this.MAX_CHUNK_SIZE 
      ? processedContent.substring(0, this.MAX_CHUNK_SIZE) + '...[truncated]'
      : processedContent;

    // Get or create buffer for this agent+type
    if (!this.streamingBuffers.has(key)) {
      this.streamingBuffers.set(key, { chunks: [], lastFlush: now });
    }
    
    const buffer = this.streamingBuffers.get(key)!;
    buffer.chunks.push(truncatedContent);

    // For progress notifications, emit immediately and also call onProgress
    if (options?.progressToken && options?.onProgress && type === 'agent_progress') {
      // Estimate progress based on content length (rough approximation)
      const currentProgress = buffer.chunks.length * 10; // rough estimate
      const totalProgress = 100;
      
      options.onProgress(currentProgress, totalProgress, `${agent.toUpperCase()}: ${truncatedContent.substring(0, 50)}...`);
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
  async detectCLIContext(): Promise<CLIContext> {
    // Return cached context if still valid
    if (this.cliContextCached && Date.now() - this.cliContextCacheTime < this.CLI_CACHE_TTL) {
      logger.debug('Using cached CLI context');
      return this.cliContext;
    }

    const availableCLIs: ('claude' | 'codex' | 'gemini')[] = [];

    // Check for available CLIs
    const cliChecks = [
      { name: 'claude' as const, command: 'claude --version' },
      { name: 'codex' as const, command: 'codex --version' },
      { name: 'gemini' as const, command: 'gemini --version' }
    ];

    const results = await Promise.allSettled(cliChecks.map(async (check) => {
      try {
        await spawnAsync(check.name, ['--version'], { timeout: CLI_CHECK_TIMEOUT });
        logger.debug(`CLI available: ${check.name}`);
        return check.name;
      } catch (error) {
        logger.debug(`CLI not available: ${check.name}`);
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
      logger.info(`✅ Using preferred CLI: ${preferredCLI}`);
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
        logger.info(`🎯 Auto-selected ${cli} for ${analysisType || 'general'} analysis`);
        return cli;
      }
    }

    // Fallback to first available
    if (this.cliContext.availableCLIs.length === 0) {
      throw new Error('No CLI agents available');
    }

    logger.warn(`⚠️ Using fallback CLI: ${this.cliContext.availableCLIs[0]}`);
    return this.cliContext.availableCLIs[0];
  }

  private async _executeCLI(
    cliName: 'claude' | 'codex' | 'gemini',
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions = {},
    commandBuilder: (userPrompt: string, systemPromptSpec: string, options: CLIAgentOptions) => { command: string; args: string[]; env?: Record<string, string>; input?: string }
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    const workingDir = options.workingDirectory || this.defaultWorkingDir;
    const timeout = options.timeout || this.defaultTimeout;

    try {
      logger.info(`🤖 Executing ${cliName.toUpperCase()} CLI`);
      logger.debug(`${cliName.toUpperCase()} prompt`, { prompt: userPrompt.substring(0, 100) });

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


      const { command, args, env, input } = commandBuilder(userPrompt, systemPromptSpec, options);

      logger.info(`📋 Command: ${command} ${args.join(' ')}`);
      logger.info(`📁 Working directory: ${workingDir}`);
      logger.info(`⏱️ Timeout: ${timeout}ms`);
      if (input) {
        logger.info(`📝 Using stdin for prompt (${input.length} characters)`);
      }

      const { stdout, stderr } = await spawnAsync(command, args, {
        cwd: workingDir,
        timeout: timeout,
        maxBuffer: MAX_BUFFER_SIZE, // Configurable buffer for model outputs
        env: env,
        input: input,
        onProgress: (chunk: string, type: 'stdout' | 'stderr') => {
          // Stream output in real-time with agent identification
          if (type === 'stdout' && chunk.trim()) {
            logger.info(`🤖 ${cliName.toUpperCase()}: ${chunk.trim()}`);
            
            // Emit throttled streaming event for real-time updates
            this.emitThrottledStreamingEvent(cliName, 'agent_progress', chunk.trim(), options.onStreamingEvent, options);
          } else if (type === 'stderr' && chunk.trim()) {
            logger.warn(`⚠️ ${cliName.toUpperCase()} stderr: ${chunk.trim()}`);
            
            // Emit throttled error streaming event
            this.emitThrottledStreamingEvent(cliName, 'agent_error', chunk.trim(), options.onStreamingEvent, options);
          }
        }
      });

      logger.info(`✅ ${cliName.toUpperCase()} completed (${Date.now() - startTime}ms)`);

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

      // Post-process CLI output if needed
      let finalOutput = stdout;
      
      // If Claude was run with stream-json format, decode the NDJSON to extract text
      if (cliName === 'claude' && args.includes('--output-format') && args.includes('stream-json')) {
        const decodedText = this.decodeClaudeStreamJson(stdout);
        if (decodedText) {
          finalOutput = decodedText;
        }
      }
      
      // If Codex was run with --json flag, extract only the agent messages
      if (cliName === 'codex' && args.includes('--json')) {
        const decodedText = this.extractCodexAgentMessage(stdout);
        if (decodedText) {
          finalOutput = decodedText;
        }
      }
      
      // Fallback: If stdout is empty but stderr has content and exit was successful,
      // Claude might have written to stderr (common in non-TTY environments)
      if (!finalOutput.trim() && stderr && stderr.trim()) {
        logger.info(`📝 Using stderr as output for ${cliName} (stdout was empty)`);
        finalOutput = stderr;
      }
      
      return {
        agent: cliName,
        success: true,
        output: finalOutput,
        error: stderr || undefined,
        executionTime: Date.now() - startTime,
        command: `${command} ${args.join(' ')}`,
        workingDirectory: workingDir,
        exitCode: 0
      };
    } catch (error) {
      const execError: ChildProcessError = error as ChildProcessError;
      const exitCode = execError.code || -1;

      // Detect rate limiting errors for Gemini
      const isRateLimit = cliName === 'gemini' && (
        execError.stderr?.includes('429') ||
        execError.message?.includes('rateLimitExceeded') ||
        execError.stderr?.includes('rate limit')
      );

      if (isRateLimit) {
        logger.warn(`⏱️ ${cliName.toUpperCase()} CLI hit rate limit (${Date.now() - startTime}ms)`);
      } else {
        logger.error(`❌ ${cliName.toUpperCase()} execution failed (${Date.now() - startTime}ms)`, {
          error: "Redacted: See internal logs for full error details.",
          exitCode,
          stderr: "Redacted: See internal logs for full stderr output."
        });
      }

      // Emit error event
      if (options.onStreamingEvent) {
        options.onStreamingEvent({
          type: 'agent_error',
          agent: cliName,
          content: `${cliName.toUpperCase()} failed: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: Date.now(),
          sessionId: options.sessionId
        });
      }

      return {
        agent: cliName,
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
        command: `(redacted command for ${cliName})`,
        workingDirectory: workingDir,
        exitCode
      };
    }
  }

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
      (userPrompt, systemPromptSpec, options) => {
        const combinedPrompt = `${systemPromptSpec}\n\n${userPrompt}`;
        const args = ['--print'];

        // Enable streaming for real-time progress if progress notifications are enabled
        if (options.progressToken) {
          args.push('--output-format', 'stream-json', '--verbose');
        }

        // Use provided model or let Claude use its default
        const model = options.models?.claude || AVAILABLE_MODELS.claude.default;
        if (model) {
          args.push('--model', model);
        }

        // Use stdin to avoid MAX_ARG_LENGTH limit (4096 chars)
        // Claude --print can read from stdin when no positional argument is provided

        // DEFENSIVE: Disable MCP and Claude Code integration to prevent stdio deadlock
        // When Claude CLI runs with MCP enabled or detects Claude Code context,
        // it tries to communicate over stdio which conflicts with our stdin/stdout usage
        const cleanEnv = { ...process.env };
        delete cleanEnv.CLAUDE_MCP_CONFIG;
        delete cleanEnv.MCP_ENABLED;
        delete cleanEnv.CLAUDECODE;
        delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

        return {
          command: 'claude',
          args,
          input: combinedPrompt,
          env: {
            ...cleanEnv,
            BRUTALIST_SUBPROCESS: '1'  // Mark this as a brutalist-spawned subprocess
          }
        };
      }
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
      { ...options },
      (userPrompt, systemPromptSpec, options) => {
        // Instruct Codex to analyze immediately in one shot without waiting for approval
        const combinedPrompt = `${systemPromptSpec}\n\n${userPrompt}\n\nExecute the complete analysis now in a single response without creating a plan first or waiting for input. Provide your full findings immediately.`;
        const args = ['exec'];
        // Use provided model or let Codex use its default
        const model = options.models?.codex || AVAILABLE_MODELS.codex.default;
        if (model) {
          args.push('--model', model);
        }
        // OPTIONAL: Use --json flag to get structured output (can be disabled for compatibility)
        if (process.env.CODEX_USE_JSON !== 'false') {
          args.push('--json');
        }

        // DEFENSIVE: Disable MCP if Codex supports it (currently no known MCP support)
        // This prevents potential stdio deadlock if Codex adds MCP in the future
        // Note: Codex CLI doesn't currently have documented MCP config flags

        // Use stdin for the prompt instead of argv to avoid ARG_MAX limits
        // Create clean environment without MCP-related variables
        const cleanEnv = { ...process.env };
        delete cleanEnv.CODEX_MCP_CONFIG;
        delete cleanEnv.MCP_ENABLED;

        return {
          command: 'codex',
          args,
          input: combinedPrompt,
          env: {
            ...cleanEnv,
            BRUTALIST_SUBPROCESS: '1'  // Mark this as a brutalist-spawned subprocess
          }
        };
      }
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
      { ...options },
      (userPrompt, systemPromptSpec, options) => {
        const args = [];
        // Use provided model or let Gemini use its default
        const modelName = options.models?.gemini || AVAILABLE_MODELS.gemini.default;
        if (modelName) {
          args.push('--model', modelName);
        }

        // DEFENSIVE: Disable MCP if Gemini supports it (currently no known MCP support)
        // This prevents potential stdio deadlock if Gemini adds MCP in the future
        // Note: Gemini CLI doesn't currently have documented MCP config flags

        const combinedPrompt = `${systemPromptSpec}\n\n${userPrompt}`;

        // Use stdin to avoid MAX_ARG_LENGTH limit (4096 chars)
        // Gemini CLI can read from stdin instead of positional argument

        // Create clean environment without MCP-related variables
        const cleanEnv = { ...process.env };
        delete cleanEnv.GEMINI_MCP_CONFIG;
        delete cleanEnv.MCP_ENABLED;

        return {
          command: 'gemini',
          args: args,
          input: combinedPrompt, // Pass prompt via stdin instead of args
          env: {
            ...cleanEnv,
            TERM: 'dumb',
            NO_COLOR: '1',
            CI: 'true',
            BRUTALIST_SUBPROCESS: '1'  // Mark this as a brutalist-spawned subprocess
          }
        };
      }
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
    logger.info(`🎯 Executing ${cli} (${this.runningCLIs}/${this.MAX_CONCURRENT_CLIS} slots used)`);
    
    try {
      switch(cli) {
        case 'claude':
          return await this.executeClaudeCode(userPrompt, systemPromptSpec, options);
        
        case 'codex':
          return await this.executeCodex(userPrompt, systemPromptSpec, options);
        
        case 'gemini':
          return await this.executeGemini(userPrompt, systemPromptSpec, options);
        
        default:
          throw new Error(`Unknown CLI: ${cli}`);
      }
    } finally {
      this.runningCLIs--;
      logger.info(`✅ Released CLI slot (${this.runningCLIs}/${this.MAX_CONCURRENT_CLIS} slots used)`);
    }
  }

  private async waitForAvailableSlot(): Promise<void> {
    let waitTime = 100; // Start with 100ms wait time
    while (this.runningCLIs >= this.MAX_CONCURRENT_CLIS) {
      logger.info(`⏳ Waiting for available CLI slot (${this.runningCLIs}/${this.MAX_CONCURRENT_CLIS} in use). Next check in ${waitTime}ms...`);
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
    const responses: CLIAgentResponse[] = [];
    
    for (const agent of cliAgents) {
      if (['claude', 'codex', 'gemini'].includes(agent)) {
        try {
          const response = await this.executeCLIAgent(agent, systemPrompt, userPrompt, options);
          responses.push(response);
        } catch (error) {
          responses.push({
            agent: agent as 'claude' | 'codex' | 'gemini',
            success: false,
            output: '',
            error: error instanceof Error ? error.message : String(error),
            executionTime: 0,
            command: `${agent} execution failed`,
            workingDirectory: options.workingDirectory || process.cwd(),
            exitCode: -1
          });
        }
      }
    }
    
    return responses;
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
    const filesystemTools = ['codebase', 'file_structure', 'dependencies', 'git_history', 'test_coverage'];

    logger.debug(`Validation check: analysisType="${analysisType}", isFilesystemTool=${filesystemTools.includes(analysisType)}`);

    try {
      if (filesystemTools.includes(analysisType) && primaryContent && primaryContent.trim() !== '') {
        logger.debug(`Validating path: "${primaryContent}"`);
        validatePath(primaryContent, 'targetPath');
      }
    } catch (error) {
      logger.error(`Path validation failed: ${error}`);
      throw new Error(`Security validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Validate workingDirectory if provided
    try {
      if (options.workingDirectory) {
        validatePath(options.workingDirectory, 'workingDirectory');
      }
    } catch (error) {
      throw new Error(`Security validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    const userPrompt = this.constructUserPrompt(analysisType, primaryContent, context);
    
    // If preferred CLI is specified, use single CLI mode
    if (options.preferredCLI) {
      const selectedCLI = this.selectSingleCLI(
        options.preferredCLI,
        analysisType  // Use the direct parameter, not options.analysisType
      );
      
      logger.info(`✅ Using preferred CLI: ${selectedCLI}`);
      
      const response = await this.executeSingleCLI(selectedCLI, userPrompt, systemPromptSpec, options);
      
      return [{
        ...response,
        selectionMethod: 'user-specified',
        analysisType
      } as CLIAgentResponse];
    }
    
    // Multi-CLI execution (default behavior)
    logger.info(`🚀 Executing multi-CLI analysis`);

    // Use all available CLIs - spawning separate processes is fine
    let availableCLIs = [...this.cliContext.availableCLIs];
    logger.info(`📋 Using all available CLIs: ${availableCLIs.join(', ')}`)
    
    if (availableCLIs.length === 0) {
      throw new Error('No CLI agents available for analysis');
    }
    
    logger.info(`📊 Available CLIs: ${availableCLIs.join(', ')}`);
    
    // Execute all available CLIs in parallel with allSettled for better error handling
    const promises = availableCLIs.map(async (cli) => {
      try {
        const response = await this.executeSingleCLI(cli, userPrompt, systemPromptSpec, options);
        return {
          ...response,
          selectionMethod: 'multi-cli',
          analysisType
        } as CLIAgentResponse;
      } catch (error) {
        logger.error(`❌ ${cli} execution failed:`, error);
        return {
          agent: cli,
          success: false,
          output: '',
          error: error instanceof Error ? error.message : String(error),
          executionTime: 0,
          selectionMethod: 'multi-cli',
          analysisType
        } as CLIAgentResponse;
      }
    });
    
    // Use allSettled to handle partial failures gracefully
    const results = await Promise.allSettled(promises);
    const responses: CLIAgentResponse[] = results
      .filter(result => result.status === 'fulfilled')
      .map(result => (result as PromiseFulfilledResult<CLIAgentResponse>).value);
    
    logger.info(`✅ Multi-CLI analysis complete: ${responses.filter(r => r.success).length}/${responses.length} successful`);
    
    return responses;
  }


  synthesizeBrutalistFeedback(responses: CLIAgentResponse[], analysisType: string): string {
    const successfulResponses = responses.filter(r => r.success);
    const failedResponses = responses.filter(r => !r.success);
    
    if (successfulResponses.length === 0) {
      return `# Brutalist Analysis Failed\n\n❌ All CLI agents failed to analyze\n${failedResponses.map(r => `- ${r.agent.toUpperCase()}: ${r.error}`).join('\n')}`;
    }

    let synthesis = `${successfulResponses.length} AI critics have systematically demolished your work.\n\n`;
    
    successfulResponses.forEach((response, index) => {
      synthesis += `## Critic ${index + 1}: ${response.agent.toUpperCase()}\n`;
      synthesis += `*Execution time: ${response.executionTime}ms*\n\n`;
      synthesis += response.output;
      synthesis += '\n\n---\n\n';
    });
    
    if (failedResponses.length > 0) {
      synthesis += `## Failed Critics\n`;
      synthesis += `${failedResponses.length} critics failed to complete their destruction:\n`;
      failedResponses.forEach(r => {
        synthesis += `- **${r.agent.toUpperCase()}**: ${r.error}\n`;
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