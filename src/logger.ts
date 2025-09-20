export class Logger {
  private static instance: Logger;
  private debugMode: boolean;

  private constructor() {
    this.debugMode = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  info(message: string, data?: any) {
    console.log(`[BRUTALIST MCP] INFO: ${message}`, data ? JSON.stringify(data) : '');
  }

  warn(message: string, data?: any) {
    console.error(`[BRUTALIST MCP] WARN: ${message}`, data ? JSON.stringify(data) : '');
  }

  error(message: string, error?: Error | any) {
    console.error(`[BRUTALIST MCP] ERROR: ${message}`, error instanceof Error ? error.message : error);
    if (this.debugMode && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  }

  debug(message: string, data?: any) {
    if (this.debugMode) {
      console.log(`[BRUTALIST MCP] DEBUG: ${message}`, data ? JSON.stringify(data) : '');
    }
  }
}

export const logger = Logger.getInstance();