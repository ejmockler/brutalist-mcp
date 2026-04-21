import {
  appendFileSync,
  statSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Production logger with optional size-rotated file output.
 *
 * Stderr output (human-readable) is always active — this is the MCP-safe
 * channel since stdout is reserved for protocol messages.
 *
 * File output (NDJSON) is opt-in via BRUTALIST_LOG_FILE=true.
 * Files are written to ~/.brutalist-mcp/logs/ by default and capped
 * via size-based ring rotation so disk usage never exceeds
 * MAX_SIZE × (MAX_FILES + 1).
 *
 * Uses synchronous file writes (appendFileSync) so every log line
 * survives crashes — essential for post-mortem debugging.
 *
 * Environment variables:
 *   BRUTALIST_LOG_FILE      – "true" to enable file logging
 *   BRUTALIST_LOG_DIR       – override log directory
 *   BRUTALIST_LOG_MAX_SIZE  – max MB per file (default 5)
 *   BRUTALIST_LOG_MAX_FILES – rotated files to keep (default 3)
 *   BRUTALIST_LOG_LEVEL     – minimum file log level (default "info")
 *
 * Structured fields (intents.md #3):
 *   Every call carries {ts, level, msg, pid}. Callers that use
 *   `logger.for({module, operation})` additionally bind `module` and
 *   `operation` so records are queryable by subsystem without reading
 *   source. Base methods remain source-compatible with pre-migration
 *   call sites — module/operation are simply absent on unbound calls.
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const LOG_FILENAME = 'brutalist.log';

/** Max length for sanitized scope fields on the stderr prefix (RL4). */
const STDERR_SCOPE_MAX_LEN = 64;

/** Placeholder written when JSON serialization throws (RL3). */
const UNSERIALIZABLE_PLACEHOLDER = '[unserializable]';

/**
 * Safely stringify arbitrary user-supplied data. JSON.stringify throws on
 * circular structures and on objects with toJSON methods that throw —
 * callers into the logger must never have their requests killed by a
 * logging call, so on failure we fall back to a stable placeholder.
 *
 * Used for stderr payload rendering (RL3). The NDJSON file path already
 * wraps JSON.stringify in the writeToFile try/catch block.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return UNSERIALIZABLE_PLACEHOLDER;
  }
}

/**
 * Sanitize a scope field (module/operation) for stderr interpolation (RL4).
 *
 * Callers of the logger can pass attacker-influenced strings into module
 * or operation (tool names, provider IDs, error categories bound at
 * integration time). The stderr layout `[BRUTALIST MCP] LEVEL [m/o]:`
 * is a flat line format, so a `\n` in a scope field forges a second
 * log record, a `\x1b` injects ANSI escapes, and `]` breaks the
 * delimiter. This function strips/escapes those characters and caps
 * length to bound the attack surface.
 *
 * Applied ONLY at the stderr emission path — the NDJSON file record
 * preserves the original unescaped values because JSON.stringify
 * already escapes control characters safely.
 *
 * RL4-extension (Cycle 6): also escape C1 control chars (0x80–0x9f),
 * notably U+009B CSI which some terminals interpret as an ANSI control
 * introducer without a literal ESC byte.
 *
 * RL6 (Cycle 6): also escape `%`. The returned string becomes the first
 * argument to `console.error`, which Node's `util.format` treats as a
 * format string — `%j`/`%s`/`%d`/`%o` would consume subsequent
 * arguments. Doubling `%` as `%%` is the standard `util.format` escape.
 *
 * RL7 (Cycle 6): defense-in-depth — accept null/undefined (returns '')
 * so an upstream merge bug that propagates undefined through scope
 * cannot crash the logger when the caller is in an error handler.
 */
function sanitizeScopeForStderr(value: string | null | undefined): string {
  // RL7: defense-in-depth null/undefined guard — never throw from inside
  // the logger because of a bad scope field (loggers run in error handlers).
  if (value == null) return '';
  // Replace CR, LF, tab, ESC, and other C0 control chars (0x00-0x1f, 0x7f)
  // and C1 control chars (0x80-0x9f) plus the ']' delimiter and `%`. Using
  // explicit replacements so escapes stay visible rather than silently
  // dropped.
  let sanitized = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === ']') {
      sanitized += '\\]';
    } else if (ch === '%') {
      // RL6: escape per util.format convention so the prefix string
      // cannot be interpreted as a format spec when used as the first
      // arg to console.error.
      sanitized += '%%';
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      // Escape as \xHH so operators can see what was there.
      // C0 (0x00-0x1f), DEL (0x7f), and C1 (0x80-0x9f) all hex-escaped —
      // C1 includes U+009B CSI which several terminals treat as an
      // ANSI control introducer without a literal ESC.
      sanitized += '\\x' + code.toString(16).padStart(2, '0');
    } else {
      sanitized += ch;
    }
  }
  if (sanitized.length > STDERR_SCOPE_MAX_LEN) {
    sanitized = sanitized.slice(0, STDERR_SCOPE_MAX_LEN);
  }
  return sanitized;
}

/**
 * Sanitize the caller-provided `message` and string error payloads before
 * they hit `console.error` (RL5, Cycle 6).
 *
 * RL4 closed the scope-field injection vector at `stderrPrefix`, but the
 * `message` argument restored by RL1 (and the string-error payload in
 * `emitError`) is a parallel raw channel into stderr. Without
 * sanitization, a `message` containing `\n[BRUTALIST MCP] ERROR ...`
 * forges an additional stderr line that downstream log scrapers will
 * parse as a separate record.
 *
 * Distinct from `sanitizeScopeForStderr`:
 *  - No length cap — messages are intentionally free-form text and
 *    operators rely on full-message visibility for triage.
 *  - No `]` escape — `]` is not a delimiter inside the message body.
 *  - No `%` escape — `message` is the SECOND console.error argument and
 *    is never treated as a format string (RL6 handles the prefix, which
 *    is the only arg position where util.format parses specifiers).
 *  - CR/LF replaced with visible `\n` / `\r` rather than `\xHH` because
 *    these are by far the most common chars in a message body and the
 *    short escape keeps the stderr line readable.
 *  - Other C0 controls and DEL hex-escaped; C1 controls hex-escaped
 *    (parity with `sanitizeScopeForStderr`).
 */
function sanitizeMessageForStderr(value: string | null | undefined): string {
  if (value == null) return '';
  let sanitized = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '\n') {
      sanitized += '\\n';
    } else if (ch === '\r') {
      sanitized += '\\r';
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      sanitized += '\\x' + code.toString(16).padStart(2, '0');
    } else {
      sanitized += ch;
    }
  }
  return sanitized;
}

/**
 * Scope carried by a child logger produced via `logger.for({module, operation})`.
 * Both fields are required when a child is created — the factory is the
 * single way to bind them, which makes their presence easy to grep for.
 */
export interface LogScope {
  module: string;
  operation: string;
}

/**
 * Public logger API surface. Both the root `Logger` and the child
 * `ScopedLogger` satisfy this shape so call sites can accept either
 * without widening to `any`.
 *
 * RL8 (Cycle 6): `for()` accepts `Partial<LogScope>` and `forOperation`
 * is part of the contract. The integration phase will inject
 * `StructuredLogger`-typed dependencies (DebateOrchestrator,
 * CLIAgentOrchestrator); both ergonomic shorthands need to be callable
 * without downcasting to the concrete `ScopedLogger`. Method parameter
 * types are contravariant — `Partial<LogScope>` is wider than
 * `LogScope`, so `ScopedLogger` (whose `for` accepts `Partial<LogScope>`)
 * still satisfies a stricter override that wants the same.
 *
 * The root `Logger.for` takes a stricter `LogScope` at the implementation
 * level (no parent scope to inherit from) but its declared signature is
 * widened here too — root callers that pass a partial scope will receive
 * a runtime error from the root impl, which is the documented contract:
 * the root logger has no defaults to fall back on.
 */
export interface StructuredLogger {
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, error?: Error | any): void;
  debug(message: string, data?: any): void;
  for(scope: Partial<LogScope>): ScopedLogger;
  forOperation(operation: string): ScopedLogger;
}

export class Logger implements StructuredLogger {
  private static instance: Logger;
  private debugMode: boolean;

  // File logging state
  private fileEnabled: boolean = false;
  private logDir: string = '';
  private logFilePath: string = '';
  private maxFileSize: number = 5 * 1024 * 1024; // 5 MB
  private maxFiles: number = 3;
  private fileLogLevel: number = LOG_LEVELS.info;
  private currentFileSize: number = 0;
  private rotating: boolean = false;
  private pid: number = process.pid;

  private constructor() {
    this.debugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
    this.initFileLogging();
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  // ---------------------------------------------------------------------------
  // Public API — unchanged signatures, all call sites continue to work
  // ---------------------------------------------------------------------------

  info(message: string, data?: any): void {
    this.emit('info', message, data);
  }

  warn(message: string, data?: any): void {
    this.emit('warn', message, data);
  }

  error(message: string, error?: Error | any): void {
    this.emitError(message, error);
  }

  debug(message: string, data?: any): void {
    this.emit('debug', message, data);
  }

  /**
   * Produce a child logger that binds `module` and `operation` to every
   * record it emits. Child loggers delegate to the same file + stderr
   * pipeline as the root, so `BRUTALIST_LOG_LEVEL`, `DEBUG`, and
   * `shutdown()` behavior are shared.
   *
   * Callers should bind once per subsystem scope (e.g., in a class
   * constructor) and reuse the returned logger, rather than creating a
   * new child per call.
   *
   * RL8 (Cycle 6): signature accepts `Partial<LogScope>` to match the
   * `StructuredLogger` interface, but the root `Logger` has no parent
   * scope to inherit from — both `module` and `operation` must be
   * provided. A missing field throws so that an integration-phase
   * caller cannot silently produce a child with `undefined` fields
   * (which would defeat the structured-logging guarantee).
   */
  for(scope: Partial<LogScope>): ScopedLogger {
    if (!scope.module || !scope.operation) {
      throw new Error(
        `Logger.for() requires both module and operation at the root ` +
        `(no parent scope to inherit from). Got module=${JSON.stringify(scope.module)} ` +
        `operation=${JSON.stringify(scope.operation)}.`
      );
    }
    return new ScopedLogger(this, { module: scope.module, operation: scope.operation });
  }

  /**
   * Root-level `forOperation` is intentionally a thrower: there is no
   * parent module to inherit from, so the resulting child would have
   * `module=undefined`. Use `logger.for({ module, operation })` to bind
   * the scope at the root and `child.forOperation(op)` thereafter.
   *
   * This exists on the interface (RL8) so that DI-typed dependencies
   * can call `forOperation` after they have been narrowed once. Calling
   * it on the bare root logger is a programming error.
   */
  forOperation(_operation: string): ScopedLogger {
    throw new Error(
      `Logger.forOperation() cannot be called on the root logger — ` +
      `bind a module first via logger.for({ module, operation }).`
    );
  }

  /** No-op kept for API compatibility. Writes are synchronous, nothing to flush. */
  shutdown(): void {
    // All writes use appendFileSync — every line is already on disk.
  }

  // ---------------------------------------------------------------------------
  // Internal emit pipeline — shared by root methods and ScopedLogger
  // ---------------------------------------------------------------------------

  /**
   * Emit a non-error record. Private so that the only externally visible
   * methods keep their original signatures.
   *
   * Stderr layout (RL1): `{prefix} {message}` followed by the serialized
   * data when present. The message text must appear on stderr — it is
   * the guaranteed operational sink since file logging is opt-in via
   * BRUTALIST_LOG_FILE=true.
   *
   * RL5/RL6 (Cycle 6): the prefix is sanitized for `%` (RL6) by
   * `sanitizeScopeForStderr` so it cannot drive `util.format` substitution
   * even though it is the first console.error argument. The caller-
   * supplied `message` is sanitized via `sanitizeMessageForStderr`
   * (RL5) so CR/LF in `message` cannot forge a second log line. The
   * NDJSON file path receives the ORIGINAL `message` and `data`
   * because JSON.stringify already escapes control chars safely.
   */
  /** @internal */
  emit(level: LogLevel, message: string, data?: any, scope?: LogScope): void {
    const prefix = this.stderrPrefix(level, scope);
    const safeMessage = sanitizeMessageForStderr(message);
    // RL3: safeStringify guards against circular structures and toJSON
    // throws. If data is absent we pass through the empty string to
    // preserve the two-argument call shape tests assert against.
    //
    // RL9 (Cycle 8): JSON.stringify escapes C0 (0x00-0x1f) natively but
    // does NOT escape C1 controls (0x80-0x9f) — those emit as raw UTF-8
    // bytes. Several terminals interpret U+009B CSI as an ANSI control
    // introducer without a literal ESC. Pipe the stringified payload
    // through `sanitizeMessageForStderr` so C1 bytes are hex-escaped
    // before they reach `console.error`. The NDJSON file path below
    // still receives the ORIGINAL `data` object (unsanitized) — parity
    // with the RL4/RL5 stderr-vs-file split: operators consume files
    // with jq/grep, raw bytes are tool-safe there; stderr is the
    // channel terminals render.
    const payload = data !== undefined
      ? sanitizeMessageForStderr(safeStringify(data))
      : '';
    if (level === 'debug') {
      if (this.debugMode) {
        console.error(prefix, safeMessage, payload);
      }
    } else {
      console.error(prefix, safeMessage, payload);
    }
    this.writeToFile(level, message, data, scope);
  }

  /**
   * Emit an error record. Splits stderr vs file formatting the same way
   * the original `error()` did — Error instances get `.message` on
   * stderr and the full shape in the NDJSON record.
   *
   * Stderr layout (RL1): `{prefix} {message} {error.message|payload}`.
   * The caller-supplied `message` must appear alongside the error detail
   * so the human-readable line is symmetric with emit().
   *
   * RL5 (Cycle 6): both the caller-supplied `message` and the string
   * forms of the error payload (`Error.message` and string error
   * arguments) are passed through `sanitizeMessageForStderr` before
   * `console.error`. CR/LF in either field would otherwise forge a
   * second stderr log line. Non-Error object payloads go through
   * `safeStringify` (RL3) and JSON.stringify already escapes control
   * chars, so they are stderr-safe without further sanitization.
   *
   * The file path (`writeToFile`) receives the ORIGINAL `message` and
   * the structured `fileData` shape so NDJSON consumers see the raw
   * values that were logged (JSON.stringify handles control char
   * escaping safely on the file side).
   */
  /** @internal */
  emitError(message: string, error?: Error | any, scope?: LogScope): void {
    const prefix = this.stderrPrefix('error', scope);
    // RL3: Error.message is always a string so JSON stringify is not
    // invoked. For non-Error payloads we safeStringify defensively,
    // since error?: any permits arbitrary user-supplied objects.
    let errPayload: string;
    if (error instanceof Error) {
      // RL5: Error.message can carry user-controlled CR/LF (e.g., a
      // remote API error message echoed back into an exception).
      errPayload = sanitizeMessageForStderr(error.message);
    } else if (error === undefined) {
      errPayload = '';
    } else if (typeof error === 'string') {
      // RL5: string error payloads are also raw caller input.
      errPayload = sanitizeMessageForStderr(error);
    } else {
      // RL9 (Cycle 8): JSON.stringify escapes C0 but NOT C1 controls
      // (0x80-0x9f). Non-Error object payloads reach stderr via
      // safeStringify, so an attacker-controlled object field like
      // { csi: '\u009b2J' } would render raw bytes that some
      // terminals interpret as ANSI control introducers without a
      // literal ESC. Pipe the JSON through `sanitizeMessageForStderr`
      // to hex-escape C1 (and any stray C0/DEL) before the byte
      // hits `console.error`. File-side NDJSON below still receives
      // the ORIGINAL `fileData` object — stderr-vs-file parity.
      errPayload = sanitizeMessageForStderr(safeStringify(error));
    }
    const safeMessage = sanitizeMessageForStderr(message);
    console.error(prefix, safeMessage, errPayload);
    if (this.debugMode && error instanceof Error && error.stack) {
      // Stack traces include filenames and line numbers from the runtime
      // and are intentionally multi-line — sanitizing them would defeat
      // operator triage. The debug-mode gate is acceptable because the
      // stack is only emitted in DEBUG=true, an operator-controlled path.
      console.error(error.stack);
    }
    const fileData = error instanceof Error
      ? { message: error.message, stack: error.stack, name: error.name }
      : error;
    this.writeToFile('error', message, fileData, scope);
  }

  private stderrPrefix(level: LogLevel, scope?: LogScope): string {
    const upper = level.toUpperCase();
    if (scope) {
      // Human-readable tag — keeps the original `[BRUTALIST MCP] LEVEL:`
      // prefix so log scrapers still match, but adds `[module/operation]`
      // so the subsystem is visible without parsing NDJSON.
      // RL4: sanitize scope fields against CR/LF/ANSI/tab/control-char
      // injection. The NDJSON file record preserves the originals.
      const mod = sanitizeScopeForStderr(scope.module);
      const op = sanitizeScopeForStderr(scope.operation);
      return `[BRUTALIST MCP] ${upper} [${mod}/${op}]:`;
    }
    return `[BRUTALIST MCP] ${upper}:`;
  }

  // ---------------------------------------------------------------------------
  // File logging internals
  // ---------------------------------------------------------------------------

  private initFileLogging(): void {
    const enabled = process.env.BRUTALIST_LOG_FILE === 'true';
    const isSubprocess = process.env.BRUTALIST_SUBPROCESS === '1';

    if (!enabled || isSubprocess) return;

    try {
      this.logDir = process.env.BRUTALIST_LOG_DIR
        || join(homedir(), '.brutalist-mcp', 'logs');

      const maxSizeMB = Number(process.env.BRUTALIST_LOG_MAX_SIZE) || 5;
      this.maxFileSize = maxSizeMB * 1024 * 1024;
      this.maxFiles = Number(process.env.BRUTALIST_LOG_MAX_FILES) || 3;

      const levelStr = (process.env.BRUTALIST_LOG_LEVEL || 'info').toLowerCase();
      this.fileLogLevel = LOG_LEVELS[levelStr as LogLevel] ?? LOG_LEVELS.info;

      // Ensure directory exists
      mkdirSync(this.logDir, { recursive: true });

      this.logFilePath = join(this.logDir, LOG_FILENAME);

      // Measure existing file so we rotate correctly
      if (existsSync(this.logFilePath)) {
        try {
          this.currentFileSize = statSync(this.logFilePath).size;
        } catch {
          this.currentFileSize = 0;
        }
      } else {
        // Touch the file so appendFileSync doesn't fail on first write
        const fd = openSync(this.logFilePath, 'a');
        closeSync(fd);
      }

      this.fileEnabled = true;
    } catch (err) {
      // Never let logging prevent the server from starting
      console.error(
        `[BRUTALIST MCP] WARN: File logging init failed: ${err instanceof Error ? err.message : err}`
      );
      this.fileEnabled = false;
    }
  }

  private writeToFile(level: LogLevel, message: string, data?: any, scope?: LogScope): void {
    if (!this.fileEnabled) return;
    if (LOG_LEVELS[level] < this.fileLogLevel) return;

    try {
      // Field order is stable for operators grepping NDJSON:
      // ts → level → module → operation → msg → data → pid.
      // `module`/`operation` are omitted entirely when no scope is bound
      // so pre-migration call sites produce exactly the same record as
      // before.
      const entry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        ...(scope && { module: scope.module, operation: scope.operation }),
        msg: message,
        ...(data !== undefined && { data }),
        pid: this.pid
      };

      const line = JSON.stringify(entry) + '\n';
      const lineBytes = Buffer.byteLength(line);

      // Rotate before writing if this line would exceed the cap
      if (this.currentFileSize + lineBytes > this.maxFileSize) {
        this.rotate();
      }

      appendFileSync(this.logFilePath, line);
      this.currentFileSize += lineBytes;
    } catch {
      this.disableFileLogging('write failure');
    }
  }

  /**
   * Size-based ring rotation.
   *
   * brutalist.log       → brutalist.1.log
   * brutalist.1.log     → brutalist.2.log
   * …
   * brutalist.{max}.log → deleted
   */
  private rotate(): void {
    if (this.rotating) return;
    this.rotating = true;

    try {
      // Shift existing rotated files
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = join(this.logDir, `brutalist.${i}.log`);
        const dst = join(this.logDir, `brutalist.${i + 1}.log`);
        if (existsSync(src)) {
          renameSync(src, dst);
        }
      }

      // Drop the oldest file if it exists
      const oldest = join(this.logDir, `brutalist.${this.maxFiles}.log`);
      if (existsSync(oldest)) {
        unlinkSync(oldest);
      }

      // Current → .1
      if (existsSync(this.logFilePath)) {
        renameSync(this.logFilePath, join(this.logDir, 'brutalist.1.log'));
      }

      this.currentFileSize = 0;
    } catch (err) {
      this.disableFileLogging(`rotation failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.rotating = false;
    }
  }

  private disableFileLogging(reason: string): void {
    if (!this.fileEnabled) return;
    this.fileEnabled = false;
    console.error(`[BRUTALIST MCP] WARN: File logging disabled (${reason})`);
  }
}

/**
 * Scoped child logger returned by `Logger.for(...)`. Binds `module` and
 * `operation` to every record so integration-time call sites only need
 * to create the child once per subsystem, not thread the scope through
 * every call.
 *
 * Delegates to the root Logger for the actual stderr + file write so
 * all env-var behavior (BRUTALIST_LOG_LEVEL, DEBUG, BRUTALIST_LOG_FILE,
 * rotation, shutdown) is shared and there is no duplicated pipeline.
 */
export class ScopedLogger implements StructuredLogger {
  constructor(
    private readonly root: Logger,
    private readonly scope: LogScope
  ) {}

  info(message: string, data?: any): void {
    this.root.emit('info', message, data, this.scope);
  }

  warn(message: string, data?: any): void {
    this.root.emit('warn', message, data, this.scope);
  }

  error(message: string, error?: Error | any): void {
    this.root.emitError(message, error, this.scope);
  }

  debug(message: string, data?: any): void {
    this.root.emit('debug', message, data, this.scope);
  }

  /**
   * Narrow an existing scoped logger to a new operation while preserving
   * the bound module (RL2). Accepts a partial scope so common usage like
   * `.for({ operation: 'orchestrateRound' })` keeps the class-bound
   * module and only overrides the operation. Passing both fields fully
   * replaces the scope — making renaming the module explicit.
   *
   * Resolution (a): module is preserved by default. This is the shape
   * integrate_observability will consume — bind module at the class
   * level, bind operation per method — so typo'd modules across call
   * sites can't split log streams.
   *
   * Method parameter type is `Partial<LogScope>` which is wider than
   * `LogScope` (every `LogScope` is assignable to `Partial<LogScope>`),
   * so this override still satisfies the `StructuredLogger.for`
   * contract — method parameters are contravariant.
   *
   * RL7 (Cycle 6): explicit `undefined` is filtered so it does not
   * overwrite parent fields. The previous `??` form already handled
   * undefined in the override expression, but a caller writing
   * `.for({ module: undefined, operation: 'x' })` would still produce
   * `module: this.scope.module` (correct) — and the same caller writing
   * `.for({ module: undefined })` correctly preserves the parent. The
   * defense-in-depth here is making the intent explicit so future
   * refactors that switch to `Object.assign`-style merge can't silently
   * regress, and so `null` is also handled (TypeScript allows `null`
   * to satisfy an optional field if `strictNullChecks` is off in some
   * consumer). `sanitizeScopeForStderr` also has a null/undefined
   * guard for paranoid defense.
   */
  for(scope: Partial<LogScope>): ScopedLogger {
    const nextModule = scope.module != null ? scope.module : this.scope.module;
    const nextOperation = scope.operation != null ? scope.operation : this.scope.operation;
    return new ScopedLogger(this.root, {
      module: nextModule,
      operation: nextOperation,
    });
  }

  /**
   * Grep-friendly shorthand for the common pattern of binding module
   * at class construction and narrowing by operation per method (RL2).
   * Equivalent to `.for({ operation })` but more discoverable and
   * avoids accidental `.for({ module })` typos stripping the operation.
   */
  forOperation(operation: string): ScopedLogger {
    return new ScopedLogger(this.root, {
      module: this.scope.module,
      operation,
    });
  }
}

export const logger = Logger.getInstance();
