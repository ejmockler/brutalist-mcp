/**
 * truncateDiff isn't currently exported, but its behavior is critical:
 * if it cuts mid-hunk the agent reads corrupt diff and the resolver
 * drops legitimate findings. We export-and-test the behavior here as
 * a regression gate against the round-11 "fake diff --git inside a
 * hunk poisons truncation" finding.
 */
import { describe, it, expect } from '@jest/globals';
// truncateDiff is internal — duplicate the function under test for now,
// or import it. We'll import via a small re-export path on index.ts.
import { truncateDiff } from '../src/truncate-diff.js';

describe('truncateDiff', () => {
  it('aligns the cut at the last `diff --git` boundary that fits', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    // Force the cut to fall between the two files.
    const max = diff.indexOf('diff --git a/b.ts');
    const result = truncateDiff(diff, max + 5);
    expect(result.didTruncate).toBe(true);
    // The kept portion ends at a clean file boundary.
    expect(result.text.startsWith('diff --git a/a.ts')).toBe(true);
    expect(result.text).not.toContain('diff --git a/b.ts');
    expect(result.text).toContain('truncated at file boundary');
  });

  it('does NOT use a fake `diff --git` literal inside a hunk as a boundary', () => {
    // Regression: a hunk line containing `diff --git` (e.g. a test
    // fixture string) should not be mistaken for a file header.
    const diff = [
      'diff --git a/realfile.ts b/realfile.ts',
      '--- a/realfile.ts',
      '+++ b/realfile.ts',
      '@@ -1,3 +1,4 @@',
      ' const foo = "bar";',
      '+const marker = "diff --git fake";',
      ' const baz = "qux";',
      ' const last = 1;',
    ].join('\n');
    // Cut request near the fake `diff --git` inside the hunk.
    const fakePosition = diff.indexOf('diff --git fake');
    expect(fakePosition).toBeGreaterThan(0);
    const result = truncateDiff(diff, fakePosition + 5);
    expect(result.didTruncate).toBe(true);
    // The cut must NOT land at the fake marker — that would corrupt
    // the hunk. The fallback should pick a newline (hunk header
    // doesn't fit because everything before fakePosition is in the
    // first file's hunk body).
    expect(result.text).not.toContain('"diff --git fake"');
    // The cut must land at a line boundary. keptChars marks where the
    // truncation in the original diff happens; the byte before it
    // must be a newline (so the agent never sees a half-line).
    expect(diff[result.keptChars - 1]).toBe('\n');
  });

  it('does not truncate when diff fits', () => {
    const diff = 'tiny diff';
    expect(truncateDiff(diff, 1000)).toEqual({
      text: diff,
      didTruncate: false,
      originalChars: diff.length,
      keptChars: diff.length,
    });
  });
});
