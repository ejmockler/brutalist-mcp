import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { BrutalistServer } from '../../src/brutalist-server.js';
import { defaultTestConfig } from '../fixtures/test-configs.js';
import { 
  extractPaginationParams,
  createPaginationMetadata,
  formatPaginationStatus,
  parseCursor,
  estimateTokenCount,
  ResponseChunker,
  PAGINATION_DEFAULTS
} from '../../src/utils/pagination.js';
import { TestIsolation } from '../../src/test-utils/test-isolation.js';

// E2E Pagination Integration Tests
// These tests verify pagination utility functions work correctly

describe('Pagination E2E Integration', () => {
  let server: BrutalistServer;
  let testIsolation: TestIsolation;
  
  beforeEach(() => {
    testIsolation = new TestIsolation('pagination-e2e');
    
    server = new BrutalistServer({
      ...defaultTestConfig,
      transport: 'stdio' // Use stdio for direct testing
    });
    
    // Extend timeout for real CLI operations
    jest.setTimeout(120000); // 2 minutes
  });

  afterEach(async () => {
    await testIsolation.cleanup();
    jest.setTimeout(30000); // Reset timeout
  });

  describe('End-to-End Pagination Workflow', () => {
    it('should handle pagination request without CLI execution', async () => {
      // Test pagination parameter parsing without requiring actual CLI tools
      const mockArgs = {
        targetPath: '/test/path',
        offset: 5000,
        limit: 15000,
        context: 'E2E pagination test'
      };

      // Test that pagination utility can process pagination parameters
      const result = extractPaginationParams(mockArgs);
      
      expect(result).toEqual({
        offset: 5000,
        limit: 15000,
        cursor: undefined
      });
    });

    it('should parse cursor-based pagination', async () => {
      const mockArgs = {
        targetPath: '/test/path',
        cursor: 'offset:10000'
      };

      const result = extractPaginationParams(mockArgs);
      
      expect(result.offset).toBe(0); // Direct params
      expect(result.cursor).toBe('offset:10000');
      
      // Test cursor parsing
      const parsedCursor = parseCursor('offset:10000');
      expect(parsedCursor).toEqual({ offset: 10000 });
    });

    it('should validate pagination parameter constraints', async () => {
      // Test parameter validation without mocking
      const validParams = {
        offset: 1000,
        limit: 25000,
        cursor: undefined
      };

      const extractedParams = extractPaginationParams(validParams);
      
      expect(extractedParams.offset).toBe(1000);
      expect(extractedParams.limit).toBe(25000);
    });

    it('should enforce limit constraints', async () => {
      // Test that pagination utility enforces limits correctly
      const tooHighLimit = {
        offset: 0,
        limit: 150000 // Above max of 100000
      };

      const extractedParams = extractPaginationParams(tooHighLimit);
      
      // Should be clamped to maximum
      expect(extractedParams.limit).toBe(100000);
    });

    it('should enforce minimum limit constraint', async () => {
      const tooLowLimit = {
        offset: 0,
        limit: 500 // Below min of 1000
      };

      const extractedParams = extractPaginationParams(tooLowLimit);
      
      // Should be clamped to minimum
      expect(extractedParams.limit).toBe(1000);
    });
  });

  describe('Integration with Real Responses', () => {
    it('should create pagination metadata correctly', async () => {
      const testContent = 'A'.repeat(50000); // 50KB test content
      const paginationParams = { offset: 0, limit: 20000, cursor: undefined };
      
      const metadata = createPaginationMetadata(
        testContent.length,
        paginationParams,
        20000
      );

      expect(metadata).toEqual({
        total: 50000,
        offset: 0,
        limit: 20000,
        hasMore: true,
        nextCursor: 'offset:20000',
        chunkIndex: 1,
        totalChunks: 3 // Math.ceil(50000/20000) = 3
      });
    });

    it('should format pagination status correctly', async () => {
      const metadata = {
        total: 50000,
        offset: 20000,
        limit: 15000,
        hasMore: true,
        chunkIndex: 2,
        totalChunks: 4,
        nextCursor: 'offset:35000'
      };

      const status = formatPaginationStatus(metadata);
      
      expect(status).toBe('Part 2/4: chars 20,000-35,000 of 50,000 • Use offset parameter to continue');
    });

    it('should format final chunk status', async () => {
      const metadata = {
        total: 30000,
        offset: 20000,
        limit: 15000,
        hasMore: false,
        chunkIndex: 2,
        totalChunks: 2
      };

      const status = formatPaginationStatus(metadata);
      
      expect(status).toBe('Part 2/2: chars 20,000-30,000 of 30,000 • Complete');
    });

    it('should handle complete single response', async () => {
      const metadata = {
        total: 5000,
        offset: 0,
        limit: 25000,
        hasMore: false,
        chunkIndex: 1,
        totalChunks: 1
      };

      const status = formatPaginationStatus(metadata);
      
      expect(status).toBe('Complete response (5,000 characters)');
    });
  });

  describe('Token Estimation Integration', () => {
    it('should estimate tokens accurately', () => {
      const testTexts = [
        { text: 'A'.repeat(4000), expectedTokens: 1000 },
        { text: 'Hello world', expectedTokens: 3 },
        { text: '', expectedTokens: 0 },
        { text: 'X'.repeat(1000), expectedTokens: 250 }
      ];

      testTexts.forEach(({ text, expectedTokens }) => {
        const tokens = estimateTokenCount(text);
        expect(tokens).toBe(expectedTokens);
      });
    });

    it('should handle unicode characters in token estimation', () => {
      const unicodeText = '测试文本🚀🔥'; // Mixed unicode
      const tokens = estimateTokenCount(unicodeText);
      
      // Should use character length for estimation
      expect(tokens).toBe(Math.ceil(unicodeText.length / 4));
    });
  });

  describe('Response Chunking Integration', () => {
    it('should create response chunks with smart boundaries', () => {
      const chunker = new ResponseChunker(100, 20);
      const testText = 'Word '.repeat(50); // 250 chars with word boundaries
      
      const chunks = chunker.chunkText(testText);
      
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].metadata.originalLength).toBe(testText.length);
      
      if (chunks.length > 1) {
        // Verify overlap between chunks
        expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
      }
    });

    it('should preserve sentence boundaries when possible', () => {
      const chunker = new ResponseChunker(50, 10);
      const testText = 'First sentence. Second sentence that is longer. Third sentence.';
      
      const chunks = chunker.chunkText(testText);
      
      // Should break at sentence boundaries when possible
      if (chunks.length > 1) {
        expect(chunks[0].content).toMatch(/\.\s*$/);
      }
    });
  });

  describe('Configuration Integration', () => {
    it('should respect pagination defaults from configuration', () => {
      expect(PAGINATION_DEFAULTS).toEqual({
        DEFAULT_LIMIT: 90000, // Updated to correct value
        MAX_LIMIT: 100000,
        MIN_LIMIT: 1000,
        CHUNK_OVERLAP: 200
      });
    });

    it('should use configuration values in parameter extraction', () => {
      const emptyParams = {};
      const extracted = extractPaginationParams(emptyParams);
      
      expect(extracted.offset).toBe(0);
      expect(extracted.limit).toBe(90000); // DEFAULT_LIMIT (updated)
      expect(extracted.cursor).toBeUndefined();
    });
  });

  describe('Error Handling Integration', () => {
    it('should handle malformed JSON cursors gracefully', () => {
      const malformedCursor = '{"offset": 1000, invalid json}';
      const parsed = parseCursor(malformedCursor);
      
      expect(parsed).toEqual({}); // Should return empty object on parse failure
    });

    it('should handle non-numeric cursor values gracefully', () => {
      const invalidCursor = 'offset:not-a-number';
      const parsed = parseCursor(invalidCursor);
      
      expect(parsed).toEqual({}); // Should return empty object
    });

    it('should handle negative offset gracefully', () => {
      const params = { offset: -1000, limit: 5000 };
      const extracted = extractPaginationParams(params);
      
      expect(extracted.offset).toBe(0); // Should clamp to 0
    });
  });
});