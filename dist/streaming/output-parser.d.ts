/**
 * @module output-parser
 * @deprecated NOT INTEGRATED -- This module provides semantic CLI output
 * parsing for the unintegrated StreamingCLIOrchestrator. The canonical
 * streaming path decodes CLI output via per-provider adapters in
 * src/cli-adapters/ (e.g., ClaudeAdapter.decodeOutput). Retained for possible
 * future integration. See src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
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
 * Streaming parser interface for real-time CLI output processing
 */
export interface StreamingParser {
    parse(chunk: string, agent: string): StreamingEvent[];
    flush(): StreamingEvent[];
    getState(): ParserState;
    reset(): void;
}
/**
 * Advanced semantic output parser with boundary detection and content classification.
 *
 * Key features:
 * - State machine tracking for CLI phases
 * - Sentence/paragraph boundary detection
 * - Content classification (findings vs debug info)
 * - Streaming tokenization with incomplete sentence handling
 * - Memory-efficient circular buffering
 *
 * @deprecated NOT INTEGRATED -- The canonical streaming path decodes CLI
 * output via per-provider adapters in src/cli-adapters/. This parser is not
 * used by any production code path.
 */
export declare class SemanticOutputParser implements StreamingParser {
    private buffer;
    private state;
    private readonly BOUNDARY_PATTERNS;
    private readonly CLASSIFICATION_PATTERNS;
    private readonly PHASE_PATTERNS;
    constructor(agent: string, sessionId?: string);
    /**
     * Parse incoming CLI output chunk into semantic streaming events
     */
    parse(chunk: string, agent: string): StreamingEvent[];
    /**
     * Flush any remaining content as final events
     */
    flush(): StreamingEvent[];
    /**
     * Get current parser state
     */
    getState(): ParserState;
    /**
     * Reset parser to initial state
     */
    reset(): void;
    /**
     * Detect semantic boundaries in text for clean chunking
     */
    private detectBoundaries;
    /**
     * Check if text ends with complete sentence
     */
    private isCompleteSentence;
    /**
     * Restore code blocks in text
     */
    private restoreCodeBlocks;
    /**
     * Update parser phase based on content analysis
     */
    private updatePhase;
    /**
     * Create streaming event from text segment
     */
    private createEventFromSegment;
    /**
     * Classify content to determine event type and severity
     */
    private classifyContent;
}
/**
 * Factory for creating parsers optimized for different CLI agents.
 *
 * @deprecated NOT INTEGRATED -- See SemanticOutputParser deprecation note.
 */
export declare class ParserFactory {
    /**
     * Create parser optimized for specific CLI agent
     */
    static createParser(agent: 'claude' | 'codex' | 'agy', sessionId?: string): StreamingParser;
}
//# sourceMappingURL=output-parser.d.ts.map