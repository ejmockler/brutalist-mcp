import { createHash } from 'crypto';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { logger } from '../logger.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface CachedResponse {
  content: string;
  timestamp: number;
  analysisId: string;
  cacheKey: string;
  requestParams: Record<string, unknown>;
  compressed: boolean;
  size: number;
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
  private cache = new Map<string, CachedResponse>();
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
        if (params[key] !== undefined && key !== 'analysis_id' && key !== 'offset' && key !== 'limit' && key !== 'cursor' && key !== 'force_refresh') {
          acc[key] = params[key];
        }
        return acc;
      }, {} as Record<string, unknown>);

    const paramString = JSON.stringify(sortedParams);
    const hash = createHash('sha256').update(paramString).digest('hex');
    return hash;
  }

  /**
   * Generate short analysis ID from cache key
   */
  generateAnalysisId(cacheKey: string): string {
    return cacheKey.substring(0, 8);
  }

  /**
   * Store response in cache
   */
  async set(
    params: Record<string, unknown>,
    content: string,
    forceKey?: string
  ): Promise<{ cacheKey: string; analysisId: string }> {
    const cacheKey = forceKey || this.generateCacheKey(params);
    const analysisId = this.generateAnalysisId(cacheKey);

    // Check entry size
    const contentSize = Buffer.byteLength(content, 'utf-8');
    const sizeMB = contentSize / (1024 * 1024);
    
    if (sizeMB > this.maxEntrySizeMB) {
      logger.warn(`⚠️ Response too large for cache: ${sizeMB.toFixed(2)}MB > ${this.maxEntrySizeMB}MB`);
      return { cacheKey, analysisId };
    }

    // Compress if needed
    let finalContent = content;
    let compressed = false;
    
    if (sizeMB > this.compressionThresholdMB) {
      try {
        const compressedBuffer = await gzipAsync(Buffer.from(content, 'utf-8'));
        const compressedSize = compressedBuffer.length / (1024 * 1024);
        logger.info(`🗜️ Compressed response: ${sizeMB.toFixed(2)}MB → ${compressedSize.toFixed(2)}MB`);
        finalContent = compressedBuffer.toString('base64');
        compressed = true;
      } catch (error) {
        logger.error('Compression failed:', error);
      }
    }

    // Check total cache size
    await this.ensureCapacity(contentSize);

    // Store in cache
    const entry: CachedResponse = {
      content: finalContent,
      timestamp: Date.now(),
      analysisId,
      cacheKey,
      requestParams: params,
      compressed,
      size: compressed ? Buffer.byteLength(finalContent, 'base64') : contentSize
    };

    this.cache.set(cacheKey, entry);
    this.cache.set(analysisId, entry); // Also index by short ID
    this.updateAccessOrder(cacheKey); // Only track cache key in LRU order
    
    this.stats.entries = this.cache.size / 2; // Divided by 2 because we store twice
    this.stats.totalSize += entry.size;

    logger.info(`✅ Cached response: ${analysisId} (${sizeMB.toFixed(2)}MB${compressed ? ' compressed' : ''})`);
    
    return { cacheKey, analysisId };
  }

  /**
   * Retrieve response from cache
   */
  async get(keyOrId: string): Promise<string | null> {
    const entry = this.cache.get(keyOrId);
    
    if (!entry) {
      this.stats.misses++;
      logger.debug(`❌ Cache miss: ${keyOrId}`);
      return null;
    }

    // Check TTL
    const age = Date.now() - entry.timestamp;
    if (age > this.ttlMs) {
      logger.info(`⏰ Cache expired: ${keyOrId} (age: ${(age / 1000 / 60).toFixed(0)} minutes)`);
      this.delete(keyOrId);
      this.stats.misses++;
      return null;
    }

    // Update access order (always use cache key for consistency)
    this.updateAccessOrder(entry.cacheKey);
    this.stats.hits++;
    
    logger.info(`✅ Cache hit: ${keyOrId} (age: ${(age / 1000 / 60).toFixed(0)} minutes)`);

    // Decompress if needed
    if (entry.compressed) {
      try {
        const buffer = Buffer.from(entry.content, 'base64');
        const decompressed = await gunzipAsync(buffer);
        return decompressed.toString('utf-8');
      } catch (error) {
        logger.error('Decompression failed:', error);
        this.delete(keyOrId);
        return null;
      }
    }

    return entry.content;
  }

  /**
   * Check if key exists in cache
   */
  has(keyOrId: string): boolean {
    const entry = this.cache.get(keyOrId);
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
    const entry = this.cache.get(keyOrId);
    if (entry) {
      this.stats.totalSize -= entry.size;
      // Delete both the cache key and analysis ID
      this.cache.delete(entry.cacheKey);
      this.cache.delete(entry.analysisId);
      // Remove cache key from access order
      this.accessOrder = this.accessOrder.filter(k => k !== entry.cacheKey);
      this.stats.entries = this.cache.size / 2;
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
  private async ensureCapacity(newEntrySize: number): Promise<void> {
    const maxTotalSize = this.maxTotalSizeMB * 1024 * 1024;
    
    // Check total size limit
    while (this.stats.totalSize + newEntrySize > maxTotalSize && this.accessOrder.length > 0) {
      const oldestKey = this.accessOrder[0];
      logger.info(`🗑️ Evicting for size limit: ${oldestKey}`);
      this.delete(oldestKey);
      this.stats.evictions++;
    }

    // Check entry count limit
    while (this.cache.size / 2 >= this.maxEntries && this.accessOrder.length > 0) {
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
    
    for (const [key, entry] of this.cache.entries()) {
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
   * Clear entire cache
   */
  clear(): void {
    this.cache.clear();
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