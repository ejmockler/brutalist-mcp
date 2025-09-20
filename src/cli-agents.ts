import { spawn } from 'child_process';
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
const DEFAULT_TIMEOUT = parseInt(process.env.BRUTALIST_TIMEOUT || '300000', 10); // 5 minutes default
const CLI_CHECK_TIMEOUT = parseInt(process.env.BRUTALIST_CLI_CHECK_TIMEOUT || '5000', 10); // 5 seconds for CLI checks
const MAX_BUFFER_SIZE = parseInt(process.env.BRUTALIST_MAX_BUFFER || String(10 * 1024 * 1024), 10); // 10MB default
const MAX_CONCURRENT_CLIS = parseInt(process.env.BRUTALIST_MAX_CONCURRENT || '3', 10); // 3 concurrent CLIs

// Available models for each CLI
export const AVAILABLE_MODELS = {
  claude: {
    default: undefined, // Uses user's configured model
    aliases: ['opus', 'sonnet', 'haiku'],
    full: ['claude-opus-4-1-20250805', 'claude-sonnet-4-20250514']
  },
  codex: {
    default: 'gpt-5', // Fast default reasoning
    models: ['gpt-5', 'gpt-5-codex', 'o3', 'o3-mini', 'o3-pro', 'o4-mini']
  },
  gemini: {
    default: 'gemini-2.5-flash', // Best price/performance
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']
  }
} as const;

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
    // Use working directory as-is - let CLI tools handle their own sandboxing
    const cwd = options.cwd || process.cwd();

    const child = spawn(command, args, {
      cwd: cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, // CRITICAL: disable shell to prevent injection
      detached: command !== 'gemini', // Disable detached for Gemini CLI to fix macOS sandbox issue
      env: options.env || process.env
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    // Set up timeout with SIGKILL escalation
    const timeoutMs = options.timeout || DEFAULT_TIMEOUT;
    const timer = setTimeout(() => {
      timedOut = true;
      // First try SIGTERM
      child.kill('SIGTERM');
      // If still running after 5 seconds, escalate to SIGKILL
      setTimeout(() => {
        if (!killed) {
          try {
            if (command === 'gemini' || process.platform === 'win32') {
              // Gemini runs non-detached, and Windows doesn't support process groups
              child.kill('SIGKILL');
            } else {
              // Other CLIs on Unix-like systems: kill process group
              process.kill(-child.pid!, 'SIGKILL');
            }
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
      reject(error);
    });

    // Send input if provided
    if (options.input) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });
}

export interface CLIAgentOptions {
  workingDirectory?: string;
  timeout?: number;
  sandbox?: boolean;
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
}

export interface StreamingEvent {
  type: 'agent_start' | 'agent_progress' | 'agent_complete' | 'agent_error';
  agent: 'claude' | 'codex' | 'gemini';
  content?: string;
  timestamp: number;
  sessionId?: string;
}

export interface CLIContext {
  currentCLI?: 'claude' | 'codex' | 'gemini';
  availableCLIs: ('claude' | 'codex' | 'gemini')[];
}

export class CLIAgentOrchestrator {
  private defaultTimeout = 1500000; // 25 minutes - thorough analysis takes time
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

    const key = `${agent}-${type}`;
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
        timestamp: now
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
    let currentCLI: 'claude' | 'codex' | 'gemini' | undefined;

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


    // Detect current CLI context from environment or process
    currentCLI = this.detectCurrentCLI();

    this.cliContext = { currentCLI, availableCLIs };
    this.cliContextCached = true;
    this.cliContextCacheTime = Date.now();
    
    return this.cliContext;
  }

  private detectCurrentCLI(): 'claude' | 'codex' | 'gemini' | undefined {
    // Check environment variables that might indicate current CLI
    if (process.env.CLAUDE_CODE_SESSION || process.env.CLAUDE_CONFIG_DIR) {
      return 'claude';
    }
    
    if (process.env.CODEX_SESSION || process.env.OPENAI_CODEX_SESSION) {
      return 'codex';
    }
    
    if (process.env.GEMINI_SESSION || process.env.GEMINI_API_KEY) {
      return 'gemini';
    }

    // Check process parent/ancestry for CLI indicators
    try {
      const processInfo = process.env._;
      if (processInfo?.includes('claude')) return 'claude';
      if (processInfo?.includes('codex')) return 'codex'; 
      if (processInfo?.includes('gemini')) return 'gemini';
    } catch (error) {
      logger.debug('Could not detect current CLI from process info');
    }

    return undefined;
  }

  selectSingleCLI(
    preferredCLI?: 'claude' | 'codex' | 'gemini',
    analysisType?: BrutalistPromptType
  ): 'claude' | 'codex' | 'gemini' {
    // 1. Honor explicit preference if available (allow even if current CLI to avoid blocking)
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
    
    // 3. Filter available CLIs, exclude current CLI only for auto-selection to prevent recursion
    const currentCLI = this.cliContext.currentCLI;
    const candidates = this.cliContext.availableCLIs.filter(cli => cli !== currentCLI);
    
    // If no candidates after filtering, fall back to available CLIs (allow recursion if necessary)
    const finalCandidates = candidates.length > 0 ? candidates : this.cliContext.availableCLIs;
    
    if (finalCandidates.length === 0) {
      throw new Error('No CLI agents available');
    }
    
    // 4. Select by priority
    for (const cli of priority) {
      if (finalCandidates.includes(cli)) {
        const recursionWarning = candidates.length === 0 ? ' (allowing recursion)' : '';
        logger.info(`🎯 Auto-selected ${cli} for ${analysisType || 'general'} analysis${recursionWarning}`);
        return cli;
      }
    }
    
    // Fallback to first available
    logger.warn(`⚠️ Using fallback CLI: ${finalCandidates[0]}`);
    return finalCandidates[0];
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
          timestamp: Date.now()
        });
      }

      // WARNING: Claude CLI does not have a native --sandbox flag. 
      // If options.sandbox is true, it is assumed that the environment 
      // running this Brutalist MCP server provides the sandboxing (e.g., Docker, VM).
      // Running Claude without external sandboxing can be a security risk.
      if (cliName === 'claude' && options.sandbox) {
        logger.warn("⚠️ Claude CLI requested with sandbox: true, but Claude CLI does not support native sandboxing. Ensure external sandboxing is in place.");
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
          timestamp: Date.now()
        });
      }

      // Post-process Claude stream-json output if needed
      let finalOutput = stdout;
      
      // If Claude was run with stream-json format, decode the NDJSON to extract text
      if (cliName === 'claude' && args.includes('--output-format') && args.includes('stream-json')) {
        const decodedText = this.decodeClaudeStreamJson(stdout);
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
          timestamp: Date.now()
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
        // Pass prompt as argument - Claude CLI works better this way
        args.push(combinedPrompt);
        
        // Set environment to ensure consistent output behavior
        const env = {
          ...process.env,
          TERM: 'dumb',      // Disable fancy terminal output
          NO_COLOR: '1',     // Disable colored output
          CI: 'true'         // Indicate non-interactive environment
        };
        
        return { command: 'claude', args, env };
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
      { ...options, sandbox: true }, // Ensure sandbox is always true for Codex
      (userPrompt, systemPromptSpec, options) => {
        const combinedPrompt = `CONTEXT AND INSTRUCTIONS:\n${systemPromptSpec}\n\nANALYZE:\n${userPrompt}`;
        const args = ['exec'];
        // Use provided model or default to gpt-5
        const model = options.models?.codex || AVAILABLE_MODELS.codex.default;
        args.push('--model', model);
        if (options.sandbox) {
          args.push('--sandbox', 'read-only');
        }
        // Use stdin for the prompt instead of argv to avoid ARG_MAX limits
        return { 
          command: 'codex', 
          args,
          input: combinedPrompt
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
      { ...options, sandbox: true }, // Ensure sandbox is always true for Gemini
      (userPrompt, systemPromptSpec, options) => {
        const args = [];
        // Use provided model or default to gemini-2.5-flash
        const modelName = options.models?.gemini || AVAILABLE_MODELS.gemini.default;
        args.push('--model', modelName);
        
        if (options.sandbox) {
          args.push('--sandbox');
        }
        
        const combinedPrompt = `${systemPromptSpec}\n\n${userPrompt}`;
        args.push(combinedPrompt);
        return { 
          command: 'gemini', 
          args: args,
          env: {
            ...process.env,
            TERM: 'dumb',
            NO_COLOR: '1',
            CI: 'true'
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
          return await this.executeCodex(userPrompt, systemPromptSpec, { ...options, sandbox: true });
        
        case 'gemini':
          return await this.executeGemini(userPrompt, systemPromptSpec, { ...options, sandbox: true });
        
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

  async executeBrutalistAnalysis(
    analysisType: BrutalistPromptType,
    targetPath: string,
    systemPromptSpec: string,
    context?: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse[]> {
    const userPrompt = this.constructUserPrompt(analysisType, targetPath, context);
    
    // If preferred CLI is specified, use single CLI mode
    if (options.preferredCLI) {
      const selectedCLI = this.selectSingleCLI(
        options.preferredCLI,
        options.analysisType
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
    
    // Only exclude current CLI if we have other options
    let availableCLIs = [...this.cliContext.availableCLIs];
    if (this.cliContext.currentCLI && this.cliContext.availableCLIs.length > 1) {
      // Exclude current CLI to prevent recursion, but only if we have alternatives
      availableCLIs = availableCLIs.filter(cli => cli !== this.cliContext.currentCLI);
      logger.info(`🔄 Excluding current CLI (${this.cliContext.currentCLI}) to prevent recursion`);
    } else if (this.cliContext.currentCLI && this.cliContext.availableCLIs.length === 1) {
      logger.info(`🔄 Using current CLI (${this.cliContext.currentCLI}) - spawning separate process`);
    }
    
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
    targetPath: string, 
    context?: string
  ): string {
    // Trust CLI tools to handle their own security
    const sanitizedTargetPath = targetPath;
    const sanitizedContext = context || 'No additional context provided';

    const prompts = {
      code: `Analyze the codebase at ${sanitizedTargetPath} for issues. Context: ${sanitizedContext}`,
      codebase: `Analyze the codebase directory at ${sanitizedTargetPath} for security vulnerabilities, performance issues, and architectural problems. Context: ${sanitizedContext}`,
      architecture: `Review the architecture: ${sanitizedTargetPath}. Find every scaling failure and cost explosion.`,
      idea: `Analyze this idea: ${sanitizedTargetPath}. Find where imagination fails to become reality.`,
      research: `Review this research: ${sanitizedTargetPath}. Find every methodological flaw and reproducibility issue.`,
      data: `Analyze this data/model: ${sanitizedTargetPath}. Find every overfitting issue, bias, and correlation fallacy.`,
      security: `Security audit of: ${sanitizedTargetPath}. Find every attack vector and vulnerability.`,
      product: `Product review: ${sanitizedTargetPath}. Find every UX disaster and adoption barrier.`,
      infrastructure: `Infrastructure review: ${sanitizedTargetPath}. Find every single point of failure.`,
      debate: `Debate topic: ${sanitizedTargetPath}. Take opposing positions and argue until truth emerges.`,
      fileStructure: `Analyze the directory structure at ${sanitizedTargetPath}. Find organizational disasters and naming failures.`,
      dependencies: `Analyze dependencies at ${sanitizedTargetPath}. Find version conflicts and security vulnerabilities.`,
      gitHistory: `Analyze git history at ${sanitizedTargetPath}. Find commit disasters and workflow failures.`,
      testCoverage: `Analyze test coverage at ${sanitizedTargetPath}. Find testing gaps and quality issues.`
    };

    const specificPrompt = prompts[analysisType as keyof typeof prompts] || `Analyze ${sanitizedTargetPath} for ${analysisType} issues.`;
    
    return `${specificPrompt} ${context ? `Context: ${sanitizedContext}` : ''}`;
  }
}