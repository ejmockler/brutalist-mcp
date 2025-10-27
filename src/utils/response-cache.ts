import { createHash, randomUUID } from 'crypto';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { logger } from '../logger.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface CachedResponse {
  content: string;
  timestamp: number;
  contextId: string;
  cacheKey: string;
  requestParams: Record<string, unknown>;
  compressed: boolean;
  size: number;
  sessionId?: string; // Session binding for security
  requestId?: string; // Request tracking
}

// Context ID mapping for secure lookup
interface ContextIdMapping {
  cacheKey: string;
  sessionId: string;
  created: number;
}

// Cache entry with session context
interface CachedResponseEntry {
  content: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  accessCount: number;
  size: number;
  compressed?: boolean;
  sessionId?: string;
  requestId?: string;
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
export class ResponseCache {
  private entries = new Map<string, CachedResponseEntry>();
  private contextIdMap = new Map<string, ContextIdMapping>(); // Context ID to cache mapping
  private accessOrder: string[] = [];
  private stats: CacheStats = {
    entries: 0,
    totalSize: 0,
    hits: 0,
    misses: 0,
    evictions: 0
  };

  // Configuration
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly maxTotalSizeMB: number;
  private readonly maxEntrySizeMB: number;
  private readonly compressionThresholdMB: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: {
    maxEntries?: number;
    ttlHours?: number;
    maxTotalSizeMB?: number;
    maxEntrySizeMB?: number;
    compressionThresholdMB?: number;
  } = {}) {
    this.maxEntries = options.maxEntries || 50;
    this.ttlMs = (options.ttlHours || 2) * 60 * 60 * 1000; // Convert hours to ms
    this.maxTotalSizeMB = options.maxTotalSizeMB || 500;
    this.maxEntrySizeMB = options.maxEntrySizeMB || 10;
    this.compressionThresholdMB = options.compressionThresholdMB || 1;

    // Log configuration
    logger.info(`📦 ResponseCache initialized:`, {
      maxEntries: this.maxEntries,
      ttlHours: this.ttlMs / (1000 * 60 * 60),
      maxTotalSizeMB: this.maxTotalSizeMB,
      maxEntrySizeMB: this.maxEntrySizeMB,
      compressionThresholdMB: this.compressionThresholdMB
    });

    // Periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 5 * 60 * 1000); // Every 5 minutes
    // Allow Node to exit even if timer is active
    this.cleanupTimer.unref();
  }

  /**
   * Generate cache key from request parameters
   */
  generateCacheKey(params: Record<string, unknown>): string {
    // Create deterministic string from params
    const sortedParams = Object.keys(params)
      .sort()
      .reduce((acc, key) => {
        if (params[key] !== undefined && key !== 'context_id' && key !== 'offset' && key !== 'limit' && key !== 'cursor' && key !== 'force_refresh') {
          acc[key] = params[key];
        }
        return acc;
      }, {} as Record<string, unknown>);

    const paramString = JSON.stringify(sortedParams);
    const hash = createHash('sha256').update(paramString).digest('hex');
    return hash;
  }

  /**
   * Generate secure context ID (UUID)
   */
  generateContextId(cacheKey: string): string {
    return randomUUID(); // Full UUID for security
  }

  /**
   * Find existing context_id for a given cache key
   */
  findContextIdForKey(cacheKey: string): string | null {
    for (const [contextId, mapping] of this.contextIdMap.entries()) {
      if (mapping.cacheKey === cacheKey) {
        return contextId;
      }
    }
    return null;
  }

  /**
   * Create alias context_id that maps to same cache entry
   * Used for pagination - each request gets unique context_id but shares cached content
   */
  createAlias(existingContextId: string, cacheKey: string): string {
    const existingMapping = this.contextIdMap.get(existingContextId);
    if (!existingMapping) {
      throw new Error(`Cannot create alias: context_id ${existingContextId} not found`);
    }

    const newAlias = randomUUID();
    this.contextIdMap.set(newAlias, {
      cacheKey,
      sessionId: existingMapping.sessionId,
      created: Date.now()
    });

    logger.debug(`🔗 Created alias ${newAlias.substring(0, 8)}... -> ${cacheKey.substring(0, 16)}...`);
    return newAlias;
  }

  /**
   * Store response with session binding
   */
  async set(
    data: Record<string, any>,
    content: string,
    cacheKey?: string,
    sessionId?: string,
    requestId?: string
  ): Promise<{ contextId: string; cacheKey: string }> {
    const finalCacheKey = cacheKey || this.generateCacheKey(data);
    const contextId = this.generateContextId(finalCacheKey);
    
    // Check size limits before compression
    const sizeInMB = Buffer.byteLength(content, 'utf8') / (1024 * 1024);
    if (sizeInMB > this.maxEntrySizeMB) {
      throw new Error(`Response too large: ${sizeInMB.toFixed(2)}MB > ${this.maxEntrySizeMB}MB limit`);
    }
    
    // Compress if needed
    let finalContent = content;
    let compressed = false;
    if (sizeInMB > this.compressionThresholdMB) {
      try {
        const compressedBuffer = await gzipAsync(Buffer.from(content, 'utf8'));
        finalContent = compressedBuffer.toString('base64');
        compressed = true;
        logger.debug(`📦 Compressed cache entry: ${sizeInMB.toFixed(2)}MB -> ${(compressedBuffer.length / (1024 * 1024)).toFixed(2)}MB`);
      } catch (error) {
        logger.warn("Failed to compress cache entry, storing uncompressed", error);
      }
    }
    
    // Create cache entry with session binding
    const entry: CachedResponseEntry = {
      content: finalContent,
      metadata: { 
        ...data, 
        sessionId,
        requestId,
        originalSize: sizeInMB 
      },
      timestamp: Date.now(),
      accessCount: 1,
      size: Buffer.byteLength(finalContent, 'utf8'),
      compressed,
      sessionId,
      requestId
    };
    
    // Store in cache
    this.entries.set(finalCacheKey, entry);

    // Map context ID to cache key with session binding
    this.contextIdMap.set(contextId, {
      cacheKey: finalCacheKey,
      sessionId: sessionId || 'anonymous',
      created: Date.now()
    });

    // Update access order for LRU
    this.updateAccessOrder(finalCacheKey);

    // Update stats
    this.stats.entries = this.entries.size;
    this.stats.totalSize = Array.from(this.entries.values()).reduce((sum, e) => sum + e.size, 0);

    // Ensure capacity limits
    await this.ensureCapacity();

    logger.debug(`✅ Cached response with context_id: ${contextId} for session: ${sessionId?.substring(0, 8)}...`);

    return { contextId, cacheKey: finalCacheKey };
  }

  /**
   * Retrieve response with session validation
   */
  async get(contextIdOrCacheKey: string, sessionId?: string): Promise<string | null> {
    let cacheKey: string;
    let requiredSessionId: string | undefined;

    // Check if it's a context ID first
    const mapping = this.contextIdMap.get(contextIdOrCacheKey);
    if (mapping) {
      cacheKey = mapping.cacheKey;
      requiredSessionId = mapping.sessionId;

      // Validate session access
      if (requiredSessionId !== 'anonymous') {
        if (!sessionId || sessionId !== requiredSessionId) {
          logger.warn(`🚫 Session mismatch for context ${contextIdOrCacheKey}: ${sessionId?.substring(0, 8) || 'none'} != ${requiredSessionId?.substring(0, 8)}`);
          this.stats.misses++;
          return null; // Block cross-session access
        }
      }
    } else {
      // Direct cache key access (legacy support)
      cacheKey = contextIdOrCacheKey;
    }
    
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      logger.debug(`⏰ Cache entry expired: ${cacheKey.substring(0, 8)}...`);
      this.entries.delete(cacheKey);
      // Also clean up context ID mapping
      if (mapping) {
        this.contextIdMap.delete(contextIdOrCacheKey);
      }
      this.stats.misses++;
      this.stats.evictions++;
      return null;
    }
    
    // Additional session validation on the entry itself
    if (sessionId && entry.sessionId && entry.sessionId !== sessionId && entry.sessionId !== 'anonymous') {
      logger.warn(`🚫 Entry session mismatch for ${cacheKey.substring(0, 8)}: ${sessionId?.substring(0, 8)} != ${entry.sessionId?.substring(0, 8)}`);
      this.stats.misses++;
      return null;
    }
    
    // Update access tracking
    entry.accessCount++;
    this.updateAccessOrder(cacheKey);
    this.stats.hits++;
    
    // Decompress if needed
    let content = entry.content;
    if (entry.compressed) {
      try {
        const compressedBuffer = Buffer.from(content, 'base64');
        const decompressedBuffer = await gunzipAsync(compressedBuffer);
        content = decompressedBuffer.toString('utf8');
      } catch (error) {
        logger.error("Failed to decompress cache entry", error);
        return null;
      }
    }
    
    logger.debug(`🎯 Cache hit for session ${sessionId?.substring(0, 8)}...: ${cacheKey.substring(0, 8)}...`);
    return content;
  }

  /**
   * Check if key exists in cache
   */
  has(keyOrId: string): boolean {
    // Check context ID mapping first
    const mapping = this.contextIdMap.get(keyOrId);
    const cacheKey = mapping ? mapping.cacheKey : keyOrId;

    const entry = this.entries.get(cacheKey);
    if (!entry) return false;

    // Check if expired
    const age = Date.now() - entry.timestamp;
    if (age > this.ttlMs) {
      this.delete(keyOrId);
      return false;
    }

    return true;
  }

  /**
   * Delete entry from cache
   */
  private delete(keyOrId: string): void {
    // Check context ID mapping first
    const mapping = this.contextIdMap.get(keyOrId);
    const cacheKey = mapping ? mapping.cacheKey : keyOrId;

    const entry = this.entries.get(cacheKey);
    if (entry) {
      this.stats.totalSize -= entry.size;
      // Delete from entries
      this.entries.delete(cacheKey);
      // Remove from context ID mapping if it exists
      if (mapping) {
        this.contextIdMap.delete(keyOrId);
      }
      // Remove cache key from access order
      this.accessOrder = this.accessOrder.filter(k => k !== cacheKey);
      this.stats.entries = this.entries.size;
    }
  }

  /**
   * Update LRU access order
   */
  private updateAccessOrder(key: string): void {
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);
  }

  /**
   * Ensure cache has capacity for new entry
   */
  private async ensureCapacity(): Promise<void> {
    const maxTotalSize = this.maxTotalSizeMB * 1024 * 1024;
    
    // Check total size limit
    while (this.stats.totalSize > maxTotalSize && this.accessOrder.length > 0) {
      const oldestKey = this.accessOrder[0];
      logger.info(`🗑️ Evicting for size limit: ${oldestKey}`);
      this.delete(oldestKey);
      this.stats.evictions++;
    }

    // Check entry count limit
    while (this.entries.size >= this.maxEntries && this.accessOrder.length > 0) {
      const oldestKey = this.accessOrder[0];
      logger.info(`🗑️ Evicting for entry limit: ${oldestKey}`);
      this.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  /**
   * Clean up expired entries
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.entries.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.info(`🧹 Cleaned ${cleaned} expired cache entries`);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Retrieve response by context ID, returning full cached response object
   */
  async getByContextId(contextId: string, sessionId?: string): Promise<CachedResponse | null> {
    const mapping = this.contextIdMap.get(contextId);
    if (!mapping) {
      this.stats.misses++;
      logger.debug(`❌ Cache miss by context ID: ${contextId}`);
      return null;
    }

    // Validate session access
    if (sessionId && mapping.sessionId !== sessionId && mapping.sessionId !== 'anonymous') {
      logger.warn(`🚫 Session mismatch for context ${contextId}: ${sessionId?.substring(0, 8)} != ${mapping.sessionId?.substring(0, 8)}`);
      this.stats.misses++;
      return null;
    }

    const entry = this.entries.get(mapping.cacheKey);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check TTL
    const age = Date.now() - entry.timestamp;
    if (age > this.ttlMs) {
      logger.info(`⏰ Cache expired: ${contextId} (age: ${(age / 1000 / 60).toFixed(0)} minutes)`);
      this.delete(contextId);
      this.stats.misses++;
      return null;
    }

    // Update access order
    this.updateAccessOrder(mapping.cacheKey);
    this.stats.hits++;

    logger.info(`✅ Cache hit by context ID: ${contextId} (age: ${(age / 1000 / 60).toFixed(0)} minutes)`);

    // Decompress if needed
    let content = entry.content;
    if (entry.compressed) {
      try {
        const buffer = Buffer.from(entry.content, 'base64');
        const decompressed = await gunzipAsync(buffer);
        content = decompressed.toString('utf-8');
      } catch (error) {
        logger.error('Decompression failed:', error);
        this.delete(contextId);
        return null;
      }
    }

    return {
      content,
      timestamp: entry.timestamp,
      contextId,
      cacheKey: mapping.cacheKey,
      requestParams: entry.metadata,
      compressed: entry.compressed || false,
      size: entry.size,
      sessionId: entry.sessionId,
      requestId: entry.requestId
    };
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    this.entries.clear();
    this.contextIdMap.clear();
    this.accessOrder = [];
    this.stats = {
      entries: 0,
      totalSize: 0,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions
    };
    logger.info('🗑️ Cache cleared');
  }

  /**
   * Destroy cache and cleanup resources
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.clear();
    logger.info('💀 Cache destroyed');
  }
}