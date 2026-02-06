# Streaming Architecture for Brutalist MCP

## Executive Summary

The Brutalist MCP server implements a sophisticated streaming architecture to deliver progressive critique results as they're generated, rather than waiting for complete CLI agent responses. This document details the current implementation, MCP SDK capabilities, and the path forward for full streaming support.

**Status**: 🟡 Partial Implementation
- ✅ Progress notifications (MCP standard)
- ✅ Real-time event streaming infrastructure (custom)
- ⏳ Streaming CLI output capture (needs integration)
- ⏳ Incremental response delivery (needs MCP integration)

---

## Table of Contents

1. [Current Architecture](#1-current-architecture)
2. [MCP Progress API](#2-mcp-progress-api)
3. [Streaming Components](#3-streaming-components)
4. [CLI Output Streaming](#4-cli-output-streaming)
5. [Integration Points](#5-integration-points)
6. [Implementation Roadmap](#6-implementation-roadmap)
7. [Performance Considerations](#7-performance-considerations)
8. [Error Handling](#8-error-handling)

---

## 1. Current Architecture

### 1.1 High-Level Data Flow

```
┌─────────────┐
│   Client    │
│  (Claude)   │
└──────┬──────┘
       │ Tool Call (with progressToken)
       ▼
┌─────────────────────────────────────┐
│      BrutalistServer (MCP)          │
│  ┌───────────────────────────────┐  │
│  │      ToolHandler              │  │
│  │   (handleRoastTool)           │  │
│  └───────────┬───────────────────┘  │
│              │                       │
│              ▼                       │
│  ┌───────────────────────────────┐  │
│  │   CLIAgentOrchestrator        │  │
│  │   (executeBrutalistAnalysis)  │  │
│  └───────────┬───────────────────┘  │
│              │                       │
│              │ Spawns child process  │
│              ▼                       │
│  ┌───────────────────────────────┐  │
│  │    spawnAsync()               │  │
│  │  - Captures stdout/stderr     │  │
│  │  - Calls onProgress callback  │  │
│  └───────────┬───────────────────┘  │
│              │                       │
│              │ Real-time chunks      │
│              ▼                       │
│  ┌───────────────────────────────┐  │
│  │  onStreamingEvent callback    │  │
│  │  onProgress callback          │  │
│  └───────────┬───────────────────┘  │
│              │                       │
│              │ MCP notifications     │
│              ▼                       │
│  ┌───────────────────────────────┐  │
│  │  server.notification()        │  │
│  │  "notifications/progress"     │  │
│  └───────────────────────────────┘  │
└──────────────┬──────────────────────┘
               │ Out-of-band
               ▼
       ┌──────────────┐
       │   Client     │
       │  (receives   │
       │  progress)   │
       └──────────────┘
```

### 1.2 Current Implementation Files

**Core Streaming Infrastructure** (Built but not fully integrated):
```
src/streaming/
├── streaming-orchestrator.ts    ✅ High-level streaming coordination
├── progress-tracker.ts          ✅ Milestone-based progress tracking
├── intelligent-buffer.ts        ✅ Priority-based event buffering
├── session-manager.ts           ✅ Multi-session event routing
├── sse-transport.ts             ✅ Server-Sent Events transport
├── output-parser.ts             ✅ Semantic CLI output parsing
└── circuit-breaker.ts           ✅ Fault tolerance
```

**Current Tool Execution Flow**:
```
src/handlers/tool-handler.ts         → Tool request entry point
src/cli-agents.ts                     → CLI process spawning & management
  ├── spawnAsync()                    → Captures output in real-time
  │   └── onProgress callback         → Called for each stdout/stderr chunk
  └── emitThrottledStreamingEvent()   → Buffers & throttles events
```

### 1.3 What Works Today

#### ✅ Progress Notifications
The server **already sends** MCP-compliant progress notifications:

```typescript
// In src/brutalist-server.ts
private handleProgressUpdate = (
  progressToken: string | number,
  progress: number,
  total: number,
  message: string,
  sessionId?: string
) => {
  this.server.server.notification({
    method: "notifications/progress",
    params: {
      progressToken,
      progress,
      total,
      message: `[${sessionId}] ${message}`,
      sessionId
    }
  });
};
```

**How it works**:
1. Client sends `progressToken` in tool call metadata
2. During CLI execution, `onProgress` callback fires
3. Server sends `notifications/progress` back to client
4. Client displays progress updates in real-time

#### ✅ Streaming Event Infrastructure
The `StreamingCLIOrchestrator` provides:
- Multi-agent coordination
- Progress milestone detection
- Intelligent event buffering
- Circuit breaker protection
- SSE transport for web clients

**But**: This infrastructure is not yet connected to the main tool execution flow.

### 1.4 What Doesn't Work Yet

❌ **Incremental Response Delivery**
- Current: Client waits for full CLI completion
- Needed: Client receives partial results during execution

❌ **Streaming Output Integration**
- Current: `spawnAsync()` captures output but only calls callbacks
- Needed: Callbacks should feed into streaming orchestrator

❌ **Chunked Tool Results**
- Current: Tool returns single final response
- Needed: Tool streams multiple partial responses

---

## 2. MCP Progress API

### 2.1 Progress Notifications (Standard)

The MCP SDK provides `notifications/progress` for out-of-band updates:

```typescript
// Client sends progressToken in request
{
  "method": "tools/call",
  "params": {
    "name": "roast_codebase",
    "arguments": { "targetPath": "/src" },
    "_meta": {
      "progressToken": "abc123"  // ← Client provides this
    }
  }
}

// Server sends progress updates
{
  "method": "notifications/progress",
  "params": {
    "progressToken": "abc123",  // ← Matches request token
    "progress": 45,
    "total": 100,
    "message": "Analyzing architecture..."
  }
}
```

**Key Properties**:
- **Out-of-band**: Notifications don't affect tool response
- **Non-blocking**: Client continues waiting for tool result
- **Unidirectional**: Server → Client only
- **Progress indicator**: Good for progress bars, not content delivery

**From MCP SDK** (`types.js`):
```typescript
export const ProgressNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/progress"),
  params: BaseNotificationParamsSchema.merge(ProgressSchema).extend({
    /**
     * The progress token which was given in the initial request,
     * used to associate this notification with the request that is proceeding.
     */
    progressToken: ProgressTokenSchema,
  }),
});

export const ProgressSchema = z.object({
  progress: z.number(),  // Current progress
  total: z.optional(z.number()),  // Total (if known)
  message: z.optional(z.string())  // Human-readable message
});
```

### 2.2 Limitations of Progress API

❌ **Not for Content Delivery**
- Progress notifications are for **status updates**, not **data transfer**
- Message field is for human display, not machine-parsed content
- No guarantee of delivery or ordering

❌ **No Response Streaming**
- Tool execution still returns a single final response
- Client must wait for complete analysis before seeing results

❌ **No Content Chunking**
- Can't send partial findings incrementally
- Can't stream CLI agent output in real-time

### 2.3 What We Need Instead

For true streaming critique delivery, we need:

1. **Streaming Response Protocol**
   - Return partial tool results incrementally
   - Each chunk is valid, standalone content
   - Final chunk indicates completion

2. **Content-Aware Chunking**
   - Break CLI output at semantic boundaries
   - Preserve markdown formatting
   - Ensure each chunk is useful on its own

3. **Backpressure Handling**
   - Slow consumers don't block CLI execution
   - Buffer overflow protection
   - Priority-based delivery

**Unfortunately**, the MCP protocol spec (as of 2025-02) does **not define** a streaming response mechanism for tool calls.

---

## 3. Streaming Components

### 3.1 StreamingCLIOrchestrator

**Purpose**: High-level coordinator for streaming CLI execution with full observability.

**Location**: `src/streaming/streaming-orchestrator.ts`

**Key Features**:
```typescript
class StreamingCLIOrchestrator {
  // Execute CLI with full streaming capabilities
  async executeWithStreaming(
    analysisType: string,
    cliAgents: string[],
    systemPrompt: string,
    userPrompt: string,
    options: StreamingExecutionOptions
  ): Promise<StreamingExecutionResult>

  // Real-time event handling
  private createStreamingEventHandler(
    sessionId: string,
    progressTracker: ProgressTracker,
    result: StreamingExecutionResult
  ): (event: StreamingEvent) => void
}
```

**Integration Path**:
```typescript
// CURRENT (in tool-handler.ts)
const responses = await this.cliOrchestrator.executeBrutalistAnalysis(
  analysisType,
  primaryContent,
  systemPromptSpec,
  context,
  options
);

// FUTURE (with streaming orchestrator)
const streamingOrchestrator = new StreamingCLIOrchestrator();
const result = await streamingOrchestrator.executeWithStreaming(
  analysisType,
  cliAgents,
  systemPrompt,
  userPrompt,
  {
    ...options,
    enableProgress: true,
    enableCircuitBreaker: true,
    onStreamingEvent: (event) => {
      // Send incremental updates to client
      this.sendPartialResult(event);
    }
  }
);
```

### 3.2 ProgressTracker

**Purpose**: Intelligent milestone detection from CLI output.

**Location**: `src/streaming/progress-tracker.ts`

**How It Works**:
```typescript
class ProgressTracker {
  // Pattern-based phase detection
  private readonly PHASE_PATTERNS = {
    [AnalysisPhase.INITIALIZING]: [
      /initializing|starting|setting up/i,
    ],
    [AnalysisPhase.ANALYZING]: [
      /analyzing|examining|evaluating/i,
      /Security scan|Architecture analysis/i
    ],
    // ...
  };

  // Process CLI output and detect progress
  processEvent(event: StreamingEvent): void {
    this.detectPhaseFromContent(event.content);
    this.detectMilestonesFromContent(event.content);
    this.updateProgress();
    this.emitProgressEvent('progress_updated');
  }
}
```

**Analysis-Specific Milestones**:
```typescript
export const ANALYSIS_MILESTONES = {
  roast_codebase: [
    { id: 'init_analysis', weight: 0.05, estimatedDuration: 5000 },
    { id: 'scan_structure', weight: 0.15, estimatedDuration: 15000 },
    { id: 'analyze_architecture', weight: 0.25, estimatedDuration: 45000 },
    { id: 'security_audit', weight: 0.20, estimatedDuration: 35000 },
    // ...
  ],
  roast_security: [
    { id: 'threat_modeling', weight: 0.20, estimatedDuration: 15000 },
    { id: 'vulnerability_scan', weight: 0.40, estimatedDuration: 40000 },
    // ...
  ]
};
```

**ETA Calculation**:
- Tracks elapsed time per milestone
- Estimates completion based on remaining weighted milestones
- Adapts to actual CLI execution speed

### 3.3 IntelligentBuffer

**Purpose**: Priority-based event buffering with adaptive throttling.

**Location**: `src/streaming/intelligent-buffer.ts`

**Buffering Strategy**:
```typescript
// Content-aware buffering rules
private readonly BUFFERING_RULES: Record<string, BufferingRule> = {
  'critical_finding': {
    delay: 0,           // Immediate delivery
    maxBatch: 1,
    priority: 'immediate'
  },
  'agent_progress': {
    delay: 200,         // Throttle updates
    maxBatch: 10,
    priority: 'normal'
  },
  'debug_info': {
    delay: 1000,        // Heavy throttling
    maxBatch: 20,
    priority: 'low'
  }
};
```

**Event Coalescence**:
- Groups similar consecutive events
- Reduces noise (e.g., "Reading file... Reading file... Reading file..." → "Reading 3 files...")
- Preserves critical events unchanged

**Backpressure Handling**:
```typescript
if (state.memoryUsage > MAX_MEMORY_MB * 1024 * 1024) {
  // Drop low-priority events
  const droppedEvents = buffer.dequeueAll('low');
  logger.warn(`Backpressure: dropped ${droppedEvents.length} low-priority events`);
}
```

### 3.4 OutputParser

**Purpose**: Semantic parsing of CLI output with markdown preservation.

**Location**: `src/streaming/output-parser.ts`

**Key Capabilities**:
- **Boundary Detection**: Split output at meaningful boundaries (headings, code blocks, paragraphs)
- **Syntax Preservation**: Maintain markdown/code syntax across chunks
- **Finding Extraction**: Parse structured findings from CLI output
- **Metadata Enrichment**: Add severity, category, line numbers

**Example**:
```typescript
// Raw CLI output
const cliOutput = `
## Security Issues

### Critical: SQL Injection
File: auth.js:42
...
`;

// Parsed output
const parsed = parser.parse(cliOutput);
// [
//   {
//     type: 'finding',
//     severity: 'critical',
//     category: 'security',
//     title: 'SQL Injection',
//     location: { file: 'auth.js', line: 42 },
//     content: '...'
//   }
// ]
```

### 3.5 SessionManager & SSETransport

**Purpose**: Multi-session event routing and SSE delivery.

**Status**: Built for HTTP transport mode, not used in stdio mode.

**Use Case**: When MCP server runs over HTTP (experimental), these components:
- Route events to correct client sessions
- Deliver via Server-Sent Events (SSE)
- Handle connection lifecycle

---

## 4. CLI Output Streaming

### 4.1 Current Implementation

**File**: `src/cli-agents.ts`

**Key Function**: `spawnAsync()`
```typescript
async function spawnAsync(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    input?: string;
    onProgress?: (chunk: string, type: 'stdout' | 'stderr') => void;
  }
): Promise<{ stdout: string; stderr: string }>
```

**How Output is Captured**:
```typescript
// Set up stdout listener
child.stdout?.on('data', (data) => {
  const chunk = data.toString();
  stdout += chunk;  // ← Buffered for final return

  // Call progress callback if provided
  if (options.onProgress) {
    options.onProgress(chunk, 'stdout');  // ← Real-time callback
  }
});

// Same for stderr
child.stderr?.on('data', (data) => {
  const chunk = data.toString();
  stderr += chunk;

  if (options.onProgress) {
    options.onProgress(chunk, 'stderr');
  }
});
```

**Current Flow**:
```
spawnAsync(onProgress callback)
    └─> CLI stdout/stderr
        └─> onProgress(chunk)
            └─> emitThrottledStreamingEvent()
                └─> this.handleStreamingEvent()
                    └─> (does nothing meaningful yet)
```

### 4.2 Streaming Event Emission

**In**: `CLIAgentOrchestrator._executeCLI()`
```typescript
const { stdout, stderr } = await spawnAsync(command, args, {
  onProgress: (chunk: string, type: 'stdout' | 'stderr') => {
    if (type === 'stdout' && chunk.trim()) {
      logger.info(`🤖 ${cliName.toUpperCase()}: ${chunk.trim()}`);

      // Emit throttled streaming event
      this.emitThrottledStreamingEvent(
        cliName,
        'agent_progress',
        chunk.trim(),
        options.onStreamingEvent,
        options
      );
    }
  }
});
```

**Throttling Logic**:
```typescript
private emitThrottledStreamingEvent(
  agent: string,
  type: 'agent_progress' | 'agent_error',
  content: string,
  onStreamingEvent?: (event: StreamingEvent) => void,
  options?: CLIAgentOptions
) {
  // For Claude with stream-json, skip intermediate events entirely
  // The useful output comes from the final 'result' event decoded post-execution
  if (agent === 'claude' && options?.progressToken) {
    return;
  }

  // Buffer events per agent+type (for Codex/Gemini)
  const key = `${agent}-${type}`;
  const buffer = this.streamingBuffers.get(key);

  buffer.chunks.push(content);

  // Flush if enough time passed or buffer full
  if (now - buffer.lastFlush > FLUSH_INTERVAL || buffer.chunks.length > 10) {
    onStreamingEvent({
      type,
      agent,
      content: buffer.chunks.join('\\n'),
      timestamp: now
    });
    buffer.chunks = [];
  }
}
```

### 4.3 Output Post-Processing

Different CLIs require different output handling:

**Claude** (with `--output-format stream-json --verbose`):
```typescript
// Extract from final 'result' event only - ignores intermediate events
private decodeClaudeStreamJson(ndjsonOutput: string): string {
  const events = this.parseNDJSON(ndjsonOutput);

  for (const event of events) {
    if (event.type === 'result' && event.subtype === 'success' && event.result) {
      return event.result;  // The final clean text output
    }
  }

  return '';
}
```

**Codex** (with `--json`):
```typescript
// Extract only assistant messages
private extractCodexAgentMessage(jsonOutput: string): string {
  const events = this.parseNDJSON(jsonOutput);

  for (const event of events) {
    if (event.type === 'item.completed' &&
        event.item?.type === 'agent_message') {
      agentMessages.push(event.item.text);  // Skip thinking/reasoning
    }
  }

  return agentMessages.join('\\n\\n');
}
```

**Gemini** (plain text):
```typescript
// No special processing needed
return stdout;
```

### 4.4 Buffering and Timeout Management

**Memory Protection**:
```typescript
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;  // 10MB

child.stdout?.on('data', (data) => {
  stdout += data.toString();

  if (stdout.length > MAX_BUFFER_SIZE) {
    child.kill('SIGTERM');
    reject(new Error(`stdout exceeded maxBuffer`));
  }
});
```

**Resource Limits**:
```typescript
const MAX_MEMORY_MB = 2048;     // 2GB per process
const MAX_CPU_TIME_SEC = 3000;  // 50 minutes

// Memory monitoring every 5 seconds
setInterval(async () => {
  const usage = await getMemoryUsage(child.pid);

  if (usage.memoryMB > MAX_MEMORY_MB) {
    child.kill('SIGTERM');
    reject(new Error(`Process exceeded memory limit`));
  }
}, 5000);
```

---

## 5. Integration Points

### 5.1 Where Streaming Needs to Connect

#### A. Tool Handler Level
**File**: `src/handlers/tool-handler.ts`

**Current**:
```typescript
// Waits for complete CLI response
const result = await this.executeBrutalistAnalysis(
  analysisType,
  primaryContent,
  systemPromptSpec,
  context,
  options
);

// Returns single final response
return this.formatter.formatToolResponse(result, ...);
```

**Needed**:
```typescript
// Option 1: Stream via callback
const result = await this.executeBrutalistAnalysisStreaming(
  analysisType,
  primaryContent,
  systemPromptSpec,
  context,
  {
    ...options,
    onPartialResult: (chunk: string) => {
      // How to send to client? MCP doesn't support this.
      this.sendPartialToolResult(chunk);
    }
  }
);

// Option 2: Return async iterator (requires MCP protocol change)
for await (const chunk of this.executeBrutalistAnalysisStreaming(...)) {
  yield { type: 'partial', content: chunk };
}
yield { type: 'complete', content: finalSummary };
```

#### B. CLI Orchestrator Level
**File**: `src/cli-agents.ts`

**Current**:
```typescript
async executeBrutalistAnalysis(...): Promise<CLIAgentResponse[]> {
  // Waits for all CLIs to complete
  const responses = await Promise.all(
    cliAgents.map(cli => this.executeSingleCLI(...))
  );
  return responses;
}
```

**Needed**:
```typescript
async *executeBrutalistAnalysisStreaming(
  ...
): AsyncGenerator<CLIAgentResponse, void, unknown> {
  // Stream as each CLI produces output
  for (const cli of cliAgents) {
    const stream = this.executeSingleCLIStreaming(cli, ...);

    for await (const chunk of stream) {
      yield { agent: cli, partial: true, content: chunk };
    }
  }
}
```

#### C. Response Formatter Level
**File**: `src/formatting/response-formatter.ts`

**Current**:
```typescript
formatToolResponse(
  result: BrutalistResponse,
  verbose: boolean,
  paginationParams: PaginationParams,
  contextId?: string
): CallToolResult
```

**Needed**:
```typescript
// Format partial results with continuation metadata
formatPartialToolResponse(
  partialContent: string,
  sequenceNumber: number,
  isComplete: boolean
): CallToolResult

// OR: Format for SSE streaming
formatSSEEvent(event: StreamingEvent): string
```

### 5.2 MCP Protocol Constraints

**The Core Problem**: MCP tool responses are **not streamable**.

From MCP SDK:
```typescript
export type ToolCallback<Args> = (
  args: Args,
  extra: RequestHandlerExtra
) => CallToolResult | Promise<CallToolResult>;
//     ↑ Single result, not AsyncIterator<CallToolResult>

export type CallToolResult = {
  content: Content[];  // ← Single array, not stream
  isError?: boolean;
};
```

**Why This Matters**:
- Tool handler **must** return complete result before client receives anything
- No way to yield partial results mid-execution
- Progress notifications are separate, not tied to content delivery

**Potential Workarounds**:

1. **Multi-Part Content Hack**
   ```typescript
   // Return multiple content blocks, each a "chunk"
   return {
     content: [
       { type: 'text', text: 'Chunk 1: Initializing...' },
       { type: 'text', text: 'Chunk 2: Found 50 issues...' },
       { type: 'text', text: 'Chunk 3: Analysis complete.' }
     ]
   };
   ```
   **Problem**: Still waits for full execution before returning.

2. **Context-ID Polling**
   ```typescript
   // Client polls with context_id to get incremental updates
   const result1 = await roast_codebase({ targetPath, context_id: undefined });
   // → Returns partial result + context_id

   const result2 = await roast_codebase({ context_id: result1.context_id });
   // → Returns next chunk

   const result3 = await roast_codebase({ context_id: result1.context_id });
   // → Returns final chunk with completion flag
   ```
   **Problem**: Requires client-side polling loop, not true streaming.

3. **Server-Sent Events (HTTP Mode)**
   ```typescript
   // MCP over HTTP + SSE for streaming
   // Client subscribes to SSE endpoint with session ID
   const eventSource = new EventSource('/sse?sessionId=abc123');
   eventSource.onmessage = (event) => {
     const chunk = JSON.parse(event.data);
     console.log('Received chunk:', chunk);
   };

   // Meanwhile, call tool normally
   const result = await roast_codebase({ targetPath, sessionId: 'abc123' });
   ```
   **Problem**: Only works for HTTP transport, not stdio (which Claude uses).

4. **Progress Notification Abuse** ⚠️
   ```typescript
   // Hijack progress notifications for content delivery
   for (const chunk of cliOutput) {
     this.server.notification({
       method: 'notifications/progress',
       params: {
         progressToken,
         message: JSON.stringify({
           type: 'content_chunk',
           data: chunk
         })
       }
     });
   }
   ```
   **Problem**: Violates MCP spec, may break clients expecting progress format.

---

## 6. Implementation Roadmap

### Phase 1: Enhanced Progress Notifications ✅ (Mostly Done)

**Goal**: Provide richer progress updates without changing protocol.

**Status**: ✅ 90% Complete

**What's Done**:
- ✅ Progress callbacks wired through CLI orchestrator
- ✅ MCP `notifications/progress` sent to clients
- ✅ Session-scoped progress tracking
- ✅ Throttled event emission to reduce noise

**What's Needed**:
- ⏳ Integrate `ProgressTracker` for milestone detection
- ⏳ Enrich progress messages with phase names and ETAs

**Implementation**:
```typescript
// In tool-handler.ts
const progressTracker = new ProgressTracker(sessionId, analysisType);

// Wire progress events
progressTracker.on('progress', (event) => {
  if (progressToken) {
    this.handleProgressUpdate(
      progressToken,
      Math.round(event.progress.overall * 100),
      100,
      `${event.phase}: ${event.milestone?.name || 'In progress'}`,
      sessionId
    );
  }
});

// Feed CLI events to tracker
const result = await this.cliOrchestrator.executeBrutalistAnalysis(..., {
  onStreamingEvent: (event) => {
    progressTracker.processEvent(event);
  }
});
```

**Benefits**:
- ✅ Works with existing MCP protocol
- ✅ No client changes needed
- ✅ Immediate value for users
- ❌ Still waits for full analysis before returning content

---

### Phase 2: Context-ID Based Incremental Delivery ⏳

**Goal**: Allow clients to poll for incremental results.

**Status**: ⏳ Not Started

**Design**:
```typescript
// Client workflow
const result1 = await roast_codebase({ targetPath: '/src' });
// Returns:
// {
//   content: [{ text: '[Partial] Initialized analysis...' }],
//   context_id: 'abc123',
//   metadata: { partial: true, progress: 10 }
// }

const result2 = await roast_codebase({ context_id: 'abc123', resume: true });
// Returns:
// {
//   content: [{ text: '[Partial] Found 15 security issues...' }],
//   context_id: 'abc123',
//   metadata: { partial: true, progress: 45 }
// }

const final = await roast_codebase({ context_id: 'abc123', resume: true });
// Returns:
// {
//   content: [{ text: '[Complete] Analysis finished. Full report...' }],
//   context_id: 'abc123',
//   metadata: { partial: false, progress: 100 }
// }
```

**Implementation Steps**:

1. **Modify Response Cache** (`src/utils/response-cache.ts`)
   ```typescript
   interface CachedResponse {
     content: string;
     partial: boolean;        // ← New: Is this a partial result?
     sequenceNumber: number;  // ← New: Chunk sequence
     totalChunks?: number;    // ← New: Known total (if available)
     conversationHistory: ConversationMessage[];
     // ...
   }
   ```

2. **Background Analysis with Chunking** (`src/handlers/tool-handler.ts`)
   ```typescript
   async handleRoastTool(config: ToolConfig, args: any, extra: any) {
     const contextId = this.generateContextId();

     // Start analysis in background
     this.startBackgroundAnalysis(
       contextId,
       config,
       args,
       (chunk: string, progress: number) => {
         // Cache each chunk as it arrives
         this.responseCache.setPartial(contextId, chunk, progress);
       }
     );

     // Return immediately with first partial result
     return this.formatter.formatPartialToolResponse(
       'Analysis started...',
       contextId,
       { partial: true, progress: 0 }
     );
   }
   ```

3. **Polling Handler**
   ```typescript
   // When context_id + resume provided
   if (args.context_id && args.resume) {
     const cached = await this.responseCache.getLatestPartial(args.context_id);

     if (!cached) {
       throw new Error('Analysis not found or expired');
     }

     return this.formatter.formatPartialToolResponse(
       cached.content,
       args.context_id,
       {
         partial: !cached.complete,
         progress: cached.progress,
         sequenceNumber: cached.sequenceNumber
       }
     );
   }
   ```

**Challenges**:
- ❌ Background analysis risks resource exhaustion (need job queue)
- ❌ Client must implement polling loop (UX friction)
- ❌ Increased cache memory usage (need TTL/eviction)
- ❌ Race conditions between analysis and polling

**Benefits**:
- ✅ Works with current MCP protocol
- ✅ Clients get incremental updates
- ✅ Backward compatible (non-polling clients get final result)

---

### Phase 3: Streaming Orchestrator Integration ⏳

**Goal**: Wire existing streaming components into main execution flow.

**Status**: ⏳ Not Started (components exist, not integrated)

**What to Connect**:
```typescript
// In tool-handler.ts
import { StreamingCLIOrchestrator } from './streaming/streaming-orchestrator.js';

class ToolHandler {
  private streamingOrchestrator: StreamingCLIOrchestrator;

  constructor(...) {
    this.streamingOrchestrator = new StreamingCLIOrchestrator({
      maxConcurrentAnalyses: 10,
      enableMetrics: true
    });
  }

  async executeBrutalistAnalysis(...) {
    // Replace current cliOrchestrator call
    const result = await this.streamingOrchestrator.executeWithStreaming(
      analysisType,
      [preferredCLI || 'auto'],
      systemPromptSpec,
      primaryContent,
      {
        ...options,
        enableProgress: true,
        enableCircuitBreaker: true,
        onStreamingEvent: (event: StreamingEvent) => {
          // Cache partial results
          if (event.type === 'agent_progress') {
            this.cachePartialResult(sessionId, event.content);
          }

          // Send progress notification
          if (progressToken) {
            this.handleProgressUpdate(
              progressToken,
              event.metadata?.progress || 0,
              100,
              event.content || '',
              sessionId
            );
          }
        }
      }
    );

    return this.convertStreamingResult(result);
  }
}
```

**Required Changes**:

1. **Add `onStreamingEvent` to CLIAgentOptions**
   ```typescript
   // In cli-agents.ts
   export interface CLIAgentOptions {
     // ...existing fields
     onStreamingEvent?: (event: StreamingEvent) => void;
   }
   ```

2. **Wire Events Through spawnAsync**
   ```typescript
   // In cli-agents.ts
   async function spawnAsync(..., options: { onStreamingEvent?: ... }) {
     child.stdout?.on('data', (data) => {
       const chunk = data.toString();
       stdout += chunk;

       if (options.onStreamingEvent) {
         options.onStreamingEvent({
           type: 'agent_progress',
           agent: command as any,
           content: chunk,
           timestamp: Date.now()
         });
       }
     });
   }
   ```

3. **Route Events to Intelligent Buffer**
   ```typescript
   // In streaming-orchestrator.ts
   const buffer = new IntelligentBuffer();

   const enhancedOptions = {
     ...options,
     onStreamingEvent: (event: StreamingEvent) => {
       // Add to priority buffer
       buffer.add(event);

       // Flush when appropriate
       const batch = buffer.flush(event.sessionId!);
       if (batch) {
         // Deliver batch to client (Phase 4)
       }
     }
   };
   ```

**Benefits**:
- ✅ Activates all built streaming infrastructure
- ✅ Circuit breaker protection
- ✅ Smart buffering and throttling
- ✅ Milestone-based progress tracking
- ❌ Still can't deliver to client mid-execution (need Phase 4)

---

### Phase 4: True Streaming Protocol (Future)

**Goal**: Implement true streaming tool responses.

**Status**: 🔴 Blocked on MCP protocol support

**What's Needed from MCP SDK**:

1. **Streaming Tool Callback Signature**
   ```typescript
   // Proposed API
   export type StreamingToolCallback<Args> = (
     args: Args,
     extra: RequestHandlerExtra
   ) => AsyncIterator<CallToolChunk> | Promise<CallToolResult>;

   export interface CallToolChunk {
     content: Content[];
     sequenceNumber: number;
     isComplete: boolean;
     metadata?: {
       progress?: number;
       phase?: string;
       estimatedCompletion?: number;
     };
   }
   ```

2. **Client-Side Streaming API**
   ```typescript
   // Client receives chunks as they arrive
   for await (const chunk of client.callToolStreaming('roast_codebase', { targetPath: '/src' })) {
     if (chunk.isComplete) {
       console.log('Analysis complete!');
       break;
     }
     console.log('Partial result:', chunk.content);
   }
   ```

3. **Transport Layer Support**
   - Stdio: Need to multiplex chunks with other messages
   - HTTP: Use chunked transfer encoding or SSE
   - WebSocket: Native streaming support

**Implementation (Once Protocol Exists)**:
```typescript
// In tool-handler.ts
this.server.tool(
  'roast_codebase',
  'Brutal codebase critique',
  schema,
  async function* (args, extra) {  // ← Generator function
    const sessionId = extra.sessionId;
    let sequenceNumber = 0;

    // Start streaming analysis
    const stream = this.cliOrchestrator.executeBrutalistAnalysisStreaming(...);

    for await (const chunk of stream) {
      yield {
        content: [{ type: 'text', text: chunk.content }],
        sequenceNumber: sequenceNumber++,
        isComplete: false,
        metadata: {
          progress: chunk.progress,
          phase: chunk.phase
        }
      };
    }

    // Final chunk
    yield {
      content: [{ type: 'text', text: 'Analysis complete.' }],
      sequenceNumber: sequenceNumber++,
      isComplete: true,
      metadata: { progress: 100 }
    };
  }
);
```

**Timeline**: Unknown - depends on MCP protocol evolution.

---

## 7. Performance Considerations

### 7.1 Memory Management

**Current Limits**:
```typescript
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;  // 10MB per CLI process
const MAX_MEMORY_MB = 2048;                 // 2GB per process
```

**Streaming Impact**:
- ✅ **Reduced Peak Memory**: Don't need to buffer entire CLI output
- ✅ **Controlled Growth**: Circular buffers prevent unbounded growth
- ❌ **Cache Pressure**: Storing partial results increases cache size

**Mitigation**:
```typescript
// In intelligent-buffer.ts
class IntelligentBuffer {
  private readonly MAX_MEMORY_MB = 50;  // Per session

  private handleMemoryPressure(sessionId: string): void {
    // Drop low-priority events first
    const buffer = this.buffers.get(sessionId);
    buffer.dequeueAll('low');

    // Enable backpressure to slow down CLI
    state.backpressure = true;
  }
}
```

### 7.2 Throughput & Latency

**CLI Output Characteristics**:
- **Codex**: Bursty, large JSON chunks (KB-MB per event)
- **Claude**: Steady stream, small deltas (bytes per event)
- **Gemini**: Variable, plain text (lines per event)

**Buffering Strategy**:
```typescript
// Adaptive throttling based on CLI type
const BUFFERING_RULES = {
  claude: { delay: 50, maxBatch: 50 },   // High frequency, small chunks
  codex: { delay: 200, maxBatch: 5 },    // Low frequency, large chunks
  gemini: { delay: 100, maxBatch: 10 }   // Medium
};
```

**Network Impact**:
- **Stdio Transport**: Single-threaded, message-at-a-time
- **HTTP Transport**: Concurrent, multiplexed SSE streams

**Optimization**:
```typescript
// Compress large events
if (event.content.length > 10000) {
  event.content = zlib.gzipSync(event.content).toString('base64');
  event.compressed = true;
}
```

### 7.3 CPU Usage

**Parsing Overhead**:
- NDJSON parsing: ~0.1ms per event
- Pattern matching: ~0.5ms per chunk (regex-heavy)
- Event classification: ~0.01ms per event

**Throttling Impact**:
- Without throttling: 1000+ events/sec → CPU spike
- With throttling: 10-50 events/sec → negligible

**Recommendation**: Current throttling is sufficient.

### 7.4 Concurrent Analyses

**Current Limit**: `MAX_CONCURRENT_CLIS = 3`

**With Streaming**:
- Each streaming analysis maintains:
  - 1 CLI process (2GB memory)
  - 1 progress tracker (~10KB)
  - 1 session buffer (~1-50MB)
  - 1 event backlog (~5MB)

**Resource Calculation**:
```
Per Analysis: ~2GB + 55MB = 2055MB
Max Concurrent: 3 analyses
Total Peak: ~6.2GB

Recommendation: Keep MAX_CONCURRENT_CLIS = 3 for safety
```

**Alternative**: Queue-based execution
```typescript
class StreamingOrchestrator {
  private analysisQueue = new PQueue({ concurrency: 3 });

  async executeWithStreaming(...) {
    return this.analysisQueue.add(() => this._execute(...));
  }
}
```

---

## 8. Error Handling

### 8.1 Partial Failure Scenarios

**Scenario 1: CLI Crashes Mid-Execution**
```typescript
// Detection
child.on('close', (code) => {
  if (code !== 0 && !analysisComplete) {
    this.emitStreamingEvent({
      type: 'agent_error',
      content: `CLI exited unexpectedly: code ${code}`
    });
  }
});

// Recovery
// - Flush any buffered partial output
// - Mark analysis as incomplete
// - Cache partial results for resume
```

**Scenario 2: Timeout During Streaming**
```typescript
// Graceful timeout
setTimeout(() => {
  if (!analysisComplete) {
    // Kill CLI but preserve partial results
    child.kill('SIGTERM');

    // Cache what we have so far
    this.responseCache.setPartial(contextId, partialOutput, {
      incomplete: true,
      reason: 'timeout'
    });
  }
}, TIMEOUT);
```

**Scenario 3: Memory Exhaustion**
```typescript
// Backpressure handling
if (state.memoryUsage > MAX_MEMORY) {
  // Drop low-priority events
  buffer.dequeueAll('low');

  // Slow down CLI (send SIGSTOP? or just drop events)
  state.backpressure = true;
}
```

### 8.2 Cache Consistency

**Problem**: Partial results in cache may become stale.

**Solution**: Cache invalidation strategy
```typescript
interface CachedPartialResult {
  content: string;
  sequenceNumber: number;
  timestamp: number;
  ttl: number;  // Shorter TTL for partials (5 min vs 2 hrs)
}

// Cleanup stale partials
setInterval(() => {
  for (const [contextId, cached] of this.partialCache) {
    if (Date.now() - cached.timestamp > cached.ttl) {
      this.partialCache.delete(contextId);
    }
  }
}, 60000);
```

### 8.3 Circuit Breaker Integration

**Current State**: Circuit breakers exist but not fully integrated.

**How to Use**:
```typescript
// In streaming-orchestrator.ts
const circuitBreaker = this.circuitBreakers.get(agent);

const response = await circuitBreaker.execute(async () => {
  return await this.cliOrchestrator.executeSingleCLI(...);
}, {
  id: `${agent}_${sessionId}`,
  fallback: new CachedResponseFallback(this.responseCache)
});
```

**Fallback Strategy**:
1. **Cached Response**: Return previous successful result
2. **Degraded Service**: Return partial result from other agents
3. **Error Message**: Return structured error with retry guidance

**State Transitions**:
```
CLOSED (normal)
  ↓ 5 failures
OPEN (blocking requests)
  ↓ 30s recovery period
HALF_OPEN (testing)
  ↓ 3 successes
CLOSED
```

### 8.4 Client-Side Error Handling

**Polling Errors**:
```typescript
// Client should handle these cases
try {
  const result = await roast_codebase({ context_id: 'abc123', resume: true });
} catch (error) {
  if (error.code === 'CONTEXT_EXPIRED') {
    // Re-run analysis from scratch
  } else if (error.code === 'ANALYSIS_FAILED') {
    // Show error, offer retry
  } else if (error.code === 'TIMEOUT') {
    // Offer to wait longer or cancel
  }
}
```

**Progress Notification Errors**:
- Silently dropped (notifications are best-effort)
- No retry mechanism
- Client should not depend on receiving all notifications

---

## 9. Testing Strategy

### 9.1 Unit Tests

**Test Files**:
```
tests/unit/streaming/
├── progress-tracker.test.ts
├── intelligent-buffer.test.ts
├── output-parser.test.ts
└── circuit-breaker.test.ts
```

**Key Test Cases**:

1. **Progress Tracker**
   ```typescript
   it('should detect phase transitions from CLI output', () => {
     const tracker = new ProgressTracker('session1', 'roast_codebase');

     tracker.processEvent({
       type: 'agent_progress',
       content: 'Analyzing architecture...',
       agent: 'claude',
       timestamp: Date.now()
     });

     expect(tracker.getState().currentPhase).toBe(AnalysisPhase.ANALYZING);
   });

   it('should calculate ETA based on milestone completion', () => {
     // Complete 2 of 5 milestones
     // Should estimate 60% remaining time
   });
   ```

2. **Intelligent Buffer**
   ```typescript
   it('should prioritize critical findings over debug info', () => {
     buffer.add({ type: 'debug_info', ... });
     buffer.add({ type: 'critical_finding', ... });

     const batch = buffer.flush('session1');

     expect(batch.events[0].type).toBe('critical_finding');
   });

   it('should apply backpressure when memory limit exceeded', () => {
     // Fill buffer beyond MAX_MEMORY_MB
     // Verify low-priority events dropped
   });
   ```

3. **Output Parser**
   ```typescript
   it('should preserve markdown formatting across chunks', () => {
     const parser = new OutputParser();

     const chunk1 = '## Security\n\n### Critical: ';
     const chunk2 = 'SQL Injection\n\nDetails...';

     parser.addChunk(chunk1);
     parser.addChunk(chunk2);

     const findings = parser.getFindings();
     expect(findings[0].title).toBe('SQL Injection');
   });
   ```

### 9.2 Integration Tests

**Test Scenarios**:

1. **End-to-End Streaming**
   ```typescript
   it('should deliver incremental results during CLI execution', async () => {
     const chunks: string[] = [];

     await roast_codebase({
       targetPath: '/test/fixtures/simple-project',
       onPartialResult: (chunk) => chunks.push(chunk)
     });

     expect(chunks.length).toBeGreaterThan(1);
     expect(chunks[0]).toContain('Initializing');
     expect(chunks[chunks.length - 1]).toContain('complete');
   });
   ```

2. **Progress Notification Flow**
   ```typescript
   it('should send progress notifications to client', async () => {
     const progressUpdates: number[] = [];

     const mockServer = {
       notification: (msg) => {
         if (msg.method === 'notifications/progress') {
           progressUpdates.push(msg.params.progress);
         }
       }
     };

     await runAnalysisWithMockServer(mockServer);

     expect(progressUpdates.length).toBeGreaterThan(3);
     expect(progressUpdates).toEqual([10, 25, 50, 75, 100]);
   });
   ```

3. **Circuit Breaker Fallback**
   ```typescript
   it('should use cached result when CLI fails repeatedly', async () => {
     // Simulate 5 consecutive CLI failures
     mockCLI.mockRejectedValue(new Error('CLI crashed'));

     // First call fails
     await expect(roast_codebase({ targetPath: '/src' })).rejects.toThrow();

     // Sixth call should use fallback
     const result = await roast_codebase({ targetPath: '/src' });
     expect(result.content[0].text).toContain('[Fallback]');
   });
   ```

### 9.3 Performance Tests

**Load Testing**:
```typescript
it('should handle 100 concurrent analyses without OOM', async () => {
  const analyses = Array(100).fill(null).map((_, i) =>
    roast_codebase({
      targetPath: `/test/fixtures/project-${i}`,
      sessionId: `session-${i}`
    })
  );

  await Promise.all(analyses);

  const memoryUsage = process.memoryUsage().heapUsed;
  expect(memoryUsage).toBeLessThan(8 * 1024 * 1024 * 1024); // 8GB
});
```

**Latency Testing**:
```typescript
it('should deliver first chunk within 5 seconds', async () => {
  const startTime = Date.now();
  let firstChunkTime = 0;

  await roast_codebase({
    targetPath: '/large/project',
    onPartialResult: (chunk) => {
      if (firstChunkTime === 0) {
        firstChunkTime = Date.now() - startTime;
      }
    }
  });

  expect(firstChunkTime).toBeLessThan(5000);
});
```

---

## 10. Recommendations

### 10.1 Short-Term (Next Sprint)

**Priority 1: Integrate Progress Tracker** ⏱️ **2-3 days**
- Wire `ProgressTracker` into existing progress notification flow
- Add milestone definitions for all analysis types
- Enrich progress messages with phase and ETA

**Priority 2: Enhanced Progress Messages** ⏱️ **1 day**
- Include analysis phase in progress notifications
- Add estimated time remaining
- Show current milestone name

**Priority 3: Streaming Event Consolidation** ⏱️ **2 days**
- Route all CLI events through `IntelligentBuffer`
- Apply priority-based throttling
- Enable event coalescence

**Expected Outcome**: Users see much richer progress updates, no protocol changes needed.

---

### 10.2 Medium-Term (Next Month)

**Priority 1: Context-ID Polling** ⏱️ **1 week**
- Implement partial result caching
- Add `partial` flag to tool responses
- Enable polling with `context_id + resume`

**Priority 2: Background Analysis** ⏱️ **1 week**
- Job queue for long-running analyses
- Detach CLI execution from request handling
- Cache partial results incrementally

**Priority 3: Streaming Orchestrator Integration** ⏱️ **3-4 days**
- Replace current orchestrator calls with streaming version
- Enable circuit breaker protection
- Activate all streaming components

**Expected Outcome**: Clients can poll for incremental updates, long-running analyses don't block.

---

### 10.3 Long-Term (Future)

**If MCP Adds Streaming Support**:
1. Refactor tool callbacks to return `AsyncIterator<CallToolChunk>`
2. Implement client-side streaming API
3. Remove polling workarounds
4. Full end-to-end streaming

**If MCP Doesn't Add Streaming**:
1. Continue with context-ID polling approach
2. Consider custom transport (WebSocket) for streaming use cases
3. Document limitations in user guide

---

## 11. Conclusion

### Current State Summary

✅ **What Works**:
- MCP progress notifications with session tracking
- Real-time CLI output capture via `onProgress` callback
- Comprehensive streaming infrastructure (built but not integrated)
- Throttled event emission to reduce noise

⏳ **What's Partially Done**:
- Progress tracking (exists but not milestone-aware)
- Event buffering (exists but not wired into main flow)
- Session management (exists for HTTP mode only)

❌ **What Doesn't Work**:
- Incremental result delivery to clients
- Streaming tool responses (protocol limitation)
- Background analyses with partial caching

### Key Blockers

1. **MCP Protocol Limitation**: No streaming tool response mechanism
2. **Integration Gap**: Streaming components not connected to main execution flow
3. **Client Support**: Polling requires client-side implementation

### Recommended Next Steps

1. **Immediate** (this week):
   - Integrate `ProgressTracker` into existing progress notifications
   - Enrich progress messages with milestones and ETAs

2. **Short-term** (this month):
   - Implement context-ID based polling
   - Enable partial result caching
   - Wire streaming orchestrator into tool handler

3. **Long-term** (future):
   - Monitor MCP protocol evolution for streaming support
   - Consider custom transport for advanced streaming use cases
   - Continuously optimize buffering and throttling strategies

### Final Thoughts

The Brutalist MCP server has **excellent streaming infrastructure** already built, but it's **not yet integrated** into the main execution flow. The main blocker is the **MCP protocol's lack of streaming tool responses**.

In the short term, **enhanced progress notifications** and **context-ID polling** provide the best path forward, offering incremental results without protocol changes. The long-term solution depends on the MCP protocol adding native streaming support.

---

**Document Version**: 1.0
**Last Updated**: 2026-02-01
**Author**: Claude (Streaming Systems Engineer)
**Status**: Living Document - Update as implementation progresses
