import { logger } from '../logger.js';
import { 
  PaginationParams, 
  PaginationMetadata, 
  ResponseChunk, 
  PaginatedResponse 
} from '../types/brutalist.js';

// Default pagination configuration - WORKING IN TOKENS NOW, not characters
export const PAGINATION_DEFAULTS = {
  DEFAULT_LIMIT_TOKENS: 22000, // 22K tokens - safe margin below Claude Code's 25K limit
  MAX_LIMIT_TOKENS: 90000,     // 90K tokens - reasonable upper bound for large responses
  MIN_LIMIT_TOKENS: 1000,      // 1K tokens - minimum meaningful chunk
  CHUNK_OVERLAP_TOKENS: 50,    // 50 token overlap between chunks for context
  // Legacy character-based defaults (for backward compatibility with existing tool args)
  DEFAULT_LIMIT: 90000,        // ~22.5K tokens worth of characters (kept at 90K for back-compat)
  MAX_LIMIT: 100000,           // ~25K tokens worth of characters (hard limit for tool args)
  MIN_LIMIT: 1000,             // ~250 tokens worth of characters
  CHUNK_OVERLAP: 200           // Character overlap between chunks
} as const;

/**
 * Calculates token count approximation (rough estimate: 1 token ≈ 4 characters)
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Smart text chunking that preserves sentence boundaries and adds overlap
 * NOW WORKS WITH TOKEN LIMITS, not character limits
 */
export class ResponseChunker {
  private readonly chunkSizeTokens: number;
  private readonly overlapTokens: number;

  constructor(chunkSizeTokens: number = PAGINATION_DEFAULTS.DEFAULT_LIMIT_TOKENS, overlapTokens: number = PAGINATION_DEFAULTS.CHUNK_OVERLAP_TOKENS) {
    this.chunkSizeTokens = Math.max(chunkSizeTokens, PAGINATION_DEFAULTS.MIN_LIMIT_TOKENS);
    this.overlapTokens = Math.min(overlapTokens, Math.floor(chunkSizeTokens * 0.1)); // Max 10% overlap
  }

  /**
   * Split text into chunks with smart boundary detection
   * Works with TOKEN limits, not character limits
   */
  public chunkText(text: string): ResponseChunk[] {
    const totalTokens = estimateTokenCount(text);

    // If content fits in one chunk, return as-is
    if (totalTokens <= this.chunkSizeTokens) {
      return [{
        content: text,
        startOffset: 0,
        endOffset: text.length,
        metadata: {
          isComplete: true,
          truncated: false,
          originalLength: text.length
        }
      }];
    }

    const chunks: ResponseChunk[] = [];
    let currentOffset = 0;

    while (currentOffset < text.length) {
      // Convert token limit to approximate character offset
      const chunkSizeChars = this.chunkSizeTokens * 4; // ~4 chars per token
      const endOffset = Math.min(currentOffset + chunkSizeChars, text.length);
      let chunkEnd = endOffset;

      // Smart boundary detection - prefer paragraph, then sentence, then word breaks
      if (endOffset < text.length) {
        chunkEnd = this.findSmartBreakpoint(text, currentOffset, endOffset, chunkSizeChars);
      }

      const chunkContent = text.substring(currentOffset, chunkEnd);
      const chunkTokens = estimateTokenCount(chunkContent);

      // If chunk is too large (rare due to smart breakpoint), force split
      if (chunkTokens > this.chunkSizeTokens * 1.1) { // 10% tolerance
        logger.warn(`Chunk ${chunks.length + 1} is ${chunkTokens} tokens (target: ${this.chunkSizeTokens}) - forcing split`);
        // Recalculate with tighter bound
        chunkEnd = currentOffset + Math.floor(this.chunkSizeTokens * 3.8); // Conservative estimate
      }

      chunks.push({
        content: text.substring(currentOffset, chunkEnd),
        startOffset: currentOffset,
        endOffset: chunkEnd,
        metadata: {
          isComplete: chunkEnd === text.length,
          truncated: chunkEnd < endOffset,
          originalLength: text.length
        }
      });

      // Move to next chunk with token-based overlap (except for last chunk)
      const overlapChars = this.overlapTokens * 4; // ~4 chars per token
      currentOffset = chunkEnd - (chunkEnd === text.length ? 0 : overlapChars);
    }

    logger.debug(`Chunked ${text.length} chars (~${totalTokens} tokens) into ${chunks.length} chunks (target: ${this.chunkSizeTokens} tokens/chunk, overlap: ${this.overlapTokens} tokens)`);
    return chunks;
  }

  /**
   * Find intelligent breakpoint that preserves readability
   */
  private findSmartBreakpoint(text: string, start: number, idealEnd: number, chunkSizeChars: number): number {
    const searchRange = Math.min(500, Math.floor(chunkSizeChars * 0.1)); // Search within 10% of chunk size
    const minEnd = Math.max(start + chunkSizeChars - searchRange, idealEnd - searchRange);

    // Try to find paragraph break (double newline)
    for (let i = idealEnd; i >= minEnd; i--) {
      if (text.substring(i - 2, i) === '\n\n') {
        return i;
      }
    }

    // Try to find sentence break
    for (let i = idealEnd; i >= minEnd; i--) {
      if (/[.!?]\s/.test(text.substring(i - 2, i))) {
        return i;
      }
    }

    // Try to find word boundary
    for (let i = idealEnd; i >= minEnd; i--) {
      if (/\s/.test(text[i])) {
        return i + 1;
      }
    }

    // Fallback to ideal end if no good boundary found
    return idealEnd;
  }
}

/**
 * Create pagination metadata for a response using actual chunk boundaries
 */
export function createPaginationMetadata(
  totalLength: number,
  params: PaginationParams,
  chunkSize: number = PAGINATION_DEFAULTS.DEFAULT_LIMIT,
  chunks?: ResponseChunk[],
  currentChunkIndex?: number
): PaginationMetadata {
  // If chunks and index are provided, use actual boundaries
  if (chunks && currentChunkIndex !== undefined) {
    const currentChunk = chunks[currentChunkIndex];
    const hasMore = currentChunkIndex < chunks.length - 1;
    const nextChunk = hasMore ? chunks[currentChunkIndex + 1] : undefined;

    return {
      total: totalLength,
      offset: currentChunk.startOffset,
      limit: currentChunk.endOffset - currentChunk.startOffset,
      hasMore,
      nextCursor: nextChunk ? `offset:${nextChunk.startOffset}` : undefined,
      chunkIndex: currentChunkIndex + 1, // 1-based for display
      totalChunks: chunks.length
    };
  }

  // Fallback to theoretical calculation (for backwards compatibility)
  const offset = params.offset || 0;
  const limit = Math.min(params.limit || PAGINATION_DEFAULTS.DEFAULT_LIMIT, PAGINATION_DEFAULTS.MAX_LIMIT);

  const totalChunks = Math.ceil(totalLength / chunkSize);
  const currentChunk = Math.floor(offset / chunkSize) + 1;
  const hasMore = offset + limit < totalLength;

  return {
    total: totalLength,
    offset,
    limit,
    hasMore,
    nextCursor: hasMore ? `offset:${offset + limit}` : undefined,
    chunkIndex: currentChunk,
    totalChunks
  };
}

/**
 * Extract pagination parameters from tool arguments
 */
export function extractPaginationParams(args: Record<string, unknown>): PaginationParams {
  return {
    offset: typeof args.offset === 'number' ? Math.max(0, args.offset) : 0,
    limit: typeof args.limit === 'number' 
      ? Math.min(Math.max(args.limit, PAGINATION_DEFAULTS.MIN_LIMIT), PAGINATION_DEFAULTS.MAX_LIMIT)
      : PAGINATION_DEFAULTS.DEFAULT_LIMIT,
    cursor: typeof args.cursor === 'string' ? args.cursor : undefined
  };
}

/**
 * Parse cursor string to extract pagination state with proper clamping
 */
export function parseCursor(cursor: string): Partial<PaginationParams> {
  try {
    if (cursor.startsWith('offset:')) {
      const offset = parseInt(cursor.substring(7), 10);
      return isNaN(offset) ? {} : { offset: Math.max(0, offset) }; // Clamp to non-negative
    }

    // Support JSON cursor format for future extensibility
    const parsed = JSON.parse(cursor);
    return {
      offset: typeof parsed.offset === 'number' ? Math.max(0, parsed.offset) : undefined,
      limit: typeof parsed.limit === 'number'
        ? Math.min(Math.max(parsed.limit, PAGINATION_DEFAULTS.MIN_LIMIT), PAGINATION_DEFAULTS.MAX_LIMIT)
        : undefined
    };
  } catch {
    logger.warn(`Invalid cursor format: ${cursor}`);
    return {};
  }
}

/**
 * Create a paginated response with proper metadata
 */
export function createPaginatedResponse<T = string>(
  data: T,
  pagination: PaginationMetadata,
  summary?: string
): PaginatedResponse<T> {
  return {
    data,
    pagination,
    summary
  };
}

/**
 * Format pagination status for user display
 */
export function formatPaginationStatus(pagination: PaginationMetadata): string {
  const { chunkIndex, totalChunks, offset, total, hasMore } = pagination;
  
  if (totalChunks === 1) {
    return `Complete response (${total.toLocaleString()} characters)`;
  }

  const endOffset = Math.min(offset + pagination.limit, total);
  const progress = `${chunkIndex}/${totalChunks}`;
  const range = `chars ${offset.toLocaleString()}-${endOffset.toLocaleString()} of ${total.toLocaleString()}`;
  const next = hasMore ? ' • Use offset parameter to continue' : ' • Complete';

  return `Part ${progress}: ${range}${next}`;
}