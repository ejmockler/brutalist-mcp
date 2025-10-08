import { logger } from '../logger.js';
import { StreamingEvent } from '../cli-agents.js';

/**
 * Parser state for tracking CLI output phases
 */
export interface ParserState {
  phase: 'starting' | 'thinking' | 'analyzing' | 'outputting' | 'complete';
  agent: string;
  sessionId?: string;
  bufferSize: number;
  processedChunks: number;
  lastEventTime: number;
}

/**
 * Semantic boundary detection result
 */
interface BoundaryResult {
  complete: string[];
  remaining: string;
}

/**
 * Content classification for streaming events
 */
interface ContentClassification {
  type: 'finding' | 'progress' | 'debug' | 'error' | 'milestone';
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info';
  confidence: number; // 0-1
}

/**
 * Streaming parser interface for real-time CLI output processing
 */
export interface StreamingParser {
  parse(chunk: string, agent: string): StreamingEvent[];
  flush(): StreamingEvent[];
  getState(): ParserState;
  reset(): void;
}

/**
 * Advanced semantic output parser with boundary detection and content classification
 * 
 * Key features:
 * - State machine tracking for CLI phases
 * - Sentence/paragraph boundary detection
 * - Content classification (findings vs debug info)
 * - Streaming tokenization with incomplete sentence handling
 * - Memory-efficient circular buffering
 */
export class SemanticOutputParser implements StreamingParser {
  private buffer = '';
  private state: ParserState;
  
  // Boundary detection patterns for clean chunking
  private readonly BOUNDARY_PATTERNS = {
    sentence: /([.!?]+)\s+(?=[A-Z])/g,
    paragraph: /\n\s*\n/g,
    codeBlock: /```[\s\S]*?```/g,
    listItem: /^\s*[-*+]\s+/gm,
    numberedItem: /^\s*\d+\.\s+/gm
  };
  
  // Content classification patterns
  private readonly CLASSIFICATION_PATTERNS = {
    finding: {
      critical: /\b(CRITICAL|SECURITY|VULNERABILITY|EXPLOIT|DANGEROUS)\b/i,
      high: /\b(ERROR|WARNING|ISSUE|PROBLEM|BUG|FAIL)\b/i,
      medium: /\b(CONCERN|RISK|POTENTIAL|IMPROVE|OPTIMIZE)\b/i,
      low: /\b(SUGGESTION|CONSIDER|MINOR|STYLE)\b/i,
      info: /\b(INFO|NOTE|TIP|FOUND|DETECTED)\b/i
    },
    progress: /\b(ANALYZING|SCANNING|PROCESSING|CHECKING|LOADING)\b/i,
    debug: /\b(DEBUG|TRACE|VERBOSE|LOG)\b/i,
    error: /\b(FAILED|CRASHED|TIMEOUT|EXCEPTION)\b/i,
    milestone: /\b(COMPLETED?|FINISHED|DONE|SUCCESS|STARTED?)\b/i
  };
  
  // Phase transition patterns
  private readonly PHASE_PATTERNS = {
    starting: /\b(starting|initializing|beginning|loading)\b/i,
    thinking: /\b(thinking|considering|planning|preparing)\b/i,
    analyzing: /\b(analyzing|examining|reviewing|checking)\b/i,
    outputting: /\b(found|detected|identified|discovered)\b/i,
    complete: /\b(complete|finished|done|analysis complete)\b/i
  };
  
  constructor(agent: string, sessionId?: string) {
    this.state = {
      phase: 'starting',
      agent,
      sessionId,
      bufferSize: 0,
      processedChunks: 0,
      lastEventTime: Date.now()
    };
  }
  
  /**
   * Parse incoming CLI output chunk into semantic streaming events
   */
  parse(chunk: string, agent: string): StreamingEvent[] {
    if (!chunk || chunk.trim().length === 0) {
      return [];
    }
    
    this.buffer += chunk;
    this.state.bufferSize = this.buffer.length;
    this.state.processedChunks++;
    this.state.lastEventTime = Date.now();
    
    const events: StreamingEvent[] = [];
    
    // Update parser state based on content
    this.updatePhase(chunk);
    
    // Extract complete semantic units
    const boundaries = this.detectBoundaries(this.buffer);
    
    for (const segment of boundaries.complete) {
      const event = this.createEventFromSegment(segment, agent);
      if (event) {
        events.push(event);
      }
    }
    
    // Keep remaining incomplete content in buffer
    this.buffer = boundaries.remaining;
    this.state.bufferSize = this.buffer.length;
    
    // Prevent buffer overflow
    if (this.buffer.length > 8192) { // 8KB limit
      logger.warn(`Parser buffer overflow for ${agent}, flushing incomplete content`);
      const flushEvents = this.flush();
      events.push(...flushEvents);
    }
    
    return events;
  }
  
  /**
   * Flush any remaining content as final events
   */
  flush(): StreamingEvent[] {
    if (!this.buffer.trim()) {
      return [];
    }
    
    logger.debug(`Flushing remaining ${this.buffer.length} chars for ${this.state.agent}`);
    
    const event = this.createEventFromSegment(this.buffer, this.state.agent);
    this.buffer = '';
    this.state.bufferSize = 0;
    this.state.phase = 'complete';
    
    return event ? [event] : [];
  }
  
  /**
   * Get current parser state
   */
  getState(): ParserState {
    return { ...this.state };
  }
  
  /**
   * Reset parser to initial state
   */
  reset(): void {
    this.buffer = '';
    this.state = {
      phase: 'starting',
      agent: this.state.agent,
      sessionId: this.state.sessionId,
      bufferSize: 0,
      processedChunks: 0,
      lastEventTime: Date.now()
    };
  }
  
  /**
   * Detect semantic boundaries in text for clean chunking
   */
  private detectBoundaries(text: string): BoundaryResult {
    const complete: string[] = [];
    let remaining = text;
    
    // First, extract complete code blocks (highest priority)
    const codeBlocks: string[] = [];
    remaining = remaining.replace(this.BOUNDARY_PATTERNS.codeBlock, (match) => {
      codeBlocks.push(match);
      return '\n__CODE_BLOCK__\n';
    });
    
    // Extract complete paragraphs
    const paragraphs = remaining.split(this.BOUNDARY_PATTERNS.paragraph);
    
    for (let i = 0; i < paragraphs.length - 1; i++) {
      const paragraph = paragraphs[i].trim();
      if (paragraph) {
        // Restore code blocks
        const restored = this.restoreCodeBlocks(paragraph, codeBlocks);
        complete.push(restored);
      }
    }
    
    // Check if last paragraph is complete (ends with sentence boundary)
    const lastParagraph = paragraphs[paragraphs.length - 1];
    if (lastParagraph && this.isCompleteSentence(lastParagraph)) {
      const restored = this.restoreCodeBlocks(lastParagraph.trim(), codeBlocks);
      complete.push(restored);
      remaining = '';
    } else {
      remaining = this.restoreCodeBlocks(lastParagraph || '', codeBlocks);
    }
    
    return { complete, remaining };
  }
  
  /**
   * Check if text ends with complete sentence
   */
  private isCompleteSentence(text: string): boolean {
    const trimmed = text.trim();
    return /[.!?]$/.test(trimmed) || /```\s*$/.test(trimmed);
  }
  
  /**
   * Restore code blocks in text
   */
  private restoreCodeBlocks(text: string, codeBlocks: string[]): string {
    let index = 0;
    return text.replace(/\n__CODE_BLOCK__\n/g, () => {
      return codeBlocks[index++] || '';
    });
  }
  
  /**
   * Update parser phase based on content analysis
   */
  private updatePhase(content: string): void {
    for (const [phase, pattern] of Object.entries(this.PHASE_PATTERNS)) {
      if (pattern.test(content)) {
        this.state.phase = phase as ParserState['phase'];
        break;
      }
    }
  }
  
  /**
   * Create streaming event from text segment
   */
  private createEventFromSegment(segment: string, agent: string): StreamingEvent | null {
    const trimmed = segment.trim();
    if (!trimmed) {
      return null;
    }
    
    const classification = this.classifyContent(trimmed);
    
    // Filter out low-value debug content
    if (classification.type === 'debug' && classification.confidence < 0.5) {
      return null;
    }
    
    // Determine event type based on classification
    let eventType: StreamingEvent['type'] = 'agent_progress';
    if (classification.type === 'finding') {
      eventType = 'agent_progress'; // Findings are progress updates with metadata
    } else if (classification.type === 'error') {
      eventType = 'agent_error';
    } else if (classification.type === 'milestone') {
      eventType = this.state.phase === 'complete' ? 'agent_complete' : 'agent_progress';
    }
    
    return {
      type: eventType,
      agent: agent as 'claude' | 'codex' | 'gemini',
      content: trimmed,
      timestamp: Date.now(),
      sessionId: this.state.sessionId,
      metadata: {
        phase: this.state.phase,
        severity: classification.severity,
        contentType: classification.type,
        confidence: classification.confidence,
        bufferSize: this.state.bufferSize,
        processedChunks: this.state.processedChunks
      }
    };
  }
  
  /**
   * Classify content to determine event type and severity
   */
  private classifyContent(content: string): ContentClassification {
    // Check for findings with severity
    for (const [severity, pattern] of Object.entries(this.CLASSIFICATION_PATTERNS.finding)) {
      if (pattern.test(content)) {
        return {
          type: 'finding',
          severity: severity as ContentClassification['severity'],
          confidence: 0.9
        };
      }
    }
    
    // Check for other content types
    if (this.CLASSIFICATION_PATTERNS.progress.test(content)) {
      return { type: 'progress', confidence: 0.8 };
    }
    
    if (this.CLASSIFICATION_PATTERNS.error.test(content)) {
      return { type: 'error', confidence: 0.9 };
    }
    
    if (this.CLASSIFICATION_PATTERNS.milestone.test(content)) {
      return { type: 'milestone', confidence: 0.7 };
    }
    
    if (this.CLASSIFICATION_PATTERNS.debug.test(content)) {
      return { type: 'debug', confidence: 0.6 };
    }
    
    // Default classification
    return { type: 'progress', confidence: 0.5 };
  }
}

/**
 * Factory for creating parsers optimized for different CLI agents
 */
export class ParserFactory {
  /**
   * Create parser optimized for specific CLI agent
   */
  static createParser(agent: 'claude' | 'codex' | 'gemini', sessionId?: string): StreamingParser {
    switch (agent) {
      case 'claude':
        return new ClaudeOptimizedParser(agent, sessionId);
      case 'codex':
        return new CodexOptimizedParser(agent, sessionId);
      case 'gemini':
        return new GeminiOptimizedParser(agent, sessionId);
      default:
        return new SemanticOutputParser(agent, sessionId);
    }
  }
}

/**
 * Claude-optimized parser (handles thinking blocks and stream-json format)
 */
class ClaudeOptimizedParser extends SemanticOutputParser {
  private readonly CLAUDE_PATTERNS = {
    thinking: /<thinking>[\s\S]*?<\/thinking>/g,
    streamJson: /^data: (.+)$/gm
  };
  
  parse(chunk: string, agent: string): StreamingEvent[] {
    // Handle Claude's stream-json format
    let processedChunk = chunk;
    const streamJsonMatches = chunk.match(this.CLAUDE_PATTERNS.streamJson);
    if (streamJsonMatches) {
      processedChunk = streamJsonMatches
        .map(match => {
          try {
            const jsonStr = match.replace(/^data: /, '');
            const data = JSON.parse(jsonStr);
            return data.content || '';
          } catch {
            return '';
          }
        })
        .join(' ');
    }
    
    // Remove thinking blocks (internal reasoning)
    processedChunk = processedChunk.replace(this.CLAUDE_PATTERNS.thinking, '');
    
    return super.parse(processedChunk, agent);
  }
}

/**
 * Codex-optimized parser (handles JSON structured output)
 */
class CodexOptimizedParser extends SemanticOutputParser {
  parse(chunk: string, agent: string): StreamingEvent[] {
    // Codex outputs structured JSON, extract assistant messages
    try {
      const lines = chunk.split('\n').filter(line => line.trim());
      let extractedContent = '';
      
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.type === 'assistant' && data.content) {
            extractedContent += data.content + '\n';
          }
        } catch {
          // Not JSON, treat as raw text
          extractedContent += line + '\n';
        }
      }
      
      return super.parse(extractedContent, agent);
    } catch {
      // Fallback to regular parsing
      return super.parse(chunk, agent);
    }
  }
}

/**
 * Gemini-optimized parser (handles markdown and structured output)
 */
class GeminiOptimizedParser extends SemanticOutputParser {
  private readonly GEMINI_PATTERNS = {
    metadata: /^(\*\*|##|\s*-\s*)/gm,
    thinking: /\[THINKING:[\s\S]*?\]/g
  };
  
  parse(chunk: string, agent: string): StreamingEvent[] {
    // Remove Gemini's thinking annotations
    let processedChunk = chunk.replace(this.GEMINI_PATTERNS.thinking, '');
    
    // Gemini often uses markdown formatting, preserve structure
    return super.parse(processedChunk, agent);
  }
}