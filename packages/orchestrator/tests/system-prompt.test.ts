import { describe, it, expect } from '@jest/globals';
import { ORCHESTRATOR_SYSTEM_PROMPT } from '../src/system-prompt.js';
import { ALLOWED_BRUTALIST_TOOLS, DENIED_BRUTALIST_TOOLS } from '../src/orchestrator.js';

/**
 * The system prompt is the contract that drives the agent's behavior.
 * These tests guard the load-bearing instructions: if any of them is
 * accidentally edited away, downstream resolution will silently break.
 */
describe('ORCHESTRATOR_SYSTEM_PROMPT', () => {
  it('references the deterministic per-CLI delimiters from @brutalist/mcp', () => {
    // Without these references the agent has no parsing contract.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('BRUTALIST_CLI_BEGIN');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('BRUTALIST_CLI_END');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('cli="<name>"');
  });

  it('mandates verbatimQuote verification via Grep', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('Grep');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('verbatimQuote');
    expect(ORCHESTRATOR_SYSTEM_PROMPT.toLowerCase()).toMatch(/before submitting/);
  });

  it('explicitly bans the debate tool', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('roast_cli_debate');
  });

  it('narrows v0 domain selection to codebase / architecture / security', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('codebase');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('architecture');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('security');
  });

  it('requires a single submit_findings terminal call', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('submit_findings');
    expect(ORCHESTRATOR_SYSTEM_PROMPT.toLowerCase()).toMatch(/exactly once/);
  });

  it('caps roast calls per session', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT.toLowerCase()).toMatch(/at most 3 .*roast/);
  });

  it('instructs the agent to follow pagination via context_id + offset', () => {
    // Round 4 finding: brutalist auto-paginates roast responses above
    // ~25k tokens; without explicit instructions, the agent submits
    // findings against a truncated first chunk, missing whole per-CLI
    // sections. The system prompt now teaches pagination follow-through.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('context_id');
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toContain('offset');
    expect(ORCHESTRATOR_SYSTEM_PROMPT.toLowerCase()).toMatch(/paginat|hasmore|continue reading/);
  });

  it('instructs the agent that LEFT-side findings on renames use the pre-rename path', () => {
    // Round 10 finding: for renames, the diff parser keys LEFT context
    // lines against the OLD (pre-rename) filename. Agents reading the
    // diff would naturally pick the new path for both sides, causing
    // LEFT findings to drop to outOfDiff and resolver.getFileLines to
    // 404 the new path at base SHA.
    expect(ORCHESTRATOR_SYSTEM_PROMPT.toLowerCase()).toMatch(/rename.*left|left.*rename|pre-rename/);
  });

  it('instructs the agent to include domain + target on pagination calls', () => {
    // Round 9 finding: brutalist's roast tool schema marks domain and
    // target as required even on cached page reads. The cached-read
    // handler only runs after Zod validation passes, so a paginating
    // agent that omits domain/target hits a schema error and burns
    // turns. The prompt now teaches the agent to repeat the initial
    // call's domain + target alongside context_id + offset.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/same\s+`domain`\s+and\s+`target`|domain.*target.*required/i);
  });
});

describe('Tool allowlist contract', () => {
  it('admits the three non-debate brutalist tools', () => {
    expect(ALLOWED_BRUTALIST_TOOLS).toEqual([
      'mcp__brutalist__roast',
      'mcp__brutalist__brutalist_discover',
      'mcp__brutalist__cli_agent_roster',
    ]);
  });

  it('denies the debate tool', () => {
    expect(DENIED_BRUTALIST_TOOLS).toEqual(['mcp__brutalist__roast_cli_debate']);
  });

  it('does not double-list any tool', () => {
    const overlap = ALLOWED_BRUTALIST_TOOLS.filter((t) => DENIED_BRUTALIST_TOOLS.includes(t));
    expect(overlap).toHaveLength(0);
  });
});
