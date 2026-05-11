/**
 * Truncate a unified diff at a safe boundary that fits within maxChars.
 *
 * Why this exists: the agent reads the diff text we hand it as `focus`
 * context, so a mid-hunk cut produces corrupt unified diff (orphan +/-
 * lines, a header without its hunks) which encourages the agent to
 * invent verbatim quotes against truncated paths. Those findings then
 * drop at resolver time and the visible result is a cliff in finding
 * count near the byte limit.
 *
 * Boundary preference:
 *   1. Line-anchored `diff --git ` (file header) — required at line
 *      start AND followed by a space, so a string literal containing
 *      "diff --git" inside a hunk can't be mistaken for a header.
 *   2. Line-anchored `@@ ` (hunk header).
 *   3. Last newline before the limit (still preserves line integrity).
 *   4. Byte slice (pathological — only if there are no newlines).
 */

export interface TruncationResult {
  text: string;
  didTruncate: boolean;
  originalChars: number;
  keptChars: number;
}

export function truncateDiff(diff: string, maxChars: number): TruncationResult {
  if (diff.length <= maxChars) {
    return { text: diff, didTruncate: false, originalChars: diff.length, keptChars: diff.length };
  }

  // Line-anchored search for `diff --git `. The header may be at
  // offset 0 (first file in the diff has no leading newline) so we
  // accept either `^diff --git ` or `\ndiff --git ` and step past the
  // leading newline. Unanchored lastIndexOf('diff --git') is unsafe
  // because a hunk line containing the literal string would match.
  let cut = -1;
  const fileHeaderRegex = /(^|\n)diff --git /g;
  let match: RegExpExecArray | null;
  while ((match = fileHeaderRegex.exec(diff)) !== null) {
    const headerStart = match.index + (match[1] === '\n' ? 1 : 0);
    if (headerStart >= maxChars) break;
    cut = headerStart;
  }
  if (cut <= 0) {
    cut = diff.lastIndexOf('\n@@ ', maxChars);
    if (cut > 0) cut += 1; // step past the leading \n
  }
  if (cut <= 0) cut = diff.lastIndexOf('\n', maxChars);
  if (cut <= 0) cut = maxChars;

  const kept = diff.slice(0, cut);
  const omittedFiles = (diff.slice(cut).match(/^diff --git /gm) ?? []).length;
  const noteParts: string[] = [`${diff.length - cut} chars omitted`];
  if (omittedFiles > 0) noteParts.push(`${omittedFiles} file(s) not shown`);
  const text = `${kept}\n\n... [diff truncated at file boundary; ${noteParts.join('; ')}]`;
  return { text, didTruncate: true, originalChars: diff.length, keptChars: cut };
}
