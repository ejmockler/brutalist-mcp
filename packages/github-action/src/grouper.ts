/**
 * Cross-CLI grouping.
 *
 * Brutalist's value prop is that 3 CLIs critiquing the same line is the
 * signal — *especially* when they disagree. So when multiple findings
 * land on the same `(path, resolvedLine, side)`, we collapse them into
 * a single PR comment with stacked CLI badges and a severity rollup.
 * The orchestrator emits one Finding per CLI per issue; the grouping
 * happens here.
 *
 * Out-of-diff findings get rendered separately (as a section in the
 * review summary), since GitHub rejects inline comments on lines that
 * aren't in the diff.
 */

import type { Finding } from '@brutalist/orchestrator';
import type { ResolvedFinding } from './resolver.js';
import type { SeverityFilter } from './inputs.js';
import { meetsSeverityThreshold } from './inputs.js';

/**
 * GitHub Reviews API soft limits we defend against:
 *   - Comment body: 65536 chars hard cap. We truncate to 60000 leaving
 *     headroom for the markdown chrome the API itself may add.
 *   - Comments per review: not documented as a hard cap, but the API
 *     starts to choke around 50. We cap at 40 and demote excess to
 *     the out-of-diff bucket so the review still submits.
 */
export const COMMENT_BODY_MAX_CHARS = 60_000;
export const COMMENTS_PER_REVIEW_MAX = 40;

export interface GroupedComment {
  path: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
  /**
   * Highest severity across the grouped findings — used for rollup
   * presentation, not as a filter.
   */
  rollupSeverity: SeverityFilter;
  /** Source findings ordered by severity (high → low) then by cli name. */
  findings: ResolvedFinding[];
  /** Rendered markdown body for the inline comment. */
  body: string;
}

const SEVERITY_RANK: Record<SeverityFilter, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  nit: 0,
};

const SEVERITY_BADGES: Record<SeverityFilter, string> = {
  critical: '🔴 critical',
  high: '🟠 high',
  medium: '🟡 medium',
  low: '🔵 low',
  nit: '⚪ nit',
};

const CLI_BADGE: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

export interface GroupingOutcome {
  /** Comments that fit within COMMENTS_PER_REVIEW_MAX. */
  inline: GroupedComment[];
  /**
   * Findings that were demoted out of the inline channel because we
   * exceeded the per-review comment cap. The action renders these in
   * the out-of-diff bucket so they're still surfaced to the reviewer.
   */
  demoted: ResolvedFinding[];
  /** True if any comment body was truncated to fit the API cap. */
  bodyTruncated: boolean;
}

export interface GroupingResult {
  /** Inline-eligible groups (path/line/side findings at-or-above threshold). */
  groups: GroupedComment[];
  /**
   * Findings filtered out by the severity threshold. The contract
   * (action.yml: "Lower-severity findings still appear in the review
   * summary") requires the caller surface these in outOfDiff, NOT drop
   * them. This is a separate output so the bug-prone filter-then-drop
   * pattern is impossible to write accidentally.
   */
  subThreshold: ResolvedFinding[];
}

export function groupInlineFindings(
  findings: ResolvedFinding[],
  threshold: SeverityFilter,
): GroupedComment[] {
  return groupInlineFindingsWithSubThreshold(findings, threshold).groups;
}

/**
 * Like {@link groupInlineFindings} but also returns the findings that
 * the threshold filtered out. Callers are responsible for surfacing
 * `subThreshold` in the review's out-of-diff bucket so the action.yml
 * contract holds.
 */
export function groupInlineFindingsWithSubThreshold(
  findings: ResolvedFinding[],
  threshold: SeverityFilter,
): GroupingResult {
  // Bucket FIRST, filter SECOND. Filtering per-finding splits cross-CLI
  // agreement when one critic's severity falls below threshold — three
  // critics agreeing at critical/high/nit with threshold=medium would
  // ship critical+high inline and the nit alone in summary, silently
  // destroying the multi-perspective signal the product exists to
  // surface. Bucket by (path,line,side) first; keep a whole bucket
  // inline if any finding in it meets threshold (the rollup signal);
  // demote whole buckets where no finding meets threshold so callers
  // can render them as a cohesive sub-threshold group.
  const fileSide: ResolvedFinding[] = [];
  const lineBuckets = new Map<string, ResolvedFinding[]>();
  for (const f of findings) {
    if (f.side === 'FILE') {
      fileSide.push(f);
      continue;
    }
    const key = `${f.path}::${f.resolvedLine}::${f.side}`;
    const existing = lineBuckets.get(key);
    if (existing) existing.push(f);
    else lineBuckets.set(key, [f]);
  }

  const buckets = new Map<string, ResolvedFinding[]>();
  const subThreshold: ResolvedFinding[] = [];
  for (const [key, bucket] of lineBuckets) {
    const anyMeets = bucket.some((f) => meetsSeverityThreshold(f.severity, threshold));
    if (anyMeets) {
      // Keep the whole bucket inline — cross-CLI agreement is preserved
      // even when individual critics are sub-threshold. Their voice
      // still appears in the inline comment.
      buckets.set(key, bucket);
    } else {
      // Whole bucket falls below — render in summary as a cohesive set
      // (caller's bucketOutOfDiff currently re-buckets by category;
      // future improvement: preserve (path,line) grouping there too).
      subThreshold.push(...bucket);
    }
  }
  // FILE-side findings sub-threshold filtering remains per-finding —
  // they have no (path,line) bucket to agree about.
  for (const f of fileSide) {
    if (meetsSeverityThreshold(f.severity, threshold)) {
      // FILE-side never goes inline (the cap was already enforced by
      // the outer caller via outOfDiff), so admitting it here would do
      // nothing. Skip — the caller already routed FILE-side to outOfDiff.
    } else {
      subThreshold.push(f);
    }
  }

  const groups: GroupedComment[] = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => {
      const sevDelta = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sevDelta !== 0) return sevDelta;
      return a.cli.localeCompare(b.cli);
    });
    const head = bucket[0];
    const rollup = bucket.reduce<SeverityFilter>(
      (acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc),
      'nit',
    );

    if (head.side === 'FILE') {
      // Defensive — shouldn't happen since FILE was filtered above.
      continue;
    }

    groups.push({
      path: head.path,
      line: head.resolvedLine,
      side: head.side,
      rollupSeverity: rollup,
      findings: bucket,
      body: renderInlineCommentBody(bucket, rollup),
    });
  }

  // Sort groups: highest severity first, then by path/line for stable output.
  groups.sort((a, b) => {
    const sevDelta = SEVERITY_RANK[b.rollupSeverity] - SEVERITY_RANK[a.rollupSeverity];
    if (sevDelta !== 0) return sevDelta;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.line - b.line;
  });

  return { groups, subThreshold };
}

/**
 * Apply Reviews API soft limits to a sorted list of GroupedComment.
 *
 * 1. Truncate each comment body to COMMENT_BODY_MAX_CHARS, appending a
 *    continuation marker. Highest-severity findings come first inside
 *    each group, so any truncation cuts off lower-severity attribution
 *    last — preserving the headline brutalist signal.
 * 2. Cap the array at COMMENTS_PER_REVIEW_MAX, demoting the lowest-
 *    severity overflow back to the resolver's out-of-diff bucket so
 *    the action renders them in the review summary.
 *
 * Inputs MUST already be sorted highest-severity-first (groupInlineFindings
 * does this). The cap kicks in by truncating the tail.
 */
export function applyReviewsApiLimits(
  groups: GroupedComment[],
  maxComments: number = COMMENTS_PER_REVIEW_MAX,
  maxBody: number = COMMENT_BODY_MAX_CHARS,
): GroupingOutcome {
  let bodyTruncated = false;
  const truncated: GroupedComment[] = groups.map((g) => {
    if (g.body.length <= maxBody) return g;
    bodyTruncated = true;
    const room = maxBody - TRUNCATION_MARKER.length;
    return { ...g, body: `${g.body.slice(0, room)}${TRUNCATION_MARKER}` };
  });

  if (truncated.length <= maxComments) {
    return { inline: truncated, demoted: [], bodyTruncated };
  }

  const inline = truncated.slice(0, maxComments);
  const overflowGroups = truncated.slice(maxComments);
  const demoted = overflowGroups.flatMap((g) => g.findings);
  return { inline, demoted, bodyTruncated };
}

const TRUNCATION_MARKER = '\n\n_... truncated; comment exceeded GitHub limit._';

/**
 * Render the markdown body for a grouped inline comment.
 *
 * Format:
 *   🪓 Brutalist — N critic(s), <severity rollup>
 *
 *   **[Codex 🔴 critical]** *security* — JWT in localStorage exfiltrates via XSS…
 *   <body>
 *
 *   **[Claude 🟠 high]** *security* — Same concern; rotation also missing.
 *   <body>
 *
 *   ```suggestion
 *   <suggestion text if any>
 *   ```
 *
 * Suggestions: only the highest-severity finding's suggestion (if any)
 * is rendered to avoid GitHub-side conflict on the same line.
 */
export function renderInlineCommentBody(findings: ResolvedFinding[], rollup: SeverityFilter): string {
  const noun = findings.length === 1 ? 'critic' : 'critics';
  const lines: string[] = [];
  lines.push(`🪓 **Brutalist** — ${findings.length} ${noun}, rollup: ${SEVERITY_BADGES[rollup]}`);
  lines.push('');

  for (const f of findings) {
    const cliLabel = CLI_BADGE[f.cli] ?? f.cli;
    lines.push(`**[${cliLabel} ${SEVERITY_BADGES[f.severity]}]** *${f.category}* — ${f.title}`);
    lines.push('');
    lines.push(f.body.trim());
    lines.push('');
  }

  // Render the highest-severity suggestion, if exactly one of the
  // top-severity findings provided one. Avoid stacking suggestion
  // blocks because GitHub treats them as proposed replacements and
  // would conflict.
  const topSeverity = findings[0]?.severity;
  const topWithSuggestion = findings.filter(
    (f) => f.severity === topSeverity && typeof f.suggestion === 'string' && f.suggestion.length > 0,
  );
  if (topWithSuggestion.length === 1 && topWithSuggestion[0].suggestion) {
    lines.push('```suggestion');
    lines.push(topWithSuggestion[0].suggestion);
    lines.push('```');
  }

  return lines.join('\n').trim();
}

export function bucketOutOfDiff(
  outOfDiff: ResolvedFinding[],
): { byCategory: Record<string, ResolvedFinding[]>; total: number } {
  const byCategory: Record<string, ResolvedFinding[]> = {};
  for (const f of outOfDiff) {
    const key = f.category || 'general';
    (byCategory[key] ??= []).push(f);
  }
  for (const arr of Object.values(byCategory)) {
    arr.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  }
  return { byCategory, total: outOfDiff.length };
}

export { SEVERITY_BADGES, CLI_BADGE };
