import { describe, it, expect } from '@jest/globals';
import { capReviewBody, REVIEW_BODY_MAX_CHARS } from '../src/render.js';

describe('capReviewBody', () => {
  it('returns the body unchanged when under the cap', () => {
    const body = 'short body';
    expect(capReviewBody(body)).toBe(body);
  });

  it('truncates and appends a marker when over the cap', () => {
    const body = 'x'.repeat(REVIEW_BODY_MAX_CHARS + 1000);
    const result = capReviewBody(body);
    expect(result.length).toBeLessThanOrEqual(REVIEW_BODY_MAX_CHARS);
    expect(result).toContain('truncated');
  });

  it('preserves the prefix when truncating (priority-ordered content)', () => {
    const head = 'CRITICAL FINDING — should survive truncation\n\n';
    const tail = 'x'.repeat(REVIEW_BODY_MAX_CHARS);
    const result = capReviewBody(head + tail);
    expect(result.startsWith(head)).toBe(true);
  });

  it('preserves the schemaVersion/contextId footer through truncation', () => {
    // Round-12 regression: the footer carries the metadata most useful
    // for debugging oversized reviews. Tail truncation used to slice
    // it off; capReviewBody now stitches the footer back in.
    const filler = 'x'.repeat(REVIEW_BODY_MAX_CHARS);
    const footer =
      '<sub>Brutalist orchestrator schemaVersion=1 · context_id=abc-123</sub>';
    const result = capReviewBody(`${filler}\n\n${footer}`);
    expect(result.length).toBeLessThanOrEqual(REVIEW_BODY_MAX_CHARS);
    expect(result).toContain('schemaVersion=1');
    expect(result).toContain('context_id=abc-123');
    expect(result).toContain('truncated');
  });
});
