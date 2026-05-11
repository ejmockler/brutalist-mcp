/**
 * End-to-end pipeline smoke test (#19).
 *
 * Live OAuth + brutalist CLI critics are out of reach in CI, so this
 * test exercises the action's *adapter pipeline* end-to-end with a
 * fixture OrchestratorResult: resolver → grouper → render → submission
 * payload shape. A genuine E2E (live SDK + live MCP) is documented as
 * a manual run in packages/github-action/README.md.
 *
 * Coverage:
 *   - A finding with a quote that appears once in the diff lands inline.
 *   - A finding with a quote that exists in the file but outside the
 *     diff lands in the out-of-diff bucket of the review summary.
 *   - A finding with a fabricated quote is dropped.
 *   - Two CLIs flagging the same line collapse into one inline comment.
 *   - The Reviews API call carries the right shape: event=COMMENT,
 *     commit_id=headSha, body contains synthesis, comments[] grouped.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { OrchestratorResult } from '@brutalist/orchestrator';
import { resolveFindings } from '../src/resolver.js';
import { groupInlineFindings } from '../src/grouper.js';
import { submitReview } from '../src/reviews-api.js';
import type { PullRequestContext, PullRequestRef } from '../src/diff.js';
import { parseDiff, parseDiffLines } from '../src/diff.js';

// Fixture: a tiny PR diff against src/auth.ts adding a localStorage call.
const DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 1234567..89abcde 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -10,3 +10,4 @@',
  ' export function login(user) {',
  '-  return user;',
  '+  const token = localStorage.getItem("jwt");',
  '+  return token;',
  ' }',
].join('\n');

const FILE_CONTENT = [
  'import { hash } from "crypto";', // line 1
  '',                                 // line 2
  'function rotate() {',              // line 3
  '  // unchanged: out-of-diff finding will land here',
  '  return null;',                   // line 5
  '}',                                 // line 6
  '',
  '',
  '',
  'export function login(user) {',    // line 10
  '  const token = localStorage.getItem("jwt");', // line 11 (added in diff)
  '  return token;',                  // line 12 (added in diff)
  '}',                                 // line 13
].join('\n');

const PULL: PullRequestRef = {
  owner: 'acme',
  repo: 'auth',
  number: 42,
  baseSha: 'base-sha-aaaa',
  headSha: 'head-sha-bbbb',
};

function makeContext(): PullRequestContext {
  const parsed = parseDiff(DIFF);
  return { pull: PULL, diffText: DIFF, diffLines: parsed.diffLines, changedLines: parsed.changedLines };
}

function makeOctokitMock(opts: { createReview?: jest.Mock } = {}): any {
  const createReview =
    opts.createReview ??
    (jest.fn() as any).mockResolvedValue({
      data: { id: 999, html_url: 'https://github.com/acme/auth/pull/42#review-999' },
    });
  return {
    rest: {
      pulls: {
        createReview,
      },
      repos: {
        getContent: (jest.fn() as any).mockImplementation(async (params: any) => {
          if (params.path === 'src/auth.ts') {
            return {
              data: {
                type: 'file',
                content: Buffer.from(FILE_CONTENT, 'utf8').toString('base64'),
              },
            };
          }
          throw Object.assign(new Error('not found'), { status: 404 });
        }),
      },
    },
  };
}

const ORCHESTRATOR_FIXTURE: OrchestratorResult = {
  schemaVersion: 1,
  findings: [
    // 2 critics agree on the localStorage line — should group into one inline.
    {
      cli: 'codex',
      path: 'src/auth.ts',
      side: 'RIGHT',
      severity: 'critical',
      category: 'security',
      title: 'JWT in localStorage',
      body: 'Localstorage tokens are exfiltratable via any XSS sink.',
      verbatimQuote: 'localStorage.getItem("jwt")',
      lineHint: 11,
    },
    {
      cli: 'claude',
      path: 'src/auth.ts',
      side: 'RIGHT',
      severity: 'high',
      category: 'security',
      title: 'No httpOnly cookie',
      body: 'Same concern; rotation also missing.',
      verbatimQuote: 'localStorage.getItem("jwt")',
    },
    // Fabricated quote — should be dropped.
    {
      cli: 'gemini',
      path: 'src/auth.ts',
      side: 'RIGHT',
      severity: 'high',
      category: 'security',
      title: 'Hallucinated finding',
      body: 'This refers to a string that does not exist.',
      verbatimQuote: 'fabricated_function_that_does_not_exist()',
    },
  ],
  perCli: [
    { cli: 'codex', success: true, executionTimeMs: 2400, summary: 'Found JWT issue.' },
    { cli: 'claude', success: true, model: 'opus', executionTimeMs: 1800, summary: 'Same.' },
    { cli: 'gemini', success: true, model: 'gemini-3.1-pro-preview', executionTimeMs: 3200, summary: 'Verified deps.' },
  ],
  synthesis:
    'All three critics agree the new localStorage token storage is the headline risk; rotation is unset.',
  contextId: 'ctx-abc-123',
  outOfDiff: [
    // A real quote that's in the file but not in the diff.
    {
      cli: 'codex',
      path: 'src/auth.ts',
      side: 'RIGHT',
      severity: 'medium',
      category: 'maintainability',
      title: 'Empty rotate stub',
      body: 'Function returns null with no rotation logic.',
      verbatimQuote: '  return null;', // line 5, outside diff
    },
  ],
};

describe('Pipeline smoke', () => {
  it('flows fixture → resolver → grouper → reviews-api with expected shape', async () => {
    const octokit = makeOctokitMock();
    const context = makeContext();

    // 1. Resolve findings against the file at head SHA.
    const all = [...ORCHESTRATOR_FIXTURE.findings, ...ORCHESTRATOR_FIXTURE.outOfDiff];
    const resolution = await resolveFindings(all, octokit, context);

    expect(resolution.dropped).toHaveLength(1);
    expect(resolution.dropped[0].finding.cli).toBe('gemini');
    expect(resolution.dropped[0].reason).toMatch(/not found/);

    // The 2 valid in-diff findings resolve to line 11 (localStorage call).
    expect(resolution.inline).toHaveLength(2);
    expect(resolution.inline.every((r) => r.resolvedLine === 11)).toBe(true);
    expect(resolution.inline.every((r) => r.inDiff)).toBe(true);

    // The "return null" finding lives at line 5 — in the file, not in the diff.
    expect(resolution.outOfDiff).toHaveLength(1);
    expect(resolution.outOfDiff[0].resolvedLine).toBe(5);
    expect(resolution.outOfDiff[0].inDiff).toBe(false);

    // 2. Group: 2 CLIs on same line → 1 comment with rollup=critical.
    const groups = groupInlineFindings(resolution.inline, 'low');
    expect(groups).toHaveLength(1);
    expect(groups[0].rollupSeverity).toBe('critical');
    expect(groups[0].findings).toHaveLength(2);
    expect(groups[0].body).toContain('🪓 **Brutalist** — 2 critics');
    expect(groups[0].body).toContain('**[Codex 🔴 critical]**');
    expect(groups[0].body).toContain('**[Claude 🟠 high]**');

    // 3. Submit: assert the Reviews API call shape.
    await submitReview(octokit, {
      pull: PULL,
      groups,
      outOfDiff: resolution.outOfDiff,
      dropped: resolution.dropped,
      result: ORCHESTRATOR_FIXTURE,
    });

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    const submission = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(submission.event).toBe('COMMENT');
    expect(submission.commit_id).toBe(PULL.headSha);
    expect(submission.pull_number).toBe(PULL.number);
    expect(submission.comments).toHaveLength(1);
    expect(submission.comments[0]).toMatchObject({
      path: 'src/auth.ts',
      line: 11,
      side: 'RIGHT',
    });
    // Review body contains synthesis + per-CLI breakdown + out-of-diff section.
    expect(submission.body).toContain('headline risk');
    expect(submission.body).toContain('Per-CLI breakdown');
    expect(submission.body).toContain('Out-of-diff findings');
    expect(submission.body).toContain('schemaVersion=1');
    expect(submission.body).toContain('1 finding(s) dropped');
  });

  it('FILE-side falls back to base SHA when file is deleted by the PR', async () => {
    // Mock a head 404 + base success for `src/legacy/deprecated.ts`.
    const octokit = {
      rest: {
        pulls: { createReview: jest.fn() },
        repos: {
          getContent: jest.fn().mockImplementation(async (params: any) => {
            if (params.path === 'src/legacy/deprecated.ts' && params.ref === PULL.headSha) {
              throw Object.assign(new Error('Not Found'), { status: 404 });
            }
            if (params.path === 'src/legacy/deprecated.ts' && params.ref === PULL.baseSha) {
              return {
                data: {
                  type: 'file',
                  content: Buffer.from(
                    'export function legacyHandler() {\n  return null;\n}',
                    'utf8',
                  ).toString('base64'),
                },
              };
            }
            throw Object.assign(new Error('not found'), { status: 404 });
          }),
        },
      },
    } as any;

    const findings = [
      {
        cli: 'codex' as const,
        path: 'src/legacy/deprecated.ts',
        side: 'FILE' as const,
        severity: 'high' as const,
        category: 'maintainability',
        title: 'Deletion removes the only handler for legacy callers',
        body: 'The deletion eliminates `legacyHandler` without a deprecation path.',
        verbatimQuote: 'legacyHandler',
      },
    ];
    const resolution = await resolveFindings(findings, octokit, makeContext());

    // Legitimate deletion critique survives via base-SHA fallback.
    expect(resolution.outOfDiff).toHaveLength(1);
    expect(resolution.outOfDiff[0].provenance).toBe('unanchored');
    expect(resolution.dropped).toHaveLength(0);
  });

  it('verifies FILE-side findings against the file at head SHA (closes fabrication bypass)', async () => {
    const octokit = makeOctokitMock();
    const context = makeContext();

    const fileFindings = [
      // Real FILE-side finding: quote exists in the file at line 3.
      {
        cli: 'codex' as const,
        path: 'src/auth.ts',
        side: 'FILE' as const,
        severity: 'medium' as const,
        category: 'maintainability',
        title: 'Empty rotate stub',
        body: 'Function returns null with no rotation logic.',
        verbatimQuote: 'function rotate() {',
      },
      // Fabricated FILE-side finding: quote isn't anywhere in the file.
      {
        cli: 'gemini' as const,
        path: 'src/auth.ts',
        side: 'FILE' as const,
        severity: 'high' as const,
        category: 'security',
        title: 'Fabricated FILE finding',
        body: 'Hallucinated content.',
        verbatimQuote: 'this string definitely does not exist in the file',
      },
    ];

    const resolution = await resolveFindings(fileFindings, octokit, context);

    // Genuine FILE finding survives (unanchored bucket), fabricated one dropped.
    expect(resolution.outOfDiff).toHaveLength(1);
    expect(resolution.outOfDiff[0].cli).toBe('codex');
    expect(resolution.outOfDiff[0].provenance).toBe('unanchored');
    expect(resolution.dropped).toHaveLength(1);
    expect(resolution.dropped[0].finding.cli).toBe('gemini');
    expect(resolution.dropped[0].reason).toMatch(/FILE-side.*not found/);
  });

  it('anchors multi-line quotes to the CHANGED line, not the unchanged signature inside the range', async () => {
    // Round-14 regression: parseDiffLines records context lines as
    // commentable, so the round-13 "first line in diffLines" fallback
    // picks the function signature when a quote spans the function.
    // Fix uses changedLines (only +/- lines) first.
    const blockDiff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -10,4 +10,5 @@',
      ' export function login(user) {', // context line 10
      '-  return user;', // deletion at 11 (LEFT)
      '+  const token = localStorage.getItem("jwt");', // addition at 11 (RIGHT)
      '+  return token;', // addition at 12 (RIGHT)
      ' }', // context
    ].join('\n');
    const fileContent = [
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'export function login(user) {',
      '  const token = localStorage.getItem("jwt");',
      '  return token;',
      '}',
    ].join('\n');

    const octokit = {
      rest: {
        pulls: { createReview: jest.fn() },
        repos: {
          getContent: (jest.fn() as any).mockResolvedValue({
            data: { type: 'file', content: Buffer.from(fileContent, 'utf8').toString('base64') },
          }),
        },
      },
    } as any;
    const parsed = parseDiff(blockDiff);
    const ctx = {
      pull: PULL,
      diffText: blockDiff,
      diffLines: parsed.diffLines,
      changedLines: parsed.changedLines,
    };

    // Critic quotes the whole function (LF-delimited). No lineHint.
    const findings = [
      {
        cli: 'codex' as const,
        path: 'src/auth.ts',
        side: 'RIGHT' as const,
        severity: 'critical' as const,
        category: 'security',
        title: 'localStorage JWT',
        body: 'detail',
        verbatimQuote:
          'export function login(user) {\n  const token = localStorage.getItem("jwt");\n  return token;\n}',
      },
    ];

    const res = await resolveFindings(findings, octokit, ctx);
    expect(res.inline).toHaveLength(1);
    // The anchor must be on a CHANGED line (11 or 12 — the additions),
    // never on line 10 (unchanged context). Without the changedLines
    // preference, the round-13 fallback would have picked line 10.
    expect([11, 12]).toContain(res.inline[0].resolvedLine);
  });

  it('bridges agent subtree paths to repo-root diff keys (monorepo working-directory)', async () => {
    // Round-12 regression: when working-directory is `packages/api`, the
    // agent emits `src/foo.ts` meaning `packages/api/src/foo.ts`. Without
    // bridging, the diff-key lookup misses + getContent 404s; the
    // finding lands in dropped as "fabricated". With bridging, it
    // anchors correctly.
    const monorepoDiff = [
      'diff --git a/packages/api/src/foo.ts b/packages/api/src/foo.ts',
      '--- a/packages/api/src/foo.ts',
      '+++ b/packages/api/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
    ].join('\n');

    const octokit = {
      rest: {
        pulls: { createReview: jest.fn() },
        repos: {
          getContent: jest.fn().mockImplementation(async (params: any) => {
            if (params.path === 'packages/api/src/foo.ts') {
              return {
                data: {
                  type: 'file',
                  content: Buffer.from('const a = 1;\nconst b = 2;', 'utf8').toString('base64'),
                },
              };
            }
            throw Object.assign(new Error('not found'), { status: 404 });
          }),
        },
      },
    } as any;
    const monorepoParsed = parseDiff(monorepoDiff);
    const context = {
      pull: PULL,
      diffText: monorepoDiff,
      diffLines: monorepoParsed.diffLines,
      changedLines: monorepoParsed.changedLines,
    };

    const agentFindings = [
      {
        cli: 'codex' as const,
        path: 'src/foo.ts', // ← agent's view from working-directory
        side: 'RIGHT' as const,
        severity: 'high' as const,
        category: 'security',
        title: 'Subtree finding',
        body: 'flagging the new const',
        verbatimQuote: 'const b = 2;',
      },
    ];
    const resolution = await resolveFindings(agentFindings, octokit, context, {
      workingDirectoryOffset: 'packages/api',
    });

    expect(resolution.inline).toHaveLength(1);
    expect(resolution.inline[0].path).toBe('packages/api/src/foo.ts');
    expect(resolution.dropped).toHaveLength(0);
  });

  it('surfaces 422 with diagnostic context when a comment falls outside the diff', async () => {
    const failing422 = jest.fn() as any;
    failing422.mockRejectedValue(Object.assign(new Error('Unprocessable'), { status: 422 }));
    const octokit = makeOctokitMock({ createReview: failing422 });
    const context = makeContext();

    const resolution = await resolveFindings(
      ORCHESTRATOR_FIXTURE.findings.slice(0, 1),
      octokit,
      context,
    );
    const groups = groupInlineFindings(resolution.inline, 'low');

    await expect(
      submitReview(octokit, {
        pull: PULL,
        groups,
        outOfDiff: [],
        dropped: [],
        result: ORCHESTRATOR_FIXTURE,
      }),
    ).rejects.toThrow(/HTTP 422/);
  });
});
