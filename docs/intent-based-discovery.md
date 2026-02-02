# Intent-Based Tool Discovery

## Overview

The Brutalist MCP server implements intelligent tool discovery that helps agents find the most relevant analysis tools based on natural language intent. Instead of requiring agents to know all 14 tools upfront, they can describe what they want to analyze and get targeted recommendations.

## How It Works

### Architecture

```
User Intent → Tool Router → Relevance Scoring → Top 3 Tools
```

1. **Intent Parsing**: Natural language intent is broken into keywords (words > 2 characters)
2. **Relevance Scoring**: Each domain is scored based on keyword matches
3. **Ranking**: Domains are sorted by relevance score (descending)
4. **Filtering**: Top 3 most relevant tools are returned

### Scoring Algorithm

The tool router uses a weighted scoring system:

- **Strong Match** (+2 points): Intent keyword matches domain's `keywords` array
- **Weak Match** (+1 point): Intent keyword found in domain name or description

Example:
```typescript
// Intent: "review security vulnerabilities"
// Keywords extracted: ["review", "security", "vulnerabilities"]

// Scoring for SECURITY domain:
// - "security" matches keyword → +2
// - "security" in description → +1
// Total: 3 points

// Scoring for CODEBASE domain:
// - "review" in description → +1
// Total: 1 point
```

## Using the Discovery Tool

### Basic Usage

```javascript
// Find tools for security analysis
brutalist_discover({
  intent: "review security of my auth system"
})

// Returns:
// - roast_security (highest match)
// - roast_architecture (security context)
// - roast_codebase (code analysis)
```

### Example Intents

**Security Analysis:**
```javascript
brutalist_discover({ intent: "find vulnerabilities in authentication" })
// → roast_security, roast_codebase, roast_architecture
```

**Code Quality:**
```javascript
brutalist_discover({ intent: "review code quality and maintainability" })
// → roast_codebase, roast_test_coverage, roast_file_structure
```

**Testing:**
```javascript
brutalist_discover({ intent: "check test coverage and quality" })
// → roast_test_coverage, roast_codebase, roast_dependencies
```

**Dependencies:**
```javascript
brutalist_discover({ intent: "analyze npm packages for security issues" })
// → roast_dependencies, roast_security, roast_codebase
```

**Architecture:**
```javascript
brutalist_discover({ intent: "review system design and scalability" })
// → roast_architecture, roast_infrastructure, roast_security
```

**Infrastructure:**
```javascript
brutalist_discover({ intent: "check devops and cloud setup" })
// → roast_infrastructure, roast_architecture, roast_security
```

**Business Ideas:**
```javascript
brutalist_discover({ intent: "validate startup concept feasibility" })
// → roast_idea, roast_product, roast_research
```

## Domain Keywords

Each domain has specific keywords for matching:

| Domain | Keywords |
|--------|----------|
| **codebase** | code, codebase, review, audit, quality |
| **file_structure** | files, structure, organization, directory |
| **dependencies** | dependencies, packages, npm, security, versions |
| **git_history** | git, commits, history, workflow |
| **test_coverage** | tests, coverage, testing, quality |
| **idea** | idea, startup, concept, feasibility |
| **architecture** | architecture, design, system, scale |
| **research** | research, methodology, academic, statistics |
| **security** | security, vulnerability, threat, pentest |
| **product** | product, ux, user, market |
| **infrastructure** | infrastructure, devops, cloud, operations |

## Response Format

The discovery tool returns a formatted response:

```markdown
# Recommended Brutalist Tools

Based on your intent: "review security of my auth system"

**Top 3 matches:**

### roast_security
Deploy brutal AI critics to systematically destroy your security analysis.
Security vulnerability and threat analysis.

### roast_architecture
Deploy brutal AI critics to systematically destroy your architecture review.
System architecture design and scalability review.

### roast_codebase
Deploy brutal AI critics to systematically destroy your codebase analysis.
Comprehensive codebase review for architecture, security, and maintainability.

**Tip:** Use the unified `roast` tool with domain parameter for a leaner schema.
```

## Fallback Behavior

When no keywords match:
- All 11 domain tools are returned
- User is directed to the unified `roast` tool or `roast_codebase` for general analysis

```javascript
brutalist_discover({ intent: "xyz quantum blockchain" })
// → Returns all tools (no specific match)
```

## Integration with CLI Agent Roster

The `cli_agent_roster` tool now includes discovery information:

```markdown
## Tool Discovery
Use `brutalist_discover` with a natural language intent to find the best tools for your analysis:
- Example: `brutalist_discover(intent: 'review my authentication security')`
- Returns the top 3 most relevant tools based on keywords and domain matching
```

## API Reference

### `brutalist_discover`

**Parameters:**
- `intent` (string, required): Natural language description of what you want to analyze

**Returns:**
```typescript
{
  content: [{
    type: "text",
    text: string  // Formatted markdown with tool recommendations
  }]
}
```

### Internal Functions

#### `filterToolsByIntent(intent?: string): ToolConfig[]`

Filters and ranks tools based on intent keywords.

**Behavior:**
- Returns all tools if intent is empty/undefined
- Returns top 3 matches if keywords match any domains
- Returns all tools if no matches found

**Example:**
```typescript
import { filterToolsByIntent } from './tool-router.js';

const tools = filterToolsByIntent("security vulnerability");
// Returns: [roast_security, roast_codebase, roast_architecture]
```

#### `getMatchingDomainIds(intent: string): string[]`

Returns domain IDs (without `roast_` prefix) that match the intent.

**Example:**
```typescript
import { getMatchingDomainIds } from './tool-router.js';

const domainIds = getMatchingDomainIds("security");
// Returns: ["security", "codebase", "architecture"]
```

## Implementation Details

### File Structure

```
src/
├── tool-router.ts           # Intent-based routing logic
├── brutalist-server.ts      # Discovery tool registration
├── registry/
│   └── domains.ts          # Domain definitions with keywords
└── types/
    └── tool-config.ts      # ToolConfig interface
```

### Key Components

**1. Relevance Scoring (`calculateRelevance`)**
```typescript
function calculateRelevance(
  domain: CritiqueDomain,
  intentWords: string[]
): number {
  let score = 0;

  // Strong keyword matches
  for (const keyword of domain.keywords) {
    for (const word of intentWords) {
      if (keyword.includes(word) || word.includes(keyword)) {
        score += 2;
      }
    }
  }

  // Weak description matches
  const domainText = `${domain.name} ${domain.description}`.toLowerCase();
  for (const word of intentWords) {
    if (domainText.includes(word)) {
      score += 1;
    }
  }

  return score;
}
```

**2. Tool Filtering (`filterToolsByIntent`)**
```typescript
export function filterToolsByIntent(intent?: string): ToolConfig[] {
  if (!intent || intent.trim() === '') {
    return getToolConfigs();  // All tools
  }

  const intentWords = intent.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);

  const scored = Object.values(DOMAINS).map(domain => ({
    domain,
    score: calculateRelevance(domain, intentWords)
  }));

  scored.sort((a, b) => b.score - a.score);

  const topMatches = scored.filter(s => s.score > 0).slice(0, 3);

  return topMatches.length === 0
    ? getToolConfigs()  // Fallback to all
    : topMatches.map(s => generateToolConfig(s.domain));
}
```

## Testing

Comprehensive test coverage in `tests/unit/tool-router.test.ts`:

- ✅ Returns all tools when no intent provided
- ✅ Matches security-related intents to `roast_security`
- ✅ Matches code-related intents to `roast_codebase`
- ✅ Matches testing intents to `roast_test_coverage`
- ✅ Handles case-insensitive matching
- ✅ Filters out short words (≤2 characters)
- ✅ Returns top 3 matches maximum
- ✅ Falls back to all tools for unmatched intents
- ✅ Strips `roast_` prefix from domain IDs

## Performance Characteristics

- **Time Complexity**: O(n × m × k)
  - n = number of domains (11)
  - m = number of keywords per domain (~5)
  - k = number of intent words (~3-5)
  - **Practical runtime**: <1ms for typical queries

- **Space Complexity**: O(n)
  - Stores scoring results for all domains
  - Returns at most 3 tool configs

## Best Practices

### For Agent Developers

1. **Use Natural Language**: Write intents as you would ask a human
   ```javascript
   // ✅ Good
   brutalist_discover({ intent: "check if my API has security holes" })

   // ❌ Less optimal (but still works)
   brutalist_discover({ intent: "api security" })
   ```

2. **Be Specific**: More keywords = better matches
   ```javascript
   // ✅ Better
   brutalist_discover({ intent: "review authentication security and token handling" })

   // ❌ Generic (returns more results)
   brutalist_discover({ intent: "security" })
   ```

3. **Combine with Roster**: Use `cli_agent_roster` first for context
   ```javascript
   cli_agent_roster()  // Understand available tools
   brutalist_discover({ intent: "..." })  // Find specific match
   ```

### For Server Maintainers

1. **Update Keywords**: Keep domain keywords current in `src/registry/domains.ts`
2. **Monitor Usage**: Track which intents users provide
3. **Tune Scoring**: Adjust weights (+2 vs +1) if needed
4. **Extend Matching**: Consider fuzzy matching or embeddings in future

## Future Enhancements

### Wave 4: Semantic Matching (Planned)

Current implementation uses keyword matching. Future versions may include:

- **Embedding-Based Search**: Use vector similarity for semantic matching
- **Query Expansion**: Automatically expand intents with synonyms
- **Learning**: Track which tool selections work best for given intents
- **Multi-Language**: Support non-English intents

### Example Future API

```typescript
// Future: Semantic matching
brutalist_discover({
  intent: "Is my login secure?",
  useEmbeddings: true  // Vector similarity search
})

// Future: Confidence scores
brutalist_discover({
  intent: "security",
  includeScores: true
})
// Returns: [
//   { tool: "roast_security", confidence: 0.95 },
//   { tool: "roast_codebase", confidence: 0.72 }
// ]
```

## Troubleshooting

### No Relevant Tools Found

**Problem**: Discovery returns all tools instead of targeted matches.

**Solutions:**
1. Use more specific keywords from domain list
2. Check spelling of domain-specific terms
3. Use multiple related keywords in intent

### Wrong Tool Recommended

**Problem**: The top match doesn't fit your use case.

**Solutions:**
1. Review all 3 returned tools (second/third may be better)
2. Use the unified `roast` tool with explicit domain parameter
3. Call specific `roast_*` tool directly if you know it

### Performance Issues

**Problem**: Discovery feels slow.

**Solutions:**
1. Scoring algorithm is <1ms, likely network latency
2. Use direct tool calls for production automation
3. Cache discovery results for repeated queries

## Related Documentation

- [Pagination](./pagination.md) - Handling large analysis results
- [README](../README.md) - Quick start and tool overview

## Version History

- **v0.9.3** (2026-02-01): Intent-based discovery included
  - Basic keyword matching
  - Top 3 tool recommendations
  - Fallback to all tools
  - Integration with cli_agent_roster

---

**Note**: Intent-based discovery is optimized for MCP agent clients. For programmatic access, consider using domain IDs directly with the unified `roast` tool.
