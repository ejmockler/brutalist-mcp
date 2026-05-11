import { describe, it, expect } from '@jest/globals';
import {
  FindingSchema,
  OrchestratorResultSchema,
  CliBreakdownSchema,
  CliNameSchema,
  SeveritySchema,
  SideSchema,
} from '../src/schemas.js';

describe('Finding schema', () => {
  it('accepts a fully-populated finding', () => {
    const ok = {
      cli: 'codex',
      path: 'src/auth.ts',
      lineHint: 42,
      side: 'RIGHT',
      severity: 'high',
      category: 'security',
      title: 'JWT in localStorage',
      body: 'Detail',
      verbatimQuote: 'localStorage.getItem("jwt")',
      suggestion: 'use httpOnly cookie',
    };
    expect(FindingSchema.parse(ok)).toEqual(ok);
  });

  it('rejects missing verbatimQuote (the linchpin of line resolution)', () => {
    expect(() =>
      FindingSchema.parse({
        cli: 'codex',
        path: 'src/auth.ts',
        side: 'RIGHT',
        severity: 'high',
        category: 'security',
        title: 'T',
        body: 'B',
      } as unknown),
    ).toThrow();
  });

  it('rejects unknown CLI names', () => {
    expect(() =>
      FindingSchema.parse({
        cli: 'gpt5',
        path: 'src/auth.ts',
        side: 'RIGHT',
        severity: 'high',
        category: 'security',
        title: 'T',
        body: 'B',
        verbatimQuote: 'x',
      } as unknown),
    ).toThrow();
  });

  it('rejects negative line hints', () => {
    expect(() =>
      FindingSchema.parse({
        cli: 'codex',
        path: 'src/auth.ts',
        lineHint: -1,
        side: 'RIGHT',
        severity: 'high',
        category: 'security',
        title: 'T',
        body: 'B',
        verbatimQuote: 'x',
      } as unknown),
    ).toThrow();
  });

  it('caps title length to 200 chars', () => {
    expect(() =>
      FindingSchema.parse({
        cli: 'codex',
        path: 'src/auth.ts',
        side: 'RIGHT',
        severity: 'high',
        category: 'security',
        title: 'a'.repeat(201),
        body: 'B',
        verbatimQuote: 'x',
      } as unknown),
    ).toThrow();
  });

  it('omits suggestion when not provided', () => {
    const parsed = FindingSchema.parse({
      cli: 'codex',
      path: 'src/auth.ts',
      side: 'RIGHT',
      severity: 'high',
      category: 'security',
      title: 'T',
      body: 'B',
      verbatimQuote: 'x',
    });
    expect(parsed.suggestion).toBeUndefined();
  });
});

describe('OrchestratorResult schema', () => {
  it('parses a minimal valid result', () => {
    const result = OrchestratorResultSchema.parse({
      schemaVersion: 1,
      findings: [],
      perCli: [],
      synthesis: '',
      outOfDiff: [],
    });
    expect(result.schemaVersion).toBe(1);
  });

  it('rejects schemaVersion mismatch (contract anchor)', () => {
    expect(() =>
      OrchestratorResultSchema.parse({
        schemaVersion: 2,
        findings: [],
        perCli: [],
        synthesis: '',
        outOfDiff: [],
      } as unknown),
    ).toThrow();
  });

  it('preserves cli + model attribution in perCli breakdown', () => {
    const result = OrchestratorResultSchema.parse({
      schemaVersion: 1,
      findings: [],
      perCli: [
        { cli: 'claude', success: true, model: 'opus', executionTimeMs: 1200, summary: 'ok' },
        { cli: 'codex', success: false, executionTimeMs: 800, summary: 'failed' },
      ],
      synthesis: '',
      outOfDiff: [],
    });
    expect(result.perCli).toHaveLength(2);
    expect(result.perCli[0].cli).toBe('claude');
    expect(result.perCli[0].model).toBe('opus');
    expect(result.perCli[1].model).toBeUndefined();
  });
});

describe('enums', () => {
  it('CliName accepts the three brutalist critics', () => {
    for (const name of ['claude', 'codex', 'gemini'] as const) {
      expect(CliNameSchema.parse(name)).toBe(name);
    }
  });

  it('Severity accepts the five-level scale', () => {
    for (const s of ['critical', 'high', 'medium', 'low', 'nit'] as const) {
      expect(SeveritySchema.parse(s)).toBe(s);
    }
  });

  it('Side accepts RIGHT / LEFT / FILE', () => {
    for (const s of ['RIGHT', 'LEFT', 'FILE'] as const) {
      expect(SideSchema.parse(s)).toBe(s);
    }
  });
});

describe('CliBreakdown schema', () => {
  it('rejects negative executionTimeMs', () => {
    expect(() =>
      CliBreakdownSchema.parse({
        cli: 'claude',
        success: true,
        executionTimeMs: -1,
        summary: '',
      } as unknown),
    ).toThrow();
  });
});
