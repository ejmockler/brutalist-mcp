/**
 * Markdown rendering for the top-level review body.
 *
 * Composition:
 *   1. Header with cross-CLI synthesis
 *   2. Per-CLI breakdown (collapsed in <details>)
 *   3. Out-of-diff findings grouped by category
 *   4. Run metadata footer (dropped findings count, schemaVersion)
 */

import type { OrchestratorResult } from '@brutalist/orchestrator';
import type { ReviewSubmissionInputs } from './reviews-api.js';
import { SEVERITY_BADGES, CLI_BADGE } from './grouper.js';
import { bucketOutOfDiff } from './grouper.js';
import type { ResolvedFinding } from './resolver.js';

/**
 * GitHub Reviews API caps the review body at 65536 chars. We render
 * conservatively below that so markdown and any GitHub-side wrapping
 * have headroom; the safety margin matters because exceeding the cap
 * 422s the entire review (not just the offending field).
 */
export const REVIEW_BODY_MAX_CHARS = 60_000;

export function renderReviewSummary(inputs: ReviewSubmissionInputs): string {
  const { result, groups, outOfDiff, dropped } = inputs;
  const lines: string[] = [];

  lines.push('# 🪓 Brutalist Review');
  lines.push('');
  if (result.synthesis.trim()) {
    lines.push(result.synthesis.trim());
    lines.push('');
  }

  // Inline-finding rollup
  if (groups.length > 0) {
    const sevCounts: Record<string, number> = {};
    for (const g of groups) sevCounts[g.rollupSeverity] = (sevCounts[g.rollupSeverity] ?? 0) + 1;
    const sevSummary = (['critical', 'high', 'medium', 'low', 'nit'] as const)
      .filter((s) => sevCounts[s])
      .map((s) => `${sevCounts[s]} ${SEVERITY_BADGES[s]}`)
      .join(' · ');
    lines.push(`**Inline comments:** ${groups.length} (${sevSummary})`);
    lines.push('');
  } else {
    lines.push('**Inline comments:** none above threshold.');
    lines.push('');
  }

  // Per-CLI breakdown
  if (result.perCli.length > 0) {
    lines.push('<details>');
    lines.push('<summary>Per-CLI breakdown</summary>');
    lines.push('');
    for (const cli of result.perCli) {
      const label = CLI_BADGE[cli.cli] ?? cli.cli;
      const status = cli.success ? '✅' : '❌';
      const model = cli.model ? `\`${cli.model}\`` : '`default`';
      lines.push(`### ${status} ${label} (${model}, ${cli.executionTimeMs}ms)`);
      lines.push('');
      if (cli.summary.trim()) {
        lines.push(cli.summary.trim());
      } else {
        lines.push('_No summary._');
      }
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  // Out-of-diff bucket. Each finding carries a `provenance` tag so the
  // reviewer can tell why it didn't make the inline cut: 'unanchored'
  // = quote couldn't be located in the diff; 'sub-threshold' = real but
  // below the severity cutoff; 'comment-cap-overflow' = pushed out by
  // the per-review comment cap.
  if (outOfDiff.length > 0) {
    const { byCategory } = bucketOutOfDiff(outOfDiff);
    lines.push('<details>');
    lines.push(`<summary>Out-of-diff findings (${outOfDiff.length})</summary>`);
    lines.push('');
    for (const [category, items] of Object.entries(byCategory)) {
      lines.push(`### ${category}`);
      for (const f of items) {
        const cli = CLI_BADGE[f.cli] ?? f.cli;
        const tag = renderProvenance(f.provenance);
        lines.push(
          `- ${SEVERITY_BADGES[f.severity]} **\`${f.path}\`** — *${cli}*${tag}: ${f.title}`,
        );
      }
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  // Footer with run metadata
  const droppedCount = dropped.length;
  if (droppedCount > 0) {
    lines.push(
      `<sub>${droppedCount} finding(s) dropped due to unverifiable verbatim quotes (likely fabrication).</sub>`,
    );
  }
  lines.push('');
  lines.push(
    `<sub>Brutalist orchestrator schemaVersion=${result.schemaVersion} · context_id=${result.contextId ?? 'n/a'}</sub>`,
  );

  return capReviewBody(lines.join('\n'));
}

function renderProvenance(provenance: ResolvedFinding['provenance']): string {
  switch (provenance) {
    case 'unanchored':
      return ' [unanchored]';
    case 'sub-threshold':
      return ' [sub-threshold]';
    case 'comment-cap-overflow':
      return ' [overflow]';
    default:
      return '';
  }
}

/**
 * Truncate the rendered review body if it exceeds GitHub's 65KB cap.
 *
 * The body is composed in priority order — synthesis, inline rollup,
 * per-CLI breakdown, out-of-diff bucket, footer — but tail truncation
 * eats the footer (schemaVersion + contextId), which is exactly the
 * metadata most useful for debugging oversized reviews. We extract
 * the footer before truncating the body and stitch it back in after
 * the truncation marker, so the metadata survives.
 *
 * Exceeding the cap 422s the entire review submission server-side, so
 * a defensive margin (60KB instead of 65536) protects against
 * markdown rendering / wrapping overhead the API may add.
 */
export function capReviewBody(body: string): string {
  if (body.length <= REVIEW_BODY_MAX_CHARS) return body;
  const marker = '\n\n_... review summary truncated; raise minimum-severity or split the PR to see all findings._\n';

  // Extract the trailing footer block — everything from the first
  // `<sub>` tag at or near the end. This is where render.ts emits
  // schemaVersion + contextId and drop-count metadata. Keeping it
  // intact through truncation preserves the debugging contract.
  const footerStart = body.lastIndexOf('<sub>');
  const footer =
    footerStart >= 0 && body.length - footerStart < 2000
      ? body.slice(footerStart)
      : '';

  const room = REVIEW_BODY_MAX_CHARS - marker.length - footer.length - 4; // 4 for newline buffer
  if (room <= 0) {
    // Pathological — footer alone exceeds budget. Fall back to plain
    // tail truncation (better something than nothing).
    return body.slice(0, REVIEW_BODY_MAX_CHARS - marker.length) + marker;
  }
  return body.slice(0, room) + marker + (footer ? `\n${footer}` : '');
}
