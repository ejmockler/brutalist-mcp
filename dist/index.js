#!/usr/bin/env node
import { BrutalistServer } from './brutalist-server.js';
async function main() {
    try {
        // CRITICAL: Prevent recursion - refuse to start if we're in a brutalist subprocess
        if (process.env.BRUTALIST_SUBPROCESS === '1') {
            console.error("ERROR: Brutalist MCP cannot be used from within a brutalist-spawned CLI subprocess (recursion prevented)");
            process.exit(1);
        }
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
    }
    catch (error) {
        console.error("Fatal error:", error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
main().catch((error) => {
    console.error("Unhandled exception:", error instanceof Error ? error.message : String(error));
    process.exit(1);
});
//# sourceMappingURL=index.js.map