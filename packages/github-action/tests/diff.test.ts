import { describe, it, expect } from '@jest/globals';
import { parseDiffLines, diffLineKey, normalizeRepoPath } from '../src/diff.js';

describe('parseDiffLines', () => {
  it('captures added lines on the RIGHT side', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,3 +10,4 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
      '+const z = 4;',
      ' const w = 5;',
    ].join('\n');

    const lines = parseDiffLines(diff);
    expect(lines.has(diffLineKey({ path: 'src/foo.ts', line: 10, side: 'RIGHT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: 'src/foo.ts', line: 11, side: 'RIGHT' }))).toBe(true); // const y = 3
    expect(lines.has(diffLineKey({ path: 'src/foo.ts', line: 12, side: 'RIGHT' }))).toBe(true); // const z = 4
    expect(lines.has(diffLineKey({ path: 'src/foo.ts', line: 11, side: 'LEFT' }))).toBe(true); // const y = 2 (deleted)
  });

  it('handles multiple files in one diff', () => {
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
      '@@ -5,1 +5,1 @@',
      '-foo',
      '+bar',
    ].join('\n');

    const lines = parseDiffLines(diff);
    expect(lines.has(diffLineKey({ path: 'a.ts', line: 1, side: 'RIGHT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: 'b.ts', line: 5, side: 'RIGHT' }))).toBe(true);
  });

  it('returns empty for empty input', () => {
    expect(parseDiffLines('').size).toBe(0);
  });

  it('skips lines outside hunks', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      'random text not in a hunk',
    ].join('\n');
    expect(parseDiffLines(diff).size).toBe(0);
  });

  it('handles deleted files without poisoning the previous file path', () => {
    // Regression test for round 4 finding: parseDiffLines used to track
    // currentPath only from `+++ b/<path>`. For deletions the `+++` is
    // `/dev/null`, so currentPath stayed stale from the previous file
    // and `-` lines were recorded against the WRONG path.
    const diff = [
      'diff --git a/modified.ts b/modified.ts',
      '--- a/modified.ts',
      '+++ b/modified.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      'diff --git a/deleted.ts b/deleted.ts',
      '--- a/deleted.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line1',
      '-line2',
    ].join('\n');

    const lines = parseDiffLines(diff);
    expect(lines.has(diffLineKey({ path: 'modified.ts', line: 1, side: 'LEFT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: 'modified.ts', line: 1, side: 'RIGHT' }))).toBe(true);
    // Deleted file's lines must land against THE DELETED FILE PATH.
    expect(lines.has(diffLineKey({ path: 'deleted.ts', line: 1, side: 'LEFT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: 'deleted.ts', line: 2, side: 'LEFT' }))).toBe(true);
    // Crucially: NO phantom keys against `modified.ts` for line 2.
    expect(lines.has(diffLineKey({ path: 'modified.ts', line: 2, side: 'LEFT' }))).toBe(false);
  });

  it('handles created files (--- /dev/null) — only RIGHT side keys', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line1',
      '+line2',
    ].join('\n');
    const lines = parseDiffLines(diff);
    expect(lines.has(diffLineKey({ path: 'new.ts', line: 1, side: 'RIGHT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: 'new.ts', line: 2, side: 'RIGHT' }))).toBe(true);
    // No LEFT keys for a created file.
    expect([...lines].some((k) => k.endsWith(':LEFT'))).toBe(false);
  });

  it('canonicalizes finding paths so agent variants resolve to the same diff key', () => {
    // Regression for round 10 finding: diffLineKey now goes through
    // normalizeRepoPath so agent emissions like `./src/foo.ts` or
    // `/src/foo.ts` resolve against `src/foo.ts` stored from the diff.
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
    ].join('\n');
    const lines = parseDiffLines(diff);
    // All four forms must hit the same diff entry.
    expect(lines.has(diffLineKey({ path: 'src/foo.ts', line: 1, side: 'RIGHT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: './src/foo.ts', line: 1, side: 'RIGHT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: '/src/foo.ts', line: 1, side: 'RIGHT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: 'src//foo.ts', line: 1, side: 'RIGHT' }))).toBe(true);
  });

  it('normalizeRepoPath collapses ., .., and slashes correctly', () => {
    expect(normalizeRepoPath('src/foo.ts')).toBe('src/foo.ts');
    expect(normalizeRepoPath('./src/foo.ts')).toBe('src/foo.ts');
    expect(normalizeRepoPath('/src/foo.ts')).toBe('src/foo.ts');
    expect(normalizeRepoPath('src/../foo.ts')).toBe('foo.ts');
    expect(normalizeRepoPath('src/./foo.ts')).toBe('src/foo.ts');
    expect(normalizeRepoPath('src//foo.ts')).toBe('src/foo.ts');
    // Upward escape — bail to original rather than silently rewriting.
    expect(normalizeRepoPath('../escape.ts')).toBe('../escape.ts');
  });

  it('handles git-quoted paths (non-ASCII filenames with core.quotepath=true)', () => {
    // Regression for round 10 finding: git's default quotes filenames
    // containing non-ASCII bytes. Round 4's `startsWith('--- a/')`
    // matcher missed the leading `"`, dropping every line for the file
    // and bucketing all findings as "[unanchored]" with misleading
    // "likely fabricated path" warnings.
    const diff = [
      'diff --git "a/src/café.ts" "b/src/café.ts"',
      'index 1234567..89abcde 100644',
      '--- "a/src/caf\\303\\251.ts"',
      '+++ "b/src/caf\\303\\251.ts"',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const lines = parseDiffLines(diff);
    expect(lines.has(diffLineKey({ path: 'src/café.ts', line: 1, side: 'LEFT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: 'src/café.ts', line: 1, side: 'RIGHT' }))).toBe(true);
  });

  it('handles renames with modification — LEFT keys against base path, RIGHT against head', () => {
    const diff = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 80%',
      'rename from old-name.ts',
      'rename to new-name.ts',
      '--- a/old-name.ts',
      '+++ b/new-name.ts',
      '@@ -1,2 +1,2 @@',
      '-deleted-content',
      '+added-content',
      ' shared',
    ].join('\n');
    const lines = parseDiffLines(diff);
    expect(lines.has(diffLineKey({ path: 'old-name.ts', line: 1, side: 'LEFT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: 'new-name.ts', line: 1, side: 'RIGHT' }))).toBe(true);
    // Context line on both sides.
    expect(lines.has(diffLineKey({ path: 'old-name.ts', line: 2, side: 'LEFT' }))).toBe(true);
    expect(lines.has(diffLineKey({ path: 'new-name.ts', line: 2, side: 'RIGHT' }))).toBe(true);
    // Cross-keying must NOT happen.
    expect(lines.has(diffLineKey({ path: 'new-name.ts', line: 1, side: 'LEFT' }))).toBe(false);
    expect(lines.has(diffLineKey({ path: 'old-name.ts', line: 1, side: 'RIGHT' }))).toBe(false);
  });
});
