#!/usr/bin/env node

import { GeminiServer } from './server.js';

async function main() {
  try {
    const server = new GeminiServer();
    await server.start();
  } catch (error) {
    console.error("Fatal error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled exception:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});