# Contributing to Brutalist MCP

## Development Setup

```bash
git clone https://github.com/ejmockler/brutalist-mcp.git
cd brutalist-mcp
npm install
npm run build
```

## CLI Agent Implementation Details

### Working CLI Command Patterns

After extensive debugging, here are the exact patterns that work for each CLI:

**Claude CLI:**
```javascript
const args = ['--print'];
args.push(`${systemPrompt}\n\n${userPrompt}`);
await spawnAsync('claude', args, { cwd: workingDir, timeout: 1800000 });
```

**Codex CLI:**
```javascript
const args = ['exec', '--sandbox', 'read-only', '--json'];
await spawnAsync('codex', args, { 
  cwd: workingDir, 
  input: combinedPrompt  // Uses stdin
});
```

**Agy (Antigravity) CLI:**
```javascript
// agy --print does NOT accept stdin; prompt goes via argv (~128KB OS ARG_MAX).
// No --system or --model flag exists at runtime; fold system prompt into the
// user prompt slot. --sandbox redirects writes to ~/.gemini/antigravity-cli/
// scratch/ (not the user's cwd). --dangerously-skip-permissions auto-approves
// tool permissions (no human present in --print mode).
const combined = `${systemPrompt}\n\n---\n\n${userPrompt}`;
const args = ['--print', combined,
              '--print-timeout', '15m',
              '--sandbox',
              '--dangerously-skip-permissions'];
await spawnAsync(process.env.AGY_BIN || 'agy', args, {
  cwd: workingDir,
  timeout: 1800000  // --print-timeout is internally broken; orchestrator owns the wall clock
});
```

### Known Failure Patterns

- **Claude --append-system-prompt**: Times out in spawn context
- **Agy --print-timeout**: Internally broken — doesn't enforce wall-clock. Orchestrator's spawnAsync timeout is what actually bounds execution
- **Agy --print + stdin**: agy ignores stdin in print mode; prompt must be in argv
- **Agy on macOS PATH**: If the Antigravity desktop IDE is installed, its wrapper at `~/.antigravity/antigravity/bin/agy` may shadow the CLI agent at `~/.local/bin/agy`. Use `AGY_BIN=$HOME/.local/bin/agy` to disambiguate

## TypeScript Standards

### Zero Tolerance for Type Shortcuts

❌ **NEVER USE:**
- `any` type
- `@ts-ignore` comments
- `unknown` without proper type guards
- Casting with `as` without validation

✅ **ALWAYS USE:**
- Proper interface definitions
- Generic constraints with `extends`
- Zod schemas for runtime validation
- Exact Jest mock types matching real interfaces

### Code Review Checklist

Every PR MUST pass:
- [ ] `npm run build` succeeds with 0 TypeScript errors
- [ ] `npm run lint` passes with 0 violations
- [ ] No `any`, `@ts-ignore`, or `@ts-expect-error` in new code
- [ ] All Jest mocks properly typed

## Testing

```bash
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests
npm run test:coverage # With coverage report
```

## Architecture Overview

```
src/
├── brutalist-server.ts       # MCP server + tool registration
├── cli-agents.ts             # CLI execution and orchestration
├── registry/domains.ts       # Domain definitions (single source of truth)
├── tool-definitions.ts       # Tool config generation (lazy loading)
├── system-prompts.ts         # System prompts by domain
├── handlers/tool-handler.ts  # Roast tool execution logic
└── streaming/                # Streaming infrastructure
```

## Security Notes

CLI agents inherit only whitelisted environment variables via `createSecureEnvironment()`:
- PATH, HOME, USER, SHELL, TERM, LANG, LC_ALL, TZ, NODE_ENV
- Plus their specific API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY)

## Support

- GitHub Issues: https://github.com/ejmockler/brutalist-mcp/issues
