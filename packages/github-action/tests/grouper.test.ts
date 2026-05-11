import { describe, it, expect } from '@jest/globals';
import type { Finding } from '@brutalist/orchestrator';
import {
  groupInlineFindings,
  groupInlineFindingsWithSubThreshold,
  bucketOutOfDiff,
  applyReviewsApiLimits,
  COMMENT_BODY_MAX_CHARS,
  COMMENTS_PER_REVIEW_MAX,
} from '../src/grouper.js';
import type { ResolvedFinding } from '../src/resolver.js';
import { meetsSeverityThreshold } from '../src/inputs.js';

function fixture(overrides: Partial<ResolvedFinding> = {}): ResolvedFinding {
  return {
    cli: 'codex',
    path: 'src/auth.ts',
    side: 'RIGHT',
    severity: 'high',
    category: 'security',
    title: 'JWT in localStorage',
    body: 'Detail',
    verbatimQuote: 'localStorage.getItem("jwt")',
    resolvedLine: 42,
    inDiff: true,
    ...overrides,
  } as ResolvedFinding;
}

describe('meetsSeverityThreshold', () => {
  it('admits at-or-above threshold', () => {
    expect(meetsSeverityThreshold('high', 'medium')).toBe(true);
    expect(meetsSeverityThreshold('medium', 'medium')).toBe(true);
    expect(meetsSeverityThreshold('low', 'medium')).toBe(false);
    expect(meetsSeverityThreshold('critical', 'nit')).toBe(true);
  });
});

describe('groupInlineFindings', () => {
  it('groups two CLIs flagging the same (path, line, side) into one comment', () => {
    const findings: ResolvedFinding[] = [
      fixture({ cli: 'codex', severity: 'critical' }),
      fixture({ cli: 'claude', severity: 'high' }),
    ];
    const groups = groupInlineFindings(findings, 'low');
    expect(groups).toHaveLength(1);
    expect(groups[0].findings).toHaveLength(2);
    expect(groups[0].rollupSeverity).toBe('critical');
    // Sort: critical (codex) first, then high (claude)
    expect(groups[0].findings[0].cli).toBe('codex');
    expect(groups[0].findings[1].cli).toBe('claude');
  });

  it('does not group findings on different lines', () => {
    const findings: ResolvedFinding[] = [
      fixture({ cli: 'codex', resolvedLine: 10 }),
      fixture({ cli: 'codex', resolvedLine: 20 }),
    ];
    expect(groupInlineFindings(findings, 'low')).toHaveLength(2);
  });

  it('respects severity threshold', () => {
    const findings: ResolvedFinding[] = [
      fixture({ severity: 'high' }),
      fixture({ severity: 'low', resolvedLine: 99 }),
    ];
    const high = groupInlineFindings(findings, 'high');
    expect(high).toHaveLength(1);
    expect(high[0].findings[0].severity).toBe('high');
  });

  it('orders groups by severity then path/line for deterministic output', () => {
    const findings: ResolvedFinding[] = [
      fixture({ path: 'b.ts', resolvedLine: 5, severity: 'low' }),
      fixture({ path: 'a.ts', resolvedLine: 5, severity: 'critical' }),
      fixture({ path: 'a.ts', resolvedLine: 10, severity: 'critical' }),
    ];
    const groups = groupInlineFindings(findings, 'nit');
    expect(groups.map((g) => `${g.path}:${g.line}:${g.rollupSeverity}`)).toEqual([
      'a.ts:5:critical',
      'a.ts:10:critical',
      'b.ts:5:low',
    ]);
  });

  it('renders body with brutalist header and stacked CLI badges', () => {
    const findings: ResolvedFinding[] = [
      fixture({ cli: 'codex', severity: 'critical', title: 'T1', body: 'B1' }),
      fixture({ cli: 'claude', severity: 'high', title: 'T2', body: 'B2' }),
    ];
    const [group] = groupInlineFindings(findings, 'low');
    expect(group.body).toContain('🪓 **Brutalist** — 2 critics');
    expect(group.body).toContain('rollup: 🔴 critical');
    expect(group.body).toContain('**[Codex 🔴 critical]**');
    expect(group.body).toContain('**[Claude 🟠 high]**');
    expect(group.body).toContain('B1');
    expect(group.body).toContain('B2');
  });

  it('includes a single suggestion block from the top-severity finding', () => {
    const findings: ResolvedFinding[] = [
      fixture({ cli: 'codex', severity: 'critical', suggestion: 'replacement code' }),
      fixture({ cli: 'claude', severity: 'high', suggestion: 'different replacement' }),
    ];
    const [group] = groupInlineFindings(findings, 'low');
    expect(group.body).toContain('```suggestion');
    expect(group.body).toContain('replacement code');
    expect(group.body).not.toContain('different replacement');
  });

  it('skips suggestion block when multiple top-severity findings would conflict', () => {
    const findings: ResolvedFinding[] = [
      fixture({ cli: 'codex', severity: 'critical', suggestion: 'A' }),
      fixture({ cli: 'claude', severity: 'critical', suggestion: 'B' }),
    ];
    const [group] = groupInlineFindings(findings, 'low');
    expect(group.body).not.toContain('```suggestion');
  });

  it('excludes FILE-side findings from inline groups', () => {
    const findings: ResolvedFinding[] = [
      fixture({ side: 'FILE' as Finding['side'] }) as ResolvedFinding,
    ];
    expect(groupInlineFindings(findings, 'low')).toHaveLength(0);
  });
});

describe('groupInlineFindingsWithSubThreshold', () => {
  it('returns sub-threshold findings separately so callers can surface them', () => {
    const findings: ResolvedFinding[] = [
      fixture({ severity: 'high', resolvedLine: 1 }),
      fixture({ severity: 'low', resolvedLine: 2 }),
      fixture({ severity: 'nit', resolvedLine: 3 }),
    ];
    const result = groupInlineFindingsWithSubThreshold(findings, 'medium');
    expect(result.groups).toHaveLength(1); // only the 'high' makes it inline
    expect(result.groups[0].findings[0].severity).toBe('high');
    // 'low' and 'nit' both got demoted, not dropped.
    expect(result.subThreshold).toHaveLength(2);
    expect(result.subThreshold.map((f) => f.severity).sort()).toEqual(['low', 'nit']);
  });

  it('preserves FILE-side sub-threshold findings (still substantive observations)', () => {
    const findings: ResolvedFinding[] = [
      fixture({ severity: 'low', side: 'FILE' as Finding['side'] }) as ResolvedFinding,
    ];
    const result = groupInlineFindingsWithSubThreshold(findings, 'high');
    expect(result.subThreshold).toHaveLength(1);
    expect(result.groups).toHaveLength(0);
  });

  it('keeps cross-CLI agreement intact when some critics are sub-threshold', () => {
    // Round 10 regression: 3 critics agreeing on the same line at
    // critical/high/nit must all appear in the inline comment when the
    // threshold is medium. Filtering per-finding silently broke the
    // "agreement is the signal" thesis by splitting the nit into a
    // lone summary entry.
    const findings: ResolvedFinding[] = [
      fixture({ cli: 'codex', severity: 'critical', resolvedLine: 42 }),
      fixture({ cli: 'claude', severity: 'high', resolvedLine: 42 }),
      fixture({ cli: 'gemini', severity: 'nit', resolvedLine: 42 }),
    ];
    const result = groupInlineFindingsWithSubThreshold(findings, 'medium');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].findings).toHaveLength(3);
    expect(result.groups[0].findings.map((f) => f.cli).sort()).toEqual([
      'claude',
      'codex',
      'gemini',
    ]);
    // Nothing demoted to subThreshold — the nit is INSIDE the inline
    // group, not separated from its agreement signal.
    expect(result.subThreshold).toHaveLength(0);
  });

  it('demotes whole bucket when no finding in it meets the threshold', () => {
    const findings: ResolvedFinding[] = [
      fixture({ cli: 'codex', severity: 'low', resolvedLine: 50 }),
      fixture({ cli: 'claude', severity: 'nit', resolvedLine: 50 }),
    ];
    const result = groupInlineFindingsWithSubThreshold(findings, 'high');
    expect(result.groups).toHaveLength(0);
    expect(result.subThreshold).toHaveLength(2);
  });
});

describe('applyReviewsApiLimits', () => {
  function group(idx: number, severity: 'critical' | 'high' | 'medium' | 'low' | 'nit', bodyLen = 100): any {
    return {
      path: `f${idx}.ts`,
      line: idx,
      side: 'RIGHT',
      rollupSeverity: severity,
      findings: [fixture({ resolvedLine: idx, severity })],
      body: 'x'.repeat(bodyLen),
    };
  }

  it('passes through when under both caps', () => {
    const groups = [group(1, 'critical'), group(2, 'high')];
    const out = applyReviewsApiLimits(groups);
    expect(out.inline).toHaveLength(2);
    expect(out.demoted).toHaveLength(0);
    expect(out.bodyTruncated).toBe(false);
  });

  it('truncates oversized comment bodies and flags bodyTruncated', () => {
    const groups = [group(1, 'critical', COMMENT_BODY_MAX_CHARS + 500)];
    const out = applyReviewsApiLimits(groups);
    expect(out.bodyTruncated).toBe(true);
    expect(out.inline[0].body.length).toBeLessThanOrEqual(COMMENT_BODY_MAX_CHARS);
    expect(out.inline[0].body).toContain('truncated');
  });

  it('caps comment count and demotes the lowest-priority overflow', () => {
    // Build COMMENTS_PER_REVIEW_MAX + 5 groups, severity decreasing as
    // index grows so the tail is what gets demoted.
    const sevByIdx: Array<'critical' | 'high' | 'medium' | 'low' | 'nit'> = [
      'critical',
      'high',
      'medium',
      'low',
      'nit',
    ];
    const groups = Array.from({ length: COMMENTS_PER_REVIEW_MAX + 5 }, (_, i) =>
      group(i, sevByIdx[Math.min(i, sevByIdx.length - 1)]),
    );
    const out = applyReviewsApiLimits(groups);
    expect(out.inline).toHaveLength(COMMENTS_PER_REVIEW_MAX);
    // 5 overflow groups → demoted findings (one per group in this fixture).
    expect(out.demoted).toHaveLength(5);
  });

  it('honors a custom comment cap', () => {
    const groups = [group(1, 'critical'), group(2, 'high'), group(3, 'low')];
    const out = applyReviewsApiLimits(groups, 2);
    expect(out.inline).toHaveLength(2);
    expect(out.demoted).toHaveLength(1);
    expect(out.demoted[0].severity).toBe('low');
  });
});

describe('bucketOutOfDiff', () => {
  it('groups findings by category and sorts by severity within each', () => {
    const findings: ResolvedFinding[] = [
      fixture({ category: 'security', severity: 'low' }),
      fixture({ category: 'security', severity: 'critical' }),
      fixture({ category: 'perf', severity: 'medium' }),
    ];
    const { byCategory, total } = bucketOutOfDiff(findings);
    expect(total).toBe(3);
    expect(Object.keys(byCategory).sort()).toEqual(['perf', 'security']);
    expect(byCategory.security[0].severity).toBe('critical');
    expect(byCategory.security[1].severity).toBe('low');
  });

  it('falls back to "general" category when category is empty', () => {
    const findings: ResolvedFinding[] = [
      fixture({ category: '' }),
    ];
    const { byCategory } = bucketOutOfDiff(findings);
    expect(byCategory.general).toHaveLength(1);
  });
});
