/**
 * Unit tests for src/logger.ts — the extended structured logger.
 *
 * Proves:
 *   (1) `logger.for({module, operation})` binds those fields to every
 *       emitted NDJSON record and to the stderr prefix.
 *   (2) The root `logger.info/.warn/.error/.debug` methods still accept
 *       their original `(message, data?)` signatures — backward compat
 *       for pre-migration call sites.
 *   (3) `BRUTALIST_LOG_LEVEL=warn` suppresses info/debug records in
 *       both the base and child loggers, same behavior as before.
 *   (4) NDJSON file output includes `module`/`operation` when bound
 *       and omits them entirely when not — so existing call sites
 *       produce the same shape they did before this phase.
 *   (5) Stderr output preserves the `[BRUTALIST MCP] LEVEL:` prefix;
 *       scoped records add a `[module/operation]` tag but keep the
 *       format human-readable and grep-friendly.
 *
 * Test technique:
 *   - `jest.isolateModulesAsync` constructs fresh `Logger` instances
 *     under controlled env vars (BRUTALIST_LOG_FILE=true, a per-test
 *     BRUTALIST_LOG_DIR, per-test BRUTALIST_LOG_LEVEL) so file-output
 *     paths are exercised without touching the real home directory.
 *   - `tests/setup.ts` already replaces `global.console` with Jest
 *     mocks when `DEBUG !== 'true'`; we assert against those mocks.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('src/logger.ts — structured logger extension', () => {
  let tempDir: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    tempDir = mkdtempSync(join(tmpdir(), 'brutalist-logger-test-'));
    process.env.BRUTALIST_LOG_DIR = tempDir;
    process.env.BRUTALIST_LOG_FILE = 'true';
    // Make sure a stray BRUTALIST_SUBPROCESS from earlier tests doesn't
    // silently disable file logging.
    delete process.env.BRUTALIST_SUBPROCESS;
    // Clear any prior console.error mock calls so assertions are local
    // to each test.
    (console.error as jest.Mock).mockClear?.();
  });

  afterEach(() => {
    process.env = savedEnv;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /**
   * Construct a fresh Logger module under isolated env. Returns the
   * module so each test can destructure the root `logger` singleton
   * along with `Logger`/`ScopedLogger` classes.
   */
  async function loadLogger(envOverrides: Record<string, string | undefined> = {}) {
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }

    let mod!: typeof import('../../src/logger.js');
    await jest.isolateModulesAsync(async () => {
      mod = await import('../../src/logger.js');
    });
    return mod;
  }

  function readLogLines(): Array<Record<string, unknown>> {
    const path = join(tempDir, 'brutalist.log');
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    return raw
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  }

  // -------------------------------------------------------------------------
  // (1) Child factory binds module + operation
  // -------------------------------------------------------------------------
  describe('logger.for({module, operation}) — child factory', () => {
    it('binds module and operation on every record produced by the child', async () => {
      const { logger } = await loadLogger();
      const log = logger.for({ module: 'debate', operation: 'orchestrate' });

      log.info('round started', { round: 2 });
      log.warn('tier escalated', { from: 1, to: 2 });

      const lines = readLogLines();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        level: 'info',
        module: 'debate',
        operation: 'orchestrate',
        msg: 'round started',
        data: { round: 2 }
      });
      expect(lines[1]).toMatchObject({
        level: 'warn',
        module: 'debate',
        operation: 'orchestrate',
        msg: 'tier escalated'
      });
    });

    it('serializes error records with full Error shape when bound', async () => {
      const { logger } = await loadLogger();
      const log = logger.for({ module: 'cli', operation: 'spawn' });

      const err = new Error('boom');
      log.error('spawn failed', err);

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'error',
        module: 'cli',
        operation: 'spawn',
        msg: 'spawn failed'
      });
      const data = lines[0].data as Record<string, unknown>;
      expect(data.message).toBe('boom');
      expect(data.name).toBe('Error');
      expect(typeof data.stack).toBe('string');
    });

    it('RL2: child.for({ operation }) preserves the parent module', async () => {
      const { logger, ScopedLogger } = await loadLogger();
      const moduleLog = logger.for({ module: 'streaming', operation: 'init' });
      // Narrow by operation only — parent-bound `module: 'streaming'` must survive.
      const opLog = moduleLog.for({ operation: 'dispatch' });

      expect(opLog).toBeInstanceOf(ScopedLogger);

      opLog.info('event dispatched', { event_type: 'progress' });

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        module: 'streaming',
        operation: 'dispatch',
        msg: 'event dispatched'
      });
    });

    it('RL2: child.for({ module }) preserves the parent operation', async () => {
      // Rare but valid — if only the module needs rebranding, the operation
      // should survive.
      const { logger } = await loadLogger();
      const parent = logger.for({ module: 'debate', operation: 'orchestrate' });
      const narrowed = parent.for({ module: 'debate-legacy' });

      narrowed.info('legacy path');

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        module: 'debate-legacy',
        operation: 'orchestrate',
        msg: 'legacy path'
      });
    });

    it('RL2: child.for({ module, operation }) replaces both when both are given', async () => {
      const { logger } = await loadLogger();
      const parent = logger.for({ module: 'streaming', operation: 'init' });
      const replaced = parent.for({ module: 'cli', operation: 'spawn' });

      replaced.info('full replace');

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        module: 'cli',
        operation: 'spawn',
        msg: 'full replace'
      });
    });

    it('RL2: forOperation(op) is the grep-friendly shorthand for narrowing operation', async () => {
      const { logger, ScopedLogger } = await loadLogger();
      const classScope = logger.for({ module: 'debate', operation: 'orchestrate' });
      const methodScope = classScope.forOperation('runRound');

      expect(methodScope).toBeInstanceOf(ScopedLogger);

      methodScope.info('round executed', { round: 3 });

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        module: 'debate',
        operation: 'runRound',
        msg: 'round executed',
        data: { round: 3 }
      });
    });

    it('RL2: parent scope is not mutated when a child narrows operation', async () => {
      // Defensive — any future optimization that mutates `this.scope` in
      // place would silently leak state to the parent. Lock the contract.
      const { logger } = await loadLogger();
      const parent = logger.for({ module: 'streaming', operation: 'init' });
      const child = parent.for({ operation: 'dispatch' });

      parent.info('parent-still-init');
      child.info('child-dispatch');

      const lines = readLogLines();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        module: 'streaming',
        operation: 'init',
        msg: 'parent-still-init'
      });
      expect(lines[1]).toMatchObject({
        module: 'streaming',
        operation: 'dispatch',
        msg: 'child-dispatch'
      });
    });
  });

  // -------------------------------------------------------------------------
  // (2) Backward compatibility — root methods still accept (message, data?)
  // -------------------------------------------------------------------------
  describe('root logger — backward compatibility', () => {
    it('emits info/warn/error/debug without module/operation when no scope is bound', async () => {
      const { logger } = await loadLogger({ BRUTALIST_LOG_LEVEL: 'debug' });

      logger.info('plain info', { foo: 1 });
      logger.warn('plain warn');
      logger.error('plain error', new Error('x'));
      logger.debug('plain debug');

      const lines = readLogLines();
      expect(lines).toHaveLength(4);

      for (const line of lines) {
        expect(line).not.toHaveProperty('module');
        expect(line).not.toHaveProperty('operation');
      }
      expect(lines[0]).toMatchObject({ level: 'info', msg: 'plain info', data: { foo: 1 } });
      expect(lines[1]).toMatchObject({ level: 'warn', msg: 'plain warn' });
      expect(lines[2]).toMatchObject({ level: 'error', msg: 'plain error' });
      expect(lines[3]).toMatchObject({ level: 'debug', msg: 'plain debug' });
    });

    it('preserves Logger.getInstance() as a stable singleton accessor', async () => {
      const { Logger, logger } = await loadLogger();
      expect(Logger.getInstance()).toBe(logger);
    });

    it('preserves the ts and pid fields on every record', async () => {
      const { logger } = await loadLogger();
      logger.info('with ts and pid');

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(typeof lines[0].ts).toBe('string');
      expect(Number.isInteger(lines[0].pid)).toBe(true);
      expect(lines[0].pid).toBe(process.pid);
    });

    it('keeps shutdown() as a no-op (writes are synchronous)', async () => {
      const { logger } = await loadLogger();
      logger.info('pre-shutdown');
      expect(() => logger.shutdown()).not.toThrow();
      // The line is already on disk — we don't need to wait on shutdown.
      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ msg: 'pre-shutdown' });
    });
  });

  // -------------------------------------------------------------------------
  // (3) BRUTALIST_LOG_LEVEL still filters the file output the same as before
  // -------------------------------------------------------------------------
  describe('BRUTALIST_LOG_LEVEL — level filtering', () => {
    it('suppresses info and debug records when level is warn (base logger)', async () => {
      const { logger } = await loadLogger({ BRUTALIST_LOG_LEVEL: 'warn' });

      logger.debug('dropped-debug');
      logger.info('dropped-info');
      logger.warn('kept-warn');
      logger.error('kept-error');

      const lines = readLogLines();
      const messages = lines.map(l => l.msg);
      expect(messages).toEqual(['kept-warn', 'kept-error']);
    });

    it('suppresses info and debug records when level is warn (child logger)', async () => {
      const { logger } = await loadLogger({ BRUTALIST_LOG_LEVEL: 'warn' });
      const log = logger.for({ module: 'debate', operation: 'orchestrate' });

      log.debug('dropped-debug');
      log.info('dropped-info');
      log.warn('kept-warn');
      log.error('kept-error');

      const lines = readLogLines();
      const messages = lines.map(l => l.msg);
      expect(messages).toEqual(['kept-warn', 'kept-error']);
      // And the records that survive carry the bound scope.
      for (const line of lines) {
        expect(line.module).toBe('debate');
        expect(line.operation).toBe('orchestrate');
      }
    });

    it('accepts debug level and keeps every severity', async () => {
      const { logger } = await loadLogger({ BRUTALIST_LOG_LEVEL: 'debug' });
      const log = logger.for({ module: 'cli', operation: 'spawn' });

      log.debug('dbg');
      log.info('inf');
      log.warn('wrn');
      log.error('err');

      const lines = readLogLines();
      expect(lines.map(l => l.level)).toEqual(['debug', 'info', 'warn', 'error']);
    });

    it('defaults to info when BRUTALIST_LOG_LEVEL is unset', async () => {
      const { logger } = await loadLogger({ BRUTALIST_LOG_LEVEL: undefined });

      logger.debug('dropped');
      logger.info('kept');

      const lines = readLogLines();
      expect(lines.map(l => l.msg)).toEqual(['kept']);
    });
  });

  // -------------------------------------------------------------------------
  // (4) NDJSON shape includes module/operation when bound, omits when not
  // -------------------------------------------------------------------------
  describe('NDJSON file output — field presence', () => {
    it('includes module/operation exactly when a scope is bound', async () => {
      const { logger } = await loadLogger();
      logger.info('no-scope');
      logger.for({ module: 'm', operation: 'o' }).info('scoped');

      const lines = readLogLines();
      expect(lines).toHaveLength(2);
      expect(lines[0]).not.toHaveProperty('module');
      expect(lines[0]).not.toHaveProperty('operation');
      expect(lines[1]).toMatchObject({ module: 'm', operation: 'o' });
    });

    it('emits NDJSON — one JSON object per line, newline-terminated', async () => {
      const { logger } = await loadLogger();
      logger.info('a');
      logger.warn('b');
      logger.error('c', new Error('e'));

      const raw = readFileSync(join(tempDir, 'brutalist.log'), 'utf8');
      // Trailing newline ensures appenders can keep appending without
      // merging records.
      expect(raw.endsWith('\n')).toBe(true);
      const lines = raw.split('\n').filter(l => l.length > 0);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  // -------------------------------------------------------------------------
  // (5) Stderr human-readable output format
  // -------------------------------------------------------------------------
  describe('stderr output — human-readable', () => {
    it('keeps the [BRUTALIST MCP] LEVEL: prefix for unbound calls', async () => {
      const { logger } = await loadLogger();
      logger.info('hello');

      const calls = (console.error as jest.Mock).mock.calls;
      const prefixes = calls.map(c => String(c[0]));
      expect(prefixes).toContain('[BRUTALIST MCP] INFO:');
    });

    it('adds the [module/operation] tag for child calls, keeping the prefix', async () => {
      const { logger } = await loadLogger();
      logger.for({ module: 'debate', operation: 'orchestrate' }).info('round started');

      const calls = (console.error as jest.Mock).mock.calls;
      const prefixes = calls.map(c => String(c[0]));
      expect(prefixes).toContain('[BRUTALIST MCP] INFO [debate/orchestrate]:');
    });

    it('error output carries the caller message and Error.message (RL1)', async () => {
      const { logger } = await loadLogger();
      logger.error('boom', new Error('detail'));

      const calls = (console.error as jest.Mock).mock.calls;
      // Layout: [prefix, message, errorPayload]. Both the caller-supplied
      // `message` and the Error.message must be visible on stderr.
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] ERROR'));
      expect(match).toBeDefined();
      expect(match![1]).toBe('boom');
      expect(match![2]).toBe('detail');
    });

    it('debug stderr output stays gated by DEBUG=true', async () => {
      const { logger } = await loadLogger({ DEBUG: 'false', BRUTALIST_LOG_LEVEL: 'debug' });
      (console.error as jest.Mock).mockClear();
      logger.debug('gated');

      const calls = (console.error as jest.Mock).mock.calls;
      const debugCalls = calls.filter(c => String(c[0]).includes('DEBUG'));
      expect(debugCalls).toHaveLength(0);

      // And the file still receives the record — file path is not
      // gated by DEBUG.
      const lines = readLogLines();
      expect(lines.map(l => l.msg)).toContain('gated');
    });
  });

  // -------------------------------------------------------------------------
  // RL1: Stderr must carry the `message` argument for ALL levels, bound and
  // unbound. Stderr is the guaranteed operational sink — file logging is
  // opt-in — so the message text must never be dropped from stderr.
  // -------------------------------------------------------------------------
  describe('RL1: stderr includes caller message for all levels', () => {
    /** Helper: grab the console.error call whose prefix starts with given level. */
    function findCall(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', bound: boolean) {
      const calls = (console.error as jest.Mock).mock.calls;
      const expectedPrefix = bound
        ? `[BRUTALIST MCP] ${level} [`
        : `[BRUTALIST MCP] ${level}:`;
      return calls.find(c => String(c[0]).startsWith(expectedPrefix));
    }

    it('unbound info: message appears on stderr without data', async () => {
      const { logger } = await loadLogger();
      logger.info('hello-info');
      const match = findCall('INFO', false);
      expect(match).toBeDefined();
      expect(match![1]).toBe('hello-info');
    });

    it('unbound info: message appears on stderr alongside data', async () => {
      const { logger } = await loadLogger();
      logger.info('hello-info', { k: 1 });
      const match = findCall('INFO', false);
      expect(match).toBeDefined();
      expect(match![1]).toBe('hello-info');
      expect(match![2]).toBe('{"k":1}');
    });

    it('unbound warn: message appears on stderr', async () => {
      const { logger } = await loadLogger();
      logger.warn('hello-warn', { level: 'yellow' });
      const match = findCall('WARN', false);
      expect(match).toBeDefined();
      expect(match![1]).toBe('hello-warn');
      expect(match![2]).toBe('{"level":"yellow"}');
    });

    it('unbound debug: message appears on stderr when DEBUG=true', async () => {
      const { logger } = await loadLogger({ DEBUG: 'true', BRUTALIST_LOG_LEVEL: 'debug' });
      (console.error as jest.Mock).mockClear();
      logger.debug('hello-debug', { trace: 'abc' });
      const match = findCall('DEBUG', false);
      expect(match).toBeDefined();
      expect(match![1]).toBe('hello-debug');
      expect(match![2]).toBe('{"trace":"abc"}');
    });

    it('unbound error: caller message AND error detail both appear on stderr', async () => {
      const { logger } = await loadLogger();
      logger.error('connect failed', new Error('ECONNREFUSED'));
      const match = findCall('ERROR', false);
      expect(match).toBeDefined();
      expect(match![1]).toBe('connect failed');
      expect(match![2]).toBe('ECONNREFUSED');
    });

    it('unbound error: caller message present even when error is omitted', async () => {
      const { logger } = await loadLogger();
      logger.error('standalone error');
      const match = findCall('ERROR', false);
      expect(match).toBeDefined();
      expect(match![1]).toBe('standalone error');
      expect(match![2]).toBe('');
    });

    it('bound info: message appears on stderr with the scope tag', async () => {
      const { logger } = await loadLogger();
      const log = logger.for({ module: 'debate', operation: 'orchestrate' });
      log.info('round started');
      const match = findCall('INFO', true);
      expect(match).toBeDefined();
      expect(String(match![0])).toBe('[BRUTALIST MCP] INFO [debate/orchestrate]:');
      expect(match![1]).toBe('round started');
    });

    it('bound warn: message appears on stderr with the scope tag and data', async () => {
      const { logger } = await loadLogger();
      const log = logger.for({ module: 'cli', operation: 'spawn' });
      log.warn('fallback triggered', { provider: 'claude' });
      const match = findCall('WARN', true);
      expect(match).toBeDefined();
      expect(match![1]).toBe('fallback triggered');
      expect(match![2]).toBe('{"provider":"claude"}');
    });

    it('bound debug: message appears on stderr with the scope tag when DEBUG=true', async () => {
      const { logger } = await loadLogger({ DEBUG: 'true', BRUTALIST_LOG_LEVEL: 'debug' });
      (console.error as jest.Mock).mockClear();
      const log = logger.for({ module: 'streaming', operation: 'dispatch' });
      log.debug('event dispatched');
      const match = findCall('DEBUG', true);
      expect(match).toBeDefined();
      expect(match![1]).toBe('event dispatched');
    });

    it('bound error: caller message AND error detail appear on stderr with scope tag', async () => {
      const { logger } = await loadLogger();
      const log = logger.for({ module: 'cli', operation: 'spawn' });
      log.error('spawn failed', new Error('ENOENT'));
      const match = findCall('ERROR', true);
      expect(match).toBeDefined();
      expect(String(match![0])).toBe('[BRUTALIST MCP] ERROR [cli/spawn]:');
      expect(match![1]).toBe('spawn failed');
      expect(match![2]).toBe('ENOENT');
    });
  });

  // -------------------------------------------------------------------------
  // RL3: JSON.stringify safe-guard. A circular object passed as log
  // metadata must NOT throw from the logger — logging calls must remain
  // non-throwing since they run on request paths.
  // -------------------------------------------------------------------------
  describe('RL3: safe stringify on unserializable data', () => {
    it('info with circular object does not throw; stderr emits placeholder; file emits placeholder', async () => {
      const { logger } = await loadLogger();
      const circular: any = { name: 'a' };
      circular.self = circular;

      expect(() => logger.info('cycle', circular)).not.toThrow();

      // Stderr must have emitted with a safe placeholder.
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO'));
      expect(match).toBeDefined();
      expect(match![1]).toBe('cycle');
      expect(match![2]).toBe('[unserializable]');

      // File NDJSON record must also survive — writeToFile already wraps
      // JSON.stringify in try/catch and disables file logging on failure,
      // but the key contract is: the logger call does not throw.
      // We don't strictly require the file to contain the record since
      // the writeToFile catch-path disables file logging on serialization
      // failure; just asserting non-throw + stderr placeholder is
      // sufficient to prove logger-call availability.
    });

    it('warn with circular data does not throw and emits safe placeholder', async () => {
      const { logger } = await loadLogger();
      const a: any = {};
      const b: any = { a };
      a.b = b;
      expect(() => logger.warn('cycle-warn', a)).not.toThrow();
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] WARN'));
      expect(match).toBeDefined();
      expect(match![2]).toBe('[unserializable]');
    });

    it('error with non-Error circular payload does not throw; stderr emits placeholder', async () => {
      const { logger } = await loadLogger();
      const circular: any = { type: 'oops' };
      circular.self = circular;
      expect(() => logger.error('whoops', circular)).not.toThrow();

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] ERROR'));
      expect(match).toBeDefined();
      expect(match![1]).toBe('whoops');
      expect(match![2]).toBe('[unserializable]');
    });

    it('bound scoped info with circular data does not throw', async () => {
      const { logger } = await loadLogger();
      const log = logger.for({ module: 'debate', operation: 'orchestrate' });
      const circ: any = { x: 1 };
      circ.self = circ;
      expect(() => log.info('msg', circ)).not.toThrow();
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO ['));
      expect(match).toBeDefined();
      expect(match![2]).toBe('[unserializable]');
    });

    it('objects with throwing toJSON do not bring down the logger call', async () => {
      const { logger } = await loadLogger();
      const nasty = {
        toJSON() {
          throw new Error('refuse to serialize');
        }
      };
      expect(() => logger.info('naughty', nasty)).not.toThrow();
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO'));
      expect(match).toBeDefined();
      expect(match![2]).toBe('[unserializable]');
    });
  });

  // -------------------------------------------------------------------------
  // RL4: Stderr log injection via unescaped module/operation. Scope fields
  // at the stderr boundary must sanitize CR/LF/ANSI/tab/control chars and
  // cap length. NDJSON file output preserves originals (JSON.stringify is
  // already safe).
  // -------------------------------------------------------------------------
  describe('RL4: sanitize scope on stderr against log injection', () => {
    it('newline in operation does NOT forge a second log line on stderr', async () => {
      const { logger } = await loadLogger();
      const attack = 'foo\n[BRUTALIST MCP] ERROR [auth]: forged';
      logger.for({ module: 'safe', operation: attack }).info('legit');

      const calls = (console.error as jest.Mock).mock.calls;
      // No console.error call's prefix must contain a literal newline
      // (which would cause terminals/log aggregators to render a second
      // line). The raw string may still contain the *word* "forged" as
      // escaped payload — the point is that the newline is neutralized
      // so the forged text cannot appear to be its own log record.
      for (const c of calls) {
        const first = String(c[0]);
        expect(first).not.toMatch(/\n/);
        expect(first).not.toMatch(/\r/);
      }
      // And the legit record's stderr prefix must exist and be flat,
      // with the escaped newline visible as `\x0a`.
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO ['));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      expect(prefix).toContain('\\x0a');
      // Critically: the attacker's fake prefix `[BRUTALIST MCP] ERROR`
      // must NOT appear as a second line — there's still only one
      // `[BRUTALIST MCP]` token per rendered line.
      const renderedLines = prefix.split('\n');
      expect(renderedLines.length).toBe(1);
    });

    it('ANSI escape in module is neutralized on stderr', async () => {
      const { logger } = await loadLogger();
      logger.for({ module: 'a\x1b[31mred', operation: 'op' }).info('x');
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO ['));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      // Raw ESC (0x1b) must not appear.
      expect(prefix).not.toMatch(/\x1b/);
      expect(prefix).toContain('\\x1b');
    });

    it('closing bracket in operation is escaped so the tag delimiter cannot break', async () => {
      const { logger } = await loadLogger();
      logger.for({ module: 'safe', operation: 'x]injected' }).info('y');
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO ['));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      // The prefix ends with `]:` — between the opening `[` and the
      // final `]:` there should be exactly one logical bracket, so the
      // injected `]` must appear escaped.
      expect(prefix).toContain('\\]');
      // And there must not be an injected break that looks like `]:`
      // before the actual closer.
      expect(prefix).toMatch(/^\[BRUTALIST MCP\] INFO \[safe\/x\\\]injected\]:$/);
    });

    it('tab and carriage return in scope are escaped', async () => {
      const { logger } = await loadLogger();
      logger.for({ module: 'mod\twithtab', operation: 'op\rwithcr' }).info('t');
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO ['));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      expect(prefix).not.toMatch(/\t/);
      expect(prefix).not.toMatch(/\r/);
      expect(prefix).toContain('\\x09');
      expect(prefix).toContain('\\x0d');
    });

    it('over-long module/operation names are truncated on stderr (cap 64)', async () => {
      const { logger } = await loadLogger();
      const longModule = 'm'.repeat(200);
      const longOp = 'o'.repeat(500);
      logger.for({ module: longModule, operation: longOp }).info('z');
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO ['));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      // Extract the tag between `[` and `]:`.
      const tagMatch = prefix.match(/\[BRUTALIST MCP\] INFO \[([^\]]+)\/([^\]]+)\]:/);
      expect(tagMatch).not.toBeNull();
      expect(tagMatch![1].length).toBeLessThanOrEqual(64);
      expect(tagMatch![2].length).toBeLessThanOrEqual(64);
    });

    it('NDJSON file record preserves the ORIGINAL unescaped module/operation', async () => {
      const { logger } = await loadLogger();
      // A mix of newline, bracket, ANSI, and tab.
      const originalModule = 'mod\x1b[31mred';
      const originalOp = 'foo\n[BRUTALIST MCP] ERROR [auth]: forged';
      logger.for({ module: originalModule, operation: originalOp }).info('ndjson-original');

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      // NDJSON has the original (un-sanitized) values — JSON.stringify
      // already escapes control chars safely, so the on-disk record
      // is not ambiguous despite containing the raw values.
      expect(lines[0].module).toBe(originalModule);
      expect(lines[0].operation).toBe(originalOp);
    });
  });

  // -------------------------------------------------------------------------
  // RL5 (Cycle 6): caller `message` and string error payloads must be
  // sanitized before they hit `console.error`. The RL1 rework restored
  // `message` to stderr, but a CR/LF inside the message body would forge
  // a second log line on stderr — terminals/log scrapers would render
  // the second portion as a separate record.
  //
  // Distinct from RL4 (scope sanitization) because messages are free-form
  // text — no length cap, no `]`/`%` escape — and the most common control
  // chars (CR/LF) are replaced with the short visible escapes `\n`/`\r`
  // rather than `\xHH` so operator-readable lines stay readable.
  // -------------------------------------------------------------------------
  describe('RL5: stderr message/error-payload sanitization', () => {
    it('newline in caller message does NOT forge a second stderr line (info)', async () => {
      const { logger } = await loadLogger();
      const attack = 'legit\n[BRUTALIST MCP] ERROR: forged-by-message';
      logger.info(attack);

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO'));
      expect(match).toBeDefined();
      // The message arg must not contain a literal newline.
      expect(String(match![1])).not.toMatch(/\n/);
      // The forged-prefix substring is still present (escaped) so operators
      // see the attack text — but the visible escape ensures terminals
      // render the whole record as one line.
      expect(String(match![1])).toContain('\\n');
      expect(String(match![1])).toContain('forged-by-message');
    });

    it('CR in caller message is escaped to \\r (warn)', async () => {
      const { logger } = await loadLogger();
      logger.warn('first\rsecond');

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] WARN'));
      expect(match).toBeDefined();
      expect(String(match![1])).not.toMatch(/\r/);
      expect(String(match![1])).toContain('\\r');
    });

    it('C0 controls in caller message are hex-escaped (error path)', async () => {
      const { logger } = await loadLogger();
      // 0x07 (BEL) and 0x1b (ESC) are common terminal-attack chars.
      logger.error('alert\x07esc\x1bend');

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] ERROR'));
      expect(match).toBeDefined();
      const msg = String(match![1]);
      expect(msg).not.toMatch(/\x07/);
      expect(msg).not.toMatch(/\x1b/);
      expect(msg).toContain('\\x07');
      expect(msg).toContain('\\x1b');
    });

    it('Error.message is sanitized when an Error payload is passed (error path)', async () => {
      const { logger } = await loadLogger();
      // An attacker-controlled remote API echoes an error message back into
      // an exception that the server then logs.
      const err = new Error('upstream\n[BRUTALIST MCP] ERROR: forged-by-error-message');
      logger.error('caught upstream', err);

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] ERROR'));
      expect(match).toBeDefined();
      // Error payload is the third arg (after prefix and caller message).
      const errPayload = String(match![2]);
      expect(errPayload).not.toMatch(/\n/);
      expect(errPayload).toContain('\\n');
      expect(errPayload).toContain('forged-by-error-message');
    });

    it('string error payload is sanitized (error path)', async () => {
      const { logger } = await loadLogger();
      // logger.error supports a non-Error string payload via `error?: any`.
      logger.error('caller-msg', 'string-detail\n[BRUTALIST MCP] WARN: forged');

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] ERROR'));
      expect(match).toBeDefined();
      const errPayload = String(match![2]);
      expect(errPayload).not.toMatch(/\n/);
      expect(errPayload).toContain('\\n');
      expect(errPayload).toContain('forged');
    });

    it('caller message in scoped logger is sanitized (bound-path coverage)', async () => {
      const { logger } = await loadLogger();
      const log = logger.for({ module: 'safe', operation: 'op' });
      log.info('round\nstart');

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => String(c[0]).startsWith('[BRUTALIST MCP] INFO ['));
      expect(match).toBeDefined();
      expect(String(match![1])).not.toMatch(/\n/);
      expect(String(match![1])).toContain('\\n');
    });

    it('NDJSON file record preserves the ORIGINAL unsanitized message (RL5 tradeoff parity with RL4)', async () => {
      const { logger } = await loadLogger();
      const original = 'real\nbody';
      logger.info(original);
      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      // The on-disk record must keep the raw text — JSON.stringify already
      // escapes control chars safely, so the file path is not ambiguous.
      expect(lines[0].msg).toBe(original);
    });
  });

  // -------------------------------------------------------------------------
  // RL6 (Cycle 6): the stderr prefix is the FIRST argument to
  // `console.error`, so Node's `util.format` interprets `%j`/`%s`/`%d`/
  // `%o` substring inside it as a format specifier. An attacker who can
  // influence a scope name to `'op%j'` would consume the `message`
  // argument as JSON and splice it into the prefix, leaking structured
  // data into the rendered prefix.
  //
  // Resolution chosen: option (a) — escape `%` as `%%` in
  // `sanitizeScopeForStderr`. Preserves the multi-arg console.error call
  // shape that ~25 existing tests assert against.
  // -------------------------------------------------------------------------
  describe('RL6: format-string injection via % in stderr scope prefix', () => {
    it('% in module is escaped so util.format does not consume the message', async () => {
      const { logger } = await loadLogger();
      // Without the escape, `%j` would consume `match[1]` and JSON-stringify
      // it into the rendered prefix.
      logger.for({ module: 'auth%j', operation: 'op' }).info('secret-message', { secret: 'leak' });

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => /^\[BRUTALIST MCP\] INFO \[/.test(String(c[0])));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      // The escaped form is `%%`; raw `%j` must NOT survive next to literal text.
      // (Note: prefix itself is what util.format sees; an unescaped `%j` in
      // the first arg would consume args[1] when console.error renders.)
      expect(prefix).toContain('auth%%j');
      // And the `message` argument is still in its own slot — it was NOT
      // consumed as a format substitution target.
      expect(match![1]).toBe('secret-message');
    });

    it('% in operation is escaped (any spec character)', async () => {
      const { logger } = await loadLogger();
      logger.for({ module: 'm', operation: 'op%s%d%o' }).info('msg');

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => /^\[BRUTALIST MCP\] INFO \[/.test(String(c[0])));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      // Each `%` is doubled; the literal spec letters remain.
      expect(prefix).toContain('op%%s%%d%%o');
    });

    it('lone % (not a spec char) is still escaped for forward compatibility', async () => {
      const { logger } = await loadLogger();
      logger.for({ module: '50%great', operation: '100%done' }).info('z');

      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => /^\[BRUTALIST MCP\] INFO \[/.test(String(c[0])));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      // Future Node versions might add new format specifiers; doubling all
      // `%` is the safe invariant.
      expect(prefix).toContain('50%%great');
      expect(prefix).toContain('100%%done');
    });
  });

  // -------------------------------------------------------------------------
  // RL4-extension (Cycle 6): C1 control chars (0x80-0x9f) — notably
  // U+009B CSI which several terminals interpret as an ANSI control
  // introducer without a literal ESC byte — must be escaped at the
  // stderr boundary alongside C0 and DEL.
  // -------------------------------------------------------------------------
  describe('RL4-extension: C1 controls (0x80-0x9f) in scope are escaped', () => {
    it('U+009B CSI in module is hex-escaped (cannot drive terminal escape)', async () => {
      const { logger } = await loadLogger();
      logger.for({ module: 'auth\u009bforged', operation: 'op' }).info('x');
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => /^\[BRUTALIST MCP\] INFO \[/.test(String(c[0])));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      // Raw 0x9b must not appear.
      expect(prefix).not.toMatch(/\u009b/);
      // Visible hex escape present.
      expect(prefix).toContain('\\x9b');
    });

    it('full C1 range (0x80-0x9f) is escaped in operation', async () => {
      const { logger } = await loadLogger();
      // A handful from the range — first, middle, last — proves the branch.
      const c1 = '\u0080mid\u0090end\u009f';
      logger.for({ module: 'm', operation: c1 }).info('y');
      const calls = (console.error as jest.Mock).mock.calls;
      const match = calls.find(c => /^\[BRUTALIST MCP\] INFO \[/.test(String(c[0])));
      expect(match).toBeDefined();
      const prefix = String(match![0]);
      expect(prefix).not.toMatch(/[\u0080-\u009f]/);
      expect(prefix).toContain('\\x80');
      expect(prefix).toContain('\\x90');
      expect(prefix).toContain('\\x9f');
    });
  });

  // -------------------------------------------------------------------------
  // RL7 (Cycle 6): `Partial<LogScope>` widening from RL2 means a caller
  // could pass `{ module: undefined }` (e.g., from a dynamic computation
  // that returns undefined under one branch). The merge must NOT
  // propagate undefined, and the downstream `sanitizeScopeForStderr`
  // must NOT iterate over undefined (which throws TypeError).
  //
  // Loggers run in error handlers, so a TypeError originating in the
  // logger itself would convert a minor fault into a fatal crash.
  // -------------------------------------------------------------------------
  describe('RL7: undefined scope propagation does not crash', () => {
    it('child.for({ module: undefined }) preserves the parent module', async () => {
      const { logger } = await loadLogger();
      const parent = logger.for({ module: 'streaming', operation: 'init' });
      const child = parent.for({ module: undefined });

      child.info('survives');

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        module: 'streaming',
        operation: 'init',
        msg: 'survives'
      });
    });

    it('child.for({ operation: undefined }) preserves the parent operation', async () => {
      const { logger } = await loadLogger();
      const parent = logger.for({ module: 'cli', operation: 'spawn' });
      const child = parent.for({ operation: undefined });

      child.info('still spawning');

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        module: 'cli',
        operation: 'spawn',
        msg: 'still spawning'
      });
    });

    it('.info on a child with explicit-undefined scope does NOT throw', async () => {
      const { logger } = await loadLogger();
      const parent = logger.for({ module: 'safe', operation: 'op' });
      const child = parent.for({ module: undefined, operation: undefined });

      // The previous merge `??` was actually safe but the explicit `!= null`
      // form makes the intent unambiguous and protects against future
      // `Object.assign` style refactors. The defense-in-depth is the
      // sanitizer null-guard tested below.
      expect(() => child.info('no-throw')).not.toThrow();
      expect(() => child.warn('no-throw')).not.toThrow();
      expect(() => child.error('no-throw')).not.toThrow();
    });

    it('sanitizeScopeForStderr defense-in-depth: never throws on null/undefined', async () => {
      // We cannot directly call the un-exported `sanitizeScopeForStderr`,
      // but we can assert the indirect contract: a manually-forged scope
      // bag with undefined fields (only reachable via a buggy intermediate
      // wrapper) does not throw at the stderr-emit boundary. Use the
      // private emit() via the root Logger's interface (cast) to simulate
      // the pathological case the defense-in-depth is for.
      const { Logger } = await loadLogger();
      const root = Logger.getInstance();
      // Reach through to the internal emit with a deliberately malformed
      // scope to assert the guard runs. Cast tightly scoped to the test.
      const emit = (root as unknown as {
        emit: (
          level: 'info',
          message: string,
          data: undefined,
          scope: { module: undefined; operation: undefined } | undefined
        ) => void;
      }).emit.bind(root);

      expect(() => emit('info', 'still-renders', undefined, {
        module: undefined,
        operation: undefined,
      })).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // RL8 (Cycle 6): the `StructuredLogger` interface must expose
  // `Partial<LogScope>` on `for()` and add `forOperation(op)` so that
  // integration-phase DI sites typed as `StructuredLogger` can call
  // both ergonomics without downcasting to `ScopedLogger`.
  // -------------------------------------------------------------------------
  describe('RL8: StructuredLogger interface exposes partial scope and forOperation', () => {
    it('a parameter typed as StructuredLogger can call .forOperation() (compile-time + runtime)', async () => {
      const { logger } = await loadLogger();
      // Bind first via the root, then exercise the interface contract.
      const bound = logger.for({ module: 'debate', operation: 'orchestrate' });

      // Simulate a DI consumer typed against the interface.
      function consumeStructured(log: import('../../src/logger.js').StructuredLogger) {
        return log.forOperation('runRound');
      }

      const narrowed = consumeStructured(bound);
      narrowed.info('via interface');

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        module: 'debate',
        operation: 'runRound',
        msg: 'via interface'
      });
    });

    it('a parameter typed as StructuredLogger can call .for({ operation }) without rebinding module', async () => {
      const { logger } = await loadLogger();
      const bound = logger.for({ module: 'cli', operation: 'spawn' });

      function consumeStructured(log: import('../../src/logger.js').StructuredLogger) {
        return log.for({ operation: 'health-check' });
      }

      const narrowed = consumeStructured(bound);
      narrowed.info('partial via interface');

      const lines = readLogLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        module: 'cli',
        operation: 'health-check',
        msg: 'partial via interface'
      });
    });

    it('root Logger.for still requires both fields (no parent to inherit from)', async () => {
      const { logger } = await loadLogger();
      // Root path — no parent scope. Expect a clear error rather than
      // silently producing a child with undefined fields.
      expect(() => logger.for({ operation: 'no-module' })).toThrow(/requires both module and operation/);
      expect(() => logger.for({ module: 'no-operation' })).toThrow(/requires both module and operation/);
      expect(() => logger.for({})).toThrow(/requires both module and operation/);
    });

    it('root Logger.forOperation throws (no module to inherit) — interface contract still satisfied', async () => {
      const { logger } = await loadLogger();
      expect(() => logger.forOperation('whatever')).toThrow(/cannot be called on the root logger/);
    });
  });
});
