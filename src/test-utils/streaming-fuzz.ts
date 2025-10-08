import { Readable, Transform } from 'stream';
import { logger } from '../logger.js';

/**
 * Utilities for fuzz testing streaming parsers with random chunking,
 * corrupted data, and various edge cases
 */
export class StreamingFuzzHarness {
  /**
   * Split data into random-sized chunks
   */
  randomChunker(
    data: string | Buffer, 
    minChunk: number = 1, 
    maxChunk: number = 100
  ): Buffer[] {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const chunks: Buffer[] = [];
    let offset = 0;

    while (offset < buffer.length) {
      const chunkSize = Math.floor(Math.random() * (maxChunk - minChunk + 1)) + minChunk;
      const end = Math.min(offset + chunkSize, buffer.length);
      chunks.push(buffer.slice(offset, end));
      offset = end;
    }

    return chunks;
  }

  /**
   * Create a readable stream that emits data in random chunks
   */
  createRandomChunkStream(
    data: string | Buffer,
    minChunk: number = 1,
    maxChunk: number = 100,
    delayMs: number = 0
  ): Readable {
    const chunks = this.randomChunker(data, minChunk, maxChunk);
    let index = 0;

    return new Readable({
      async read() {
        if (index >= chunks.length) {
          this.push(null); // End stream
          return;
        }

        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        this.push(chunks[index++]);
      }
    });
  }

  /**
   * Inject invalid UTF-8 sequences into a string
   */
  corruptWithInvalidUtf8(data: string): Buffer {
    const buffer = Buffer.from(data);
    const corrupted = Buffer.allocUnsafe(buffer.length + 10);
    buffer.copy(corrupted);

    // Inject some invalid UTF-8 sequences
    const invalidSequences = [
      Buffer.from([0xFF, 0xFF]), // Invalid start bytes
      Buffer.from([0xC0, 0x80]), // Overlong encoding
      Buffer.from([0xED, 0xA0, 0x80]), // UTF-16 surrogate
      Buffer.from([0xF4, 0x90, 0x80, 0x80]), // Code point > U+10FFFF
    ];

    // Insert random invalid sequences
    for (let i = 0; i < 3; i++) {
      const pos = Math.floor(Math.random() * corrupted.length);
      const invalidSeq = invalidSequences[Math.floor(Math.random() * invalidSequences.length)];
      invalidSeq.copy(corrupted, pos);
    }

    return corrupted;
  }

  /**
   * Truncate data at various boundaries to test partial parsing
   */
  truncateAtBoundaries(data: string): string[] {
    const truncated: string[] = [];
    
    // Truncate at different percentages
    const percentages = [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99];
    for (const pct of percentages) {
      const len = Math.floor(data.length * pct);
      truncated.push(data.substring(0, len));
    }

    // Truncate in middle of likely JSON structures
    const jsonBoundaries = ['{', '}', '[', ']', '"', ':', ','];
    for (const boundary of jsonBoundaries) {
      const index = data.indexOf(boundary);
      if (index > 0 && index < data.length - 1) {
        truncated.push(data.substring(0, index));
        truncated.push(data.substring(0, index + 1));
      }
    }

    return truncated;
  }

  /**
   * Create a transform stream that randomly corrupts data
   */
  createCorruptionStream(corruptionRate: number = 0.01): Transform {
    return new Transform({
      transform(chunk: Buffer, encoding, callback) {
        const corrupted = Buffer.allocUnsafe(chunk.length);
        
        for (let i = 0; i < chunk.length; i++) {
          if (Math.random() < corruptionRate) {
            // Corrupt this byte
            corrupted[i] = Math.floor(Math.random() * 256);
          } else {
            corrupted[i] = chunk[i];
          }
        }

        callback(null, corrupted);
      }
    });
  }

  /**
   * Create a transform stream that simulates slow delivery
   */
  createThrottleStream(bytesPerSecond: number): Transform {
    let lastEmit = Date.now();
    let bytesSent = 0;

    return new Transform({
      async transform(chunk: Buffer, encoding, callback) {
        const now = Date.now();
        const elapsed = (now - lastEmit) / 1000;
        const allowedBytes = Math.floor(elapsed * bytesPerSecond);

        if (bytesSent >= allowedBytes) {
          // Need to wait
          const waitTime = ((bytesSent + chunk.length) / bytesPerSecond - elapsed) * 1000;
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        bytesSent += chunk.length;
        callback(null, chunk);
      }
    });
  }

  /**
   * Create a transform stream that simulates backpressure
   */
  createBackpressureStream(bufferSize: number = 1024): Transform {
    let buffer: Buffer[] = [];
    let totalSize = 0;
    let paused = false;

    return new Transform({
      transform(chunk: Buffer, encoding, callback) {
        buffer.push(chunk);
        totalSize += chunk.length;

        if (totalSize > bufferSize && !paused) {
          paused = true;
          logger.debug('StreamingFuzz: Simulating backpressure');
          
          // Simulate processing delay
          setTimeout(() => {
            // Flush buffer
            const combined = Buffer.concat(buffer);
            buffer = [];
            totalSize = 0;
            paused = false;
            callback(null, combined);
          }, 100);
        } else if (!paused) {
          callback(null, chunk);
        }
      }
    });
  }

  /**
   * Test a parser with various fuzzing strategies
   */
  async fuzzTestParser(
    parser: (input: string) => any,
    validInput: string,
    options: {
      testTruncation?: boolean;
      testCorruption?: boolean;
      testInvalidUtf8?: boolean;
      testRandomChunking?: boolean;
    } = {}
  ): Promise<{ passed: number; failed: number; errors: Error[] }> {
    const results = { passed: 0, failed: 0, errors: [] as Error[] };

    // Test with valid input first
    try {
      parser(validInput);
      results.passed++;
    } catch (error: any) {
      results.failed++;
      results.errors.push(new Error(`Failed on valid input: ${error.message}`));
    }

    // Test truncation
    if (options.testTruncation) {
      const truncated = this.truncateAtBoundaries(validInput);
      for (const input of truncated) {
        try {
          parser(input);
          // Parser should handle partial input gracefully
          results.passed++;
        } catch (error: any) {
          // Expected to fail on truncated input, but should not crash
          if (error.message.includes('Unexpected end') || 
              error.message.includes('Unexpected token') ||
              error.message.includes('Unterminated')) {
            results.passed++;
          } else {
            results.failed++;
            results.errors.push(new Error(`Unexpected error on truncated input: ${error.message}`));
          }
        }
      }
    }

    // Test corruption
    if (options.testCorruption) {
      // Corrupt random characters
      for (let i = 0; i < 10; i++) {
        const corrupted = validInput.split('');
        const pos = Math.floor(Math.random() * corrupted.length);
        const charCode = Math.floor(Math.random() * 128);
        corrupted[pos] = String.fromCharCode(charCode);
        
        try {
          parser(corrupted.join(''));
          // Parser might succeed if corruption didn't affect structure
          results.passed++;
        } catch (error: any) {
          // Should handle corruption gracefully
          if (!error.message.includes('Cannot read properties of undefined') &&
              !error.message.includes('Maximum call stack')) {
            results.passed++;
          } else {
            results.failed++;
            results.errors.push(new Error(`Parser crashed on corrupted input: ${error.message}`));
          }
        }
      }
    }

    // Test invalid UTF-8
    if (options.testInvalidUtf8) {
      try {
        const invalidUtf8 = this.corruptWithInvalidUtf8(validInput);
        parser(invalidUtf8.toString('utf-8'));
        results.passed++;
      } catch (error: any) {
        // Should handle invalid UTF-8 gracefully
        if (!error.message.includes('Cannot read properties of undefined')) {
          results.passed++;
        } else {
          results.failed++;
          results.errors.push(new Error(`Parser crashed on invalid UTF-8: ${error.message}`));
        }
      }
    }

    return results;
  }

  /**
   * Generate test cases for NDJSON streaming
   */
  generateNdjsonTestCases(): string[] {
    const cases: string[] = [];

    // Valid NDJSON
    cases.push('{"type":"message","content":"test"}\n{"type":"content_block_delta","delta":"more"}\n');

    // Missing newlines
    cases.push('{"type":"message","content":"test"}{"type":"content_block_delta","delta":"more"}');

    // Extra newlines
    cases.push('\n\n{"type":"message","content":"test"}\n\n\n{"type":"content_block_delta","delta":"more"}\n\n');

    // Partial JSON at end
    cases.push('{"type":"message","content":"test"}\n{"type":"content_block_delta"');

    // Invalid JSON in middle
    cases.push('{"type":"message","content":"test"}\n{invalid json}\n{"type":"content_block_delta","delta":"more"}\n');

    // Unicode in content
    cases.push('{"type":"message","content":"🚀 测试 テスト"}\n{"type":"emoji","value":"😀"}\n');

    // Very long lines
    const longContent = 'x'.repeat(10000);
    cases.push(`{"type":"message","content":"${longContent}"}\n`);

    // Nested JSON structures
    cases.push('{"type":"complex","data":{"nested":{"deep":{"value":123}}}}\n');

    return cases;
  }

  /**
   * Generate test cases for Codex JSON output
   */
  generateCodexJsonTestCases(): string[] {
    const cases: string[] = [];

    // Valid Codex output
    cases.push('[{"type":"thinking","content":"analyzing"},{"type":"agent_message","content":"result"}]');

    // Only agent messages
    cases.push('[{"type":"agent_message","content":"first"},{"type":"agent_message","content":"second"}]');

    // Mixed with other types
    cases.push('[{"type":"file_read","path":"/test"},{"type":"agent_message","content":"found"},{"type":"thinking","content":"done"}]');

    // Empty array
    cases.push('[]');

    // Not an array
    cases.push('{"type":"agent_message","content":"not in array"}');

    // Malformed JSON
    cases.push('[{"type":"agent_message","content":"unclosed"');

    // Very large output
    const largeContent = 'x'.repeat(100000);
    cases.push(`[{"type":"agent_message","content":"${largeContent}"}]`);

    return cases;
  }
}