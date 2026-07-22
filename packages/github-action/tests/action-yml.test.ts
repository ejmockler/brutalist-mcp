import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const actionYmlPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../action.yml',
);
const lines = readFileSync(actionYmlPath, 'utf8').split('\n');

/** Return the field lines of a 2-space-indented action input block. */
function inputBlock(name: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(l));
  if (start === -1) return [];
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    // Next input (or top-level key) begins at <=2-space indent — stop there.
    if (/^ {0,2}\S/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block;
}

describe('action.yml input contract', () => {
  it('context-window-tokens has NO default (a runner-injected default would clamp EVERY critic, defeating per-participant fidelity)', () => {
    // The GitHub runner injects action.yml input defaults as INPUT_* env vars,
    // so a `default:` here makes core.getInput() return it even when the caller
    // omits the input — which inputs.ts treats as an explicit per-participant
    // window cap, silently clamping claude/glm (~1M) to it. The window MUST
    // default to unset; the code-level parseIntInput fallback ('200000') still
    // feeds the legacy governing-min for the single-window fallback path.
    const block = inputBlock('context-window-tokens');
    expect(block.length).toBeGreaterThan(0);
    expect(block.some((l) => /^\s*default:/.test(l))).toBe(false);
    expect(block.some((l) => /^\s*required:\s*false\s*$/.test(l))).toBe(true);
  });
});
