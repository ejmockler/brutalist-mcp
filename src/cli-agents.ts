import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export interface CLIAgentResponse {
  agent: 'claude' | 'codex' | 'gemini';
  success: boolean;
  output: string;
  error?: string;
  executionTime: number;
}

export type BrutalistPromptType = 
  | 'codeAnalysis'
  | 'architecture' 
  | 'idea'
  | 'research'
  | 'security'
  | 'product'
  | 'infrastructure'
  | 'fileStructure'
  | 'dependencies'
  | 'gitHistory'
  | 'testCoverage';

export interface CLIAgentOptions {
  workingDirectory?: string;
  timeout?: number;
  sandbox?: boolean;
  excludeCurrentCLI?: boolean;
}

export interface CLIContext {
  currentCLI?: 'claude' | 'codex' | 'gemini';
  availableCLIs: ('claude' | 'codex' | 'gemini')[];
}

export class CLIAgentOrchestrator {
  private defaultTimeout = 30000; // 30 seconds
  private defaultWorkingDir = process.cwd();
  private cliContext: CLIContext = { availableCLIs: [] };

  private brutalistSystemPrompts: Record<BrutalistPromptType, string> = {
    codeAnalysis: "You are a battle-scarred principal engineer who has debugged production disasters for 15 years. Your job is to find every security hole, performance bottleneck, and maintainability nightmare in this code. Be ruthless about what's broken - treat this like code that will kill people if it fails. Only after destroying it should you explain exactly how to fix each problem.",
    
    architecture: "You are a distinguished architect who has watched elegant designs collapse under real load. Your job is to identify every bottleneck, cost explosion, and scaling failure that will destroy this system. Be ruthless about why this won't survive production. Only after demolishing it should you suggest what might actually work.",
    
    idea: "You are a philosopher who understands the gap between what we imagine and what actually works. Your job is to find where this idea encounters the immovable forces of reality - the deeper structural reasons why imagination fails to become real. Be harsh about delusions but wise about what might actually survive contact with the world.",
    
    research: "You are a supremely jaded peer reviewer who has rejected thousands of papers across top journals and watched countless studies fail to replicate. Your job is to DEMOLISH this research methodologically - find every statistical flaw, sampling bias, confounding variable, and reproducibility nightmare. Be unforgiving about bad science but then reluctantly explain how to design a study that might actually prove something.",
    
    security: "You are a battle-hardened penetration tester who has compromised Fortune 500 companies and government systems. Your job is to ANNIHILATE this security design - find every authentication bypass, injection vulnerability, privilege escalation path, and social engineering opportunity that real attackers will exploit. Be ruthless about security theater but then reluctantly explain how to build defenses that actually work against determined adversaries.",
    
    product: "You are a product veteran who has launched dozens of products, watched most fail spectacularly, and understands why users really abandon things. Your job is to EVISCERATE this product concept - find every usability disaster, adoption barrier, competitive threat, and workflow failure that will drive users away in seconds. Be ruthless about user behavior realities but then reluctantly explain how to build products users might actually keep using.",
    
    infrastructure: "You are a grizzled site reliability engineer who has been on-call for a decade and survived catastrophic outages at 3AM. Your job is to OBLITERATE this infrastructure design - find every single point of failure, scaling bottleneck, monitoring blind spot, and operational nightmare that will cause outages when you least expect them. Be ruthless about infrastructure fragility but then grudgingly explain how to build systems that might actually stay up under real load.",
    
    fileStructure: "You are a battle-scarred principal engineer who has debugged production disasters for 15 years. Your job is to find every organizational disaster, naming convention failure, and structural nightmare in this file structure that makes codebases unmaintainable. Be ruthless about what's broken - treat this like organization that will kill productivity if it continues.",
    
    dependencies: "You are a battle-scarred principal engineer who has debugged production disasters for 15 years. Your job is to find every security vulnerability, version conflict, and dependency nightmare that will break in production. Be ruthless about package management disasters - treat this like dependencies that will kill the system if they fail.",
    
    gitHistory: "You are a battle-scarred principal engineer who has debugged production disasters for 15 years. Your job is to find every workflow disaster, collaboration nightmare, and version control failure in this development process. Be ruthless about what's broken - treat this like git practices that will kill team productivity.",
    
    testCoverage: "You are a battle-scarred principal engineer who has debugged production disasters for 15 years. Your job is to find every testing gap, quality assurance failure, and coverage nightmare that will let bugs slip into production. Be ruthless about testing theater - treat this like test strategies that will kill reliability if they continue."
  };

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

  getSmartCLISelection(excludeCurrentCLI: boolean = true): ('claude' | 'codex' | 'gemini')[] {
    let availableCLIs = [...this.cliContext.availableCLIs];
    
    if (excludeCurrentCLI && this.cliContext.currentCLI) {
      availableCLIs = availableCLIs.filter(cli => cli !== this.cliContext.currentCLI);
      logger.debug(`Excluding current CLI: ${this.cliContext.currentCLI}`);
    }

    if (availableCLIs.length === 0) {
      logger.warn('No alternative CLIs available, using all CLIs');
      return this.cliContext.availableCLIs;
    }

    return availableCLIs;
  }

  async executeClaudeCode(
    userPrompt: string, 
    systemPromptType: BrutalistPromptType,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    
    try {
      logger.debug("Executing Claude Code", { prompt: userPrompt.substring(0, 100) });
      
      const systemPrompt = this.brutalistSystemPrompts[systemPromptType];
      const command = `claude --print --system-prompt "${systemPrompt.replace(/"/g, '\\"')}" "${userPrompt.replace(/"/g, '\\"')}"`;
      const { stdout, stderr } = await execAsync(command, {
        cwd: options.workingDirectory || this.defaultWorkingDir,
        timeout: options.timeout || this.defaultTimeout,
        encoding: 'utf8'
      });

      return {
        agent: 'claude',
        success: true,
        output: stdout,
        error: stderr || undefined,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      logger.error("Claude Code execution failed", error);
      return {
        agent: 'claude',
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime
      };
    }
  }

  async executeCodex(
    userPrompt: string,
    systemPromptType: BrutalistPromptType, 
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    
    try {
      logger.debug("Executing Codex", { prompt: userPrompt.substring(0, 100) });
      
      // Embed system prompt directly in user prompt for Codex
      const systemPrompt = this.brutalistSystemPrompts[systemPromptType];
      const combinedPrompt = `${systemPrompt}\n\nNow: ${userPrompt}`;
      
      const sandboxFlag = options.sandbox ? '--sandbox read-only' : '';
      const cdFlag = options.workingDirectory ? `--cd "${options.workingDirectory}"` : '';
      const command = `codex exec ${sandboxFlag} ${cdFlag} "${combinedPrompt.replace(/"/g, '\\"')}"`;
      
      const { stdout, stderr } = await execAsync(command, {
        timeout: options.timeout || this.defaultTimeout,
        encoding: 'utf8'
      });

      return {
        agent: 'codex',
        success: true,
        output: stdout,
        error: stderr || undefined,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      logger.error("Codex execution failed", error);
      return {
        agent: 'codex',
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime
      };
    }
  }

  async executeGemini(
    userPrompt: string,
    systemPromptType: BrutalistPromptType, 
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse> {
    const startTime = Date.now();
    
    try {
      logger.debug("Executing Gemini CLI", { prompt: userPrompt.substring(0, 100) });
      
      const systemPrompt = this.brutalistSystemPrompts[systemPromptType];
      const sandboxFlag = options.sandbox ? '--sandbox' : '';
      const cdCommand = options.workingDirectory ? `cd "${options.workingDirectory}" && ` : '';
      
      // Use process substitution to pass system prompt via GEMINI_SYSTEM_MD
      const command = `${cdCommand}GEMINI_SYSTEM_MD=<(echo "${systemPrompt.replace(/"/g, '\\"')}") gemini ${sandboxFlag} --prompt "${userPrompt.replace(/"/g, '\\"')}"`;
      
      const { stdout, stderr } = await execAsync(command, {
        shell: '/bin/bash', // Required for process substitution
        timeout: options.timeout || this.defaultTimeout,
        encoding: 'utf8'
      });

      return {
        agent: 'gemini',
        success: true,
        output: stdout,
        error: stderr || undefined,
        executionTime: Date.now() - startTime
      };
    } catch (error) {
      logger.error("Gemini CLI execution failed", error);
      return {
        agent: 'gemini',
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime
      };
    }
  }

  async executeBrutalistAnalysis(
    analysisType: string,
    targetPath: string,
    systemPromptType: BrutalistPromptType,
    context?: string,
    options: CLIAgentOptions = {}
  ): Promise<CLIAgentResponse[]> {
    const userPrompt = this.constructUserPrompt(analysisType, targetPath, context);
    
    // Use smart CLI selection to avoid calling current CLI if requested
    const availableCLIs = this.getSmartCLISelection(options.excludeCurrentCLI ?? true);
    logger.debug(`Using CLIs: ${availableCLIs.join(', ')}`);
    
    // Build agent promises based on available CLIs
    const agentPromises: Promise<CLIAgentResponse>[] = [];
    
    if (availableCLIs.includes('claude')) {
      agentPromises.push(this.executeClaudeCode(userPrompt, systemPromptType, options));
    }
    
    if (availableCLIs.includes('codex')) {
      agentPromises.push(this.executeCodex(userPrompt, systemPromptType, { ...options, sandbox: true }));
    }
    
    if (availableCLIs.includes('gemini')) {
      agentPromises.push(this.executeGemini(userPrompt, systemPromptType, { ...options, sandbox: true }));
    }

    // Ensure we have at least one CLI available
    if (agentPromises.length === 0) {
      logger.warn('No CLIs available for analysis');
      return [{
        agent: 'claude' as const,
        success: false,
        output: '',
        error: 'No CLIs available for analysis',
        executionTime: 0
      }];
    }

    try {
      const results = await Promise.allSettled(agentPromises);
      return results.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          return {
            agent: availableCLIs[index] || 'claude' as const,
            success: false,
            output: '',
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            executionTime: 0
          };
        }
      });
    } catch (error) {
      logger.error("Brutalist analysis execution failed", error);
      throw error;
    }
  }

  private constructUserPrompt(
    analysisType: string, 
    targetPath: string, 
    context?: string
  ): string {
    const prompts = {
      codebase: `Analyze the codebase at ${targetPath}. Read the source files, examine the architecture, and find every code quality disaster, security vulnerability, and maintainability nightmare.`,
      
      file_structure: `List and analyze the directory structure at ${targetPath}. Examine the file organization, naming conventions, and folder hierarchy. Find every organizational disaster and structural nightmare.`,
      
      dependencies: `Analyze the dependency file at ${targetPath} (package.json, requirements.txt, etc.). Read the actual dependencies, check for vulnerabilities, version conflicts, and package management disasters.`,
      
      git_history: `Examine the git history at ${targetPath}. Run git log commands to analyze commit patterns, branching strategy, and development workflow. Find every version control disaster.`,
      
      test_coverage: `Analyze the testing setup at ${targetPath}. Look for test files, run coverage commands if possible, and examine the testing strategy. Find every testing gap.`,
      
      idea: `Analyze this idea: ${targetPath}. Find where this concept will fail when it encounters reality.`,
      
      architecture: `Review this system architecture: ${targetPath}. Find every bottleneck and scaling failure.`,
      
      research: `Review this research: ${targetPath}. Find every methodological flaw and reproducibility issue.`,
      
      security: `Security analysis of: ${targetPath}. Find every vulnerability and attack vector.`,
      
      product: `Product review: ${targetPath}. Find every usability disaster and adoption barrier.`,
      
      infrastructure: `Infrastructure review: ${targetPath}. Find every single point of failure and operational nightmare.`
    };

    const specificPrompt = prompts[analysisType as keyof typeof prompts] || `Analyze ${targetPath} for ${analysisType} issues.`;
    
    return `${specificPrompt} ${context ? `Context: ${context}` : ''}`;
  }

  synthesizeBrutalistFeedback(responses: CLIAgentResponse[], analysisType: string): string {
    const successfulResponses = responses.filter(r => r.success);
    
    if (successfulResponses.length === 0) {
      return `# Brutalist Analysis Failed\n\nEven our brutal critics couldn't tear this apart - that's either very good or very bad.\n\nErrors:\n${responses.map(r => `- ${r.agent}: ${r.error}`).join('\n')}`;
    }

    let synthesis = `# Brutalist ${analysisType} Destruction Report\n\n`;
    synthesis += `${successfulResponses.length} AI critics have systematically demolished your work.\n\n`;

    successfulResponses.forEach((response, index) => {
      synthesis += `## Critic ${index + 1}: ${response.agent.toUpperCase()}\n`;
      synthesis += `*Execution time: ${response.executionTime}ms*\n\n`;
      synthesis += `${response.output}\n\n`;
      synthesis += `---\n\n`;
    });

    synthesis += `## Brutal Summary\n`;
    synthesis += `Your ${analysisType} has been systematically destroyed by ${successfulResponses.length} independent critics. `;
    synthesis += `Time to rebuild it properly.\n\n`;
    
    if (responses.some(r => !r.success)) {
      synthesis += `*Note: ${responses.filter(r => !r.success).length} critics failed to execute - they probably couldn't handle the carnage.*`;
    }

    return synthesis;
  }
}