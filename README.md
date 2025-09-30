# Brutalist MCP 💀

Your startup will fail. Your architecture will collapse. Your code is a security nightmare.

But this time, you'll know *why* before users do.

## Deploy AI Critics That Don't Lie

Every AI tells you what you want to hear. This one tells you what you need to know.

Three brutal CLI agents. Zero sugar-coating. Maximum carnage.

Three brutal CLI agents that can analyze anything. Each agent brings different perspectives to demolish your work from every angle.

Real file-system analysis. Actual brutal prompts. Intelligent pagination for enterprise codebases. No participation trophies.

## Brutalist Workflows

### 🔍 **Codebase Destruction**

> Analyze actual files in your repository for security holes, performance disasters, and architectural nightmares.

```bash
# Demolish your entire codebase
roast_codebase "/path/to/your/project"

# Target specific modules for focused brutality
roast_codebase "/src/auth"          # Authentication vulnerabilities
roast_codebase "/src/api/handlers"  # API endpoint disasters
roast_codebase "/components"        # React component chaos
```

---

### 💡 **Idea Obliteration**

> Reality-check your startup dreams, product concepts, and technical decisions.

```bash
# Startup idea destruction
roast_idea "A social network for developers to share code snippets"

# Technical decision analysis
roast_idea "Migrating our monolith to microservices with Kubernetes"

# Product feature validation
roast_idea "Adding AI-powered code suggestions to our IDE"
```

---

### 🏗️ **Architecture Annihilation**

> Find every scaling bottleneck, cost explosion, and operational nightmare in your system design.

```bash
# System architecture review
roast_architecture "Microservices with event sourcing and CQRS"

# Infrastructure design analysis
roast_architecture """
API Gateway → Load Balancer → 3 Node.js services → PostgreSQL
Redis for caching, Docker containers on AWS ECS
"""
```

---

### 🔒 **Security Demolition**

> Expose authentication bypasses, injection vulnerabilities, and data leak opportunities.

```bash
# Authentication system analysis
roast_security "JWT tokens with user roles in localStorage"

# API security review
roast_security "GraphQL API with dynamic queries and no rate limiting"
```

---

### 🤺 **Multi-Agent Warfare**

> Deploy multiple CLI agents in adversarial combat for maximum destruction.

```bash
# Technical decision debate
roast_cli_debate "Should we use TypeScript or Go for this API?"

# Architecture comparison battle
roast_cli_debate "Microservices vs Monolith for our e-commerce platform"
```

---

### 🛠️ **Meta Commands**

```bash
# Check which CLI agents are available
cli_agent_roster()
```

## How It Works

This MCP server orchestrates brutal feedback from locally installed CLI agents:
- **Claude Code CLI** - Anthropic's code assistant with brutal system prompts
- **Codex CLI** - OpenAI's code-focused model for technical criticism  
- **Gemini CLI** - Google's model for architectural and system analysis

Each agent runs locally on your machine with custom brutal prompts to find real problems before production fails.

**⏱️ Analysis Timeout:** 25 minutes default - thorough analysis takes time to find real issues. Complex codebases and architectural reviews need deep analysis to catch subtle problems that quick scans miss.

## Setup

### Prerequisites

Install at least one CLI agent:
- **Claude Code**: `npm install -g claude` (or via Claude desktop app)
- **Codex**: Install from [OpenAI Codex](https://github.com/openai/codex-cli)
- **Gemini**: `npm install -g @google/gemini-cli` or authenticate via `gemini auth`

<details>
<summary><strong>Claude Code</strong> — One-liner</summary>

```bash
claude mcp add brutalist --scope user -- npx -y @brutalist/mcp
```
</details>

<details>
<summary><strong>VS Code / Cline</strong> — Manual config</summary>

```bash
code --add-mcp '{"name":"brutalist","command":"npx","args":["-y","@brutalist/mcp"]}'
```
</details>

<details>
<summary><strong>Gemini CLI</strong> — One-liner</summary>

```bash
gemini mcp add brutalist -- npx -y @brutalist/mcp
```
</details>

<details>
<summary><strong>Cursor</strong> — Manual config</summary>

Add to `~/.cursor/mcp.json` or use **Settings → MCP & Integrations**

```json
{
  "brutalist": {
    "command": "npx",
    "args": ["-y", "@brutalist/mcp"]
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
    "args": ["-y", "@brutalist/mcp"]
  }
}
```
</details>

## 📄 Pagination Support (v0.5.0+)

Handle enterprise-scale analyses that exceed Claude Code's 25K token limit:

```bash
# Enable pagination for large codebases
roast_codebase({targetPath: "/monorepo", limit: 20000})

# Continue reading from where you left off
roast_codebase({targetPath: "/monorepo", offset: 20000, limit: 20000})

# Smart chunking preserves readability
roast_codebase({targetPath: "/complex-system", cursor: "offset:25000"})
```

**Features:**
- **Smart Boundary Detection** - Preserves paragraphs and sentences
- **Token Estimation** - Real-time cost awareness (~4 chars = 1 token)
- **Rich Metadata** - Progress indicators and continuation instructions
- **Configurable Chunks** - 1K to 100K characters per response

## Tools

### Code & Architecture Analysis
| Tool | What gets destroyed | CLI Agents Used |
|------|-------------------|-----------------|
| `roast_codebase` | Security holes, performance disasters, maintainability nightmares in actual files | All available |
| `roast_file_structure` | Directory chaos, naming disasters, structural nightmares | All available |
| `roast_dependencies` | Version conflicts, security vulns, dependency hell | All available |
| `roast_git_history` | Commit disasters, branching chaos, collaboration failures | All available |
| `roast_test_coverage` | Testing gaps, quality blind spots, coverage lies | All available |

### Conceptual Analysis
| Tool | What gets destroyed | CLI Agents Used |
|------|-------------------|-----------------|
| `roast_idea` | Why imagination fails to become reality | All available |
| `roast_architecture` | Scaling failures, cost explosions, operational complexity | All available |
| `roast_research` | Methodological flaws, irreproducible results, statistical crimes | All available |
| `roast_security` | Attack vectors, authentication bypasses, data leaks | All available |
| `roast_product` | UX disasters, adoption barriers, user abandonment | All available |
| `roast_infrastructure` | Single points of failure, hidden costs, 3AM outages | All available |

### Meta Tools
| Tool | What it does |
|------|--------------|
| `roast_cli_debate` | Multiple CLI agents argue until truth emerges |
| `cli_agent_roster` | Shows which CLI agents are available on your system |

## CLI Agent Selection

The system automatically detects and uses available CLI agents:

```bash
# Use specific CLI agent
roast_codebase(targetPath="/src", preferredCLI="claude")

# Let system choose based on analysis type
roast_security "/auth/module"  # Prefers Codex for security

# Force multi-agent analysis (default)
roast_idea "..."  # All available agents analyze in parallel
```

### Smart Selection Rules

Different CLI agents excel at different analysis types:
- **Code review**: Claude > Codex > Gemini
- **Architecture**: Gemini > Claude > Codex  
- **Security**: Codex > Claude > Gemini
- **Research**: Claude > Gemini > Codex

## Why This Works

**Problem:** AI optimizes for engagement, not truth.  
**Solution:** Deploy multiple local CLI agents with adversarial perspectives.  
**Result:** Brutal honesty through systematic destruction before expensive failures.

Your code will fail. Your startup will struggle. Better to learn this from brutal CLI agents than from production outages at 3AM.

The only AI that prevents disasters instead of causing them.

---

Local CLI agents → Brutal system prompts → Parallel execution → Adversarial synthesis → Production survival