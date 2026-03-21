#!/usr/bin/env node

import { BrutalistServer } from './brutalist-server.js';
import { logger } from './logger.js';

// Graceful shutdown on stdio disconnect — the MCP SDK throws "Not connected"
// when the parent process closes the pipe. This is normal during shutdown.
process.on('uncaughtException', (error) => {
  if (error.message === 'Not connected') {
    logger.shutdown();
    process.exit(0);
  }
  console.error("Uncaught exception:", error instanceof Error ? error.message : String(error));
  logger.shutdown();
  process.exit(1);
});

async function main() {
  try {
    // Check if HTTP mode is requested via environment variable or command line
    const useHttp = process.env.BRUTALIST_HTTP === 'true' || process.argv.includes('--http');
    const port = process.env.BRUTALIST_PORT ? parseInt(process.env.BRUTALIST_PORT) : 3000;

    const server = new BrutalistServer({
      transport: useHttp ? 'http' : 'stdio',
      httpPort: port
    });

    if (useHttp) {
      console.log(`Starting Brutalist MCP with HTTP streaming on port ${port}`);
      console.log('Set BRUTALIST_HTTP=true or use --http flag for HTTP mode');
    }

    await server.start();
  } catch (error) {
    console.error("Fatal error:", error instanceof Error ? error.message : String(error));
    logger.shutdown();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled exception:", error instanceof Error ? error.message : String(error));
  logger.shutdown();
  process.exit(1);
});