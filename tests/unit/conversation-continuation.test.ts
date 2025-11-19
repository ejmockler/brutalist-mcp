/**
 * Unit tests for conversation continuation feature
 * Tests that context_id allows continuing conversations with history injection
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
