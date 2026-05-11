import { describe, it, expect } from '@jest/globals';
import { redactSecrets } from '../src/index.js';

describe('redactSecrets', () => {
  it('redacts a supplied OAuth token from a message that echoes it', () => {
    const message = 'SDK failed: Bearer sk-oauth-very-secret-12345 rejected';
    const result = redactSecrets(message, ['sk-oauth-very-secret-12345']);
    expect(result).not.toContain('sk-oauth-very-secret-12345');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts multiple secrets passed in the list', () => {
    const message = 'failed with anth-abcdef123 and oai-abcdef456';
    const result = redactSecrets(message, ['anth-abcdef123', 'oai-abcdef456']);
    expect(result).not.toContain('anth-abcdef123');
    expect(result).not.toContain('oai-abcdef456');
  });

  it('redacts longer secrets first so substring-of-substring does not leak fragments', () => {
    // If "abcdef" is also a secret AND a substring of "abcdef-with-tail",
    // naive ordering would replace "abcdef" inside "abcdef-with-tail"
    // and leave "-with-tail" exposed. Sorted-by-length-desc fixes this.
    const message = 'leaked: abcdef-with-tail and abcdef';
    const result = redactSecrets(message, ['abcdef', 'abcdef-with-tail']);
    expect(result).not.toContain('abcdef-with-tail');
    expect(result).not.toContain('-with-tail');
  });

  it('skips short secrets to avoid false-positive masking', () => {
    const message = 'failed with short token in a longer phrase';
    expect(redactSecrets(message, ['short'])).toBe(message);
  });

  it('passes through messages with no secret matches', () => {
    const message = 'unrelated error with no secret material';
    expect(redactSecrets(message, ['oai-abcdef123'])).toBe(message);
  });

  it('handles empty secret list gracefully', () => {
    const message = 'unrelated error';
    expect(redactSecrets(message, [])).toBe(message);
  });
});
