import { ChildProcess, spawn, execSync } from 'child_process';
import { logger } from '../logger.js';
import * as os from 'os';

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
export class ProcessManager {
  private static instance: ProcessManager;
  private processes: Map<number, ManagedProcess> = new Map();
  private readonly isWindows = os.platform() === 'win32';
  private cleanupRegistered = false;

  private constructor() {
    // Register global cleanup handlers
    this.registerCleanupHandlers();
  }

  static getInstance(): ProcessManager {
    if (!ProcessManager.instance) {
      ProcessManager.instance = new ProcessManager();
    }
    return ProcessManager.instance;
  }

  private registerCleanupHandlers() {
    if (this.cleanupRegistered) return;
    
    const cleanup = async () => {
      await this.cleanup();
    };

    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('uncaughtException', async (err) => {
      logger.error('Uncaught exception, cleaning up processes:', err);
      await cleanup();
    });
    
    this.cleanupRegistered = true;
  }

  /**
   * Spawn a managed process with automatic tracking and cleanup
   */
  async spawn(
    command: string, 
    args: string[], 
    options: SpawnOptions = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const cwd = options.cwd || process.cwd();
      
      // Handle shell builtins that don't exist as standalone executables
      const shellBuiltins = ['echo', 'cd', 'pwd', 'test', 'true', 'false'];
      const needsShell = shellBuiltins.includes(command);
      
      // Create new process group on POSIX for proper tree killing
      const spawnOptions: any = {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: needsShell, // Enable shell for builtins
        env: options.env || process.env
      };

      // On POSIX, create new process group for tree killing
      if (!this.isWindows) {
        spawnOptions.detached = true;
      }

      const child = spawn(command, args, spawnOptions);
      
      if (!child.pid) {
        reject(new Error(`Failed to spawn process: ${command}`));
        return;
      }

      const managed: ManagedProcess = {
        pid: child.pid,
        command,
        args,
        process: child,
        stdout: '',
        stderr: '',
        killed: false,
        startTime
      };

      this.processes.set(child.pid, managed);
      logger.debug(`ProcessManager: Spawned ${command} with PID ${child.pid}`);

      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      // Set up timeout with escalation
      if (options.timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          logger.warn(`Process ${child.pid} timed out after ${options.timeout}ms`);
          this.killProcessTree(child.pid!).catch(err => {
            logger.error(`Failed to kill timed out process ${child.pid}:`, err);
          });
        }, options.timeout);
      }

      // Handle stdout with buffer limit
      child.stdout?.on('data', (data) => {
        const chunk = data.toString();
        if (options.maxBuffer && managed.stdout.length + chunk.length > options.maxBuffer) {
          logger.warn(`Process ${child.pid} exceeded stdout buffer limit`);
          this.killProcessTree(child.pid!);
          return;
        }
        managed.stdout += chunk;
        options.onProgress?.(chunk, 'stdout');
      });

      // Handle stderr with buffer limit
      child.stderr?.on('data', (data) => {
        const chunk = data.toString();
        if (options.maxBuffer && managed.stderr.length + chunk.length > options.maxBuffer) {
          logger.warn(`Process ${child.pid} exceeded stderr buffer limit`);
          this.killProcessTree(child.pid!);
          return;
        }
        managed.stderr += chunk;
        options.onProgress?.(chunk, 'stderr');
      });

      // Handle process exit
      child.on('exit', (code, signal) => {
        managed.killed = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        
        this.processes.delete(child.pid!);
        logger.debug(`Process ${child.pid} exited with code ${code}, signal ${signal}`);

        if (timedOut) {
          reject(new Error(`Process timed out after ${options.timeout}ms`));
        } else if (signal) {
          reject(new Error(`Process killed with signal ${signal}`));
        } else {
          resolve({
            stdout: managed.stdout,
            stderr: managed.stderr,
            exitCode: code
          });
        }
      });

      child.on('error', (error) => {
        managed.killed = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        
        this.processes.delete(child.pid!);
        logger.error(`Process ${child.pid} error:`, error);
        reject(error);
      });

      // Write stdin if provided
      if (options.input) {
        child.stdin?.write(options.input);
        child.stdin?.end();
      }
    });
  }

  /**
   * Kill a process and all its children (cross-platform)
   */
  async killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const managed = this.processes.get(pid);
    if (!managed || managed.killed) {
      return;
    }

    logger.info(`Killing process tree for PID ${pid}`);
    managed.killed = true;

    try {
      if (this.isWindows) {
        // Windows: Use taskkill to kill process tree
        try {
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        } catch (err) {
          logger.warn(`Windows taskkill failed for ${pid}, trying direct kill`);
          managed.process.kill('SIGKILL');
        }
      } else {
        // POSIX: Kill process group
        try {
          // First try SIGTERM to the process group
          process.kill(-pid, signal);
          
          // Give processes 5 seconds to exit gracefully
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Check if still running and escalate to SIGKILL
          try {
            process.kill(-pid, 0); // Check if process group still exists
            logger.warn(`Process group ${pid} still alive after SIGTERM, using SIGKILL`);
            process.kill(-pid, 'SIGKILL');
          } catch {
            // Process group is gone, good
          }
        } catch (err) {
          // Fallback to direct process kill if group kill fails
          logger.warn(`Failed to kill process group -${pid}, trying direct kill`);
          managed.process.kill('SIGKILL');
        }
      }
    } catch (error) {
      logger.error(`Failed to kill process tree ${pid}:`, error);
      throw error;
    } finally {
      this.processes.delete(pid);
    }
  }

  /**
   * Get all currently running managed processes
   */
  getRunningProcesses(): ManagedProcess[] {
    return Array.from(this.processes.values()).filter(p => !p.killed);
  }

  /**
   * Clean up all tracked processes
   */
  async cleanup(): Promise<void> {
    const running = this.getRunningProcesses();
    if (running.length === 0) {
      return;
    }

    logger.info(`ProcessManager: Cleaning up ${running.length} processes`);
    
    const killPromises = running.map(async (managed) => {
      try {
        await this.killProcessTree(managed.pid);
      } catch (err) {
        logger.error(`Failed to clean up process ${managed.pid}:`, err);
      }
    });

    await Promise.all(killPromises);
    this.processes.clear();
  }

  /**
   * Get diagnostic information about running processes
   */
  getDiagnostics(): string {
    const running = this.getRunningProcesses();
    if (running.length === 0) {
      return 'No running processes';
    }

    const lines = ['Running processes:'];
    for (const proc of running) {
      const runtime = Date.now() - proc.startTime;
      lines.push(`  PID ${proc.pid}: ${proc.command} ${proc.args.join(' ')} (running ${runtime}ms)`);
      if (proc.stdout) {
        lines.push(`    Last stdout: ${proc.stdout.slice(-100)}`);
      }
      if (proc.stderr) {
        lines.push(`    Last stderr: ${proc.stderr.slice(-100)}`);
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Assert no processes are leaked (for test cleanup validation)
   */
  assertNoLeakedProcesses(): void {
    const running = this.getRunningProcesses();
    if (running.length > 0) {
      const diagnostics = this.getDiagnostics();
      throw new Error(`Test leaked ${running.length} processes:\n${diagnostics}`);
    }
  }
}