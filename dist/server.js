import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
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
    }
    async executeGeminiPrompt(options) {
        // Build command arguments array (no quotes needed with execFile)
        const args = [];
        // Add model if specified
        if (options.model) {
            args.push("-m");
            args.push(options.model);
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
            args.push("--approval-mode");
            args.push(options.approvalMode);
        }
        // Add prompt
        args.push("-p");
        args.push(options.prompt);
        try {
            const execOptions = {
                timeout: 30 * 60 * 1000, // 30 minute timeout for long Gemini tasks
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large responses
                env: process.env, // Pass current environment including PATH
                cwd: options.cwd // Set working directory if specified
            };
            let result;
            // If we have input data, we need to use shell exec
            if (options.inputData) {
                // Build shell command for piping
                const escapedPrompt = options.prompt.replace(/"/g, '\\"');
                const escapedModel = options.model ? options.model.replace(/"/g, '\\"') : '';
                const escapedInput = options.inputData.replace(/"/g, '\\"');
                let command = `echo "${escapedInput}" | ${this.config.geminiPath}`;
                if (options.model) {
                    command += ` -m "${escapedModel}"`;
                }
                command += ` -p "${escapedPrompt}"`;
                result = await execAsync(command, execOptions);
            }
            else {
                // Build command with proper escaping for exec
                const escapedPrompt = options.prompt.replace(/"/g, '\\"');
                const escapedModel = options.model ? options.model.replace(/"/g, '\\"') : '';
                let command = `echo "" | ${this.config.geminiPath}`;
                if (options.model) {
                    command += ` -m "${escapedModel}"`;
                }
                command += ` -p "${escapedPrompt}"`;
                result = await execAsync(command, execOptions);
            }
            const { stdout, stderr } = result;
            // Check if there were any errors (excluding the "Loaded cached credentials" message)
            const stderrStr = String(stderr);
            if (stderrStr && stderrStr.includes('Error') && !stderrStr.includes('Loaded cached credentials')) {
                return {
                    success: false,
                    error: stderrStr,
                    model: options.model
                };
            }
            // Clean output by removing "Loaded cached credentials" if it appears
            let output = String(stdout).trim();
            // Also check if stderr has "Loaded cached credentials" and stdout has content
            if (stderrStr.includes('Loaded cached credentials') && output) {
                // Output is fine, just has the credentials message in stderr
            }
            return {
                success: true,
                output: output,
                model: options.model
            };
        }
        catch (error) {
            // Include more detailed error information
            console.error('Gemini execution error:', error);
            let errorMessage = error instanceof Error ? error.message : String(error);
            if (error.code === 'ENOENT') {
                errorMessage = `Gemini CLI not found at path: ${this.config.geminiPath}`;
            }
            else if (error.stderr) {
                errorMessage += `\nStderr: ${error.stderr}`;
            }
            else if (error.stdout) {
                errorMessage += `\nStdout: ${error.stdout}`;
            }
            return {
                success: false,
                error: errorMessage,
                model: options.model
            };
        }
    }
}
//# sourceMappingURL=server.js.map