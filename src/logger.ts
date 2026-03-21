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
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const LOG_FILENAME = 'brutalist.log';

export class Logger {
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
    console.error(`[BRUTALIST MCP] INFO: ${message}`, data ? JSON.stringify(data) : '');
    this.writeToFile('info', message, data);
  }

  warn(message: string, data?: any): void {
    console.error(`[BRUTALIST MCP] WARN: ${message}`, data ? JSON.stringify(data) : '');
    this.writeToFile('warn', message, data);
  }

  error(message: string, error?: Error | any): void {
    console.error(
      `[BRUTALIST MCP] ERROR: ${message}`,
      error instanceof Error ? error.message : error
    );
    if (this.debugMode && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    // File output always gets the full error shape for post-mortem debugging
    const fileData = error instanceof Error
      ? { message: error.message, stack: error.stack, name: error.name }
      : error;
    this.writeToFile('error', message, fileData);
  }

  debug(message: string, data?: any): void {
    if (this.debugMode) {
      console.error(`[BRUTALIST MCP] DEBUG: ${message}`, data ? JSON.stringify(data) : '');
    }
    // File always receives debug lines if the configured level allows it,
    // regardless of the stderr debug gate
    this.writeToFile('debug', message, data);
  }

  /** No-op kept for API compatibility. Writes are synchronous, nothing to flush. */
  shutdown(): void {
    // All writes use appendFileSync — every line is already on disk.
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

  private writeToFile(level: LogLevel, message: string, data?: any): void {
    if (!this.fileEnabled) return;
    if (LOG_LEVELS[level] < this.fileLogLevel) return;

    try {
      const entry = {
        ts: new Date().toISOString(),
        level,
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

export const logger = Logger.getInstance();
