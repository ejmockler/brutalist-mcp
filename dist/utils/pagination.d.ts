import { PaginationParams, PaginationMetadata, ResponseChunk, PaginatedResponse } from '../types/brutalist.js';
export declare const PAGINATION_DEFAULTS: {
    readonly DEFAULT_LIMIT_TOKENS: 22000;
    readonly MAX_LIMIT_TOKENS: 90000;
    readonly MIN_LIMIT_TOKENS: 1000;
    readonly CHUNK_OVERLAP_TOKENS: 50;
    readonly DEFAULT_LIMIT: 90000;
    readonly MAX_LIMIT: 100000;
    readonly MIN_LIMIT: 1000;
    readonly CHUNK_OVERLAP: 200;
};
/**
 * Calculates token count approximation (rough estimate: 1 token ≈ 4 characters)
 */
export declare function estimateTokenCount(text: string): number;
/**
 * Smart text chunking that preserves sentence boundaries and adds overlap
 * NOW WORKS WITH TOKEN LIMITS, not character limits
 */
export declare class ResponseChunker {
    private readonly chunkSizeTokens;
    private readonly overlapTokens;
    constructor(chunkSizeTokens?: number, overlapTokens?: number);
    /**
     * Split text into chunks with smart boundary detection
     * Works with TOKEN limits, not character limits
     */
    chunkText(text: string): ResponseChunk[];
    /**
     * Find intelligent breakpoint that preserves readability
     */
    private findSmartBreakpoint;
}
/**
 * Create pagination metadata for a response using actual chunk boundaries
 */
export declare function createPaginationMetadata(totalLength: number, params: PaginationParams, chunkSize?: number, chunks?: ResponseChunk[], currentChunkIndex?: number): PaginationMetadata;
/**
 * Extract pagination parameters from tool arguments
 */
export declare function extractPaginationParams(args: Record<string, unknown>): PaginationParams;
/**
 * Parse cursor string to extract pagination state with proper clamping
 */
export declare function parseCursor(cursor: string): Partial<PaginationParams>;
/**
 * Create a paginated response with proper metadata
 */
export declare function createPaginatedResponse<T = string>(data: T, pagination: PaginationMetadata, summary?: string): PaginatedResponse<T>;
/**
 * Format pagination status for user display
 */
export declare function formatPaginationStatus(pagination: PaginationMetadata): string;
//# sourceMappingURL=pagination.d.ts.map