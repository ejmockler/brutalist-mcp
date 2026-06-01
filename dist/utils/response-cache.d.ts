export interface ConversationMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
}
export interface CachedResponse {
    content: string;
    timestamp: number;
    contextId: string;
    cacheKey: string;
    requestParams: Record<string, unknown>;
    compressed: boolean;
    size: number;
    sessionId?: string;
    requestId?: string;
    conversationHistory?: ConversationMessage[];
}
export interface CacheStats {
    entries: number;
    totalSize: number;
    hits: number;
    misses: number;
    evictions: number;
}
/**
 * LRU Response Cache with TTL and memory management
 */
export declare class ResponseCache {
    private entries;
    private contextIdMap;
    private accessOrder;
    private stats;
    private readonly maxEntries;
    private readonly ttlMs;
    private readonly maxTotalSizeMB;
    private readonly maxEntrySizeMB;
    private readonly compressionThresholdMB;
    private cleanupTimer?;
    constructor(options?: {
        maxEntries?: number;
        ttlHours?: number;
        maxTotalSizeMB?: number;
        maxEntrySizeMB?: number;
        compressionThresholdMB?: number;
    });
    /**
     * Generate cache key from request parameters
     */
    generateCacheKey(params: Record<string, unknown>): string;
    /**
     * Generate secure context ID (UUID)
     */
    generateContextId(cacheKey: string): string;
    /**
     * Find existing context_id for a given cache key
     */
    findContextIdForKey(cacheKey: string): string | null;
    /**
     * Create alias context_id that maps to same cache entry
     * Used for pagination - each request gets unique context_id but shares cached content
     */
    createAlias(existingContextId: string, cacheKey: string): string;
    /**
     * Store response with session binding and conversation history
     */
    set(data: Record<string, any>, content: string, cacheKey?: string, sessionId?: string, requestId?: string, conversationHistory?: ConversationMessage[]): Promise<{
        contextId: string;
        cacheKey: string;
    }>;
    /**
     * Retrieve response with session validation
     */
    get(contextIdOrCacheKey: string, sessionId?: string): Promise<string | null>;
    /**
     * Check if key exists in cache
     */
    has(keyOrId: string): boolean;
    /**
     * Delete entry from cache
     */
    private delete;
    /**
     * Update LRU access order
     */
    private updateAccessOrder;
    /**
     * Ensure cache has capacity for new entry
     */
    private ensureCapacity;
    /**
     * Clean up expired entries
     */
    private cleanupExpired;
    /**
     * Get cache statistics
     */
    getStats(): CacheStats;
    /**
     * Update existing cache entry (for conversation continuation)
     */
    updateByContextId(contextId: string, content: string, conversationHistory: ConversationMessage[], sessionId?: string): Promise<void>;
    /**
     * Retrieve response by context ID, returning full cached response object
     */
    getByContextId(contextId: string, sessionId?: string): Promise<CachedResponse | null>;
    /**
     * Clear entire cache
     */
    clear(): void;
    /**
     * Destroy cache and cleanup resources
     */
    destroy(): void;
}
//# sourceMappingURL=response-cache.d.ts.map