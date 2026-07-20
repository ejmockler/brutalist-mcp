import { describe, it, expect } from '@jest/globals';
import {
  providerFidelityWindow,
  charsForWindow,
  fitContextToWindow,
  CONTEXT_TRUNCATION_MARKER,
  CLAUDE_1M_WINDOW_TOKENS,
  CONSERVATIVE_FIDELITY_WINDOW_TOKENS,
  AGY_VERBATIM_FIDELITY_TOKENS,
  CODEX_VERBATIM_INPUT_FIDELITY_TOKENS,
} from '../../src/fidelity-window.js';

const noEnv = {} as NodeJS.ProcessEnv;

describe('providerFidelityWindow', () => {
  it('claude: 1M only with the [1m] suffix, else the conservative ~200k', () => {
    expect(providerFidelityWindow('claude', 'claude-opus-4-8[1m]', undefined, noEnv)).toBe(CLAUDE_1M_WINDOW_TOKENS);
    expect(providerFidelityWindow('claude', 'claude-opus-4-8', undefined, noEnv)).toBe(CONSERVATIVE_FIDELITY_WINDOW_TOKENS);
    expect(providerFidelityWindow('claude', undefined, undefined, noEnv)).toBe(CONSERVATIVE_FIDELITY_WINDOW_TOKENS);
  });

  it('codex ~272k and agy ~135k are model-independent verbatim thresholds', () => {
    expect(providerFidelityWindow('codex', 'gpt-5.6-sol', undefined, noEnv)).toBe(CODEX_VERBATIM_INPUT_FIDELITY_TOKENS);
    expect(providerFidelityWindow('agy', 'Gemini 3.5 Flash (Medium)', undefined, noEnv)).toBe(AGY_VERBATIM_FIDELITY_TOKENS);
  });

  it('honors BRUTALIST_{CODEX,AGY}_CONTEXT_WINDOW overrides, ignoring invalid ones', () => {
    expect(providerFidelityWindow('codex', 'x', undefined, { BRUTALIST_CODEX_CONTEXT_WINDOW: '300000' } as any)).toBe(300_000);
    expect(providerFidelityWindow('agy', 'x', undefined, { BRUTALIST_AGY_CONTEXT_WINDOW: '250000' } as any)).toBe(250_000);
    expect(providerFidelityWindow('codex', 'x', undefined, { BRUTALIST_CODEX_CONTEXT_WINDOW: 'abc' } as any)).toBe(CODEX_VERBATIM_INPUT_FIDELITY_TOKENS);
    expect(providerFidelityWindow('codex', 'x', undefined, { BRUTALIST_CODEX_CONTEXT_WINDOW: '999' } as any)).toBe(CODEX_VERBATIM_INPUT_FIDELITY_TOKENS);
  });

  it('an unknown provider uses its declared window, else the conservative floor', () => {
    expect(providerFidelityWindow('other', 'm', 1_000_000, noEnv)).toBe(1_000_000);
    expect(providerFidelityWindow('other', 'm', undefined, noEnv)).toBe(CONSERVATIVE_FIDELITY_WINDOW_TOKENS);
  });
});

describe('charsForWindow', () => {
  it('applies 15% headroom + 3 chars/token by default and is monotonic', () => {
    expect(charsForWindow(135_000, 15)).toBe(Math.floor(135_000 * 0.85) * 3);
    expect(charsForWindow(135_000)).toBe(charsForWindow(135_000, 15));
    expect(charsForWindow(135_000)).toBeLessThan(charsForWindow(272_000));
    expect(charsForWindow(272_000)).toBeLessThan(charsForWindow(1_000_000));
  });
});

describe('fitContextToWindow', () => {
  const budget = charsForWindow(135_000); // ~344,250

  it('returns the context verbatim when it fits', () => {
    const c = 'x'.repeat(1000);
    expect(fitContextToWindow(c, budget)).toBe(c);
  });

  it('trims to head + marker on overflow, never exceeding the budget, dropping the tail', () => {
    const c = 'x'.repeat(500_000) + 'TAIL_SENTINEL';
    const out = fitContextToWindow(c, budget);
    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out.endsWith(CONTEXT_TRUNCATION_MARKER)).toBe(true);
    expect(out.includes('TAIL_SENTINEL')).toBe(false);
  });

  it('treats a non-finite (Infinity) budget as an explicit no-op — upstream already chunked', () => {
    const c = 'x'.repeat(500_000);
    expect(fitContextToWindow(c, Infinity)).toBe(c);
  });

  it('passes an empty context through unchanged', () => {
    expect(fitContextToWindow('', 100)).toBe('');
  });
});
