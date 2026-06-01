/**
 * @module output-parser
 * @deprecated NOT INTEGRATED -- This module provides semantic CLI output
 * parsing for the unintegrated StreamingCLIOrchestrator. The canonical
 * streaming path decodes CLI output via per-provider adapters in
 * src/cli-adapters/ (e.g., ClaudeAdapter.decodeOutput). Retained for possible
 * future integration. See src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
import { logger } from '../logger.js';
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
export class SemanticOutputParser {
    buffer = '';
    state;
    // Boundary detection patterns for clean chunking
    BOUNDARY_PATTERNS = {
        sentence: /([.!?]+)\s+(?=[A-Z])/g,
        paragraph: /\n\s*\n/g,
        codeBlock: /```[\s\S]*?```/g,
        listItem: /^\s*[-*+]\s+/gm,
        numberedItem: /^\s*\d+\.\s+/gm
    };
    // Content classification patterns
    CLASSIFICATION_PATTERNS = {
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
    PHASE_PATTERNS = {
        starting: /\b(starting|initializing|beginning|loading)\b/i,
        thinking: /\b(thinking|considering|planning|preparing)\b/i,
        analyzing: /\b(analyzing|examining|reviewing|checking)\b/i,
        outputting: /\b(found|detected|identified|discovered)\b/i,
        complete: /\b(complete|finished|done|analysis complete)\b/i
    };
    constructor(agent, sessionId) {
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
    parse(chunk, agent) {
        if (!chunk || chunk.trim().length === 0) {
            return [];
        }
        this.buffer += chunk;
        this.state.bufferSize = this.buffer.length;
        this.state.processedChunks++;
        this.state.lastEventTime = Date.now();
        const events = [];
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
    flush() {
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
    getState() {
        return { ...this.state };
    }
    /**
     * Reset parser to initial state
     */
    reset() {
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
    detectBoundaries(text) {
        const complete = [];
        let remaining = text;
        // First, extract complete code blocks (highest priority)
        const codeBlocks = [];
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
        }
        else {
            remaining = this.restoreCodeBlocks(lastParagraph || '', codeBlocks);
        }
        return { complete, remaining };
    }
    /**
     * Check if text ends with complete sentence
     */
    isCompleteSentence(text) {
        const trimmed = text.trim();
        return /[.!?]$/.test(trimmed) || /```\s*$/.test(trimmed);
    }
    /**
     * Restore code blocks in text
     */
    restoreCodeBlocks(text, codeBlocks) {
        let index = 0;
        return text.replace(/\n__CODE_BLOCK__\n/g, () => {
            return codeBlocks[index++] || '';
        });
    }
    /**
     * Update parser phase based on content analysis
     */
    updatePhase(content) {
        for (const [phase, pattern] of Object.entries(this.PHASE_PATTERNS)) {
            if (pattern.test(content)) {
                this.state.phase = phase;
                break;
            }
        }
    }
    /**
     * Create streaming event from text segment
     */
    createEventFromSegment(segment, agent) {
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
        let eventType = 'agent_progress';
        if (classification.type === 'finding') {
            eventType = 'agent_progress'; // Findings are progress updates with metadata
        }
        else if (classification.type === 'error') {
            eventType = 'agent_error';
        }
        else if (classification.type === 'milestone') {
            eventType = this.state.phase === 'complete' ? 'agent_complete' : 'agent_progress';
        }
        return {
            type: eventType,
            agent: agent,
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
    classifyContent(content) {
        // Check for findings with severity
        for (const [severity, pattern] of Object.entries(this.CLASSIFICATION_PATTERNS.finding)) {
            if (pattern.test(content)) {
                return {
                    type: 'finding',
                    severity: severity,
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
 * Factory for creating parsers optimized for different CLI agents.
 *
 * @deprecated NOT INTEGRATED -- See SemanticOutputParser deprecation note.
 */
export class ParserFactory {
    /**
     * Create parser optimized for specific CLI agent
     */
    static createParser(agent, sessionId) {
        switch (agent) {
            case 'claude':
                return new ClaudeOptimizedParser(agent, sessionId);
            case 'codex':
                return new CodexOptimizedParser(agent, sessionId);
            default:
                return new SemanticOutputParser(agent, sessionId);
        }
    }
}
/**
 * Claude-optimized parser (handles thinking blocks and stream-json format)
 */
class ClaudeOptimizedParser extends SemanticOutputParser {
    CLAUDE_PATTERNS = {
        thinking: /<thinking>[\s\S]*?<\/thinking>/g,
        streamJson: /^data: (.+)$/gm
    };
    parse(chunk, agent) {
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
                }
                catch {
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
    parse(chunk, agent) {
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
                }
                catch {
                    // Not JSON, treat as raw text
                    extractedContent += line + '\n';
                }
            }
            return super.parse(extractedContent, agent);
        }
        catch {
            // Fallback to regular parsing
            return super.parse(chunk, agent);
        }
    }
}
//# sourceMappingURL=output-parser.js.map