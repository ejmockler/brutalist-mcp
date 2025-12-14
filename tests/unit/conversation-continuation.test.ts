/**
 * Unit tests for conversation continuation feature
 * Tests that context_id allows continuing conversations with history injection
 *
 * Engineering Distinction:
 * - PAGINATION: context_id alone → returns cached response at offset
 * - CONTINUATION: context_id + resume: true + content → injects history, runs new analysis
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { MockedFunction } from 'jest-mock';
import { ResponseCache, ConversationMessage } from '../../src/utils/response-cache.js';

describe('Conversation Continuation', () => {
  let cache: ResponseCache;
  const sessionId = 'test-session-123';

  beforeEach(() => {
    cache = new ResponseCache();
  });

  it('should store conversation history with initial response', async () => {
    const conversationHistory: ConversationMessage[] = [
      {
        role: 'user',
        content: 'What is the best way to handle errors?',
        timestamp: Date.now()
      },
      {
        role: 'assistant',
        content: 'The best way is to use try-catch blocks...',
        timestamp: Date.now()
      }
    ];

    const { contextId } = await cache.set(
      { test: 'data' },
      'The best way is to use try-catch blocks...',
      undefined,
      sessionId,
      'req-1',
      conversationHistory
    );

    expect(contextId).toBeTruthy();

    const retrieved = await cache.getByContextId(contextId, sessionId);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.conversationHistory).toEqual(conversationHistory);
  });

  it('should update existing conversation when context_id is provided', async () => {
    // Initial conversation
    const initialHistory: ConversationMessage[] = [
      {
        role: 'user',
        content: 'What is the best way to handle errors?',
        timestamp: Date.now()
      },
      {
        role: 'assistant',
        content: 'Use try-catch blocks.',
        timestamp: Date.now()
      }
    ];

    const { contextId } = await cache.set(
      { test: 'data' },
      'Use try-catch blocks.',
      undefined,
      sessionId,
      'req-1',
      initialHistory
    );

    // Continue conversation
    const updatedHistory: ConversationMessage[] = [
      ...initialHistory,
      {
        role: 'user',
        content: 'What about async errors?',
        timestamp: Date.now()
      },
      {
        role: 'assistant',
        content: 'Use try-catch with async/await or .catch() with promises.',
        timestamp: Date.now()
      }
    ];

    await cache.updateByContextId(
      contextId,
      'Use try-catch with async/await or .catch() with promises.',
      updatedHistory,
      sessionId
    );

    const retrieved = await cache.getByContextId(contextId, sessionId);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.conversationHistory).toHaveLength(4);
    expect(retrieved!.conversationHistory![2].content).toContain('async errors');
    expect(retrieved!.conversationHistory![3].content).toContain('async/await');
  });

  it('should throw error when updating non-existent context_id', async () => {
    await expect(
      cache.updateByContextId(
        'non-existent-id',
        'new content',
        [],
        sessionId
      )
    ).rejects.toThrow('context_id non-existent-id not found');
  });

  it('should throw error when updating with wrong session', async () => {
    const { contextId } = await cache.set(
      { test: 'data' },
      'content',
      undefined,
      'session-1',
      'req-1',
      []
    );

    await expect(
      cache.updateByContextId(
        contextId,
        'new content',
        [],
        'different-session'
      )
    ).rejects.toThrow('Session mismatch');
  });

  it('should preserve conversation history through cache compression', async () => {
    // Create large content that will trigger compression (> 1MB)
    const largeContent = 'x'.repeat(2 * 1024 * 1024); // 2MB

    const conversationHistory: ConversationMessage[] = [
      {
        role: 'user',
        content: 'Test question',
        timestamp: Date.now()
      },
      {
        role: 'assistant',
        content: largeContent,
        timestamp: Date.now()
      }
    ];

    const { contextId } = await cache.set(
      { test: 'data' },
      largeContent,
      undefined,
      sessionId,
      'req-1',
      conversationHistory
    );

    const retrieved = await cache.getByContextId(contextId, sessionId);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.compressed).toBe(true);
    expect(retrieved!.conversationHistory).toEqual(conversationHistory);
    expect(retrieved!.content).toBe(largeContent);
  });

  it('should handle empty conversation history', async () => {
    const { contextId } = await cache.set(
      { test: 'data' },
      'content',
      undefined,
      sessionId,
      'req-1',
      []
    );

    const retrieved = await cache.getByContextId(contextId, sessionId);
    expect(retrieved!.conversationHistory).toEqual([]);
  });

  it('should handle undefined conversation history', async () => {
    const { contextId } = await cache.set(
      { test: 'data' },
      'content',
      undefined,
      sessionId,
      'req-1'
      // No conversation history provided
    );

    const retrieved = await cache.getByContextId(contextId, sessionId);
    expect(retrieved!.conversationHistory).toBeUndefined();
  });
});

/**
 * Tests for the resume flag engineering distinction
 * These validate the API contract for pagination vs continuation
 */
describe('Resume Flag Contract', () => {
  describe('Argument Validation', () => {
    it('should define resume as a boolean flag in BASE_ARGUMENTS', async () => {
      // Import dynamically to avoid circular dependencies in tests
      const { BASE_ARGUMENTS } = await import('../../src/domains/argument-space.js');

      expect(BASE_ARGUMENTS.shape.resume).toBeDefined();
      expect(BASE_ARGUMENTS.shape.context_id).toBeDefined();

      // Validate the schema accepts boolean
      const result = BASE_ARGUMENTS.safeParse({ resume: true, context_id: 'test-id' });
      expect(result.success).toBe(true);
    });

    it('should reject non-boolean resume values', async () => {
      const { BASE_ARGUMENTS } = await import('../../src/domains/argument-space.js');

      const result = BASE_ARGUMENTS.safeParse({ resume: 'yes' });
      expect(result.success).toBe(false);
    });

    it('should exclude resume and context_id from cache key inference', async () => {
      const { inferCacheKeys, FILESYSTEM_ARGUMENT_SPACE } = await import('../../src/domains/argument-space.js');

      const cacheKeys = inferCacheKeys(FILESYSTEM_ARGUMENT_SPACE);

      // resume and context_id should NOT be in cache keys (they don't affect analysis content)
      expect(cacheKeys).not.toContain('resume');
      expect(cacheKeys).not.toContain('context_id');
      expect(cacheKeys).not.toContain('offset');
      expect(cacheKeys).not.toContain('limit');
      expect(cacheKeys).not.toContain('cursor');
      expect(cacheKeys).not.toContain('force_refresh');

      // targetPath should be in cache keys (affects analysis)
      expect(cacheKeys).toContain('targetPath');
    });
  });

  describe('Mode Distinction', () => {
    let cache: ResponseCache;
    const sessionId = 'test-session-for-resume';

    beforeEach(() => {
      cache = new ResponseCache();
    });

    it('pagination mode: context_id alone should return cached content unchanged', async () => {
      const originalContent = 'This is the original analysis result';
      const { contextId } = await cache.set(
        { tool: 'roast_codebase', targetPath: '/src' },
        originalContent,
        undefined,
        sessionId,
        'req-1',
        [{ role: 'user', content: 'Analyze this', timestamp: Date.now() }]
      );

      // Pagination retrieval - should get exact same content
      const retrieved = await cache.getByContextId(contextId, sessionId);
      expect(retrieved).toBeTruthy();
      expect(retrieved!.content).toBe(originalContent);
      // Conversation history unchanged
      expect(retrieved!.conversationHistory).toHaveLength(1);
    });

    it('continuation mode: context_id + new content should update conversation', async () => {
      const { contextId } = await cache.set(
        { tool: 'roast_codebase', targetPath: '/src' },
        'Initial analysis...',
        undefined,
        sessionId,
        'req-1',
        [
          { role: 'user', content: 'Analyze this', timestamp: Date.now() },
          { role: 'assistant', content: 'Initial analysis...', timestamp: Date.now() }
        ]
      );

      // Simulate continuation - update with new conversation
      const extendedHistory: ConversationMessage[] = [
        { role: 'user', content: 'Analyze this', timestamp: Date.now() },
        { role: 'assistant', content: 'Initial analysis...', timestamp: Date.now() },
        { role: 'user', content: 'Tell me more about issue #3', timestamp: Date.now() },
        { role: 'assistant', content: 'Issue #3 is about...', timestamp: Date.now() }
      ];

      await cache.updateByContextId(
        contextId,
        'Issue #3 is about...',
        extendedHistory,
        sessionId
      );

      const retrieved = await cache.getByContextId(contextId, sessionId);
      expect(retrieved).toBeTruthy();
      expect(retrieved!.conversationHistory).toHaveLength(4);
      expect(retrieved!.content).toBe('Issue #3 is about...');
    });
  });
});

/**
 * Tests for filesystem tool resume mode
 * Verifies that original targetPath is preserved when resuming conversations
 */
describe('Filesystem Tool Resume Mode', () => {
  let cache: ResponseCache;
  const sessionId = 'test-session-filesystem';

  beforeEach(() => {
    cache = new ResponseCache();
  });

  it('should preserve original targetPath in requestParams for filesystem tools', async () => {
    const originalParams = {
      tool: 'roast_codebase',
      targetPath: '/path/to/original/project',
      preferredCLI: 'claude'
    };

    const { contextId } = await cache.set(
      originalParams,
      'Initial codebase analysis...',
      undefined,
      sessionId,
      'req-1',
      [
        { role: 'user', content: '/path/to/original/project', timestamp: Date.now() },
        { role: 'assistant', content: 'Initial codebase analysis...', timestamp: Date.now() }
      ]
    );

    // Retrieve and verify requestParams contains original targetPath
    const retrieved = await cache.getByContextId(contextId, sessionId);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.requestParams).toBeDefined();
    expect(retrieved!.requestParams.targetPath).toBe('/path/to/original/project');
    expect(retrieved!.requestParams.tool).toBe('roast_codebase');
    expect(retrieved!.requestParams.preferredCLI).toBe('claude');
  });

  it('should allow retrieving original params for resume mode path restoration', async () => {
    // Simulate initial filesystem tool execution
    const originalParams = {
      tool: 'roast_codebase',
      targetPath: '/src/my-project',
      workingDirectory: '/src/my-project'
    };

    const { contextId } = await cache.set(
      originalParams,
      'Found 5 issues in your codebase...',
      undefined,
      sessionId,
      'req-1',
      [
        { role: 'user', content: '/src/my-project', timestamp: Date.now() },
        { role: 'assistant', content: 'Found 5 issues in your codebase...', timestamp: Date.now() }
      ]
    );

    // User tries to resume with a follow-up question
    // In the old code, this would fail because "Tell me about issue 3" would be validated as a path
    // The fix extracts original targetPath from requestParams

    const cachedResponse = await cache.getByContextId(contextId, sessionId);
    expect(cachedResponse).toBeTruthy();

    // Verify we can extract the original path for resume mode
    const originalTargetPath = cachedResponse!.requestParams.targetPath as string;
    expect(originalTargetPath).toBe('/src/my-project');

    // Verify workingDirectory is also available
    const originalWorkingDir = cachedResponse!.requestParams.workingDirectory as string;
    expect(originalWorkingDir).toBe('/src/my-project');
  });
});
