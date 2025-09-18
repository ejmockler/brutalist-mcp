# Brutalist MCP

Your architecture will fail. Your startup will burn money. Your code has three unpatched CVEs.

All AIs are sycophants. This one doesn't lie.

## brutalist workflows

```bash
# Destroy your architecture before users do
roast_architecture "This microservices design for our startup..."

# Demolish your code quality with specific models
roast_code(code="authentication.py", models=["google/gemini-2.5-pro", "anthropic/claude-3.5-sonnet"])

# Reality check your ideas with 325+ AI models
roast_idea "We're building a marketplace for..."

# Discover available models (325+ and growing)
model_roster()  # Shows all available models
model_roster(search="gemini")  # Find specific models

# Multi-model adversarial debate
roast_debate "Should we use TypeScript or Go for this API?"
```

## Setup

**Get your API key:** https://openrouter.ai/keys

<details>
<summary><strong>VS Code / Cline</strong> — One-liner</summary>

```bash
code --add-mcp '{"name":"brutalist","command":"npx","args":["-y","@brutalist/mcp"],"env":{"OPENROUTER_API_KEY":"YOUR_KEY"}}'
```
</details>

<details>
<summary><strong>Claude Code</strong> — One-liner</summary>

```bash
claude mcp add brutalist --scope user -e OPENROUTER_API_KEY=YOUR_KEY -- npx -y @brutalist/mcp
```
</details>

<details>
<summary><strong>Gemini CLI</strong> — One-liner</summary>

```bash
gemini mcp add brutalist -e OPENROUTER_API_KEY=YOUR_KEY -- npx -y @brutalist/mcp
```
</details>

<details>
<summary><strong>Cursor</strong> — Manual config</summary>

Add to `~/.cursor/mcp.json` or use **Settings → MCP & Integrations**

```json
{
  "brutalist": {
    "command": "npx",
    "args": ["-y", "@brutalist/mcp"],
    "env": {
      "OPENROUTER_API_KEY": "YOUR_KEY"
    }
  }
}
```
</details>

<details>
<summary><strong>Windsurf</strong> — Manual config</summary>

Add to `~/.codeium/windsurf/mcp_config.json` or use **Plugin Store**

```json
{
  "brutalist": {
    "command": "npx",
    "args": ["-y", "@brutalist/mcp"],
    "env": {
      "OPENROUTER_API_KEY": "YOUR_KEY"
    }
  }
}
```
</details>

**Models:** 325+ models dynamically fetched from OpenRouter. Always current.

## why

Every LLM defaults to "great idea!" because conflict doesn't pay. This deploys 325+ models to fight over your assumptions.

## model selection

```bash
# Specific models
roast_code(code="...", models=["google/gemini-2.5-pro", "openai/gpt-4o"])

# Random from 325+ models
roast_idea "..."  # Chaos mode
```

## Tools

| Tool | What gets destroyed |
|------|-------------------|
| `roast_idea` | Why imagination fails to become reality |
| `roast_code` | Security holes, performance disasters, maintainability nightmares |
| `roast_architecture` | Scaling failures, cost explosions, operational complexity |
| `roast_research` | Methodological flaws, irreproducible results, statistical crimes |
| `roast_data` | Overfitting, bias, correlation fallacies |
| `roast_security` | Attack vectors, authentication bypasses, data leaks |
| `roast_product` | UX disasters, adoption barriers, user abandonment |
| `roast_infrastructure` | Single points of failure, hidden costs, 3AM outages |
| `roast_debate` | Multiple models argue until truth emerges |
| `model_roster` | Browse and search 325+ available critics |

## why this works

**Problem:** AI optimizes for engagement, not truth.  
**Solution:** Deploy multiple models with conflicting incentives.  
**Result:** Brutal honesty before expensive failures.

Your code will fail. Your startup will struggle. Better to learn this from AI critics than users.

---

OpenRouter API → 325+ models → Parallel execution → Adversarial synthesis