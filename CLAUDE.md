# Claude Code Integration Guide

## Overview

The Brutalist MCP server integrates seamlessly with Claude Code to provide brutal, honest feedback about your code and ideas. This guide covers Claude-specific features, configuration, and troubleshooting.

## Installation

### Quick Setup (Recommended)

```bash
# Install for user scope - available across all projects
claude mcp add brutalist --scope user -- npx -y @brutalist/mcp
```

### Manual Configuration (Advanced)

For direct configuration file editing, add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "brutalist": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@brutalist/mcp"]
    }
  }
}
```

### Verification

```bash
# Verify installation
claude mcp list

# Test the server
claude mcp get brutalist
```

## Claude-Specific Features

### Brutal System Prompts

When using Claude Code as the CLI agent, the Brutalist MCP injects brutal system prompts that override Claude's typically helpful nature:

```javascript
// Example system prompt for code analysis
"You are a brutal code critic. Find security vulnerabilities, 
performance issues, and architectural problems in this codebase. 
Be direct about real issues that cause production failures."
```

### Timeout Configuration

Claude Code can take significantly longer for complex analysis. The system automatically sets a 30-minute timeout for Claude to handle:
- Large codebases
- Complex architectural analysis
- Multi-file security audits
- Deep dependency analysis

### Model Selection

Claude Code uses the current model configured in your Claude settings. To change models:

```bash
# Use specific Claude model
roast_codebase(targetPath="/src", preferredCLI="claude", models={claude: "claude-3-opus"})
```

## Usage Examples

### Analyze Your Codebase

```bash
# Let Claude brutally review your entire project
roast_codebase "/path/to/project"

# Force Claude-only analysis
roast_codebase(targetPath="/src", preferredCLI="claude")
```

### Security Analysis

```bash
# Claude excels at finding security vulnerabilities
roast_security "Our JWT implementation"
```

### Idea Validation

```bash
# Get Claude's brutal take on your startup idea
roast_idea "An AI-powered social network for pets"
```

### Multi-Agent Debate

```bash
# Have Claude debate with other CLI agents
roast_cli_debate "Should we migrate from REST to GraphQL?"
```

## Performance Optimization

### For Large Codebases

Claude Code performs best when analyzing specific modules rather than entire monorepos:

```bash
# Good: Focused analysis
roast_codebase "/src/auth"
roast_codebase "/src/api/handlers"

# Slower: Entire project
roast_codebase "/"
```

### Context Management

The Brutalist MCP automatically manages context to stay within Claude's limits:
- Truncates extremely long file contents
- Focuses on most critical issues
- Provides summaries for large analyses

## Troubleshooting

### Claude CLI Not Found

If you get "Claude CLI not found" errors:

1. Ensure Claude Code is installed:
   ```bash
   claude --version
   ```

2. If not installed, install via npm:
   ```bash
   npm install -g claude
   ```

3. Or use the Claude desktop app which includes the CLI

### Timeout Issues

If Claude times out on large analyses:

1. Break down the analysis into smaller chunks
2. Use more specific paths rather than entire directories
3. The timeout has been increased to 30 minutes automatically
4. For extremely large codebases, consider analyzing modules separately

### No Response from Claude

If Claude doesn't provide brutal feedback:

1. Check Claude CLI is authenticated:
   ```bash
   claude --help
   ```

2. Ensure the MCP server is running:
   ```bash
   # Check MCP logs
   cat ~/.claude/logs/mcp.log
   ```

3. Restart Claude Code and the MCP connection

### Rate Limiting

Claude Code may have rate limits. If you encounter them:
1. Wait a few minutes between analyses
2. Use other CLI agents (Codex, Gemini) in rotation
3. Focus on smaller, more targeted analyses

## Best Practices

### When to Use Claude

Claude excels at:
- **Code review**: Finding subtle bugs and architectural issues
- **Security analysis**: Identifying authentication and authorization flaws
- **Research validation**: Critiquing methodology and statistical approaches
- **Idea evaluation**: Understanding market dynamics and user behavior

### When to Use Other Agents

Consider other CLI agents for:
- **Performance optimization**: Codex often provides more technical details
- **Infrastructure**: Gemini excels at cloud architecture analysis
- **Quick checks**: Gemini tends to be faster for simple validations

## Response Pagination (New in v0.5.0)

### Solving the 25K Token Limit

The brutalist MCP now supports intelligent pagination to handle responses larger than Claude Code's default 25,000 token limit:

```bash
# Default behavior (no pagination)
roast_codebase({targetPath: "/src"})

# Enable pagination with custom chunk size
roast_codebase({targetPath: "/src", limit: 15000})

# Continue reading from offset
roast_codebase({targetPath: "/src", offset: 15000, limit: 15000})

# Use cursor-based navigation
roast_codebase({targetPath: "/src", cursor: "offset:15000"})
```

### Pagination Parameters

All brutalist tools now support:
- **offset**: Character position to start from (default: 0)
- **limit**: Maximum characters per chunk (1,000 - 100,000, default: 25,000)
- **cursor**: Navigation token from previous response

### Smart Chunking Features

- **Boundary Detection**: Preserves paragraphs, sentences, and word boundaries
- **Token Estimation**: Real-time token count (~4 chars = 1 token)
- **Rich Metadata**: Progress indicators and continuation instructions
- **Overlap Support**: Configurable context preservation between chunks

### Response Format

Paginated responses include navigation metadata:

```markdown
# Brutalist Analysis Results

**📊 Pagination Status:** Part 1/3: chars 0-25,000 of 75,000 • Use offset parameter to continue
**🔢 Token Estimate:** ~6,250 tokens (chunk) / ~18,750 tokens (total)

**⏭️ Continue Reading:** Use `offset: 25000` for next chunk

---
[ANALYSIS CONTENT]
---

🔄 To continue: Use same tool with `offset: 25000`
```

### Environment Configuration

```bash
# Increase Claude Code's token limit (recommended)
export MAX_MCP_OUTPUT_TOKENS=100000

# Start Claude Code with higher limits
claude
```

## Advanced Configuration

### Model Selection (Updated in v0.5.0)

As of September 2025, you can specify exact models for each CLI agent:

#### Verified Working Models

**Claude Code:**
- `opus` - Claude Opus (alias) ✅
- `sonnet` - Claude Sonnet (alias) ✅  
- `claude-opus-4-1-20250805` - Claude Opus 4.1 (full model name) ✅
- Default: Uses your configured Claude model

**Codex CLI:**
- `gpt-5.1-codex-max` - Latest frontier model with compaction for long-horizon tasks ✅ (RECOMMENDED)
- `gpt-5.1-codex` - GPT-5.1 optimized for coding ✅
- `gpt-5.1-codex-mini` - Smaller, cost-efficient 5.1 model ✅
- `gpt-5-codex` - Legacy GPT-5 optimized for coding ✅
- `gpt-5` - GPT-5 base model ✅
- `o4-mini` - Smaller efficient model ✅
- Default: `gpt-5.1-codex-max`

**Gemini CLI:**
- `gemini-3-pro-preview` - Latest frontier model with best agentic capabilities ✅ (RECOMMENDED)
- `gemini-2.5-pro` - Advanced reasoning ✅
- `gemini-2.5-flash` - Best price/performance ✅
- `gemini-2.5-flash-lite` - Cost-efficient ✅
- Default: `gemini-3-pro-preview`

#### Usage Examples

```bash
# Use specific models for complex analysis
roast_codebase(
  targetPath="/src",
  models={"claude": "opus", "codex": "gpt-5.1-codex-max", "gemini": "gemini-3-pro-preview"}
)

# Speed vs. accuracy trade-offs
roast_idea(
  idea="Quick validation of a startup concept",
  models={"gemini": "gemini-2.5-flash-lite"}  // Fastest option
)

roast_security(
  system="Critical financial system",
  models={"claude": "opus", "gemini": "gemini-3-pro-preview"}  // Most thorough
)
```

#### Model Recommendations by Use Case

**For Complex Reasoning & Architecture:**
- Claude: `opus` or `claude-opus-4-1-20250805`
- Codex: `gpt-5.1-codex-max` (latest with compaction for long-horizon tasks)
- Gemini: `gemini-3-pro-preview` (latest with best agentic capabilities)

**For Speed & Cost Efficiency:**
- Claude: `sonnet` (balanced performance)
- Codex: `o4-mini`
- Gemini: `gemini-2.5-flash-lite`

**For Balanced Analysis (Recommended):**
- Use defaults: Claude user setting, Codex `gpt-5.1-codex-max`, Gemini `gemini-3-pro-preview`

### Custom System Prompts

While the Brutalist MCP provides its own brutal prompts, you can append additional context:

```bash
roast_codebase(
  targetPath="/src",
  context="This is a financial trading system where errors cost millions",
  models={"claude": "opus"}
)
```

### Integration with Development Workflow

Add to your pre-commit hooks:

```bash
#!/bin/bash
# .git/hooks/pre-commit
echo "Running brutal code review..."
claude --print "roast_codebase './src'"
```

## CLI Agent Implementation Details

### Working CLI Command Patterns

After extensive debugging, here are the exact patterns that work for each CLI in the MCP:

#### Claude CLI (Working)
```javascript
// Uses combined prompt with --print flag
const args = ['--print'];
args.push(`${systemPrompt}\n\n${userPrompt}`);

await spawnAsync('claude', args, {
  cwd: workingDir,
  timeout: 1800000, // 30 minutes for complex analysis
  maxBuffer: 10 * 1024 * 1024
});
```

#### Codex CLI (Working - Verbose Output Suppressed)  
```javascript
// Uses exec with --json flag to suppress thinking steps
const args = ['exec'];
args.push('--model', model);
if (sandbox) args.push('--sandbox', 'read-only');
args.push('--json'); // CRITICAL: Outputs structured JSON, suppresses verbose thinking
const combinedPrompt = `CONTEXT AND INSTRUCTIONS:\n${systemPrompt}\n\nANALYZE:\n${userPrompt}`;

await spawnAsync('codex', args, {
  cwd: workingDir,
  timeout: 1800000, // 30 minutes for complex analysis
  maxBuffer: 10 * 1024 * 1024,
  input: combinedPrompt // Using stdin to avoid ARG_MAX limits
});

// Post-processing: Extract only assistant messages from JSON
const assistantMessages = parseCodexJsonOutput(stdout);
```

#### Gemini CLI (Working)
```javascript
// Uses combined prompt as positional argument
const args = ['--model', 'gemini-3-pro-preview'];
if (sandbox) args.push('--sandbox');
const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
args.push(combinedPrompt); // Positional argument, NOT stdin

await spawnAsync('gemini', args, {
  cwd: workingDir,
  timeout: 1800000, // 30 minutes for complex analysis
  maxBuffer: 10 * 1024 * 1024,
  detached: false, // CRITICAL: Gemini hangs with detached:true on macOS
  env: {
    ...process.env,
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: 'true'
  }
});
```

### Security Compromises Made

**Environment Inheritance**:
- All CLI agents inherit full parent environment variables
- **Risk**: API keys and secrets exposed to spawned processes
- Necessary for CLI authentication to work

**Path Validation Disabled**:
- `workingDirectory` and `targetPath` not validated for path traversal
- **Risk**: `../../../etc/passwd` style attacks possible
- Required for legitimate cross-directory analysis

### Debugging Tips

**Gemini Hanging Issues**:
1. Check `detached: false` is set for Gemini specifically
2. Use positional argument, NOT `--prompt` flag or stdin
3. Environment variables must include `TERM: 'dumb'`
4. Avoid large prompts that may hit argument length limits

**Timeout Issues**:
- All CLIs: Default 30 minutes for complex analysis
- Override via `BRUTALIST_TIMEOUT` environment variable if needed
- For extremely large codebases (>100k LOC), consider splitting analysis

**Process Management**:
```javascript
// Platform-specific killing
if (command === 'gemini') {
  child.kill('SIGKILL'); // Non-detached
} else {
  process.kill(-child.pid!, 'SIGKILL'); // Process group
}
```

### What NOT to Do (Failed Patterns)

**Gemini Failures**:
```javascript
// ❌ BROKEN: stdin input with combined prompt
await spawnAsync('gemini', args, {
  input: combinedPrompt // Hangs after "loading credentials"
});

// ❌ BROKEN: --prompt flag
args.push('--prompt', userPrompt); // Hangs waiting for file approval

// ❌ BROKEN: GEMINI_SYSTEM_MD environment variable  
env: { GEMINI_SYSTEM_MD: systemPrompt } // Tries to read as file path

// ❌ BROKEN: detached process on macOS
await spawnAsync('gemini', args, {
  detached: true // Hangs during macOS sandbox initialization
});
```

**Claude Failures**:
```javascript
// ❌ BROKEN: --append-system-prompt flag
args.push('--append-system-prompt', systemPrompt); // Times out
```

**Root Cause Analysis**:
- **Gemini + stdin**: CLI expects interactive terminal, hangs in non-TTY context
- **Gemini + detached**: macOS sandbox conflicts with detached process groups
- **GEMINI_SYSTEM_MD**: Environment variable expects file path, not content
- **Large prompts**: Gemini may exit early with very large combined prompts
- **Claude --append-system-prompt**: Flag causes timeout issues in spawn context

## Codex Output Improvements (v0.5.2)

### Clean Output Without Thinking Steps

As of v0.5.2, Codex output has been significantly improved:

**Before:** Codex would show all thinking steps, file reads, and internal reasoning
**After:** Only the final assistant response is shown

This is achieved by:
1. Adding the `--json` flag to Codex execution
2. Parsing the JSON output to extract only `assistant` type messages
3. Filtering out `thinking`, `file_read`, and other verbose message types

The verbose output is still available in debug logs if needed for troubleshooting.

## Known Limitations

1. **File Size**: Very large files (>10MB) may be truncated
2. **Binary Files**: Cannot analyze compiled binaries or images
3. **Real-time Analysis**: Claude analyzes static code, not runtime behavior
4. **Language Support**: Best results with mainstream languages (JS, Python, Go, etc.)
5. **Security**: Significant compromises made for functionality - see above

## TypeScript Standards - NON-NEGOTIABLE

### ZERO TOLERANCE FOR TYPE SHORTCUTS

This codebase maintains STRICT TypeScript standards. The following are **ABSOLUTELY FORBIDDEN**:

#### ❌ NEVER USE:
- `any` type - indicates lack of type safety
- `never` type inappropriately - only for genuinely impossible states  
- `@ts-ignore` comments - masks real type issues
- `@ts-expect-error` without fixing the root cause
- `unknown` without proper type guards
- Casting with `as` without validation
- Loose function signatures like `(...args: any[]) => any`

#### ✅ ALWAYS USE:
- Proper interface definitions
- Generic constraints with `extends`
- Union types for multiple possibilities  
- Type guards and narrowing
- Zod schemas for runtime validation
- Exact Jest mock types matching real interfaces

### Common Type Errors We've Eliminated

Based on extensive debugging, here are the type patterns that MUST be avoided:

**Mock Type Mismatches:**
```typescript
// ❌ WRONG - causes Mock<UnknownFunction> errors
mockTool = jest.fn().mockImplementation((name: string, ...restArgs: unknown[]) => {
  // Generic callback assignment fails
  toolHandlers[name] = callback as any; // FORBIDDEN
});

// ✅ CORRECT - proper typed mock
mockTool = jest.fn<MockedFunction<McpServer['tool']>>().mockImplementation(
  (name: string, description: string, schema: ZodRawShape, callback: ToolCallback<ZodRawShape>) => {
    // Type-safe callback assignment
    toolHandlers[name] = callback;
    return registeredToolMock;
  }
);
```

**Jest Mock Type Safety:**
```typescript
// ❌ WRONG - jest.fn() returns Mock<UnknownFunction>
const mockConnect = jest.fn().mockResolvedValue(undefined);

// ✅ CORRECT - explicitly typed Jest mock
const mockConnect = jest.fn<MockedFunction<McpServer['connect']>>()
  .mockResolvedValue(undefined);
```

**Generic Type Constraints:**
```typescript
// ❌ WRONG - loses type information
interface ToolHandler {
  (args: any): any; // FORBIDDEN
}

// ✅ CORRECT - maintains type safety
interface ToolHandler<T extends ZodRawShape = Record<string, never>> {
  (args: T extends Record<string, never> ? {} : z.infer<ZodObject<T>>): CallToolResult | Promise<CallToolResult>;
}
```

### Debugging Type Errors

When encountering type errors:

1. **Read the full error message** - TypeScript errors contain the exact type mismatch
2. **Trace to the source** - Don't suppress with `any`, fix the root interface
3. **Check import types** - Ensure imported types match usage
4. **Verify generic constraints** - Complex generics need proper bounds
5. **Test mock compatibility** - Jest mocks must match real function signatures exactly

### Code Review Checklist

Every PR MUST pass these checks:

- [ ] `npm run build` succeeds with 0 TypeScript errors
- [ ] `npm run lint` passes with 0 violations
- [ ] No `any`, `never`, `@ts-ignore`, or `@ts-expect-error` in new code
- [ ] All Jest mocks properly typed with correct function signatures
- [ ] Interface definitions match actual usage patterns
- [ ] Generic constraints properly bound

**If you see type shortcuts in code review, REJECT immediately. No exceptions.**

## Support

For issues specific to the Brutalist MCP with Claude Code:
- GitHub Issues: https://github.com/ejmockler/brutalist-mcp/issues
- Ensure you mention you're using Claude Code as the CLI agent

For Claude Code CLI issues:
- Claude support: https://support.anthropic.com

---

Remember: Claude's brutal feedback is designed to find problems before they reach production. Every harsh critique could save you from a 3 AM outage.