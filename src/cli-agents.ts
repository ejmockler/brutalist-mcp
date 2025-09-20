import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';
import { CLIAgentResponse } from './types/brutalist.js';

const execAsync = promisify(exec);

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
  private defaultTimeout = 60000; // 60 seconds
  private defaultWorkingDir = process.cwd();
  private cliContext: CLIContext = { availableCLIs: [] };

  async detectCLIContext(): Promise<CLIContext> {
    const availableCLIs: ('claude' | 'codex' | 'gemini')[] = [];
    let currentCLI: 'claude' | 'codex' | 'gemini' | undefined;

    // Check for available CLIs
    const cliChecks = [
      { name: 'claude' as const, command: 'claude --version' },
      { name: 'codex' as const, command: 'codex --version' },
      { name: 'gemini' as const, command: 'gemini --version' }
    ];

    for (const check of cliChecks) {
      try {
        await execAsync(check.command, { timeout: 5000 });
        availableCLIs.push(check.name);
        logger.debug(`CLI available: ${check.name}`);
      } catch (error) {
        logger.debug(`CLI not available: ${check.name}`);
      }
    }

    // Detect current CLI context from environment or process
    currentCLI = this.detectCurrentCLI();

    this.cliContext = { currentCLI, availableCLIs };
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
    
    // 3. Filter available and non-recursive
    const currentCLI = this.cliContext.currentCLI;
    const candidates = this.cliContext.availableCLIs.filter(cli => cli !== currentCLI);
    
    if (candidates.length === 0) {
      throw new Error('No available CLI agents (all excluded to prevent recursion)');
    }
    
    // 4. Select by priority
    for (const cli of priority) {
      if (candidates.includes(cli)) {
        logger.info(`🎯 Auto-selected ${cli} for ${analysisType || 'general'} analysis`);
        return cli;
      }
    }
    
    // Fallback to first available
    logger.warn(`⚠️ Using fallback CLI: ${candidates[0]}`);
    return candidates[0];
  }

  async executeClaudeCode(
    userPrompt: string, 
    systemPromptSpec: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    const workingDir = options.workingDirectory || this.defaultWorkingDir;
    
    try {
      logger.info(`🤖 Executing Claude Code CLI`);
      logger.debug("Claude Code prompt", { prompt: userPrompt.substring(0, 100) });
      
      // Use --append-system-prompt for proper injection
      const modelFlag = options.models?.claude ? `--model ${options.models.claude}` : '';
      const command = `claude --print ${modelFlag} --append-system-prompt "${systemPromptSpec.replace(/"/g, '\\"')}" "${userPrompt.replace(/"/g, '\\"')}"`;
      
      logger.info(`📋 Command: claude --print ${modelFlag} --append-system-prompt "..." "..."`);
      logger.info(`📁 Working directory: ${workingDir}`);
      
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDir,
        timeout: options.timeout || this.defaultTimeout,
        encoding: 'utf8'
      });

      logger.info(`✅ Claude Code completed (${Date.now() - startTime}ms)`);
      
      return {
        agent: 'claude',
        success: true,
        output: stdout,
        error: stderr || undefined,
        executionTime: Date.now() - startTime,
        command: 'claude --print --append-system-prompt "..." "..."',
        workingDirectory: workingDir,
        exitCode: 0
      };
    } catch (error) {
      const execError = error as any;
      const exitCode = execError.code || -1;
      
      logger.error(`❌ Claude Code execution failed (${Date.now() - startTime}ms)`, {
        error: execError.message,
        exitCode,
        stderr: execError.stderr
      });
      
      return {
        agent: 'claude',
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
        command: 'claude --print --append-system-prompt "..." "..."',
        workingDirectory: workingDir,
        exitCode
      };
    }
  }

  async executeCodex(
    userPrompt: string,
    systemPromptSpec: string, 
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    const workingDir = options.workingDirectory || this.defaultWorkingDir;
    
    try {
      logger.info(`🤖 Executing Codex CLI`);
      logger.debug("Codex prompt", { prompt: userPrompt.substring(0, 100) });
      
      // Embed instructions inline for Codex
      const combinedPrompt = `CONTEXT AND INSTRUCTIONS:\n${systemPromptSpec}\n\nANALYZE:\n${userPrompt}`;
      
      const sandboxFlag = options.sandbox ? '--sandbox read-only' : '';
      const cdFlag = workingDir ? `--cd "${workingDir}"` : '';
      const modelFlag = options.models?.codex ? `--model ${options.models.codex}` : '';
      
      // Increase timeout for Codex specifically (it can be very slow with complex prompts)
      const codexTimeout = Math.max(options.timeout || this.defaultTimeout, 180000); // Min 3 minutes
      
      const command = `codex exec ${modelFlag} ${sandboxFlag} ${cdFlag} "${combinedPrompt.replace(/"/g, '\\"')}"`;
      
      logger.info(`📋 Command: codex exec ${modelFlag} ${sandboxFlag} ${cdFlag} "..."`);
      logger.info(`📁 Working directory: ${workingDir}`);
      logger.info(`⏱️ Timeout: ${codexTimeout}ms`);
      
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDir,
        timeout: codexTimeout,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });

      logger.info(`✅ Codex completed (${Date.now() - startTime}ms)`);
      
      return {
        agent: 'codex',
        success: true,
        output: stdout,
        error: stderr || undefined,
        executionTime: Date.now() - startTime,
        command: `codex exec ${sandboxFlag} ${cdFlag} "..."`,
        workingDirectory: workingDir,
        exitCode: 0
      };
    } catch (error) {
      const execError = error as any;
      const exitCode = execError.code || -1;
      
      logger.error(`❌ Codex execution failed (${Date.now() - startTime}ms)`, {
        error: execError.message,
        exitCode,
        stderr: execError.stderr
      });
      
      return {
        agent: 'codex',
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
        command: `codex exec ${options.sandbox ? '--sandbox read-only' : ''} ${workingDir ? `--cd "${workingDir}"` : ''} "..."`,
        workingDirectory: workingDir,
        exitCode
      };
    }
  }

  async executeGemini(
    userPrompt: string,
    systemPromptSpec: string, 
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    const workingDir = options.workingDirectory || this.defaultWorkingDir;
    
    try {
      logger.info(`🤖 Executing Gemini CLI`);
      logger.debug("Gemini prompt", { prompt: userPrompt.substring(0, 100) });
      
      const sandboxFlag = options.sandbox ? '--sandbox' : '';
      const yoloFlag = '--yolo'; // Auto-approve all actions
      const modelFlag = options.models?.gemini ? `--model ${options.models.gemini}` : '--model gemini-2.5-flash';
      
      // Combine system and user prompts (Gemini CLI only accepts one prompt)
      const combinedPrompt = `${systemPromptSpec}

User Request: ${userPrompt}`;
      
      // Use stdin approach to avoid command line quote escaping issues
      const escapedPrompt = combinedPrompt.replace(/"/g, '\\"');
      const command = `echo "${escapedPrompt}" | gemini ${modelFlag} ${sandboxFlag} ${yoloFlag}`;
      
      logger.info(`📋 Command: echo "..." | gemini ${modelFlag} ${sandboxFlag}`);
      logger.info(`📁 Working directory: ${workingDir}`);
      logger.info(`🔄 Using combined prompt with stdin approach`);
      
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDir,
        timeout: options.timeout || Math.max(this.defaultTimeout * 2, 180000), // Gemini can be very slow
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024 // Large buffer for model outputs
      });

      logger.info(`✅ Gemini completed (${Date.now() - startTime}ms)`);
      
      return {
        agent: 'gemini',
        success: true,
        output: stdout,
        error: stderr || undefined,
        executionTime: Date.now() - startTime,
        command: `echo "..." | gemini ${modelFlag} ${sandboxFlag}`,
        workingDirectory: workingDir,
        exitCode: 0
      };
    } catch (error) {
      const execError = error as any;
      const exitCode = execError.code || -1;
      
      // Detect rate limiting errors
      const isRateLimit = execError.stderr?.includes('429') || 
                         execError.message?.includes('rateLimitExceeded') ||
                         execError.stderr?.includes('rate limit');
      
      if (isRateLimit) {
        logger.warn(`⏱️ Gemini CLI hit rate limit (${Date.now() - startTime}ms)`);
      } else {
        logger.error(`❌ Gemini CLI execution failed (${Date.now() - startTime}ms)`, {
          error: execError.message,
          exitCode,
          stderr: execError.stderr
        });
      }
      
      return {
        agent: 'gemini',
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
        command: `echo "..." | gemini ${options.models?.gemini ? `--model ${options.models.gemini}` : '--model gemini-2.5-flash'} ${options.sandbox ? '--sandbox' : ''}`,
        workingDirectory: workingDir,
        exitCode
      };
    }
  }

  async executeSingleCLI(
    cli: 'claude' | 'codex' | 'gemini',
    userPrompt: string,
    systemPromptSpec: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    logger.info(`🎯 Executing ${cli} with system prompt spec`);
    
    switch(cli) {
      case 'claude':
        return this.executeClaudeCode(userPrompt, systemPromptSpec, options);
      
      case 'codex':
        return this.executeCodex(userPrompt, systemPromptSpec, { ...options, sandbox: true });
      
      case 'gemini':
        return this.executeGemini(userPrompt, systemPromptSpec, { ...options, sandbox: true });
      
      default:
        throw new Error(`Unknown CLI: ${cli}`);
    }
  }

  async executeBrutalistAnalysis(
    analysisType: string,
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
    const availableCLIs = this.cliContext.availableCLIs.filter(cli => cli !== this.cliContext.currentCLI);
    
    if (availableCLIs.length === 0) {
      throw new Error('No available CLI agents (all excluded to prevent recursion)');
    }
    
    logger.info(`📊 Available CLIs: ${availableCLIs.join(', ')}`);
    
    // Execute all available CLIs in parallel
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
    
    const responses = await Promise.all(promises);
    logger.info(`✅ Multi-CLI analysis complete: ${responses.filter(r => r.success).length}/${responses.length} successful`);
    
    return responses;
  }

  private constructUserPrompt(
    analysisType: string, 
    targetPath: string, 
    context?: string
  ): string {
    const prompts = {
      code: `Analyze ${targetPath} for codebase issues. Context: ${context || 'No additional context provided'}`,
      codebase: `Analyze ${targetPath} for codebase issues. Context: ${context || 'No additional context provided'}`,
      architecture: `Review the architecture: ${targetPath}. Find every scaling failure and cost explosion.`,
      idea: `Analyze this idea: ${targetPath}. Find where imagination fails to become reality.`,
      research: `Review this research: ${targetPath}. Find every methodological flaw and reproducibility issue.`,
      data: `Analyze this data/model: ${targetPath}. Find every overfitting issue, bias, and correlation fallacy.`,
      security: `Security audit of: ${targetPath}. Find every attack vector and vulnerability.`,
      product: `Product review: ${targetPath}. Find every UX disaster and adoption barrier.`,
      infrastructure: `Infrastructure review: ${targetPath}. Find every single point of failure.`,
      debate: `Debate topic: ${targetPath}. Take opposing positions and argue until truth emerges.`
    };

    const specificPrompt = prompts[analysisType as keyof typeof prompts] || `Analyze ${targetPath} for ${analysisType} issues.`;
    
    return `${specificPrompt} ${context ? `Context: ${context}` : ''}`;
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
    
    synthesis += `## Brutal Summary\n`;
    synthesis += `Your ${analysisType} has been systematically destroyed by ${successfulResponses.length} independent critics. Time to rebuild it properly.`;
    
    return synthesis;
  }
}