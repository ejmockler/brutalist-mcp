# Gemini MCP Server

**Lightning-fast AI assistance at your fingertips**

Bring Google's blazing-fast Gemini Flash models directly into your CLI workflow. This MCP server transforms any tool that supports MCP (like Claude Code, Codex, or other AI assistants) into a powerful gateway to Gemini's capabilities - all running in your current working directory with full access to your files and context.

## Why This Matters

The Gemini Flash models are **ridiculously fast** - we're talking sub-second responses that make real-time AI assistance actually feel real-time. When you're deep in a coding session and need quick context, code reviews, or rapid iterations, waiting 5-10 seconds for a response breaks your flow. Gemini Flash delivers answers before you can blink.

**Perfect for:**
- 🚀 **Instant code reviews** during development
- 🔍 **Quick context gathering** from large codebases  
- ⚡ **Rapid prototyping** with AI assistance
- 🛠️ **Real-time debugging** and problem-solving
- 📊 **Fast data analysis** and processing

Unlike standalone AI tools, this MCP server gives Gemini **full CLI capabilities** - it can read your files, write code, research on the internet, and integrate seamlessly into your existing workflow without context switching.

## Features

- **gemini_prompt**: Execute prompts using Gemini CLI with model selection
- **gemini_models**: List available Gemini models and their capabilities  
- **gemini_with_stdin**: Process input data through Gemini with prompts
- **gemini_status**: Check Gemini CLI availability and configuration

## Real-World Workflow

Imagine you're working in Claude Code and hit a complex bug. Instead of switching contexts, you simply ask Claude Code to "use Gemini to analyze this error pattern across the codebase." Within seconds, Gemini Flash:

1. **Scans your entire project** for similar patterns
2. **Identifies root causes** with its blazing speed  
3. **Suggests fixes** based on your specific codebase
4. **Writes the code** directly in your editor

All without leaving your terminal or waiting more than a second for responses.

## Available Models

- `gemini-2.5-flash`: Latest Gemini 2.5 Flash model ⚡ **Recommended for speed**
- `gemini-1.5-pro`: Gemini 1.5 Pro model (more capable, slower)
- `gemini-1.5-flash`: Gemini 1.5 Flash model ⚡ **Great balance of speed/quality**
- `gemini-pro`: Classic Gemini Pro model

## Quick Setup

Get up and running in under 2 minutes:

```bash
# 1. Install dependencies
npm install

# 2. Build the server  
npm run build

# 3. That's it! The server is ready to integrate with your MCP-compatible tools
```

**Prerequisites:** Make sure you have the [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and authenticated with your Google Cloud credentials.

## How Working Directory Context Works

The magic happens automatically based on your MCP client:

**🖥️ CLI Tools (Claude Code, Codex, etc.)**  
When you run `claude-code` in `/your/project`, the MCP server inherits that same working directory. Gemini automatically has full access to your project files and operates in the correct context. No setup needed!

**🌐 Web Clients (ChatGPT, Claude Web, etc.)**  
The MCP server starts in whatever directory the web client's backend specifies (often home directory). Gemini can still access files, but you may need to navigate explicitly or provide full paths to your project.

This makes the MCP server incredibly powerful for CLI workflows where you're already working in your project directory.

**🎯 Pro Tip: Override Working Directory**  
You can specify any working directory using the `cwd` parameter:

```javascript
// In Claude Code, ask: "Use Gemini to analyze the code in /path/to/project"
// The MCP server will execute: gemini with cwd="/path/to/project"
```

This lets you point Gemini at any project directory, even from web clients!

## Integration

### With Claude Code

Add to your Claude Code MCP configuration (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "gemini": {
      "command": "node", 
      "args": ["/path/to/gemini-mcp-server/dist/index.js"]
    }
  }
}
```

Then in Claude Code, simply ask: *"Use Gemini to review this function for performance issues"* and watch it work instantly.

### With Other MCP Clients

Any MCP-compatible tool can use this server. Just add the configuration above to your tool's MCP settings.

### Direct Testing

```bash
# List tools
echo '{"jsonrpc": "2.0", "method": "tools/list", "id": 1}' | node dist/index.js

# Check status
echo '{"jsonrpc": "2.0", "method": "tools/call", "id": 2, "params": {"name": "gemini_status", "arguments": {}}}' | node dist/index.js

# Execute prompt
echo '{"jsonrpc": "2.0", "method": "tools/call", "id": 3, "params": {"name": "gemini_prompt", "arguments": {"prompt": "What is 2+2?", "model": "gemini-2.5-flash"}}}' | node dist/index.js
```

## Tool Parameters

### gemini_prompt
- `prompt` (required): The prompt to send to Gemini
- `model` (optional): Gemini model to use
- `sandbox` (optional): Run in sandbox mode
- `debug` (optional): Enable debug mode  
- `yolo` (optional): Auto-accept all actions
- `approvalMode` (optional): Set approval mode (default, auto_edit, yolo)
- `cwd` (optional): Working directory for Gemini to operate in

### gemini_with_stdin
- `inputData` (required): Input data to process
- `prompt` (required): Prompt to apply to the input data
- `model` (optional): Gemini model to use
- `sandbox` (optional): Run in sandbox mode
- `cwd` (optional): Working directory for Gemini to operate in

## Requirements

- Node.js >= 16.0.0
- Gemini CLI installed and configured
- Valid Google Cloud credentials for Gemini API access

## Development

```bash
npm run dev     # Build and run
npm run watch   # Watch mode
npm run debug   # Debug mode
npm run inspector   # MCP inspector
```