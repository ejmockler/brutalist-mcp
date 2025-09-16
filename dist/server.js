import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { promisify } from "util";
import { exec } from "child_process";
import { z } from "zod";
import { Readable } from "stream";
const execAsync = promisify(exec);
export class GeminiServer {
    server;
    config;
    AVAILABLE_MODELS = [
        { name: "gemini-2.5-flash", description: "Latest Gemini 2.5 Flash model", available: true },
        { name: "gemini-1.5-pro", description: "Gemini 1.5 Pro model", available: true },
        { name: "gemini-1.5-flash", description: "Gemini 1.5 Flash model", available: true },
        { name: "gemini-pro", description: "Classic Gemini Pro model", available: true }
    ];
    constructor(config = {}) {
        this.config = {
            defaultModel: "gemini-2.5-flash",
            geminiPath: "gemini",
            ...config
        };
        this.server = new McpServer({
            name: "gemini-mcp-server",
            version: "1.0.0",
            capabilities: {
                tools: {}
            }
        });
        this.registerTools();
    }
    async start() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Gemini MCP Server started successfully");
    }
    registerTools() {
        // Tool to execute Gemini prompts
        this.server.tool("gemini_prompt", "Execute a prompt using the Gemini CLI with specified model and options", {
            prompt: z.string().describe("The prompt to send to Gemini"),
            model: z.string().optional().describe("Gemini model to use (gemini-2.5-flash, gemini-1.5-pro, gemini-1.5-flash, gemini-pro)"),
            sandbox: z.boolean().optional().describe("Run in sandbox mode"),
            debug: z.boolean().optional().describe("Enable debug mode"),
            yolo: z.boolean().optional().describe("Auto-accept all actions (YOLO mode)"),
            approvalMode: z.enum(["default", "auto_edit", "yolo"]).optional().describe("Set approval mode"),
            cwd: z.string().optional().describe("Working directory for Gemini to operate in")
        }, async (args) => {
            try {
                const result = await this.executeGeminiPrompt({
                    prompt: args.prompt,
                    model: args.model || this.config.defaultModel,
                    sandbox: args.sandbox,
                    debug: args.debug,
                    yolo: args.yolo,
                    approvalMode: args.approvalMode,
                    cwd: args.cwd
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: result.success
                                ? `Model: ${result.model || 'default'}\n\n${result.output}`
                                : `Error: ${result.error}`
                        }
                    ]
                };
            }
            catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        });
        // Tool to list available models
        this.server.tool("gemini_models", "List available Gemini models and their information", {}, async () => {
            const modelsList = this.AVAILABLE_MODELS.map(model => `${model.name}: ${model.description} (${model.available ? 'Available' : 'Unavailable'})`).join('\n');
            return {
                content: [
                    {
                        type: "text",
                        text: `Available Gemini Models:\n\n${modelsList}`
                    }
                ]
            };
        });
        // Tool to process input data through Gemini
        this.server.tool("gemini_with_stdin", "Process input data through Gemini with a prompt", {
            inputData: z.string().describe("Input data to process"),
            prompt: z.string().describe("Prompt to apply to the input data"),
            model: z.string().optional().describe("Gemini model to use"),
            sandbox: z.boolean().optional().describe("Run in sandbox mode"),
            cwd: z.string().optional().describe("Working directory for Gemini to operate in")
        }, async (args) => {
            try {
                const result = await this.executeGeminiPrompt({
                    prompt: args.prompt,
                    model: args.model || this.config.defaultModel,
                    inputData: args.inputData,
                    sandbox: args.sandbox,
                    cwd: args.cwd
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: result.success
                                ? `Model: ${result.model || 'default'}\n\nInput processed with prompt: "${args.prompt}"\n\nResult:\n${result.output}`
                                : `Error: ${result.error}`
                        }
                    ]
                };
            }
            catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        });
        // Tool to check Gemini CLI availability
        this.server.tool("gemini_status", "Check if Gemini CLI is available and configured", {}, async () => {
            try {
                const { stdout } = await execAsync(`${this.config.geminiPath} --version`);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Gemini CLI Status: Available\nVersion: ${stdout.trim()}\nPath: ${this.config.geminiPath}`
                        }
                    ]
                };
            }
            catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Gemini CLI Status: Unavailable\nError: ${error instanceof Error ? error.message : String(error)}\nChecked path: ${this.config.geminiPath}`
                        }
                    ]
                };
            }
        });
        // Tool for JSON output
        this.server.tool("gemini_json", "Execute prompt and get structured JSON response", {
            prompt: z.string().describe("The prompt to send to Gemini"),
            model: z.string().optional().describe("Gemini model to use"),
            schema: z.object({}).passthrough().optional().describe("Expected JSON schema for validation"),
            cwd: z.string().optional().describe("Working directory")
        }, async (args) => {
            try {
                const result = await this.executeGeminiPrompt({
                    prompt: args.prompt,
                    model: args.model || this.config.defaultModel,
                    outputFormat: 'json',
                    cwd: args.cwd
                });
                if (!result.success) {
                    return {
                        content: [{ type: "text", text: `Error: ${result.error}` }]
                    };
                }
                try {
                    const jsonOutput = JSON.parse(result.output || '{}');
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(jsonOutput, null, 2)
                            }
                        ]
                    };
                }
                catch (parseError) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Failed to parse JSON response: ${result.output}`
                            }
                        ]
                    };
                }
            }
            catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        });
        // Tool for multi-directory support
        this.server.tool("gemini_directories", "Run Gemini with access to multiple directories", {
            directories: z.array(z.string()).describe("List of directories to include"),
            prompt: z.string().describe("Prompt to execute"),
            model: z.string().optional().describe("Model to use")
        }, async (args) => {
            try {
                const result = await this.executeGeminiPrompt({
                    prompt: args.prompt,
                    model: args.model || this.config.defaultModel,
                    includeDirectories: args.directories
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: result.success
                                ? `Executed with ${args.directories.length} directories:\n${result.output}`
                                : `Error: ${result.error}`
                        }
                    ]
                };
            }
            catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ]
                };
            }
        });
    }
    async executeGeminiPrompt(options) {
        return new Promise((resolve) => {
            const args = [];
            // Add model if specified
            if (options.model) {
                args.push("-m", options.model);
            }
            // Add flags
            if (options.sandbox) {
                args.push("--sandbox");
            }
            if (options.debug) {
                args.push("--debug");
            }
            if (options.yolo) {
                args.push("--yolo");
            }
            if (options.approvalMode) {
                args.push("--approval-mode", options.approvalMode);
            }
            if (options.checkpointing) {
                args.push("--checkpointing");
            }
            if (options.sessionSummary) {
                args.push("--session-summary", options.sessionSummary);
            }
            if (options.includeDirectories && options.includeDirectories.length > 0) {
                args.push("--include-directories", options.includeDirectories.join(","));
            }
            if (options.outputFormat) {
                args.push("--output-format", options.outputFormat);
            }
            if (options.nonInteractive) {
                args.push("--non-interactive");
            }
            // Add prompt as the last argument
            args.push("-p", options.prompt);
            // Spawn the Gemini process
            const geminiProcess = spawn(this.config.geminiPath || 'gemini', args, {
                cwd: options.cwd || process.cwd(),
                env: process.env
            });
            let stdout = '';
            let stderr = '';
            // If we have input data, pipe it to stdin
            if (options.inputData) {
                const inputStream = Readable.from(options.inputData);
                inputStream.pipe(geminiProcess.stdin);
            }
            else {
                // Close stdin immediately if no input
                geminiProcess.stdin.end();
            }
            // Collect stdout
            geminiProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            // Collect stderr
            geminiProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            // Handle process completion
            geminiProcess.on('close', (code) => {
                // Check for actual errors (ignore "Loaded cached credentials")
                if (code !== 0 && !stderr.includes('Loaded cached credentials')) {
                    resolve({
                        success: false,
                        error: `Process exited with code ${code}: ${stderr}`,
                        model: options.model
                    });
                    return;
                }
                // Check for errors in stderr
                if (stderr && stderr.includes('Error') && !stderr.includes('Loaded cached credentials')) {
                    resolve({
                        success: false,
                        error: stderr,
                        model: options.model
                    });
                    return;
                }
                resolve({
                    success: true,
                    output: stdout.trim(),
                    model: options.model
                });
            });
            // Handle spawn errors
            geminiProcess.on('error', (error) => {
                let errorMessage = error.message;
                if (error.code === 'ENOENT') {
                    errorMessage = `Gemini CLI not found at path: ${this.config.geminiPath}`;
                }
                resolve({
                    success: false,
                    error: errorMessage,
                    model: options.model
                });
            });
        });
    }
}
//# sourceMappingURL=server.js.map