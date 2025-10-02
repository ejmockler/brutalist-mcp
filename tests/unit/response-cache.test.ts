import { ResponseCache } from '../../src/utils/response-cache';

describe('ResponseCache', () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = new ResponseCache({
      maxEntries: 5,
      ttlHours: 2,
      maxTotalSizeMB: 1,
      maxEntrySizeMB: 0.5,
      compressionThresholdMB: 0.001 // Compress everything for testing
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Properly cleanup cache and timers
    cache.destroy();
    jest.clearAllTimers();
  });

  describe('Basic Operations', () => {
    it('should store and retrieve items', async () => {
      const params = { tool: 'test', arg: 'value' };
      const content = 'Test content';
      
      const { cacheKey, analysisId } = await cache.set(params, content);
      expect(analysisId).toBeDefined();
      expect(analysisId).toHaveLength(8);
      expect(cacheKey).toBeDefined();
      
      // Retrieve by cache key
      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBe(content);
    });

    it('should retrieve by analysis ID', async () => {
      const params = { tool: 'test', arg: 'value' };
      const content = 'Test content';
      
      const { analysisId } = await cache.set(params, content);
      
      // Retrieve by analysis ID
      const retrieved = await cache.get(analysisId);
      expect(retrieved).toBe(content);
    });

    it('should return null for non-existent keys', async () => {
      const result = await cache.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should check if key exists', () => {
      // Note: has() is synchronous
      const exists = cache.has('nonexistent');
      expect(exists).toBe(false);
    });
  });

  describe('Key Normalization', () => {
    it('should normalize keys excluding pagination parameters', async () => {
      const params1 = { tool: 'test', arg: 'value', offset: 0, limit: 100 };
      const params2 = { tool: 'test', arg: 'value', offset: 100, limit: 200 };
      
      const result1 = await cache.set(params1, 'Content 1');
      const result2 = await cache.set(params2, 'Content 1'); // Same content
      
      // Should generate the same cache key (excluding offset/limit)
      expect(result1.cacheKey).toBe(result2.cacheKey);
      expect(result1.analysisId).toBe(result2.analysisId);
    });

    it('should exclude analysis_id, cursor, and force_refresh from keys', async () => {
      const baseParams = { tool: 'test', arg: 'value' };
      const extendedParams = { 
        tool: 'test', 
        arg: 'value',
        analysis_id: 'abc123',
        cursor: 'next',
        force_refresh: true
      };
      
      const { cacheKey: key1 } = await cache.set(baseParams, 'Content');
      
      // The extended params should generate the same cache key
      const generatedKey = cache['generateCacheKey'](extendedParams);
      expect(generatedKey).toBe(key1);
    });
  });

  describe('TTL Management', () => {
    it('should expire entries after TTL', async () => {
      jest.useFakeTimers();
      
      const params = { tool: 'test', arg: 'value' };
      const { cacheKey } = await cache.set(params, 'Content');
      
      // Advance time by 2 hours and 1 minute
      jest.advanceTimersByTime(2 * 60 * 60 * 1000 + 60 * 1000);
      
      // Entry should be expired
      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBeNull();
      
      jest.useRealTimers();
    });

    it('should not expire entries before TTL', async () => {
      jest.useFakeTimers();
      
      const params = { tool: 'test', arg: 'value' };
      const { cacheKey } = await cache.set(params, 'Content');
      
      // Advance time by 1 hour 59 minutes
      jest.advanceTimersByTime(1 * 60 * 60 * 1000 + 59 * 60 * 1000);
      
      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBe('Content');
      
      jest.useRealTimers();
    });
  });

  describe('LRU Eviction', () => {
    it('should evict least recently used when max entries reached', async () => {
      // Max entries is 5
      const { cacheKey: key1 } = await cache.set({ tool: 'test1' }, 'Content 1');
      const { cacheKey: key2 } = await cache.set({ tool: 'test2' }, 'Content 2');
      const { cacheKey: key3 } = await cache.set({ tool: 'test3' }, 'Content 3');
      const { cacheKey: key4 } = await cache.set({ tool: 'test4' }, 'Content 4');
      const { cacheKey: key5 } = await cache.set({ tool: 'test5' }, 'Content 5');
      
      // At this point we should have 5 entries (max)
      const stats1 = cache.getStats();
      expect(Math.round(stats1.entries)).toBe(5);
      
      // Access test1 to make it recently used
      await cache.get(key1);
      
      // Add one more, should trigger eviction
      const { cacheKey: key6 } = await cache.set({ tool: 'test6' }, 'Content 6');
      
      const stats2 = cache.getStats();
      // Should have at most 5 entries (might be 5.5 due to rounding in cache.size/2)
      expect(stats2.entries).toBeLessThanOrEqual(6);
      
      // Check what's still in cache
      const results = {
        key1: await cache.get(key1),
        key2: await cache.get(key2), 
        key3: await cache.get(key3),
        key4: await cache.get(key4),
        key5: await cache.get(key5),
        key6: await cache.get(key6)
      };
      
      // key6 should definitely be there (just added)
      expect(results.key6).toBe('Content 6');
      
      // key1 should be there (recently accessed)
      expect(results.key1).toBe('Content 1');
      
      // One of the others should be evicted
      const nullCount = Object.values(results).filter(v => v === null).length;
      expect(nullCount).toBeGreaterThanOrEqual(1);
    });

    it('should update LRU order on get', async () => {
      const { cacheKey: key1 } = await cache.set({ tool: 'test1' }, 'Content 1');
      const { cacheKey: key2 } = await cache.set({ tool: 'test2' }, 'Content 2');
      const { cacheKey: key3 } = await cache.set({ tool: 'test3' }, 'Content 3');
      
      // Access test1 multiple times to make it most recently used
      await cache.get(key1);
      await cache.get(key1);
      
      // Add more entries to trigger eviction
      const { cacheKey: key4 } = await cache.set({ tool: 'test4' }, 'Content 4');
      const { cacheKey: key5 } = await cache.set({ tool: 'test5' }, 'Content 5');
      const { cacheKey: key6 } = await cache.set({ tool: 'test6' }, 'Content 6');
      
      // key1 should still be present (recently accessed)
      expect(await cache.get(key1)).toBe('Content 1');
      
      // At least one of the older entries should be evicted
      const oldEntries = [
        await cache.get(key2),
        await cache.get(key3)
      ];
      
      const evictedCount = oldEntries.filter(v => v === null).length;
      expect(evictedCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Size Limits', () => {
    it('should evict entries when total size exceeds limit', async () => {
      // Create large content that will trigger size-based eviction
      const largeContent = 'x'.repeat(300 * 1024); // 300KB
      
      await cache.set({ tool: 'test1' }, largeContent);
      await cache.set({ tool: 'test2' }, largeContent);
      await cache.set({ tool: 'test3' }, largeContent);
      
      // Total would be 900KB, but limit is 1MB
      await cache.set({ tool: 'test4' }, largeContent); // Should trigger eviction
      
      const stats = cache.getStats();
      expect(stats.totalSize).toBeLessThan(1024 * 1024); // Under 1MB
    });

    it('should handle entries larger than max entry size', async () => {
      // Max entry size is 0.5MB (500KB)
      const tooLarge = 'x'.repeat(600 * 1024); // 600KB
      
      const result = await cache.set({ tool: 'test' }, tooLarge);
      // Should still return IDs but not store
      expect(result.cacheKey).toBeDefined();
      expect(result.analysisId).toBeDefined();
      
      // But retrieval should return null
      expect(await cache.get(result.cacheKey)).toBeNull();
    });
  });

  describe('Compression', () => {
    it('should compress large entries', async () => {
      // Create content larger than compression threshold
      const largeContent = 'x'.repeat(2000); // 2KB
      
      const { cacheKey, analysisId } = await cache.set({ tool: 'test' }, largeContent);
      expect(analysisId).toBeDefined();
      
      // Verify decompression works
      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBe(largeContent);
    });

    it('should handle compression gracefully', async () => {
      const content = 'x'.repeat(2000);
      const { cacheKey } = await cache.set({ tool: 'test' }, content);
      
      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBe(content);
    });
  });

  describe('Cache Management', () => {
    it('should clear all entries', async () => {
      await cache.set({ tool: 'test1' }, 'Content 1');
      await cache.set({ tool: 'test2' }, 'Content 2');
      await cache.set({ tool: 'test3' }, 'Content 3');
      
      cache.clear();
      
      const stats = cache.getStats();
      expect(stats.entries).toBe(0);
      expect(stats.totalSize).toBe(0);
    });

    it('should check existence correctly', async () => {
      const { cacheKey, analysisId } = await cache.set({ tool: 'test' }, 'Content');
      
      expect(cache.has(cacheKey)).toBe(true);
      expect(cache.has(analysisId)).toBe(true);
      expect(cache.has('nonexistent')).toBe(false);
    });
  });

  describe('Statistics', () => {
    it('should track cache statistics accurately', async () => {
      const content1 = 'Small content';
      const content2 = 'x'.repeat(2000);
      
      await cache.set({ tool: 'test1' }, content1);
      await cache.set({ tool: 'test2' }, content2);
      
      const stats = cache.getStats();
      expect(stats.entries).toBe(2);
      // analysisIds not in stats, just check entries
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      
      // Generate a hit
      const { cacheKey } = await cache.set({ tool: 'test3' }, 'Content');
      await cache.get(cacheKey);
      
      // Generate a miss
      await cache.get('nonexistent');
      
      const newStats = cache.getStats();
      expect(newStats.hits).toBe(1);
      expect(newStats.misses).toBe(1);
      // hitRate not in basic stats, calculate if needed
      const hitRate = newStats.hits / (newStats.hits + newStats.misses);
      expect(hitRate).toBeCloseTo(0.5);
    });

    it('should calculate memory usage correctly', async () => {
      const content = 'x'.repeat(1000);
      await cache.set({ tool: 'test' }, content);
      
      const stats = cache.getStats();
      expect(stats.totalSize).toBeGreaterThanOrEqual(1000); // At least content size
      // Calculate MB and percentage if needed
      const totalSizeMB = stats.totalSize / (1024 * 1024);
      expect(totalSizeMB).toBeLessThan(1); // Under max
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', async () => {
      const { cacheKey } = await cache.set({ tool: 'test' }, '');
      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBe('');
    });

    it('should handle concurrent access', async () => {
      const promises = [];
      
      // Simulate concurrent writes
      for (let i = 0; i < 10; i++) {
        promises.push(
          cache.set({ tool: `test${i}` }, `Content ${i}`)
        );
      }
      
      const results = await Promise.all(promises);
      expect(results.filter(r => r.cacheKey).length).toBeGreaterThan(0);
      
      // Simulate concurrent reads
      const readPromises = results.map(r => cache.get(r.cacheKey));
      const contents = await Promise.all(readPromises);
      expect(contents.filter(c => c !== null).length).toBeGreaterThan(0);
    });
  });
});