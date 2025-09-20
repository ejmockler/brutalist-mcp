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
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Resolve and validate working directory to prevent path traversal
    const projectRoot = process.cwd(); // Assuming process.cwd() is the project root
    let resolvedCwd = options.cwd ? path.resolve(projectRoot, options.cwd) : projectRoot;

    // Ensure the resolvedCwd is within the projectRoot
    if (!resolvedCwd.startsWith(projectRoot)) {
      throw new Error(`Attempted path traversal: ${options.cwd} resolves outside project root.`);
    }

    const child = spawn(command, args, {
      cwd: resolvedCwd,
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
    const timeoutMs = options.timeout || 120000;
    const timer = setTimeout(() => {
      timedOut = true;
      // First try SIGTERM
      child.kill('SIGTERM');
      // If still running after 5 seconds, escalate to SIGKILL
      setTimeout(() => {
        if (!killed) {
          try {
            if (command === 'gemini') {
              // Gemini runs non-detached, kill process directly
              child.kill('SIGKILL');
            } else {
              // Other CLIs run detached, kill process group
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
      stdout += data.toString();
      if (options.maxBuffer && stdout.length > options.maxBuffer) {
        child.kill('SIGTERM');
        reject(new Error(`stdout exceeded maxBuffer size: ${options.maxBuffer}`));
      }
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
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
  private readonly MAX_CONCURRENT_CLIS = 2; // Prevent resource exhaustion

  constructor() {
    // Detect CLI context at startup and cache it
    this.detectCLIContext().catch(error => {
      logger.error("Failed to detect CLI context at startup:", error);
    });
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
        await spawnAsync(check.name, ['--version'], { timeout: 5000 });
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
    commandBuilder: (userPrompt: string, systemPromptSpec: string, options: CLIAgentOptions) => { command: string; args: string[]; env?: Record<string, string> }
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    const workingDir = options.workingDirectory || this.defaultWorkingDir;
    const timeout = options.timeout || this.defaultTimeout;

    try {
      logger.info(`🤖 Executing ${cliName.toUpperCase()} CLI`);
      logger.debug(`${cliName.toUpperCase()} prompt`, { prompt: userPrompt.substring(0, 100) });

      // WARNING: Claude CLI does not have a native --sandbox flag. 
      // If options.sandbox is true, it is assumed that the environment 
      // running this Brutalist MCP server provides the sandboxing (e.g., Docker, VM).
      // Running Claude without external sandboxing can be a security risk.
      if (cliName === 'claude' && options.sandbox) {
        logger.warn("⚠️ Claude CLI requested with sandbox: true, but Claude CLI does not support native sandboxing. Ensure external sandboxing is in place.");
      }

      const { command, args, env } = commandBuilder(userPrompt, systemPromptSpec, options);

      logger.info(`📋 Command: ${command} ${args.join(' ').substring(0, 100)}...`);
      logger.info(`📁 Working directory: ${workingDir}`);
      logger.info(`⏱️ Timeout: ${timeout}ms`);

      const { stdout, stderr } = await spawnAsync(command, args, {
        cwd: workingDir,
        timeout: timeout,
        maxBuffer: 10 * 1024 * 1024, // Large buffer for model outputs
        env: env
      });

      logger.info(`✅ ${cliName.toUpperCase()} completed (${Date.now() - startTime}ms)`);

      return {
        agent: cliName,
        success: true,
        output: stdout,
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
        if (options.models?.claude) {
          args.push('--model', options.models.claude);
        }
        args.push(combinedPrompt);
        return { command: 'claude', args };
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
        if (options.models?.codex) {
          args.push('--model', options.models.codex);
        }
        if (options.sandbox) {
          args.push('--sandbox', 'read-only');
        }
        args.push(combinedPrompt);
        return { command: 'codex', args };
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
        const modelName = options.models?.gemini || 'gemini-2.5-flash';
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
      logger.warn(`⚠️ Only current CLI (${this.cliContext.currentCLI}) available - allowing with recursion guard`);
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

  /**
   * Sanitizes user input to prevent prompt injection.
   * This is a basic implementation and may need to be enhanced based on specific AI model vulnerabilities.
   * It escapes common characters that could be used to break out of a prompt or inject new instructions.
   * @param input The string to sanitize.
   * @returns The sanitized string.
   */
  private sanitizePromptInput(input: string): string {
    // Basic sanitization to prevent prompt injection by escaping characters that could be interpreted as code or special commands.
    // This is a first line of defense; a more robust solution might involve AI-specific escaping or structured input.
    return input.replace(/`/g, '\\`').replace(/\$/g, '\\$');
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
    const sanitizedTargetPath = this.sanitizePromptInput(targetPath);
    const sanitizedContext = context ? this.sanitizePromptInput(context) : 'No additional context provided';

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
      file_structure: `Analyze the directory structure at ${sanitizedTargetPath}. Find organizational disasters and naming failures.`,
      dependencies: `Analyze dependencies at ${sanitizedTargetPath}. Find version conflicts and security vulnerabilities.`,
      git_history: `Analyze git history at ${sanitizedTargetPath}. Find commit disasters and workflow failures.`,
      test_coverage: `Analyze test coverage at ${sanitizedTargetPath}. Find testing gaps and quality issues.`
    };

    const specificPrompt = prompts[analysisType as keyof typeof prompts] || `Analyze ${sanitizedTargetPath} for ${analysisType} issues.`;
    
    return `${specificPrompt} ${context ? `Context: ${sanitizedContext}` : ''}`;
  }
}