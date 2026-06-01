import { Readable, Transform } from 'stream';
/**
 * Utilities for fuzz testing streaming parsers with random chunking,
 * corrupted data, and various edge cases
 */
export declare class StreamingFuzzHarness {
    /**
     * Split data into random-sized chunks
     */
    randomChunker(data: string | Buffer, minChunk?: number, maxChunk?: number): Buffer[];
    /**
     * Create a readable stream that emits data in random chunks
     */
    createRandomChunkStream(data: string | Buffer, minChunk?: number, maxChunk?: number, delayMs?: number): Readable;
    /**
     * Inject invalid UTF-8 sequences into a string
     */
    corruptWithInvalidUtf8(data: string): Buffer;
    /**
     * Truncate data at various boundaries to test partial parsing
     */
    truncateAtBoundaries(data: string): string[];
    /**
     * Create a transform stream that randomly corrupts data
     */
    createCorruptionStream(corruptionRate?: number): Transform;
    /**
     * Create a transform stream that simulates slow delivery
     */
    createThrottleStream(bytesPerSecond: number): Transform;
    /**
     * Create a transform stream that simulates backpressure
     */
    createBackpressureStream(bufferSize?: number): Transform;
    /**
     * Test a parser with various fuzzing strategies
     */
    fuzzTestParser(parser: (input: string) => any, validInput: string, options?: {
        testTruncation?: boolean;
        testCorruption?: boolean;
        testInvalidUtf8?: boolean;
        testRandomChunking?: boolean;
    }): Promise<{
        passed: number;
        failed: number;
        errors: Error[];
    }>;
    /**
     * Generate test cases for NDJSON streaming
     */
    generateNdjsonTestCases(): string[];
    /**
     * Generate test cases for Codex JSON output
     */
    generateCodexJsonTestCases(): string[];
}
//# sourceMappingURL=streaming-fuzz.d.ts.map