/**
 * Provides isolated test environments with unique workspaces,
 * cache namespaces, and environment variables
 */
export declare class TestIsolation {
    private static activeWorkspaces;
    private static originalEnv;
    private testId;
    private workspacePath;
    private envOverrides;
    private cacheNamespace;
    constructor(testName: string);
    /**
     * Create an isolated workspace directory for the test
     */
    createWorkspace(): Promise<string>;
    /**
     * Get the cache namespace for this test
     */
    getCacheNamespace(): string;
    /**
     * Set isolated environment variables for the test
     */
    setEnv(overrides: Record<string, string>): void;
    /**
     * Create a test file in the workspace
     */
    createFile(relativePath: string, content: string): Promise<string>;
    /**
     * Create a test directory structure
     */
    createDirectory(relativePath: string): Promise<string>;
    /**
     * Read a file from the workspace
     */
    readFile(relativePath: string): Promise<string>;
    /**
     * Check if a file exists in the workspace
     */
    fileExists(relativePath: string): Promise<boolean>;
    /**
     * Clean up the test workspace and restore environment
     */
    cleanup(): Promise<void>;
    /**
     * Clean up all active workspaces (for global cleanup)
     */
    static cleanupAll(): Promise<void>;
    /**
     * Assert no workspaces are leaked
     */
    static assertNoLeakedWorkspaces(): void;
    /**
     * Get diagnostic information
     */
    getDiagnostics(): string;
}
/**
 * Jest test helpers for isolation
 */
export declare function setupTestIsolation(testName: string): TestIsolation;
/**
 * Global test setup for isolation
 */
export declare function globalTestSetup(): Promise<void>;
/**
 * Global test teardown for isolation
 */
export declare function globalTestTeardown(): Promise<void>;
//# sourceMappingURL=test-isolation.d.ts.map