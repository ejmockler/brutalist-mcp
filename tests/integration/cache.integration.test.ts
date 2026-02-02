/**
 * Unified Cache Integration Tests
 * Comprehensive cache behavior with real analysis flows, security, and pagination
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ResponseCache, CachedResponse } from '../../src/utils/response-cache.js';
import { 
  ResponseChunker, 
  PAGINATION_DEFAULTS,
  estimateTokenCount 
} from '../../src/utils/pagination.js';
import { CLIAgentOrchestrator } from '../../src/cli-agents.js';
import { TestIsolation } from '../../src/test-utils/test-isolation.js';
import { randomUUID } from 'crypto';

// Test helper to create large analysis responses
function createLargeAnalysisResponse(sizeKB: number): string {
  const baseText = `# Brutalist Analysis Results

## Security Vulnerabilities Found

This is a comprehensive analysis that reveals multiple critical issues in your codebase.

### Authentication Bypass (CRITICAL)
Your authentication system has a fundamental flaw that allows attackers to bypass login.

### SQL Injection Vulnerabilities (HIGH)
Multiple endpoints are vulnerable to SQL injection attacks.

### Cross-Site Scripting (HIGH)
Your application fails to properly sanitize user input.

## Performance Issues

### Memory Leaks
Several components have memory leaks that will cause crashes.

### Inefficient Database Queries
Your database queries are extremely inefficient.

### Poor Caching Strategy
The caching implementation is fundamentally broken.

## Architectural Problems

### Tight Coupling
Your modules are too tightly coupled for maintainability.

### Missing Error Handling
Critical paths lack proper error handling.

### Scalability Issues
The current architecture won't scale beyond 100 users.

---

`;
  
  const targetSize = sizeKB * 1024;
  const repeats = Math.ceil(targetSize / baseText.length);
  return baseText.repeat(repeats).substring(0, targetSize);
}

describe('Cache Integration Tests', () => {
  let cache: ResponseCache;
  let orchestrator: CLIAgentOrchestrator;
  let chunker: ResponseChunker;
  let testIsolation: TestIsolation;

  beforeEach(async () => {
    // Create test isolation for this test
    testIsolation = new TestIsolation('cache-integration');
    
    // Create cache with test-friendly settings and isolated namespace
    cache = new ResponseCache({
      maxEntries: 20, // Increased to handle concurrent operations
      ttlHours: 1,
      maxTotalSizeMB: 10,
      maxEntrySizeMB: 2,
      compressionThresholdMB: 0.1 // Low threshold for testing compression
    });

    orchestrator = new CLIAgentOrchestrator();
    
    chunker = new ResponseChunker(
      PAGINATION_DEFAULTS.DEFAULT_LIMIT_TOKENS, // Use token-based limit
      PAGINATION_DEFAULTS.CHUNK_OVERLAP_TOKENS   // Use token-based overlap
    );

    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Cleanup cache
    cache.clear();
    cache.destroy();
    
    // Cleanup test isolation
    await testIsolation.cleanup();
  });

  describe('Cache Key Generation & Storage', () => {
    it('should generate consistent cache keys for identical requests', () => {
      const params1 = {
        targetPath: '/src',
        context: 'test analysis',
        clis: ['claude']
      };

      const params2 = {
        targetPath: '/src',
        context: 'test analysis',
        clis: ['claude']
      };

      const key1 = cache.generateCacheKey(params1);
      const key2 = cache.generateCacheKey(params2);

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex format
    });

    it('should ignore pagination parameters in cache key generation', () => {
      const baseParams = { targetPath: '/src', context: 'test' };
      const paramsWithPagination = {
        ...baseParams,
        offset: 1000,
        limit: 5000,
        cursor: 'abc123',
        context_id: 'existing123',
        force_refresh: false
      };

      const key1 = cache.generateCacheKey(baseParams);
      const key2 = cache.generateCacheKey(paramsWithPagination);

      expect(key1).toBe(key2);
    });

    it('should store and retrieve cached responses', async () => {
      const params = { targetPath: '/src', context: 'test analysis' };
      const content = 'This is a test analysis result';
      
      const { cacheKey, contextId } = await cache.set(params, content);
      expect(cacheKey).toMatch(/^[a-f0-9]{64}$/);
      expect(contextId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBe(content);
      
      // Also test retrieval by analysis ID
      const byAnalysisId = await cache.getByContextId(contextId);
      expect(byAnalysisId).toBeDefined();
      expect(byAnalysisId!.content).toBe(content);
      expect(byAnalysisId!.contextId).toBe(contextId);
    });

    it('should handle large content with compression', async () => {
      const params = { targetPath: '/large', context: 'large analysis' };
      const largeContent = 'Large analysis result '.repeat(10000); // ~200KB
      
      const { cacheKey, contextId } = await cache.set(params, largeContent);

      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBe(largeContent);
      
      // Check compressed metadata via getByContextId
      const cachedResponse = await cache.getByContextId(contextId);
      expect(cachedResponse!.compressed).toBe(true);
      expect(cachedResponse!.size).toBeLessThan(largeContent.length); // Compressed size
    });
  });

  describe('Session Security', () => {
    it('should prevent cross-session access via analysis ID', async () => {
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      
      // Store data in session A
      const { contextId } = await cache.set(
        { tool: 'test', target: 'sensitive-data' },
        'Private data for session A',
        undefined,
        sessionA,
        'request-1'
      );
      
      // Session A should be able to access it
      const resultA = await cache.get(contextId, sessionA);
      expect(resultA).toBe('Private data for session A');
      
      // Session B should NOT be able to access it
      const resultB = await cache.get(contextId, sessionB);
      expect(resultB).toBeNull();
      
      // No session should NOT be able to access it
      const resultNone = await cache.get(contextId);
      expect(resultNone).toBeNull();
    });
    
    it('should allow access to anonymous sessions from any session', async () => {
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      
      // Store data as anonymous
      const { contextId } = await cache.set(
        { tool: 'test', target: 'public-data' },
        'Public data for everyone',
        undefined,
        'anonymous',
        'request-1'
      );
      
      // Both sessions should be able to access it
      const resultA = await cache.get(contextId, sessionA);
      expect(resultA).toBe('Public data for everyone');
      
      const resultB = await cache.get(contextId, sessionB);
      expect(resultB).toBe('Public data for everyone');
      
      // No session should also be able to access it
      const resultNone = await cache.get(contextId);
      expect(resultNone).toBe('Public data for everyone');
    });

    it('should generate UUID-based analysis IDs', async () => {
      const { contextId } = await cache.set(
        { tool: 'test' },
        'test content',
        undefined,
        'test-session',
        'request-1'
      );
      
      // Should be a valid UUID format
      expect(contextId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(contextId.length).toBe(36);
    });

    it('should validate session for getByContextId', async () => {
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      
      const { contextId } = await cache.set(
        { tool: 'test', target: 'detailed-test' },
        'Detailed test content',
        undefined,
        sessionA,
        'request-1'
      );
      
      // Session A should get full response
      const resultA = await cache.getByContextId(contextId, sessionA);
      expect(resultA).not.toBeNull();
      expect(resultA!.content).toBe('Detailed test content');
      expect(resultA!.sessionId).toBe(sessionA);
      
      // Session B should be blocked
      const resultB = await cache.getByContextId(contextId, sessionB);
      expect(resultB).toBeNull();
    });

    it('should use consistent anonymous session for pagination cache hits', async () => {
      // This tests the fix for PAGINATION_BUGS.md Bug #1
      // Multiple requests with sessionId='anonymous' should share the same cache

      const params = { tool: 'roast_idea', idea: 'test idea' };
      const content = 'Large analysis result '.repeat(5000); // ~100KB

      // First request: sessionId = 'anonymous'
      const { contextId: id1 } = await cache.set(
        params,
        content,
        undefined,
        'anonymous', // Consistent anonymous session
        'request-1'
      );

      // Second request: sessionId = 'anonymous' (should match first)
      // This simulates pagination request with same anonymous session
      const result1 = await cache.get(id1, 'anonymous');
      expect(result1).toBe(content);

      // Third request: Also anonymous, should still hit cache
      const cachedResponse = await cache.getByContextId(id1, 'anonymous');
      expect(cachedResponse).not.toBeNull();
      expect(cachedResponse!.content).toBe(content);
      expect(cachedResponse!.sessionId).toBe('anonymous');

      // Verify cache hit was recorded
      const statsBefore = cache.getStats();
      await cache.get(id1, 'anonymous'); // Another hit
      const statsAfter = cache.getStats();

      expect(statsAfter.hits).toBe(statsBefore.hits + 1);
    });

    it('should prevent cache hits when sessionId changes from anonymous to random', async () => {
      // This tests what would have happened with the BUG (random session IDs)
      // If sessionId = `anonymous-${timestamp}-${random}`, cache misses occur

      const params = { tool: 'roast_idea', idea: 'test' };
      const content = 'Analysis result';

      const randomSession1 = `anonymous-${Date.now()}-abc123`;
      const randomSession2 = `anonymous-${Date.now() + 1000}-xyz789`;

      // Store with first random session
      const { contextId } = await cache.set(
        params,
        content,
        undefined,
        randomSession1,
        'request-1'
      );

      // Try to access with second random session (different session)
      const result = await cache.get(contextId, randomSession2);

      // Should be null - different sessions can't share cache
      expect(result).toBeNull();

      // But the original session can still access it
      const originalResult = await cache.get(contextId, randomSession1);
      expect(originalResult).toBe(content);
    });
  });

  describe('LRU Eviction & Memory Management', () => {
    it('should evict least recently used entries when at capacity', async () => {
      // Fill cache to capacity (20 entries)
      const cacheKeys: string[] = [];
      for (let i = 0; i < 20; i++) {
        const { cacheKey } = await cache.set({ targetPath: `/src${i}` }, `Content ${i}`);
        cacheKeys.push(cacheKey);
      }

      // All entries should be present
      for (let i = 0; i < 20; i++) {
        const retrieved = await cache.get(cacheKeys[i]);
        expect(retrieved).toBeDefined();
      }

      // Add one more entry (should evict first one)
      const { cacheKey: newKey } = await cache.set({ targetPath: '/src20' }, 'Content 20');

      // First entry should be evicted
      const evicted = await cache.get(cacheKeys[0]);
      expect(evicted).toBeNull();

      // New entry should be present
      const newEntry = await cache.get(newKey);
      expect(newEntry).toBeDefined();
    });

    it('should respect total memory limits', async () => {
      const largeContent = 'X'.repeat(1024 * 1024); // 1MB content
      
      // Try to add more content than total limit (10MB) - need more than 20 entries
      for (let i = 0; i < 25; i++) {
        await cache.set({ targetPath: `/large${i}` }, largeContent);
      }

      const stats = cache.getStats();
      expect(stats.totalSize).toBeLessThanOrEqual(10 * 1024 * 1024); // 10MB limit
      expect(stats.evictions).toBeGreaterThan(0); // Should have evicted some entries
    });

    it('should reject entries exceeding maximum entry size', async () => {
      const tooLargeContent = 'X'.repeat(3 * 1024 * 1024); // 3MB (exceeds 2MB limit)
      
      // Should throw an error when trying to store content that's too large
      await expect(async () => {
        await cache.set({ targetPath: '/toolarge' }, tooLargeContent);
      }).rejects.toThrow('Response too large');
    });
  });

  describe('Cache & Pagination Integration', () => {
    it('should cache large responses and paginate consistently', async () => {
      const largeResponse = createLargeAnalysisResponse(500); // 500KB response
      const params = { targetPath: '/large-project', analysis: 'comprehensive' };
      
      // Cache the large response
      const { cacheKey } = await cache.set(params, largeResponse);
      
      // Retrieve and paginate
      const cachedResponse = await cache.get(cacheKey);
      expect(cachedResponse).toBeDefined();
      
      const chunks = chunker.chunkText(cachedResponse!);
      expect(chunks.length).toBeGreaterThan(1);
      
      // Verify chunks maintain content integrity
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[chunks.length - 1].endOffset).toBe(largeResponse.length);
      
      // Verify each chunk has valid metadata
      chunks.forEach(chunk => {
        expect(chunk.metadata.originalLength).toBe(largeResponse.length);
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
      });
    });

    it('should maintain stable cursors across cache operations', async () => {
      const response = createLargeAnalysisResponse(300);
      const params = { targetPath: '/stable-test' };
      
      const { cacheKey: firstKey } = await cache.set(params, response);
      
      // First pagination request
      const chunks1 = chunker.chunkText(response);
      const firstChunk = chunks1[0];
      
      // Simulate cache eviction and re-caching
      cache.clear();
      const { cacheKey: secondKey } = await cache.set(params, response);
      
      // Cache keys should be identical (deterministic)
      expect(secondKey).toBe(firstKey);
      
      // Second pagination request should produce identical chunks
      const chunks2 = chunker.chunkText(response);
      const secondChunk = chunks2[0];
      
      expect(firstChunk.content).toBe(secondChunk.content);
      expect(firstChunk.startOffset).toBe(secondChunk.startOffset);
      expect(firstChunk.endOffset).toBe(secondChunk.endOffset);
    });

    it('should provide accurate token estimates for cached content', async () => {
      const response = createLargeAnalysisResponse(100); // 100KB
      const params = { targetPath: '/token-test' };
      
      const { cacheKey } = await cache.set(params, response);
      const cached = await cache.get(cacheKey);
      
      const tokenCount = estimateTokenCount(cached!);
      const expectedTokens = Math.ceil(cached!.length / 4); // ~4 chars per token
      
      expect(tokenCount).toBe(expectedTokens);
      expect(tokenCount).toBeGreaterThan(20000); // 100KB should be substantial tokens
    });

    it('should chunk content to stay within token limits', async () => {
      const response = createLargeAnalysisResponse(400); // 400KB
      const params = { targetPath: '/large-token-test' };
      
      const { cacheKey } = await cache.set(params, response);
      const cached = await cache.get(cacheKey);
      
      const chunks = chunker.chunkText(cached!);
      
      chunks.forEach(chunk => {
        const tokenCount = estimateTokenCount(chunk.content);
        // Should stay within reasonable limits (90K chars ≈ 22.5K tokens)
        expect(tokenCount).toBeLessThanOrEqual(25000);
      });
    });
  });

  describe('Real-world Integration Scenarios', () => {
    it('should integrate with brutalist server tool execution', async () => {
      // Mock a simple analysis flow
      const mockParams = {
        targetPath: '/test/src',
        context: 'Integration test analysis',
        clis: ['claude']
      };

      // Simulate first analysis request
      const analysisResult = 'Mocked brutal analysis result with security vulnerabilities found...';
      const { cacheKey } = await cache.set(mockParams, analysisResult);
      expect(cacheKey).toMatch(/^[a-f0-9]{64}$/);

      // Simulate subsequent request with same parameters
      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBe(analysisResult);

      // Verify cache hit was recorded
      const stats = cache.getStats();
      expect(stats.hits).toBeGreaterThan(0);
    });

    it('should work with CLI orchestrator integration', async () => {
      // Test that cache integrates properly with CLI orchestrator workflow
      const context = await orchestrator.detectCLIContext();
      
      // Simulate caching CLI detection results
      const cliContextParams = { operation: 'cli_context_detection' };
      const { cacheKey } = await cache.set(cliContextParams, JSON.stringify(context));
      
      const cachedContext = await cache.get(cacheKey);
      expect(cachedContext).toBeDefined();
      
      const parsedContext = JSON.parse(cachedContext!);
      expect(parsedContext.availableCLIs).toEqual(context.availableCLIs);
    });

    it('should handle typical brutalist analysis response pagination', async () => {
      const brutalistResponse = createLargeAnalysisResponse(150); // 150KB for multiple chunks

      const params = {
        targetPath: '/real-project',
        context: 'Complete security audit',
        clis: ['claude']
      };

      const { cacheKey } = await cache.set(params, brutalistResponse);

      // Test pagination workflow
      const cached = await cache.get(cacheKey);
      expect(cached).toBeDefined();

      const chunks = chunker.chunkText(cached!);

      // Should create multiple readable chunks
      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk should contain complete sections where possible
      chunks.forEach((chunk, index) => {
        expect(chunk.content.length).toBeGreaterThan(0);
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);

        // Metadata should be accurate
        expect(chunk.metadata.originalLength).toBe(brutalistResponse.length);
        expect(chunk.metadata.isComplete).toBe(index === chunks.length - 1);
      });
    }, 60000); // 60 second timeout for large content processing

    it('should handle concurrent cache operations', async () => {
      // Simulate multiple concurrent analysis requests with smaller number for stability
      const promises = Array.from({ length: 5 }, (_, i) => 
        cache.set(
          { targetPath: `/concurrent${i}`, analysis: 'concurrent test' },
          `Concurrent analysis result ${i}`
        )
      );

      const results = await Promise.all(promises);
      expect(results.every(r => r.cacheKey.match(/^[a-f0-9]{64}$/))).toBe(true);

      // Add small delay to ensure all writes are complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify all entries can be retrieved
      const retrievals = await Promise.all(
        results.map(({ cacheKey }) => cache.get(cacheKey))
      );

      retrievals.forEach((result, i) => {
        expect(result).toBeDefined();
        expect(result).not.toBeNull();
        expect(result).toBe(`Concurrent analysis result ${i}`);
      });
    });
  });

  describe('TTL & Error Handling', () => {
    it('should respect TTL expiration', async () => {
      // Create cache with very short TTL
      const shortTTLCache = new ResponseCache({ ttlHours: 0.001 }); // ~3.6 seconds
      
      const params = { targetPath: '/src', context: 'test' };
      const content = 'Test content';
      
      const { cacheKey } = await shortTTLCache.set(params, content);
      
      // Should be available immediately
      let retrieved = await shortTTLCache.get(cacheKey);
      expect(retrieved).toBeDefined();
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Should be expired
      retrieved = await shortTTLCache.get(cacheKey);
      expect(retrieved).toBeNull();
      
      // Cleanup
      shortTTLCache.destroy();
    });

    it('should handle cache misses gracefully', async () => {
      const nonExistentKey = 'nonexistent_cache_key_12345';
      
      const retrieved = await cache.get(nonExistentKey);
      expect(retrieved).toBeNull();
    });

    it('should handle empty content', async () => {
      const params = { targetPath: '/empty', context: 'test' };
      
      const { cacheKey } = await cache.set(params, '');
      const retrieved = await cache.get(cacheKey);
      expect(retrieved).toBe('');
    });

    it('should track cache hits and misses', async () => {
      const initialStats = cache.getStats();
      
      // Cache miss
      await cache.get('missing_key_12345');
      
      // Cache set and hit
      const { cacheKey } = await cache.set({ targetPath: '/test' }, 'content');
      await cache.get(cacheKey);
      
      const finalStats = cache.getStats();
      
      expect(finalStats.misses).toBe(initialStats.misses + 1);
      expect(finalStats.hits).toBe(initialStats.hits + 1);
      expect(finalStats.entries).toBe(initialStats.entries + 1);
    });
  });
});