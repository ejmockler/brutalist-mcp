/**
 * Zod schemas for orchestrator inputs and outputs.
 *
 * The schema is the contract between the orchestrator and downstream
 * adapters (e.g. @brutalist/github-action). `schemaVersion: 1` is the
 * anchor — adapters reject mismatched outputs by version, so future
 * schema changes are non-breaking with a version bump.
 *
 * Wave-2 task #7. Task #8 plugs these into the SDK structured-output
 * mechanism so the agent-emitted blob is runtime-validated.
 */

import { z } from 'zod';

export const CliNameSchema = z.enum(['claude', 'codex', 'agy']);
export type CliName = z.infer<typeof CliNameSchema>;

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'nit']);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Diff side. RIGHT = post-image (additions); LEFT = pre-image (deletions);
 * FILE = file-level comment that doesn't anchor to a specific line.
 */
export const SideSchema = z.enum(['RIGHT', 'LEFT', 'FILE']);
export type Side = z.infer<typeof SideSchema>;

export const FindingSchema = z.object({
  cli: CliNameSchema.describe(
    'Which CLI critic emitted the underlying observation. Surfaced in the PR comment as a badge.',
  ),
  clientId: z
    .string()
    .optional()
    .describe('Optional named client id when multiple clients share one CLI provider, e.g. glm over Claude Code.'),
  path: z
    .string()
    .min(1)
    .describe('Repo-relative path to the file the finding is about.'),
  lineHint: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Optional 1-indexed line the critic claimed. Treat as a hint — adapters MUST verify against verbatimQuote before posting inline. Hallucinated line numbers are common.',
    ),
  side: SideSchema.describe(
    'RIGHT for additions, LEFT for deletions, FILE for file-level comments outside the diff.',
  ),
  severity: SeveritySchema,
  category: z
    .string()
    .min(1)
    .describe('Short tag (e.g. "security", "perf", "design"). Free-form.'),
  title: z
    .string()
    .min(1)
    .max(200)
    .describe('Single-line headline rendered as the comment summary.'),
  body: z
    .string()
    .min(1)
    .describe(
      'Full critique body. Markdown. May preserve the brutalist voice from the source CLI.',
    ),
  verbatimQuote: z
    .string()
    .min(1)
    .describe(
      'Verbatim string from the file the critic is reacting to. Required. Adapters resolve this via grep -nF against the file at the PR head SHA to derive the real line number.',
    ),
  suggestion: z
    .string()
    .optional()
    .describe(
      'Optional GitHub PR suggestion-block contents. When present the adapter renders an applyable suggestion in the inline comment.',
    ),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CliBreakdownSchema = z.object({
  cli: CliNameSchema,
  clientId: z
    .string()
    .optional()
    .describe('Optional named client id when multiple clients share one CLI provider.'),
  success: z.boolean(),
  model: z
    .string()
    .optional()
    .describe('Resolved model name (e.g. "opus", "gpt-5").'),
  executionTimeMs: z.number().int().nonnegative(),
  summary: z
    .string()
    .describe('Per-CLI free-form summary preserving the brutalist prose voice.'),
});
export type CliBreakdown = z.infer<typeof CliBreakdownSchema>;

export const OrchestratorResultSchema = z.object({
  schemaVersion: z
    .literal(1)
    .describe('Contract version. Adapters reject mismatches.'),
  findings: z.array(FindingSchema),
  perCli: z.array(CliBreakdownSchema),
  synthesis: z
    .string()
    .describe('Cross-CLI synthesis: agreements, disagreements, headline.'),
  contextId: z
    .string()
    .optional()
    .describe(
      'Brutalist cache context_id for follow-up conversation continuation via roast(resume:true).',
    ),
  outOfDiff: z
    .array(FindingSchema)
    .describe(
      'Findings the orchestrator could not anchor to a diff line. Adapters typically render these in the review summary, not as inline comments.',
    ),
});
export type OrchestratorResult = z.infer<typeof OrchestratorResultSchema>;

export interface RunOptions {
  /** Absolute path to the repo (or subtree) the orchestrator should analyze. */
  repoPath: string;

  /**
   * Optional focusing context — a unified diff for PR review, a feature
   * description for design critique, etc. Threaded into roast() context.
   */
  focus?: string;

  /**
   * Optional supplementary hints (constraints, prior decisions, asks)
   * that should accompany every roast call.
   */
  contextHints?: string[];

  /**
   * Anthropic OAuth token (claude.ai session token from
   * `claude setup-token`). Required when running the SDK in CI.
   */
  oauthToken: string;

  /**
   * Optional override of the brutalist-mcp binary path / command.
   * Defaults to the `brutalist-mcp` binary on PATH.
   */
  brutalistMcpCommand?: string;

  /**
   * Optional absolute path to the `claude` Code executable. The Agent
   * SDK normally auto-detects this via its bundled native packages,
   * but those packages don't always reach a bundled action runtime —
   * resolving the path via the action-side preflight and threading it
   * through here removes the SDK's reliance on bundle-internal lookup.
   */
  claudeCodeExecutablePath?: string;

  /**
   * Wall-clock timeout in milliseconds. Defaults to 30 minutes.
   *
   * maxTurns caps agent turns but not real time. A single stuck child
   * CLI subprocess (each up to 30min by brutalist's own timeout) can
   * hold the SDK await loop until the GitHub Actions job timeout (6h
   * default), with no OrchestratorIncompleteError thrown because the
   * iterator never terminates. The wall-clock budget aborts the query
   * via AbortController so failure is loud and bounded.
   */
  timeoutMs?: number;

  /**
   * Hard cap on agent turns. Defaults to 50 (DEFAULT_MAX_TURNS), overridable
   * via the BRUTALIST_ORCHESTRATOR_MAX_TURNS env var (this option wins over
   * the env var). It's the seatbelt against a confused brain looping until the
   * wall-clock timeout — sized for the worst-case happy path, which is
   * dominated by roast pagination (each oversized 3-critic roast spans several
   * SAME-domain/target re-calls, one turn each). The wall-clock budget
   * (timeoutMs) remains the real seatbelt; this just bounds turn count.
   */
  maxTurns?: number;

  /**
   * Model the orchestrator BRAIN (the SDK `query()` loop) runs on.
   * Defaults to the most capable model (DEFAULT_BRAIN_MODEL =
   * `claude-opus-4-8`). Passed straight to the Agent SDK's `model`
   * option. The claude CRITIC's model is set separately by the action
   * (via ~/.claude/settings.json `model`), which both the claude CLI and
   * brutalist's ModelResolver read.
   */
  model?: string;

  /**
   * Harness-provisioned client ids. submit_findings clamps each
   * brain-emitted clientId to this set ∪ native cli names
   * ('claude','codex','agy'); an id not in the set is dropped to native
   * (undefined). Omitted => only native cli names are accepted: with no
   * provisioned custom clients, any custom clientId the brain emits is a
   * hallucination and is dropped to native.
   */
  knownClientIds?: string[];
}
