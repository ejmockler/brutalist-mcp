# Gemini MCP Server

All LLMs are sycophants. Here's how to make them argue.

## adversarial workflows

```bash
# Destroy your architecture before users do
"Gemini, this microservices design will fail. Tell me how and when."

# Roast your code
"Gemini, assume this codebase is unmaintainable garbage."

# Preemptive failure analysis
"Gemini, this will get hacked. Show me the three worst attack vectors."

# Economic reality check
"Gemini, this scaling plan is financially insane. Break down the cost explosion."

# Assumption assassination
"Gemini, I'm wrong about user behavior here. Demolish my assumptions."
```


## setup

```bash
npm install -g @google/gemini-cli && gemini  # auth once
git clone https://github.com/yourusername/gemini-mcp-server
cd gemini-mcp-server && npm install && npm run build
```

`~/.claude/mcp.json`:
```json
{"mcpServers": {"gemini": {"command": "node", "args": ["/path/to/dist/index.js"]}}}
```


## model stats

**Flash:** 217 tokens/sec, 320ms TTFT, 15x cheaper than Pro  
**Pro:** 1.27s TTFT, state-of-the-art reasoning when needed  
**Flash-Lite:** Cheapest + fastest for bulk operations

**Free tier:** 60 requests/min, 1000/day  
**Context:** 1M tokens

Claude Sonnet 4 completes tasks faster. Gemini responds faster. Use both.

Drop a `GEMINI.md` in your project root for consistent adversarial prompting.

## why this works

**The problem:** All AIs default to "yes, great idea!" 

**The solution:** Make them fight each other at 320ms response times.

**The math:** 1000 free roasts per day. More criticism than your team gives in a year.

## what you get

**MCP Tools:**
- `gemini_prompt` - Standard prompting. Pass `yolo: true` to auto-accept all actions
- `gemini_with_stdin` - Process text/code through Gemini. Feed it your disasters
- `gemini_json` - Get structured JSON responses instead of rambling text
- `gemini_directories` - Include multiple project paths (up to 50). Gemini sees everything
- `gemini_models` - List what models you can roast with
- `gemini_status` - Check if Gemini CLI is installed and working

**Real Architecture:**
Thin wrapper around Gemini CLI. MCP → CLI pipes. No LLM proxy, no vendor lock-in.

```bash
npm run dev           # build and run
npm run inspector     # debug MCP messages
npm test              # run tests (15 passing)
npm test:coverage     # check coverage
```

## sources

[OpenAI-Anthropic Joint Safety Evaluation](https://openai.com/index/openai-anthropic-safety-evaluation/) - Summer 2025 collaborative testing  
[SycEval: Evaluating LLM Sycophancy](https://arxiv.org/html/2502.08177v2) - AI sycophancy research

---