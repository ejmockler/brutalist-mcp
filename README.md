# Brutalist MCP

Multi-perspective code analysis using Claude Code, Codex, and Gemini CLI agents.

Get direct, honest technical feedback on your code, architecture, and ideas before they reach production.

## What It Does

The Brutalist MCP connects your AI coding assistant to three different CLI agents (Claude, Codex, Gemini), each providing independent analysis. This gives you multiple perspectives on:

- Code quality and security vulnerabilities
- Architecture decisions and scalability
- Product ideas and technical feasibility
- Research methodology and design flaws

Real file-system access. Straightforward analysis. No sugar-coating.

## Quick Start

### Step 1: Install a CLI Agent

You need at least one of these installed:

```bash
# Option 1: Claude Code (recommended)
npm install -g claude

# Option 2: Codex
# Install from https://github.com/openai/codex-cli

# Option 3: Gemini
npm install -g @google/gemini-cli
```

### Step 2: Install the MCP Server

Choose your IDE:

**Claude Code:**
```bash
claude mcp add brutalist --scope user -- npx -y @brutalist/mcp@latest
```

**Codex:**
```bash
# Install globally once to avoid npx startup chatter
npm i -g @brutalist/mcp
# Add MCP using the installed binary (clean stdio)
codex mcp add brutalist -- brutalist-mcp
```

**Configuring `tool_timeout_sec` for Codex:**
The `tool_timeout_sec` parameter (defaulting to 60 seconds) for your Brutalist MCP server needs to be configured directly in your Codex configuration file at `~/.codex/config.toml`. It cannot be passed via the `codex mcp add` command directly.

To set a custom timeout (e.g., 5 minutes or 300 seconds), add or modify the `[mcp_servers.brutalist]` section in `~/.codex/config.toml` as follows:

```toml
[mcp_servers.brutalist]
command = "brutalist-mcp" # Ensure this matches your installation command
args = [] # Depending on your setup, this might be empty or contain arguments
tool_timeout_sec = 300 # Set your desired timeout in seconds
```


**Cursor:**
Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "brutalist": {
      "command": "npx",
      "args": ["-y", "@brutalist/mcp@latest"]
    }
  }
}
```

**VS Code / Cline:**
```bash
code --add-mcp '{"name":"brutalist","command":"npx","args":["-y","@brutalist/mcp@latest"]}'
```

**Windsurf:**
Add to `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "brutalist": {
      "command": "npx",
      "args": ["-y", "@brutalist/mcp@latest"]
    }
  }
}
```

### Step 3: Verify Installation

```bash
# Check which CLI agents are available
cli_agent_roster()
```

## Usage Examples

### Analyze Your Codebase

```bash
# Analyze entire project
roast_codebase "/path/to/your/project"

# Analyze specific modules
roast_codebase "/src/auth"
roast_codebase "/src/api/handlers"
```

### Validate Ideas

```bash
# Evaluate a product concept
roast_idea "A social network for developers to share code snippets"

# Review technical decisions
roast_idea "Migrating our monolith to microservices with Kubernetes"
```

### Review Architecture

```bash
# System architecture analysis
roast_architecture "Microservices with event sourcing and CQRS"

# Infrastructure design review
roast_architecture """
API Gateway → Load Balancer → 3 Node.js services → PostgreSQL
Redis for caching, Docker containers on AWS ECS
"""
```

### Security Analysis

```bash
# Authentication review
roast_security "JWT tokens with user roles in localStorage"

# API security check
roast_security "GraphQL API with dynamic queries and no rate limiting"
```

### Compare Perspectives

```bash
# Get multiple viewpoints on technical decisions
roast_cli_debate "Should we use TypeScript or Go for this API?"

# Compare architecture approaches
roast_cli_debate "Microservices vs Monolith for our e-commerce platform"
```

## How It Works

This MCP server coordinates analysis from locally installed CLI agents:
- **Claude Code CLI** - Code review and architectural analysis
- **Codex CLI** - Security and technical implementation review
- **Gemini CLI** - System design and scalability analysis

Each agent runs locally with direct file-system access, providing independent perspectives on your code and design decisions.

**Analysis time:** Up to 25 minutes for complex projects. Thorough analysis requires time to examine code patterns, dependencies, and architectural decisions.

## Pagination for Large Results

For analyses that exceed your IDE's token limit:

```bash
# Set chunk size for large codebases
roast_codebase({targetPath: "/monorepo", limit: 20000})

# Continue from where you left off
roast_codebase({targetPath: "/monorepo", offset: 20000, limit: 20000})

# Use cursor-based navigation
roast_codebase({targetPath: "/complex-system", cursor: "offset:25000"})
```

Features:
- Smart boundary detection (preserves paragraphs and sentences)
- Token estimation (~4 chars = 1 token)
- Progress indicators
- Configurable chunk size (1K to 100K characters)

## Tools

### Code & Architecture

| Tool | Analyzes |
|------|----------|
| `roast_codebase` | Security vulnerabilities, performance issues, code quality |
| `roast_file_structure` | Directory organization, naming conventions, structure |
| `roast_dependencies` | Version conflicts, security vulnerabilities, compatibility |
| `roast_git_history` | Commit quality, branching strategy, collaboration patterns |
| `roast_test_coverage` | Test coverage, quality gaps, testing strategy |

### Design & Planning

| Tool | Analyzes |
|------|----------|
| `roast_idea` | Feasibility, market fit, implementation challenges |
| `roast_architecture` | Scalability, cost, operational complexity |
| `roast_research` | Methodology, reproducibility, statistical validity |
| `roast_security` | Attack vectors, authentication, authorization |
| `roast_product` | UX, adoption barriers, user needs |
| `roast_infrastructure` | Reliability, scaling, operational overhead |

### Utilities

| Tool | Purpose |
|------|---------|
| `roast` | **Unified tool** - use `domain` parameter to select analysis type |
| `brutalist_discover` | Find the best tool for your intent using natural language |
| `roast_cli_debate` | Multi-agent discussion from different perspectives |
| `cli_agent_roster` | Show available CLI agents on your system |

> **Tip:** Use the unified `roast` tool with a domain parameter for a leaner schema, or use `brutalist_discover` to find the right tool based on your intent.

See [docs/pagination.md](docs/pagination.md) for detailed pagination documentation.

## Advanced Usage

### Choose Specific CLI Agents

```bash
# Use specific agents (subset selection)
roast(domain="codebase", target="/src", clis=["claude", "gemini"])

# Use a single agent
roast(domain="codebase", target="/src", clis=["claude"])

# Multi-agent analysis (default - all available)
roast(domain="idea", target="...")  # All available agents provide perspectives
```

### Agent Strengths

Different agents have different strengths:
- **Code review**: Claude, Codex, Gemini
- **Architecture**: Gemini, Claude, Codex
- **Security**: Codex, Claude, Gemini
- **Research**: Claude, Gemini, Codex

## Why Multiple Perspectives

Each CLI agent brings a different approach to analysis:
- Different training data and focus areas
- Independent evaluation of the same code
- Varied perspectives on technical tradeoffs

Getting multiple viewpoints helps identify issues that a single perspective might miss.

---

**License:** MIT
**Issues:** https://github.com/ejmockler/brutalist-mcp/issues
