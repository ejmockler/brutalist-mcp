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
declare const LOG_LEVELS: {
    readonly debug: 0;
    readonly info: 1;
    readonly warn: 2;
    readonly error: 3;
};
type LogLevel = keyof typeof LOG_LEVELS;
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
export declare class Logger implements StructuredLogger {
    private static instance;
    private debugMode;
    private fileEnabled;
    private logDir;
    private logFilePath;
    private maxFileSize;
    private maxFiles;
    private fileLogLevel;
    private currentFileSize;
    private rotating;
    private pid;
    private constructor();
    static getInstance(): Logger;
    info(message: string, data?: any): void;
    warn(message: string, data?: any): void;
    error(message: string, error?: Error | any): void;
    debug(message: string, data?: any): void;
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
    for(scope: Partial<LogScope>): ScopedLogger;
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
    forOperation(_operation: string): ScopedLogger;
    /** No-op kept for API compatibility. Writes are synchronous, nothing to flush. */
    shutdown(): void;
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
    emit(level: LogLevel, message: string, data?: any, scope?: LogScope): void;
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
    emitError(message: string, error?: Error | any, scope?: LogScope): void;
    private stderrPrefix;
    private initFileLogging;
    private writeToFile;
    /**
     * Size-based ring rotation.
     *
     * brutalist.log       → brutalist.1.log
     * brutalist.1.log     → brutalist.2.log
     * …
     * brutalist.{max}.log → deleted
     */
    private rotate;
    private disableFileLogging;
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
export declare class ScopedLogger implements StructuredLogger {
    private readonly root;
    private readonly scope;
    constructor(root: Logger, scope: LogScope);
    info(message: string, data?: any): void;
    warn(message: string, data?: any): void;
    error(message: string, error?: Error | any): void;
    debug(message: string, data?: any): void;
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
    for(scope: Partial<LogScope>): ScopedLogger;
    /**
     * Grep-friendly shorthand for the common pattern of binding module
     * at class construction and narrowing by operation per method (RL2).
     * Equivalent to `.for({ operation })` but more discoverable and
     * avoids accidental `.for({ module })` typos stripping the operation.
     */
    forOperation(operation: string): ScopedLogger;
}
export declare const logger: Logger;
export {};
//# sourceMappingURL=logger.d.ts.map