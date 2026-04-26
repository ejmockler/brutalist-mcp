/**
 * DebateOrchestrator — debate orchestration extracted from brutalist-server.ts.
 *
 * This module encapsulates the entire debate subsystem:
 *   - handleDebateToolExecution(): cache-aware entry point for debate tool calls
 *   - executeCLIDebate(): core debate engine with 3-tier escalation
 *
 * Dependencies are injected via constructor, making brutalist-server.ts a pure
 * composition root that wires and delegates.
 *
 * Extracted from brutalist-server.ts lines 665-1348.
 */

import { existsSync } from 'fs';
import { join as pathJoin, resolve as pathResolve } from 'path';
import type { StructuredLogger } from '../logger.js';
import { mediateTranscript } from '../utils/transcript-mediator.js';
import {
  parseCursor,
  PAGINATION_DEFAULTS
} from '../utils/pagination.js';
import type { ResponseCache, ConversationMessage } from '../utils/response-cache.js';
import type { ResponseFormatter } from '../formatting/response-formatter.js';
import type { CLIAgentOrchestrator, StreamingEvent, CLIAgentOptions } from '../cli-agents.js';
import type { MetricsRegistry } from '../metrics/index.js';
import {
  DEBATE_DURATION_LABELS,
  ESCALATION_TIER_LABELS,
  safeMetric as sharedSafeMetric,
} from '../metrics/index.js';
import type {
  BrutalistResponse,
  BrutalistServerConfig,
  PaginationParams,
  CLIAgentResponse,
  DebateTurnMetadata,
  DebateBehaviorSummary
} from '../types/brutalist.js';

import { detectRefusal } from './refusal-detection.js';
import { constitutionalAnchor, type DebateTier } from './constitutional.js';
import { synthesizeDebate } from './synthesis.js';

// Re-export sub-module types for convenience
export type { DebateTier } from './constitutional.js';

/** Dependencies injected into DebateOrchestrator at construction time. */
export interface DebateOrchestratorDeps {
  cliOrchestrator: CLIAgentOrchestrator;
  responseCache: ResponseCache;
  formatter: ResponseFormatter;
  config: BrutalistServerConfig;
  onStreamingEvent: (event: StreamingEvent) => void;
  onProgressUpdate: (
    progressToken: string | number,
    progress: number,
    total: number | undefined,
    message: string,
    sessionId?: string
  ) => void;
  /**
   * Shared metrics registry for debate orchestration instrumentation.
   * Required: the composition root constructs a single registry per
   * BrutalistServer instance and passes it to every module that records
   * metrics. Tests construct a fresh registry via `createMetricsRegistry()`.
   */
  metrics: MetricsRegistry;
  /**
   * Scoped structured logger bound with `module='debate'`. Required: the
   * composition root binds `logger.for({ module: 'debate', operation:
   * 'orchestrate' })` once and passes it in. Call sites inside this
   * module narrow per-operation via `this.log.forOperation('...')`.
   * Typed as the interface (not the concrete `Logger` class) so tests
   * can inject stubs without subclassing.
   */
  log: StructuredLogger;
}

/** Arguments for handleDebateToolExecution (matches the tool schema). */
export interface DebateToolArgs {
  topic: string;
  proPosition: string;
  conPosition: string;
  target?: string;
  agents?: ('claude' | 'codex' | 'gemini')[];
  rounds?: number;
  context?: string;
  workingDirectory?: string;
  models?: { claude?: string; codex?: string; gemini?: string };
  context_id?: string;
  resume?: boolean;
  offset?: number;
  limit?: number;
  cursor?: string;
  force_refresh?: boolean;
  verbose?: boolean;
  mcp_servers?: string[];
}

/** Internal arguments for executeCLIDebate (includes streaming callbacks). */
interface ExecuteDebateArgs {
  topic: string;
  proPosition: string;
  conPosition: string;
  target?: string;
  agents?: ('claude' | 'codex' | 'gemini')[];
  rounds: number;
  context?: string;
  workingDirectory?: string;
  models?: { claude?: string; codex?: string; gemini?: string };
  onStreamingEvent?: (event: StreamingEvent) => void;
  progressToken?: string | number;
  onProgress?: (progress: number, total: number | undefined, message: string) => void;
  sessionId?: string;
  mcp_servers?: string[];
}

/**
 * Rank of each debate tier for computing the MAX tier reached across all
 * turns of a debate. Used to derive the `tier` label on the debate
 * duration histogram (higher rank wins).
 */
const TIER_RANK: Record<DebateTier, number> = {
  standard: 0,
  escalated: 1,
  decomposed: 2,
};

/**
 * DebateOrchestrator encapsulates all debate orchestration logic.
 *
 * It accepts dependencies via constructor injection so that brutalist-server.ts
 * remains a thin composition root.
 */
export class DebateOrchestrator {
  /** Mutable so test harnesses can replace cliOrchestrator on BrutalistServer. */
  private _cliOrchestrator: CLIAgentOrchestrator;
  private readonly responseCache: ResponseCache;
  private readonly formatter: ResponseFormatter;
  private readonly config: BrutalistServerConfig;
  private readonly onStreamingEvent: (event: StreamingEvent) => void;
  private readonly onProgressUpdate: DebateOrchestratorDeps['onProgressUpdate'];
  private readonly metrics: MetricsRegistry;
  private readonly log: StructuredLogger;

  get cliOrchestrator(): CLIAgentOrchestrator {
    return this._cliOrchestrator;
  }
  set cliOrchestrator(value: CLIAgentOrchestrator) {
    this._cliOrchestrator = value;
  }

  constructor(deps: DebateOrchestratorDeps) {
    this._cliOrchestrator = deps.cliOrchestrator;
    this.responseCache = deps.responseCache;
    this.formatter = deps.formatter;
    this.config = deps.config;
    this.onStreamingEvent = deps.onStreamingEvent;
    this.onProgressUpdate = deps.onProgressUpdate;
    this.metrics = deps.metrics;
    this.log = deps.log;
  }

  /**
   * Isolate metric writes from business control flow.
   *
   * Delegates to the shared `safeMetric` helper in
   * `src/metrics/safe-metric.ts`. The private method is retained so
   * existing call sites inside DebateOrchestrator
   * (`this.safeMetric(op, fn)`) keep working without a touch, and so
   * any debate-specific metric-error instrumentation can be layered in
   * one place in the future.
   *
   * Parity note: `CLIAgentOrchestrator` uses the same shared helper
   * directly (no private method) to prevent metric throws from
   * propagating into the outer spawn try/catch. See Cycle 3 rework
   * Task CLI-B' in phases/instrument_cli_spawn/phase.md.
   */
  private safeMetric(op: string, fn: () => void): void {
    sharedSafeMetric(this.log, op, fn);
  }

  /**
   * Handle debate tool execution with constitutional position anchoring.
   * Uses 2 randomly selected agents (or user-specified) with explicit PRO/CON positions.
   *
   * This is the entry point called from the roast_cli_debate tool registration.
   *
   * Instrumentation (intent #1): every exit path records the debate
   * orchestration duration histogram exactly once. The `tier` label is the
   * MAX tier reached across all turns of the underlying `executeCLIDebate`
   * call; cache-hit paths short-circuit before any CLI agent runs, so their
   * tier is always `'standard'`. The outer try/finally placement ensures
   * error paths, refusal paths, and cache-hit paths all emit exactly one
   * observation — `executeCLIDebate` itself has NO timer block to avoid
   * double-observation.
   */
  async handleDebateToolExecution(args: DebateToolArgs, extra?: any): Promise<any> {
    const handleToolLog = this.log.forOperation('handle_tool');
    const t0 = Date.now();
    // Histogram labels — DEBATE_DURATION_LABELS = ['outcome', 'tier'] as const.
    // outcome is derived from the debate result's behavior (refused vs. success)
    // or forced to 'error' in the catch branch.
    let outcome: 'success' | 'refused' | 'error' = 'success';
    let tier: DebateTier = 'standard';
    try {
      // Build pagination params
      const paginationParams: PaginationParams = {
        offset: args.offset || 0,
        limit: args.limit || PAGINATION_DEFAULTS.DEFAULT_LIMIT_TOKENS
      };

      if (args.cursor) {
        const cursorParams = parseCursor(args.cursor);
        Object.assign(paginationParams, cursorParams);
      }

      const explicitPaginationRequested =
        args.offset !== undefined ||
        args.limit !== undefined ||
        args.cursor !== undefined ||
        args.context_id !== undefined;
      const pageReadRequested =
        args.context_id !== undefined &&
        (args.offset !== undefined || args.cursor !== undefined);

      // Extract session ID early — needed for cache session isolation
      const sessionId = extra?.sessionId ||
                        extra?._meta?.sessionId ||
                        extra?.headers?.['mcp-session-id'] ||
                        'anonymous';

      // Validate resume flag requires context_id
      if (args.resume && !args.context_id) {
        throw new Error(
          `The 'resume' flag requires a 'context_id' from a previous debate. ` +
          `Run an initial debate first, then use the returned context_id with resume: true.`
        );
      }

      // Check cache if context_id provided
      let conversationHistory: ConversationMessage[] | undefined;
      if (args.context_id && !args.force_refresh) {
        const cachedResponse = await this.responseCache.getByContextId(args.context_id, sessionId);
        if (cachedResponse) {
          handleToolLog.info(`🎯 Debate cache HIT for context_id: ${args.context_id}`);

          if (args.resume === true && !pageReadRequested) {
            // CONVERSATION CONTINUATION: Continue the debate
            if (!args.topic || args.topic.trim() === '') {
              throw new Error(
                `Debate continuation (resume: true) requires a new prompt/question. ` +
                `Provide your follow-up in the topic field.`
              );
            }

            // Security: avoid logging user-provided topic text at info level.
            // Emit length only; if a developer needs the preview, run at debug.
            handleToolLog.info('Debate continuation - new prompt received', {
              topicLength: args.topic.length,
            });
            conversationHistory = cachedResponse.conversationHistory || [];
            // Fall through to execute new debate round with history
          } else {
            // PAGINATION: Return cached debate result — no agent ran,
            // outcome='success' and tier='standard' (their initial values).
            if (args.resume === true) {
              handleToolLog.warn(
                'Ignoring resume=true on debate page-read request; context_id + offset/cursor returns cached content'
              );
            }
            handleToolLog.info(`📖 Debate pagination request - returning cached response`);
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
          handleToolLog.warn(`❌ Debate cache MISS for context_id: ${args.context_id}`);
          throw new Error(
            `Context ID "${args.context_id}" not found in cache. ` +
            `It may have expired (2 hour TTL) or belong to a different session. ` +
            `Remove context_id parameter to run a new debate.`
          );
        }
      }

      // Generate cache key for this debate
      const cacheKey = this.responseCache.generateCacheKey({
        tool: 'roast_cli_debate',
        topic: args.topic,
        proPosition: args.proPosition,
        conPosition: args.conPosition,
        agents: args.agents,
        rounds: args.rounds,
        context: args.context
      });

      // Check cache for identical request (if not resuming)
      if (!args.force_refresh && !args.resume) {
        const cachedContent = await this.responseCache.get(cacheKey);
        if (cachedContent) {
          const existingContextId = this.responseCache.findContextIdForKey(cacheKey);
          const contextId = existingContextId
            ? this.responseCache.createAlias(existingContextId, cacheKey)
            : this.responseCache.generateContextId(cacheKey);
          handleToolLog.info(`🎯 Debate cache hit for new request, using context_id: ${contextId}`);
          const cachedResult: BrutalistResponse = {
            success: true,
            responses: [{
              agent: 'cached' as any,
              success: true,
              output: cachedContent,
              executionTime: 0
            }]
          };
          // Cache hit: outcome='success', tier='standard' (no agent ran).
          return this.formatter.formatToolResponse(cachedResult, args.verbose, paginationParams, contextId, explicitPaginationRequested);
        }
      }

      // Build context with conversation history if resuming
      let debateContext = args.context || '';
      if (conversationHistory && conversationHistory.length > 0) {
        const previousDebate = conversationHistory.map(msg => {
          const role = msg.role === 'user' ? 'User Question' : 'Debate Response';
          return `${role}:\n${msg.content}`;
        }).join('\n\n---\n\n');

        debateContext = `## Previous Debate Context\n\n${previousDebate}\n\n---\n\n## New Follow-up Question\n\nThe user wants to continue this debate with a new question or direction.\n\n${debateContext}`;
        handleToolLog.info(`💬 Injected ${conversationHistory.length} previous messages into debate context`);
      }

      // Extract streaming context from extra
      const progressToken = extra?._meta?.progressToken;

      // Execute the debate
      const numRounds = Math.min(args.rounds || 3, 3);
      const result = await this.executeCLIDebate({
        topic: args.topic,
        proPosition: args.proPosition,
        conPosition: args.conPosition,
        agents: args.agents,
        rounds: numRounds,
        context: debateContext,
        workingDirectory: args.workingDirectory,
        models: args.models,
        onStreamingEvent: this.onStreamingEvent,
        progressToken,
        onProgress: progressToken && sessionId ?
          (progress: number, total: number | undefined, message: string) =>
            this.onProgressUpdate(progressToken, progress, total, message, sessionId) : undefined,
        sessionId,
        mcp_servers: args.mcp_servers,
      });

      // Derive outcome and tier from the debate result for the histogram
      // observation that fires in the finally block below. The counter for
      // per-turn escalation tier already fired inside executeCLIDebate; this
      // block only extracts the histogram labels — no metric emissions here.
      const turns = result.debateBehavior?.turns ?? [];
      if (turns.length > 0) {
        // Tier = MAX tier reached across all turns (higher rank wins).
        tier = turns.reduce<DebateTier>(
          (max, t) => TIER_RANK[t.tier] > TIER_RANK[max] ? t.tier : max,
          'standard',
        );
        // Outcome = 'refused' when every turn's engaged=false AND at least
        // one turn refused. Otherwise 'success'. The catch branch below
        // overrides to 'error'.
        const allDisengaged = turns.every(t => !t.engaged);
        const anyRefused = turns.some(t => t.refused);
        if (allDisengaged && anyRefused) {
          outcome = 'refused';
        }
      }

      // Cache the result
      let contextId: string | undefined;
      if (result.success && result.responses.length > 0) {
        const fullContent = this.formatter.extractFullContent(result);
        if (fullContent) {
          const now = Date.now();
          const updatedConversation: ConversationMessage[] = [
            ...(conversationHistory || []),
            { role: 'user', content: args.topic, timestamp: now },
            { role: 'assistant', content: fullContent, timestamp: now }
          ];

          if (args.resume && args.context_id && conversationHistory) {
            // Update existing cache entry
            contextId = args.context_id;
            await this.responseCache.updateByContextId(
              contextId,
              fullContent,
              updatedConversation,
              sessionId
            );
            this.log.forOperation('cache').info(
              `✅ Updated debate conversation ${contextId} (now ${updatedConversation.length} messages)`
            );
          } else {
            // New debate - create new context_id
            const { contextId: newId } = await this.responseCache.set(
              { tool: 'roast_cli_debate', topic: args.topic },
              fullContent,
              cacheKey,
              sessionId,
              undefined,
              updatedConversation
            );
            contextId = newId;
            this.log.forOperation('cache').info(
              `✅ Cached new debate with context ID: ${contextId}`
            );
          }
        }
      }

      return this.formatter.formatToolResponse(result, args.verbose, paginationParams, contextId, explicitPaginationRequested);
    } catch (error) {
      outcome = 'error';
      return this.formatter.formatErrorResponse(error);
    } finally {
      // Record the debate duration exactly once per invocation. This is the
      // SINGLE histogram observation point for debate orchestration — do
      // NOT add another observe() call inside executeCLIDebate or any
      // inner path. The typed label record below references
      // DEBATE_DURATION_LABELS so a future label-set change triggers a
      // compile error at this call site.
      const durationSec = (Date.now() - t0) / 1000;
      const durationLabels: Record<(typeof DEBATE_DURATION_LABELS)[number], string> = {
        outcome,
        tier,
      };
      this.safeMetric('observe:debate_duration', () =>
        this.metrics.debateOrchestrationDurationSeconds.observe(
          durationLabels,
          durationSec,
        ),
      );
    }
  }

  /**
   * Execute CLI debate with constitutional position anchoring.
   * 2 agents, explicit PRO/CON positions, context compression between rounds.
   *
   * This is the core debate engine. It manages:
   *   - Agent selection and position assignment
   *   - Round execution with 3-tier refusal escalation
   *   - Transcript mediation between rounds
   *   - Behavioral metadata and asymmetry detection
   *   - Synthesis generation
   */
  async executeCLIDebate(args: ExecuteDebateArgs): Promise<BrutalistResponse> {
    const { topic, proPosition, conPosition, rounds, context, workingDirectory, models,
            onStreamingEvent, progressToken, onProgress, sessionId } = args;

    const debateLog = this.log.forOperation('execute_debate');
    const escalateLog = this.log.forOperation('escalate');
    // Security (Cycle 3 F32): the debug-level emission previously leaked
    // user-provided topic/proPosition/conPosition text into logs whenever
    // BRUTALIST_LOG_LEVEL=debug was set — identical disclosure channel to
    // the info-level site already redacted at :263. Emit length-only
    // fields matching that pattern; a developer needing the raw text
    // should inspect the transcript passed to executeCLIDebate directly.
    debateLog.debug("Executing CLI debate", {
      topicLength: topic.length,
      proPositionLength: proPosition.length,
      conPositionLength: conPosition.length,
      rounds,
    });

    try {
      // Get available CLIs
      const cliContext = await this.cliOrchestrator.detectCLIContext();
      const availableCLIs = cliContext.availableCLIs as ('claude' | 'codex' | 'gemini')[];

      if (availableCLIs.length < 2) {
        throw new Error(`Need at least 2 CLI agents for debate. Available: ${availableCLIs.join(', ')}`);
      }

      // Select 2 agents: use specified or random selection
      let selectedAgents: ('claude' | 'codex' | 'gemini')[];
      if (args.agents && args.agents.length === 2) {
        // Validate specified agents are available
        const unavailable = args.agents.filter(a => !availableCLIs.includes(a));
        if (unavailable.length > 0) {
          throw new Error(`Specified agents not available: ${unavailable.join(', ')}. Available: ${availableCLIs.join(', ')}`);
        }
        selectedAgents = args.agents;
      } else {
        // Random selection of 2 agents
        const shuffled = [...availableCLIs].sort(() => Math.random() - 0.5);
        selectedAgents = shuffled.slice(0, 2);
      }

      // Randomly assign PRO/CON positions
      const shuffledAgents = [...selectedAgents].sort(() => Math.random() - 0.5);
      const proAgent = shuffledAgents[0];
      const conAgent = shuffledAgents[1];

      debateLog.info(`🎭 Debate: ${proAgent.toUpperCase()} (PRO) vs ${conAgent.toUpperCase()} (CON)`);

      const debateResponses: CLIAgentResponse[] = [];
      const transcript: { agent: string; position: string; round: number; content: string }[] = [];
      const turnMetadata: DebateTurnMetadata[] = [];
      let compressedContext = '';
      const totalTurns = rounds * 2; // 2 agents per round
      let completedTurns = 0;

      // Frontier 1: Detect self-referential working directory (Codex reading its own control prompts)
      const resolvedWorkDir = args.target || workingDirectory || this.config.workingDirectory || process.cwd();
      const absWorkDir = pathResolve(resolvedWorkDir);
      const isSelfReferential = existsSync(pathJoin(absWorkDir, 'src', 'brutalist-server.ts'))
        || existsSync(pathJoin(absWorkDir, 'dist', 'brutalist-server.js'));
      if (isSelfReferential) {
        debateLog.info(`🔒 Debate working directory is brutalist repo — Codex will be sandboxed`);
      }

      // Execute rounds
      for (let round = 1; round <= rounds; round++) {
        debateLog.info(`📢 Round ${round}/${rounds}`);

        // Both agents argue in each round
        for (const [agent, position, thesis] of [
          [proAgent, 'PRO', proPosition],
          [conAgent, 'CON', conPosition]
        ] as const) {

          let prompt: string;

          debateLog.info(`  ⚔️ ${agent.toUpperCase()} (${position}) arguing...`);

          // Build prompt-generation function so we can rebuild on escalation
          const mcpBlock = args.mcp_servers?.length
            ? `\nEXTERNAL TOOL ACCESS: You have MCP tools available (${args.mcp_servers.join(', ')}). Use them to gather evidence supporting your position. You MUST NOT modify the codebase.\n`
            : '';

          const buildPrompt = (tier: DebateTier) => {
            if (round === 1) {
              return `${constitutionalAnchor(agent, position, thesis, tier)}
${mcpBlock}
TOPIC: ${topic}
${context ? `CONTEXT: ${context}` : ''}

Round 1: Opening analysis.

Present your ${position} analysis. Structure your response:

<thesis_statement>
Your core analytical position
</thesis_statement>

<key_arguments>
Three strongest arguments grounding your position in evidence and reasoning
</key_arguments>

<preemptive_rebuttal>
Address the strongest counterargument and show why it does not defeat your position
</preemptive_rebuttal>

<conclusion>
Reinforce why your analysis holds
</conclusion>`;
            } else {
              const rawOpponent = transcript
                .filter(t => t.agent !== agent && t.round === round - 1)
                .map(t => t.content)
                .join('\n\n');
              const { sanitized: opponentTranscript, patternsDetected: opponentPatterns } =
                mediateTranscript(rawOpponent, 'sanitize', 4000);
              if (opponentPatterns.length > 0) {
                debateLog.info(`🛡️ Mediated ${opponentPatterns.length} patterns from opponent transcript for ${agent}`, { opponentPatterns });
              }

              return `${constitutionalAnchor(agent, position, thesis, tier)}
${mcpBlock}
TOPIC: ${topic}

Round ${round}: Engage with your counterpart's analysis.

YOUR COUNTERPART'S PREVIOUS ANALYSIS:
${opponentTranscript || 'No previous analysis recorded'}

${compressedContext ? `ANALYSIS CONTEXT SO FAR:\n${compressedContext}\n` : ''}

<counterpart_gaps>
Identify the specific weaknesses in their reasoning and evidence
</counterpart_gaps>

<deepening_analysis>
Advance new evidence and reasoning that strengthens your position
</deepening_analysis>

<reinforcement>
Show why your position holds against their strongest points
</reinforcement>`;
            }
          };

          try {
            const turnRequestId = `debate-${sessionId || 'anon'}-${round}-${agent}-${Date.now()}`;

            // Emit agent_start streaming event
            if (onStreamingEvent) {
              onStreamingEvent({
                type: 'agent_start',
                agent,
                content: `Round ${round}/${rounds}: ${agent.toUpperCase()} (${position}) arguing...`,
                timestamp: Date.now(),
                sessionId,
              });
            }

            // Working directory: debateMode suppresses Codex shell exploration via prompt,
            // so no need to redirect — Codex still needs a git repo to function
            const agentWorkDir = workingDirectory || this.config.workingDirectory;

            const cliOptions: CLIAgentOptions = {
              workingDirectory: agentWorkDir,
              timeout: (this.config.defaultTimeout || 60000) * 2,
              models,
              onStreamingEvent,
              progressToken,
              onProgress,
              sessionId,
              requestId: turnRequestId,
              debateMode: true, // Frontier 1: suppress Codex shell exploration
              mcpServers: args.mcp_servers, // MCP servers for evidence-backed debate
            };

            // Three-tier escalation: standard -> escalated -> decomposed
            prompt = buildPrompt('standard');
            let wasRefused = false;
            let wasEscalated = false;
            let engagedAfterEscalation = false;
            let finalTier: DebateTier = 'standard';

            let response = await this.cliOrchestrator.executeSingleCLI(
              agent, prompt, prompt, cliOptions
            );

            // Tier 2: Detect refusal -> retry with analytical framing
            if (response.success && response.output && detectRefusal(response.output)) {
              wasRefused = true;
              wasEscalated = true;
              finalTier = 'escalated';
              escalateLog.warn(`🛡️ ${agent.toUpperCase()} (${position}) refused — escalating to analytical framing (tier 2)`);
              const escalatedPrompt = buildPrompt('escalated');
              const retryResponse = await this.cliOrchestrator.executeSingleCLI(
                agent, escalatedPrompt, escalatedPrompt,
                { ...cliOptions, requestId: `${turnRequestId}-escalated` }
              );

              if (retryResponse.success && retryResponse.output && !detectRefusal(retryResponse.output)) {
                escalateLog.info(`✅ ${agent.toUpperCase()} (${position}) engaged after tier 2 escalation`);
                engagedAfterEscalation = true;
                response = retryResponse;
              } else {
                // Tier 3: Decomposed — scholarly steelman framing
                finalTier = 'decomposed';
                escalateLog.warn(`🛡️ ${agent.toUpperCase()} (${position}) refused tier 2 — escalating to decomposed framing (tier 3)`);
                const decomposedPrompt = buildPrompt('decomposed');
                const decomposedResponse = await this.cliOrchestrator.executeSingleCLI(
                  agent, decomposedPrompt, decomposedPrompt,
                  { ...cliOptions, requestId: `${turnRequestId}-decomposed` }
                );

                if (decomposedResponse.success && decomposedResponse.output && !detectRefusal(decomposedResponse.output)) {
                  escalateLog.info(`✅ ${agent.toUpperCase()} (${position}) engaged after tier 3 decomposition`);
                  engagedAfterEscalation = true;
                  response = decomposedResponse;
                } else {
                  escalateLog.warn(`⚠️ ${agent.toUpperCase()} (${position}) refused all 3 tiers — using best response`);
                  // Use decomposed response if available (likely less meta-commentary)
                  if (decomposedResponse.success && decomposedResponse.output) {
                    response = decomposedResponse;
                  }
                }
              }
            }

            // Always add response (success or failure) for visibility
            debateResponses.push(response);
            completedTurns++;

            // Emit agent_complete streaming event
            if (onStreamingEvent) {
              onStreamingEvent({
                type: 'agent_complete',
                agent,
                content: `Round ${round}/${rounds}: ${agent.toUpperCase()} (${position}) ${response.success ? 'finished' : 'failed'}`,
                timestamp: Date.now(),
                sessionId,
              });
            }

            // Emit progress update
            if (onProgress) {
              onProgress(completedTurns, totalTurns, `Debate: ${completedTurns}/${totalTurns} turns complete`);
            }

            // Frontier 3: Track behavioral metadata
            const finalRefused = response.success && response.output ? detectRefusal(response.output) : false;
            turnMetadata.push({
              agent: agent as 'claude' | 'codex' | 'gemini',
              position: position as 'PRO' | 'CON',
              round,
              engaged: response.success && !!response.output && !finalRefused,
              refused: wasRefused,
              escalated: wasEscalated,
              engagedAfterEscalation,
              responseLength: response.output?.length || 0,
              executionTime: response.executionTime,
              tier: engagedAfterEscalation ? finalTier : (wasEscalated ? finalTier : 'standard'),
            });
            // Escalation-tier counter: fires exactly ONCE per turn, labeled
            // with this turn's FINAL tier (standard/escalated/decomposed).
            // Retries within a single turn are NOT counted separately —
            // they are represented by the final tier value on the pushed
            // turnMetadata record. The typed label record references
            // ESCALATION_TIER_LABELS so a future label-set change
            // triggers a compile error at this call site. The call is
            // wrapped in safeMetric so a metric throw cannot corrupt the
            // surrounding turn try/catch (would otherwise double-push
            // metadata and double-count completedTurns).
            const successTierLabels: Record<(typeof ESCALATION_TIER_LABELS)[number], string> = {
              tier: turnMetadata[turnMetadata.length - 1].tier,
            };
            this.safeMetric('inc:escalation_tier', () =>
              this.metrics.debateEscalationTierTotal.inc(successTierLabels, 1),
            );

            if (response.success && response.output) {
              transcript.push({
                agent,
                position,
                round,
                content: response.output
              });
            } else {
              // Security (Cycle 3 F33 Pattern A): response.error can carry
              // CLI-subprocess stderr tail, which in turn may echo model-
              // generated or prompt-echoed text. Emit a presence-only flag
              // at warn level instead of the raw string; operators with
              // debug file-logging can still correlate via agent/position/
              // round, and the transcript is the canonical source of truth
              // for the actual failure text.
              debateLog.warn(`⚠️ ${agent.toUpperCase()} (${position}) failed`, {
                agent,
                position,
                error: response.error ? '<redacted>' : undefined,
                hasOutput: Boolean(response.output),
              });
            }
          } catch (error) {
            // Security (Cycle 3 F33): the StructuredLogger emitError path
            // serializes the raw Error verbatim (message, stack, name)
            // into NDJSON. Passing the original `error` leaks any
            // CLI-subprocess stderr tail or prompt-echoed text embedded
            // in error.message. Pass a sanitized Error-shaped shim that
            // preserves `name` for diagnostic triage while redacting the
            // payload. `.stack` is omitted from the shim (undefined) so
            // the file-side fileData record carries only name+message.
            const errorName = error instanceof Error ? error.name : 'Error';
            const errorShim = { name: errorName, message: '<redacted>' } as Error;
            debateLog.error(`❌ ${agent.toUpperCase()} (${position}) threw error`, errorShim);
            completedTurns++;

            // Security (Cycle 4 F7/F17): the same raw caught error.message
            // that Cycle 3 redacted at the logger sink was still flowing
            // through two adjacent sinks — the streaming event content
            // (remote subscribers) and the debateResponses push (flows
            // back out as `responses` at the return site, and downstream
            // into synthesis.ts and response-formatter.ts). Emit a static
            // classifier that retains the agent identity for operator
            // triage but carries no subprocess/prompt-derived payload.
            const redactedTurnError = `${agent.toUpperCase()} execution failed. See internal logs for details.`;

            if (onStreamingEvent) {
              onStreamingEvent({
                type: 'agent_error',
                agent,
                content: `Round ${round}/${rounds}: ${agent.toUpperCase()} (${position}) error: ${redactedTurnError}`,
                timestamp: Date.now(),
                sessionId,
              });
            }

            turnMetadata.push({
              agent: agent as 'claude' | 'codex' | 'gemini',
              position: position as 'PRO' | 'CON',
              round,
              engaged: false,
              refused: false,
              escalated: false,
              engagedAfterEscalation: false,
              responseLength: 0,
              executionTime: 0,
              tier: 'standard',
            });
            // Error-path turn: still counts exactly ONCE per turn. Tier is
            // 'standard' because the turn never reached the refusal-retry
            // branches — it threw before any escalation decision. The
            // typed label record references ESCALATION_TIER_LABELS so a
            // future label-set change triggers a compile error at this
            // call site. Wrapped in safeMetric so a metric throw cannot
            // re-enter the catch path and double-count the turn.
            const errorTierLabels: Record<(typeof ESCALATION_TIER_LABELS)[number], string> = {
              tier: turnMetadata[turnMetadata.length - 1].tier,
            };
            this.safeMetric('inc:escalation_tier', () =>
              this.metrics.debateEscalationTierTotal.inc(errorTierLabels, 1),
            );

            debateResponses.push({
              agent,
              success: false,
              output: '',
              error: redactedTurnError,
              executionTime: 0
            });
          }
        }

        // Compress context for next round with mediation (if not final round)
        if (round < rounds) {
          const roundTranscript = transcript
            .filter(t => t.round === round)
            .map(t => {
              const { sanitized } = mediateTranscript(t.content, 'sanitize', 1500);
              return `${t.agent.toUpperCase()} (${t.position}): ${sanitized}`;
            })
            .join('\n\n---\n\n');

          compressedContext = `Round ${round} Summary:\n${roundTranscript}`;
        }
      }

      // Compute position-dependent asymmetry summary
      const proTurns = turnMetadata.filter(t => t.position === 'PRO');
      const conTurns = turnMetadata.filter(t => t.position === 'CON');
      const proRefusalRate = proTurns.length > 0
        ? proTurns.filter(t => t.refused).length / proTurns.length : 0;
      const conRefusalRate = conTurns.length > 0
        ? conTurns.filter(t => t.refused).length / conTurns.length : 0;

      const debateAgents = [...new Set(turnMetadata.map(t => t.agent))];
      const agentAsymmetries = debateAgents.map(a => {
        const aPro = turnMetadata.filter(t => t.agent === a && t.position === 'PRO');
        const aCon = turnMetadata.filter(t => t.agent === a && t.position === 'CON');
        const proEngaged = aPro.some(t => t.engaged);
        const conEngaged = aCon.some(t => t.engaged);
        return { agent: a, proEngaged, conEngaged, asymmetric: proEngaged !== conEngaged };
      });

      const asymmetryDetected = Math.abs(proRefusalRate - conRefusalRate) > 0.3
        || agentAsymmetries.some(a => a.asymmetric);

      const behaviorSummary: DebateBehaviorSummary = {
        topic, proPosition, conPosition,
        turns: turnMetadata,
        asymmetry: {
          detected: asymmetryDetected,
          description: asymmetryDetected
            ? `Position-dependent asymmetry: PRO refusal ${(proRefusalRate * 100).toFixed(0)}%, CON refusal ${(conRefusalRate * 100).toFixed(0)}%`
            : 'No significant position-dependent asymmetry detected',
          proRefusalRate,
          conRefusalRate,
          agentAsymmetries,
        }
      };

      if (asymmetryDetected) {
        debateLog.warn(`🎭 Alignment asymmetry detected: ${behaviorSummary.asymmetry.description}`);
      }

      // Build synthesis with behavioral data
      const synthesis = synthesizeDebate(
        debateResponses,
        topic,
        rounds,
        new Map([[proAgent, `PRO: ${proPosition}`], [conAgent, `CON: ${conPosition}`]]),
        behaviorSummary
      );

      return {
        success: debateResponses.some(r => r.success),
        responses: debateResponses,
        synthesis,
        debateBehavior: behaviorSummary,
        analysisType: 'cli_debate',
        topic
      };
    } catch (error) {
      debateLog.error("CLI debate execution failed", error);
      throw error;
    }
  }
}
