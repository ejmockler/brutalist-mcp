import { describe, it, expect } from '@jest/globals';
import { assertPreflight } from '../src/preflight.js';

function ok(binary: string) {
  return { binary, available: true, resolvedPath: `/usr/local/bin/${binary}` };
}
function missing(binary: string) {
  return { binary, available: false };
}

describe('assertPreflight', () => {
  it('passes when both hard requirements are present', () => {
    expect(() =>
      assertPreflight({
        brutalistMcp: ok('brutalist-mcp'),
        claude: ok('claude'),
        codex: ok('codex'),
        gemini: ok('gemini'),
      }),
    ).not.toThrow();
  });

  it('throws when brutalist-mcp is missing', () => {
    expect(() =>
      assertPreflight({
        brutalistMcp: missing('brutalist-mcp'),
        claude: ok('claude'),
        codex: ok('codex'),
        gemini: ok('gemini'),
      }),
    ).toThrow(/brutalist-mcp/);
  });

  it('throws when claude is missing', () => {
    expect(() =>
      assertPreflight({
        brutalistMcp: ok('brutalist-mcp'),
        claude: missing('claude'),
        codex: ok('codex'),
        gemini: ok('gemini'),
      }),
    ).toThrow(/claude/);
  });

  it('lists all missing hard requirements in one error', () => {
    expect(() =>
      assertPreflight({
        brutalistMcp: missing('brutalist-mcp'),
        claude: missing('claude'),
        codex: ok('codex'),
        gemini: ok('gemini'),
      }),
    ).toThrow(/brutalist-mcp.*claude/s);
  });

  it('passes (warn-only) when only claude is available among critics', () => {
    expect(() =>
      assertPreflight({
        brutalistMcp: ok('brutalist-mcp'),
        claude: ok('claude'),
        codex: missing('codex'),
        gemini: missing('gemini'),
      }),
    ).not.toThrow();
  });
});
