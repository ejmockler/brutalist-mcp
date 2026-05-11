/**
 * @brutalist/orchestrator — public entry point.
 *
 * The orchestrator is a Claude Agent SDK runner that consumes the
 * @brutalist/mcp server (over stdio MCP) and produces structured
 * findings. Domain-general by design: callers pass repoPath +
 * optional focus + optional contextHints; downstream adapters
 * (e.g. @brutalist/github-action) decide what to do with the
 * findings (post as PR review, file Linear tickets, render to a
 * report, etc.).
 *
 * Wave-2 task #5 ships the skeleton only. Schema (#7), structured
 * output mechanism (#8), system prompt (#9), and per-CLI extraction
 * (#10) follow.
 */

export { run, OrchestratorIncompleteError, OrchestratorTimeoutError } from './orchestrator.js';
export type { RunOptions, OrchestratorResult, Finding, CliBreakdown } from './schemas.js';
