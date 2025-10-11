# Brutalist MCP Pagination Implementation

## Overview

The Brutalist MCP server now supports elegant pagination for large responses, solving the Claude Code 25,000 token limit issue with software engineering distinction.

## Problem Solved

**Before:** Claude Code would truncate responses > 25K tokens with error:
```
Error: MCP tool "roast_codebase" response (32310 tokens) exceeds maximum allowed tokens (25000)
```

**After:** Intelligent pagination with user-controlled chunking and seamless continuation.

## Implementation Architecture

### 1. Type-Safe Pagination System

```typescript
// Core pagination types
interface PaginationParams {
  offset?: number;
  limit?: number;
  cursor?: string;
}

interface PaginationMetadata {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
  chunkIndex: number;
  totalChunks: number;
}
```

### 2. Smart Response Chunking

- **Boundary Detection**: Preserves paragraphs, sentences, and word boundaries
- **Token Estimation**: ~4 characters = 1 token for user awareness
- **Overlap Support**: Configurable overlap between chunks for context
- **Metadata Tracking**: Complete provenance of chunking operations

### 3. MCP Tool Integration

Every brutalist tool now supports pagination parameters:

```typescript
// Tool schema includes pagination
{
  targetPath: z.string(),
  // ... other parameters
  offset: z.number().min(0).optional(),
  limit: z.number().min(1000).max(100000).optional(),
  cursor: z.string().optional()
}
```

## Usage Patterns

### Basic Pagination

```bash
# Get first chunk (default: 90K characters / ~22.5K tokens)
roast_codebase({targetPath: "/src"})

# Get next chunk explicitly
roast_codebase({targetPath: "/src", offset: 90000, limit: 90000})
```

### Cursor-Based Navigation

```bash
# Use cursor from previous response
roast_codebase({targetPath: "/src", cursor: "offset:25000"})
```

### Custom Chunk Sizes

```bash
# Small chunks for detailed review
roast_codebase({targetPath: "/src", limit: 5000})

# Large chunks for overview
roast_codebase({targetPath: "/src", limit: 50000})
```

## Response Format

Paginated responses include rich metadata:

```markdown
# Brutalist Analysis Results

**📊 Pagination Status:** Part 1/3: chars 0-25,000 of 75,000 • Use offset parameter to continue
**🔢 Token Estimate:** ~6,250 tokens (chunk) / ~18,750 tokens (total)

**⏭️ Continue Reading:** Use `offset: 25000` for next chunk

---

[ACTUAL ANALYSIS CONTENT HERE]

---

📖 **End of chunk 1/3**
🔄 To continue: Use same tool with `offset: 25000`
```

## Configuration

### Environment Variables

```bash
# Increase Claude Code's token limit (recommended)
export MAX_MCP_OUTPUT_TOKENS=100000

# Adjust server buffer limits
export BRUTALIST_MAX_BUFFER=20971520  # 20MB
```

### Default Limits

- **Default chunk size**: 25,000 characters (~6,250 tokens)
- **Minimum chunk**: 1,000 characters
- **Maximum chunk**: 100,000 characters  
- **Smart overlap**: 200 characters between chunks

## Advanced Features

### Smart Boundary Detection

The chunker preserves readability by finding optimal break points:

1. **Paragraph breaks** (`\n\n`) - highest priority
2. **Sentence endings** (`. ! ?`) - medium priority  
3. **Word boundaries** (whitespace) - lowest priority
4. **Fallback**: Character limit if no good boundary found

### Token Usage Awareness

- Real-time token estimation for cost planning
- Per-chunk and total token counts
- Helps users balance thoroughness vs. cost

### Cursor State Management

```typescript
// Simple offset cursor
cursor: "offset:25000"

// Rich JSON cursor (future extensibility)
cursor: '{"offset": 25000, "limit": 10000, "context": "detailed"}'
```

## Software Engineering Principles

### 1. Type Safety
- Full TypeScript coverage with strict types
- Zod schema validation for all parameters
- Compile-time error prevention

### 2. Separation of Concerns
- `pagination.ts`: Pure utility functions
- `brutalist-server.ts`: Integration logic
- Clean interfaces between layers

### 3. Error Handling
- Graceful degradation for invalid cursors
- Parameter validation with meaningful errors
- Fallback to non-paginated responses

### 4. Performance
- O(1) character-based chunking
- Minimal memory allocation for large responses
- Lazy evaluation of pagination metadata

### 5. Extensibility
- Plugin architecture for custom chunking strategies
- Configurable via environment variables
- Future support for streaming pagination

## Testing

The implementation includes comprehensive test coverage:

```bash
npm test  # Run full test suite including pagination
```

Test scenarios:
- Parameter extraction and validation
- Token estimation accuracy
- Metadata calculation correctness
- Smart boundary detection
- Cursor parsing robustness

## Migration Guide

### Existing Users

No breaking changes - pagination is opt-in:
- Existing calls work unchanged
- Add `limit` parameter to enable pagination
- Use `offset` for subsequent chunks

### Large Response Workflows

1. **Before**: Increase `MAX_MCP_OUTPUT_TOKENS` and hope
2. **After**: Use pagination for predictable, manageable chunks

### Integration with Claude Code

```bash
# Set generous token limit
export MAX_MCP_OUTPUT_TOKENS=100000

# Use pagination for large analyses
roast_codebase({
  targetPath: "/large-monorepo", 
  limit: 30000  # Comfortable chunk size
})
```

## Benefits Summary

✅ **Solves 25K token limit** - No more truncated responses  
✅ **User-controlled chunking** - Choose optimal chunk sizes  
✅ **Smart boundary detection** - Preserves readability  
✅ **Token cost awareness** - Plan usage with estimates  
✅ **Type-safe implementation** - Compile-time error prevention  
✅ **Zero breaking changes** - Backward compatible  
✅ **Future-proof architecture** - Extensible design  

The brutalist approach now scales to enterprise codebases while maintaining the brutal honesty users expect.