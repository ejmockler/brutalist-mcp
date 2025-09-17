#!/usr/bin/env node
import { BrutalistServer } from './brutalist-server.js';
async function main() {
    try {
        const server = new BrutalistServer();
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