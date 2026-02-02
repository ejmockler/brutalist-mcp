import { z } from "zod";
import { logger } from '../logger.js';
import { CLIAgentOrchestrator, BrutalistPromptType } from '../cli-agents.js';
import { ToolConfig } from '../types/tool-config.js';
import {
  BrutalistResponse,
  CLIAgentResponse,
  PaginationParams,
  BrutalistServerConfig
} from '../types/brutalist.js';
import {
  extractPaginationParams,
  parseCursor,
  PAGINATION_DEFAULTS
} from '../utils/pagination.js';
import { ResponseCache } from '../utils/response-cache.js';
import { ResponseFormatter } from '../formatting/response-formatter.js';
import { getSystemPrompt } from '../system-prompts.js';

/**
 * ToolHandler - Handles roast tool execution with caching and pagination
 * Extracted from BrutalistServer to follow Single Responsibility Principle
 */
export class ToolHandler {
  constructor(
    private cliOrchestrator: CLIAgentOrchestrator,
    private responseCache: ResponseCache,
    private formatter: ResponseFormatter,
    private config: BrutalistServerConfig,
    private activeSessions: Map<string, {
      startTime: number;
      requestCount: number;
      lastActivity: number;
    }>,
    private handleStreamingEvent: (event: any) => void,
    private handleProgressUpdate: (
      progressToken: string | number,
      progress: number,
      total: number,
      message: string,
      sessionId?: string
    ) => void,
    private ensureSessionCapacity: () => void
  ) {}

  /**
   * Unified handler for all roast tools - DRY principle
   */
  public async handleRoastTool(
    config: ToolConfig,
    args: any,
    extra: any
  ): Promise<any> {
    try {
      // CRITICAL: Prevent recursion - reject tool calls from brutalist-spawned subprocesses
      if (process.env.BRUTALIST_SUBPROCESS === '1') {
        logger.warn(`🚫 Rejecting tool call from brutalist subprocess (recursion prevented)`);
        return {
          content: [{
            type: "text" as const,
            text: `ERROR: Brutalist MCP tools cannot be used from within a brutalist-spawned CLI subprocess (recursion prevented)`
          }]
        };
      }

      const progressToken = extra._meta?.progressToken;

      // Extract session context for security
      // IMPORTANT: Use consistent "anonymous" for all anonymous users to enable cache sharing
      const sessionId = extra?.sessionId ||
                        extra?._meta?.sessionId ||
                        extra?.headers?.['mcp-session-id'] ||
                        'anonymous'; // Consistent for cache sharing across pagination requests

      const requestId = `${sessionId}-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      logger.debug(`🔐 Processing request with session: ${sessionId.substring(0, 8)}..., request: ${requestId.substring(0, 12)}...`);

      // Track session activity
      if (!this.activeSessions.has(sessionId)) {
        this.ensureSessionCapacity(); // Ensure capacity before adding new session
        this.activeSessions.set(sessionId, {
          startTime: Date.now(),
          requestCount: 0,
          lastActivity: Date.now()
        });
      }
      const sessionInfo = this.activeSessions.get(sessionId)!;
      sessionInfo.requestCount++;
      sessionInfo.lastActivity = Date.now();

      logger.debug(`Tool execution: ${config.name}, primaryArgField=${config.primaryArgField}`);
      logger.debug(`Args: ${JSON.stringify(args, null, 2)}`);

      // Extract pagination parameters
      const paginationParams = extractPaginationParams(args);
      if (args.cursor) {
        const cursorParams = parseCursor(args.cursor);
        Object.assign(paginationParams, cursorParams);
      }

      // Determine if pagination was explicitly requested by the user
      const explicitPaginationRequested =
        args.offset !== undefined ||
        args.limit !== undefined ||
        args.cursor !== undefined ||
        args.context_id !== undefined;

      logger.info(`🔧 DEBUG: explicitPaginationRequested=${explicitPaginationRequested}, offset=${args.offset}, limit=${args.limit}, cursor=${args.cursor}, context_id=${args.context_id}, resume=${args.resume}`);

      // Validate resume flag requires context_id
      if (args.resume && !args.context_id) {
        throw new Error(
          `The 'resume' flag requires a 'context_id' from a previous response. ` +
          `Run an initial analysis first, then use the returned context_id with resume: true.`
        );
      }

      // Check cache if context_id provided
      // Two modes: PAGINATION (context_id alone) vs CONTINUATION (context_id + resume: true)
      let conversationHistory: import('../utils/response-cache.js').ConversationMessage[] | undefined;
      let resumeFollowUpQuestion: string | undefined; // Store follow-up for conversation history
      let resumeOriginalParams: Record<string, unknown> | undefined; // Original params for filesystem tools
      if (args.context_id && !args.force_refresh) {
        const cachedResponse = await this.responseCache.getByContextId(args.context_id, sessionId);
        if (cachedResponse) {
          logger.info(`🎯 Cache HIT for context_id: ${args.context_id}`);

          if (args.resume === true) {
            // CONVERSATION CONTINUATION: User explicitly wants to continue with history injection
            const textContent = args.content || args.idea || args.architecture || args.research || args.product || args.security || args.infrastructure;
            const primaryArg = textContent || args[config.primaryArgField];

            if (!primaryArg || primaryArg.trim() === '') {
              throw new Error(
                `Conversation continuation (resume: true) requires new content/prompt. ` +
                `Provide your follow-up question or comment in the content field.`
              );
            }

            // Store the follow-up question for conversation history
            resumeFollowUpQuestion = primaryArg;

            // Store original request params (for filesystem tools that need original targetPath)
            resumeOriginalParams = cachedResponse.requestParams;

            logger.info(`💬 Conversation continuation - new prompt: "${primaryArg.substring(0, 50)}..."`);
            conversationHistory = cachedResponse.conversationHistory || [];
            // Fall through to execute new analysis with history
          } else {
            // PAGINATION: Just retrieving previous response (no resume flag)
            logger.info(`📖 Pagination request - returning cached response`);
            const cachedResult: BrutalistResponse = {
              success: true,
              responses: [{
                agent: 'cached' as any,
                success: true,
                output: cachedResponse.content,
                executionTime: 0
              }]
            };
            return this.formatter.formatToolResponse(cachedResult, args.verbose, paginationParams, args.context_id, explicitPaginationRequested);
          }
        } else {
          logger.warn(`❌ Cache MISS for context_id: ${args.context_id}, session: ${sessionId}`);
          throw new Error(
            `Context ID "${args.context_id}" not found in cache. ` +
            `It may have expired (2 hour TTL) or belong to a different session. ` +
            `Remove context_id parameter to run a new analysis.`
          );
        }
      }

      // Generate cache key for this request
      const cacheKey = this.responseCache.generateCacheKey(
        config.cacheKeyFields.reduce((acc, field) => {
          acc.tool = config.name;
          if (args[field] !== undefined) acc[field] = args[field];
          return acc;
        }, {} as Record<string, any>)
      );

      // Check if we have a cached result (unless forcing refresh)
      if (!args.force_refresh) {
        const cachedContent = await this.responseCache.get(cacheKey, sessionId);
        if (cachedContent) {
          // Get existing context_id or create new alias
          const existingContextId = this.responseCache.findContextIdForKey(cacheKey);
          const contextId = existingContextId
            ? this.responseCache.createAlias(existingContextId, cacheKey)
            : this.responseCache.generateContextId(cacheKey);
          logger.info(`🎯 Cache hit for new request, using context_id: ${contextId}`);
          const cachedResult: BrutalistResponse = {
            success: true,
            responses: [{
              agent: 'cached' as any,
              success: true,
              output: cachedContent,
              executionTime: 0
            }]
          };
          return this.formatter.formatToolResponse(cachedResult, args.verbose, paginationParams, contextId, explicitPaginationRequested);
        }
      }

      // Build context with custom builder if available
      let context = config.contextBuilder ? config.contextBuilder(args) : args.context;

      // Get the primary argument (targetPath or content)
      // All abstract tools now use 'content', filesystem tools use 'targetPath'
      let primaryArg = args[config.primaryArgField];

      // For resume mode with filesystem tools, use original targetPath from cached params
      // and inject the follow-up question into context instead
      const filesystemTools = ['codebase', 'fileStructure', 'dependencies', 'gitHistory', 'testCoverage'];
      if (resumeOriginalParams && filesystemTools.includes(config.analysisType)) {
        // Use original targetPath for the CLI execution (needed for path validation)
        const originalTargetPath = resumeOriginalParams.targetPath as string;
        if (originalTargetPath) {
          logger.info(`🔄 Resume mode: Using original targetPath="${originalTargetPath}" for filesystem tool`);
          primaryArg = originalTargetPath;

          // Also restore workingDirectory if available
          if (resumeOriginalParams.workingDirectory) {
            args.workingDirectory = resumeOriginalParams.workingDirectory as string;
          }
        }
      }

      // Validate that primary argument is provided
      if (!primaryArg) {
        throw new Error(`Missing required argument: ${config.primaryArgField}`);
      }

      // Type narrowing: primaryArg is now guaranteed to be a string
      const validatedPrimaryArg: string = primaryArg;

      // If we have conversation history, inject it into the context
      if (conversationHistory && conversationHistory.length > 0) {
        const conversationContext = conversationHistory.map(msg => {
          const role = msg.role === 'user' ? 'User' : 'Assistant';
          return `${role}: ${msg.content}`;
        }).join('\n\n---\n\n');

        // For resume mode, inject the follow-up question into the context
        const followUpContent = resumeFollowUpQuestion || '';
        const contextPrefix = `## Previous Conversation\n\n${conversationContext}\n\n---\n\n## New User Prompt\n\n${followUpContent}\n\n`;
        context = contextPrefix + (context || '');
        logger.info(`💬 Injected ${conversationHistory.length} previous messages into context`);
      }

      logger.debug(`Primary arg: ${config.primaryArgField}="${validatedPrimaryArg}", analysisType="${config.analysisType}"`);

      // Get system prompt (from deprecated field or system-prompts.ts)
      const systemPrompt = config.systemPrompt || getSystemPrompt(config.analysisType);

      // Run the analysis
      const result = await this.executeBrutalistAnalysis(
        config.analysisType,
        validatedPrimaryArg,
        systemPrompt,
        context,
        args.workingDirectory,
        args.clis,
        args.verbose,
        args.models,
        progressToken,
        sessionId,
        requestId
      );

      // Cache the result if successful
      let contextId: string | undefined;
      if (result.success && result.responses.length > 0) {
        const fullContent = this.formatter.extractFullContent(result);
        if (fullContent) {
          const cacheData = config.cacheKeyFields.reduce((acc, field) => {
            acc.tool = config.name;
            if (args[field] !== undefined) acc[field] = args[field];
            return acc;
          }, {} as Record<string, any>);

          // Build updated conversation history
          // For resume mode, use the follow-up question; otherwise use primaryArg
          const now = Date.now();
          const userMessageContent = resumeFollowUpQuestion || primaryArg;
          const updatedConversation: import('../utils/response-cache.js').ConversationMessage[] = [
            ...(conversationHistory || []),
            { role: 'user', content: userMessageContent, timestamp: now },
            { role: 'assistant', content: fullContent, timestamp: now }
          ];

          // If continuing a conversation (resume: true), update existing context_id
          if (args.resume && args.context_id && conversationHistory) {
            // Update existing cache entry with extended conversation
            contextId = args.context_id as string;
            await this.responseCache.updateByContextId(
              contextId,
              fullContent,
              updatedConversation,
              sessionId || 'anonymous'
            );
            logger.info(`✅ Updated conversation ${contextId} (now ${updatedConversation.length} messages)`);
          } else {
            // New conversation - create new context_id
            const { contextId: newId } = await this.responseCache.set(
              cacheData,
              fullContent,
              cacheKey,
              sessionId,
              requestId,
              updatedConversation
            );
            contextId = newId;
            logger.info(`✅ Cached new conversation with context ID: ${contextId} for session: ${sessionId?.substring(0, 8)}`);
          }
        }
      }

      return this.formatter.formatToolResponse(result, args.verbose, paginationParams, contextId, explicitPaginationRequested);
    } catch (error) {
      return this.formatter.formatErrorResponse(error);
    }
  }

  /**
   * Execute brutalist analysis with CLI orchestrator
   */
  private async executeBrutalistAnalysis(
    analysisType: BrutalistPromptType,
    primaryContent: string,
    systemPromptSpec: string,
    context?: string,
    workingDirectory?: string,
    clis?: ('claude' | 'codex' | 'gemini')[],
    verbose?: boolean,
    models?: {
      claude?: string;
      codex?: string;
      gemini?: string;
    },
    progressToken?: string | number,
    sessionId?: string,
    requestId?: string
  ): Promise<BrutalistResponse> {
    logger.info(`🏢 Starting brutalist analysis: ${analysisType}`);
    logger.info(`🔧 DEBUG: clis=${clis?.join(',') || 'all'}, primaryContent=${primaryContent}`);
    logger.debug("Executing brutalist analysis", {
      primaryContent,
      analysisType,
      systemPromptSpec,
      workingDirectory,
      clis
    });

    try {
      // Get CLI context for execution summary
      logger.info(`🔧 DEBUG: About to detect CLI context`);
      await this.cliOrchestrator.detectCLIContext();
      logger.info(`🔧 DEBUG: CLI context detected successfully`);

      // Execute CLI agent analysis (single or multi-CLI based on preferences)
      logger.info(`🔍 Executing brutalist analysis with timeout: ${this.config.defaultTimeout}ms`);
      logger.info(`🔧 DEBUG: About to call cliOrchestrator.executeBrutalistAnalysis`);
      const responses = await this.cliOrchestrator.executeBrutalistAnalysis(
        analysisType,
        primaryContent,
        systemPromptSpec,
        context,
        {
          workingDirectory: workingDirectory || this.config.workingDirectory,
          timeout: this.config.defaultTimeout,
          clis,
          analysisType: analysisType as BrutalistPromptType,
          models,
          onStreamingEvent: this.handleStreamingEvent,
          progressToken,
          onProgress: progressToken && sessionId ?
            (progress: number, total: number, message: string) =>
              this.handleProgressUpdate(progressToken, progress, total, message, sessionId) : undefined,
          sessionId,
          requestId
        }
      );
      logger.info(`🔧 DEBUG: cliOrchestrator.executeBrutalistAnalysis returned ${responses.length} responses`);

      const successfulResponses = responses.filter(r => r.success);
      const totalExecutionTime = responses.reduce((sum, r) => sum + r.executionTime, 0);

      logger.info(`📊 Analysis complete: ${successfulResponses.length}/${responses.length} CLIs successful (${totalExecutionTime}ms total)`);
      logger.info(`🔧 DEBUG: About to synthesize feedback`);
      const synthesis = this.cliOrchestrator.synthesizeBrutalistFeedback(responses, analysisType);
      logger.info(`🔧 DEBUG: Synthesis length: ${synthesis.length} characters`);

      const result = {
        success: successfulResponses.length > 0,
        responses,
        synthesis,
        analysisType,
        targetPath: primaryContent,
        executionSummary: {
          totalCLIs: responses.length,
          successfulCLIs: successfulResponses.length,
          failedCLIs: responses.length - successfulResponses.length,
          totalExecutionTime,
          selectedCLI: responses.length === 1 ? responses[0].agent : undefined,
          selectionMethod: responses.length === 1 ? (responses[0] as any).selectionMethod : 'multi-cli'
        }
      };
      logger.info(`🔧 DEBUG: Returning result with success=${result.success}`);
      return result;
    } catch (error) {
      logger.error("Brutalist analysis execution failed", error);
      throw error;
    }
  }
}
