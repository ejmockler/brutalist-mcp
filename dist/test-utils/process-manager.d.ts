import { ChildProcess } from 'child_process';
export interface ManagedProcess {
    pid: number;
    command: string;
    args: string[];
    process: ChildProcess;
    stdout: string;
    stderr: string;
    killed: boolean;
    startTime: number;
}
export interface SpawnOptions {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    input?: string;
    env?: Record<string, string>;
    onProgress?: (chunk: string, type: 'stdout' | 'stderr') => void;
}
/**
 * Cross-platform process manager that tracks all spawned processes
 * and ensures proper cleanup, preventing orphaned processes in tests
 */
export declare class ProcessManager {
    private static instance;
    private processes;
    private readonly isWindows;
    private cleanupRegistered;
    private constructor();
    static getInstance(): ProcessManager;
    private registerCleanupHandlers;
    /**
     * Spawn a managed process with automatic tracking and cleanup
     */
    spawn(command: string, args: string[], options?: SpawnOptions): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
    }>;
    /**
     * Kill a process and all its children (cross-platform)
     */
    killProcessTree(pid: number, signal?: NodeJS.Signals): Promise<void>;
    /**
     * Get all currently running managed processes
     */
    getRunningProcesses(): ManagedProcess[];
    /**
     * Clean up all tracked processes
     */
    cleanup(): Promise<void>;
    /**
     * Get diagnostic information about running processes
     */
    getDiagnostics(): string;
    /**
     * Assert no processes are leaked (for test cleanup validation)
     */
    assertNoLeakedProcesses(): void;
}
//# sourceMappingURL=process-manager.d.ts.map