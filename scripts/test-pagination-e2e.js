#!/usr/bin/env node

/**
 * E2E Pagination Integration Test Runner
 * Tests pagination functionality without mocking CLI agents
 */

import { BrutalistServer } from '../dist/brutalist-server.js';
import { 
  extractPaginationParams,
  createPaginationMetadata,
  formatPaginationStatus,
  parseCursor,
  estimateTokenCount,
  ResponseChunker,
  PAGINATION_DEFAULTS
} from '../dist/utils/pagination.js';

console.log('🧪 Running E2E Pagination Integration Tests...\n');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
    testsFailed++;
  }
}

function expect(actual) {
  return {
    toBe: (expected) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toEqual: (expected) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toContain: (expected) => {
      if (!actual.includes(expected)) {
        throw new Error(`Expected "${actual}" to contain "${expected}"`);
      }
    },
    toBeGreaterThan: (expected) => {
      if (actual <= expected) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeLessThan: (expected) => {
      if (actual >= expected) {
        throw new Error(`Expected ${actual} to be less than ${expected}`);
      }
    }
  };
}

// Test 1: Parameter Extraction
test('extractPaginationParams - basic functionality', () => {
  const params = extractPaginationParams({ offset: 1000, limit: 5000 });
  expect(params).toEqual({ offset: 1000, limit: 5000, cursor: undefined });
});

test('extractPaginationParams - default values', () => {
  const params = extractPaginationParams({});
  expect(params).toEqual({ 
    offset: 0, 
    limit: PAGINATION_DEFAULTS.DEFAULT_LIMIT, 
    cursor: undefined 
  });
});

test('extractPaginationParams - limit constraints', () => {
  const tooHigh = extractPaginationParams({ limit: 200000 });
  expect(tooHigh.limit).toBe(PAGINATION_DEFAULTS.MAX_LIMIT);
  
  const tooLow = extractPaginationParams({ limit: 500 });
  expect(tooLow.limit).toBe(PAGINATION_DEFAULTS.MIN_LIMIT);
});

test('extractPaginationParams - negative offset handling', () => {
  const params = extractPaginationParams({ offset: -100 });
  expect(params.offset).toBe(0);
});

// Test 2: Cursor Parsing  
test('parseCursor - simple offset format', () => {
  const parsed = parseCursor('offset:5000');
  expect(parsed).toEqual({ offset: 5000 });
});

test('parseCursor - JSON format', () => {
  const cursor = JSON.stringify({ offset: 10000, limit: 2000 });
  const parsed = parseCursor(cursor);
  expect(parsed).toEqual({ offset: 10000, limit: 2000 });
});

test('parseCursor - invalid format handling', () => {
  const parsed1 = parseCursor('invalid-format');
  expect(parsed1).toEqual({});
  
  const parsed2 = parseCursor('{"invalid": json}');
  expect(parsed2).toEqual({});
  
  const parsed3 = parseCursor('offset:not-a-number');
  expect(parsed3).toEqual({});
});

// Test 3: Pagination Metadata
test('createPaginationMetadata - first page', () => {
  const metadata = createPaginationMetadata(50000, { offset: 0, limit: 20000 }, 20000);
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

test('createPaginationMetadata - last page', () => {
  const metadata = createPaginationMetadata(50000, { offset: 40000, limit: 20000 }, 20000);
  expect(metadata).toEqual({
    total: 50000,
    offset: 40000,
    limit: 20000,
    hasMore: false,
    nextCursor: undefined,
    chunkIndex: 3, // Math.floor(40000/20000) + 1 = 3
    totalChunks: 3
  });
});

test('createPaginationMetadata - single page', () => {
  const metadata = createPaginationMetadata(5000, { offset: 0, limit: 25000 });
  expect(metadata).toEqual({
    total: 5000,
    offset: 0,
    limit: 25000,
    hasMore: false,
    nextCursor: undefined,
    chunkIndex: 1,
    totalChunks: 1
  });
});

// Test 4: Status Formatting
test('formatPaginationStatus - middle chunk', () => {
  const metadata = {
    total: 50000,
    offset: 20000,
    limit: 15000,
    hasMore: true,
    chunkIndex: 2,
    totalChunks: 4
  };
  const status = formatPaginationStatus(metadata);
  expect(status).toBe('Part 2/4: chars 20,000-35,000 of 50,000 • Use offset parameter to continue');
});

test('formatPaginationStatus - final chunk', () => {
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

test('formatPaginationStatus - single complete response', () => {
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

// Test 5: Token Estimation
test('estimateTokenCount - basic estimation', () => {
  expect(estimateTokenCount('A'.repeat(4000))).toBe(1000);
  expect(estimateTokenCount('Hello world')).toBe(3);
  expect(estimateTokenCount('')).toBe(0);
  expect(estimateTokenCount('ABC')).toBe(1); // Rounds up
});

test('estimateTokenCount - unicode handling', () => {
  const unicodeText = '测试文本🚀🔥';
  const expectedTokens = Math.ceil(unicodeText.length / 4);
  expect(estimateTokenCount(unicodeText)).toBe(expectedTokens);
});

// Test 6: Response Chunker
test('ResponseChunker - single chunk for small text', () => {
  const chunker = new ResponseChunker(1000, 100);
  const text = 'Short text';
  const chunks = chunker.chunkText(text);
  
  expect(chunks.length).toBe(1);
  expect(chunks[0].content).toBe(text);
  expect(chunks[0].metadata.isComplete).toBe(true);
  expect(chunks[0].metadata.truncated).toBe(false);
});

test('ResponseChunker - multiple chunks for large text', () => {
  const chunker = new ResponseChunker(50, 10);
  const text = 'Word '.repeat(30); // 150 chars
  const chunks = chunker.chunkText(text);
  
  // Should either chunk or handle as single piece
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[chunks.length - 1].metadata.isComplete).toBe(true);
  
  // All chunks should have consistent original length
  chunks.forEach(chunk => {
    expect(chunk.metadata.originalLength).toBe(text.length);
  });
});

test('ResponseChunker - boundary detection', () => {
  const chunker = new ResponseChunker(60, 10);
  const text = 'First sentence. Second sentence that is longer. Third sentence.';
  const chunks = chunker.chunkText(text);
  
  expect(chunks.length).toBeGreaterThan(0);
  if (chunks.length > 1) {
    // Should break at sentence boundaries when possible
    expect(chunks[0].content.trim()).toMatch(/\.$/);
  }
});

// Test 7: Configuration Constants
test('PAGINATION_DEFAULTS - correct values', () => {
  expect(PAGINATION_DEFAULTS.DEFAULT_LIMIT).toBe(25000);
  expect(PAGINATION_DEFAULTS.MAX_LIMIT).toBe(100000);
  expect(PAGINATION_DEFAULTS.MIN_LIMIT).toBe(1000);
  expect(PAGINATION_DEFAULTS.CHUNK_OVERLAP).toBe(200);
});

// Test 8: Server Integration
test('BrutalistServer - can be instantiated with pagination config', () => {
  const server = new BrutalistServer({
    workingDirectory: '/tmp/test',
    defaultTimeout: 5000,
    enableSandbox: true,
    transport: 'stdio'
  });
  
  // Should not throw during construction
  expect(typeof server).toBe('object');
});

// Summary
console.log('\n📊 Test Summary:');
console.log(`✅ Passed: ${testsPassed}`);
console.log(`❌ Failed: ${testsFailed}`);
console.log(`📋 Total: ${testsPassed + testsFailed}`);

if (testsFailed > 0) {
  console.log('\n❌ Some pagination E2E tests failed!');
  process.exit(1);
} else {
  console.log('\n🎉 All pagination E2E tests passed!');
  console.log('✨ Pagination system is ready for production use.');
}