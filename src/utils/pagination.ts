import { logger } from '../logger.js';
import { 
  PaginationParams, 
  PaginationMetadata, 
  ResponseChunk, 
  PaginatedResponse 
} from '../types/brutalist.js';

// Default pagination configuration
export const PAGINATION_DEFAULTS = {
  DEFAULT_LIMIT: 90000, // ~22.5K tokens - optimized for Claude Code's 25K window with headroom
  MAX_LIMIT: 100000,    // 100K tokens - reasonable upper bound
  MIN_LIMIT: 1000,      // 1K tokens - minimum meaningful chunk
  CHUNK_OVERLAP: 200    // Character overlap between chunks for context
} as const;

/**
 * Calculates token count approximation (rough estimate: 1 token ≈ 4 characters)
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Smart text chunking that preserves sentence boundaries and adds overlap
 */
export class ResponseChunker {
  private readonly chunkSize: number;
  private readonly overlap: number;

  constructor(chunkSize: number = PAGINATION_DEFAULTS.DEFAULT_LIMIT, overlap: number = PAGINATION_DEFAULTS.CHUNK_OVERLAP) {
    this.chunkSize = Math.max(chunkSize, PAGINATION_DEFAULTS.MIN_LIMIT);
    this.overlap = Math.min(overlap, Math.floor(chunkSize * 0.1)); // Max 10% overlap
  }

  /**
   * Split text into chunks with smart boundary detection
   */
  public chunkText(text: string): ResponseChunk[] {
    if (text.length <= this.chunkSize) {
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
      const endOffset = Math.min(currentOffset + this.chunkSize, text.length);
      let chunkEnd = endOffset;

      // Smart boundary detection - prefer paragraph, then sentence, then word breaks
      if (endOffset < text.length) {
        chunkEnd = this.findSmartBreakpoint(text, currentOffset, endOffset);
      }

      const chunkContent = text.substring(currentOffset, chunkEnd);
      
      chunks.push({
        content: chunkContent,
        startOffset: currentOffset,
        endOffset: chunkEnd,
        metadata: {
          isComplete: chunkEnd === text.length,
          truncated: chunkEnd < endOffset,
          originalLength: text.length
        }
      });

      // Move to next chunk with overlap (except for last chunk)
      currentOffset = chunkEnd - (chunkEnd === text.length ? 0 : this.overlap);
    }

    logger.debug(`Chunked ${text.length} chars into ${chunks.length} chunks (size: ${this.chunkSize}, overlap: ${this.overlap})`);
    return chunks;
  }

  /**
   * Find intelligent breakpoint that preserves readability
   */
  private findSmartBreakpoint(text: string, start: number, idealEnd: number): number {
    const searchRange = Math.min(500, Math.floor(this.chunkSize * 0.1)); // Search within 10% of chunk size
    const minEnd = Math.max(start + this.chunkSize - searchRange, idealEnd - searchRange);

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
 * Create pagination metadata for a response
 */
export function createPaginationMetadata(
  totalLength: number,
  params: PaginationParams,
  chunkSize: number = PAGINATION_DEFAULTS.DEFAULT_LIMIT
): PaginationMetadata {
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
 * Parse cursor string to extract pagination state
 */
export function parseCursor(cursor: string): Partial<PaginationParams> {
  try {
    if (cursor.startsWith('offset:')) {
      const offset = parseInt(cursor.substring(7), 10);
      return isNaN(offset) ? {} : { offset };
    }
    
    // Support JSON cursor format for future extensibility
    const parsed = JSON.parse(cursor);
    return {
      offset: typeof parsed.offset === 'number' ? parsed.offset : undefined,
      limit: typeof parsed.limit === 'number' ? parsed.limit : undefined
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