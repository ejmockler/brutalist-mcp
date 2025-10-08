import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger.js';
import crypto from 'crypto';

/**
 * Provides isolated test environments with unique workspaces,
 * cache namespaces, and environment variables
 */
export class TestIsolation {
  private static activeWorkspaces: Set<string> = new Set();
  private static originalEnv: NodeJS.ProcessEnv = { ...process.env };
  private testId: string;
  private workspacePath: string | undefined;
  private envOverrides: Record<string, string> = {};
  private cacheNamespace: string;

  constructor(testName: string) {
    // Generate unique test ID
    this.testId = `${testName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.cacheNamespace = `test_cache_${this.testId}`;
  }

  /**
   * Create an isolated workspace directory for the test
   */
  async createWorkspace(): Promise<string> {
    if (this.workspacePath) {
      return this.workspacePath;
    }

    const tmpDir = os.tmpdir();
    this.workspacePath = path.join(tmpDir, 'brutalist-test', this.testId);
    
    // Create directory recursively
    await fs.promises.mkdir(this.workspacePath, { recursive: true });
    TestIsolation.activeWorkspaces.add(this.workspacePath);
    
    logger.debug(`TestIsolation: Created workspace ${this.workspacePath}`);
    return this.workspacePath;
  }

  /**
   * Get the cache namespace for this test
   */
  getCacheNamespace(): string {
    return this.cacheNamespace;
  }

  /**
   * Set isolated environment variables for the test
   */
  setEnv(overrides: Record<string, string>): void {
    this.envOverrides = { ...this.envOverrides, ...overrides };
    
    // Apply overrides to process.env
    for (const [key, value] of Object.entries(overrides)) {
      process.env[key] = value;
    }
  }

  /**
   * Create a test file in the workspace
   */
  async createFile(relativePath: string, content: string): Promise<string> {
    const workspace = await this.createWorkspace();
    const filePath = path.join(workspace, relativePath);
    
    // Create directory if needed
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    
    // Write file
    await fs.promises.writeFile(filePath, content, 'utf-8');
    
    return filePath;
  }

  /**
   * Create a test directory structure
   */
  async createDirectory(relativePath: string): Promise<string> {
    const workspace = await this.createWorkspace();
    const dirPath = path.join(workspace, relativePath);
    
    await fs.promises.mkdir(dirPath, { recursive: true });
    
    return dirPath;
  }

  /**
   * Read a file from the workspace
   */
  async readFile(relativePath: string): Promise<string> {
    if (!this.workspacePath) {
      throw new Error('Workspace not created');
    }
    
    const filePath = path.join(this.workspacePath, relativePath);
    return fs.promises.readFile(filePath, 'utf-8');
  }

  /**
   * Check if a file exists in the workspace
   */
  async fileExists(relativePath: string): Promise<boolean> {
    if (!this.workspacePath) {
      return false;
    }
    
    const filePath = path.join(this.workspacePath, relativePath);
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up the test workspace and restore environment
   */
  async cleanup(): Promise<void> {
    // Restore original environment variables
    for (const key of Object.keys(this.envOverrides)) {
      if (TestIsolation.originalEnv[key] !== undefined) {
        process.env[key] = TestIsolation.originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
    this.envOverrides = {};

    // Remove workspace directory
    if (this.workspacePath) {
      try {
        await fs.promises.rm(this.workspacePath, { recursive: true, force: true });
        TestIsolation.activeWorkspaces.delete(this.workspacePath);
        logger.debug(`TestIsolation: Cleaned up workspace ${this.workspacePath}`);
      } catch (error) {
        logger.error(`Failed to clean up workspace ${this.workspacePath}:`, error);
      }
      this.workspacePath = undefined;
    }
  }

  /**
   * Clean up all active workspaces (for global cleanup)
   */
  static async cleanupAll(): Promise<void> {
    const cleanupPromises = Array.from(TestIsolation.activeWorkspaces).map(async (workspace) => {
      try {
        await fs.promises.rm(workspace, { recursive: true, force: true });
        logger.debug(`TestIsolation: Cleaned up orphaned workspace ${workspace}`);
      } catch (error) {
        logger.error(`Failed to clean up orphaned workspace ${workspace}:`, error);
      }
    });

    await Promise.all(cleanupPromises);
    TestIsolation.activeWorkspaces.clear();

    // Restore original environment
    process.env = { ...TestIsolation.originalEnv };
  }

  /**
   * Assert no workspaces are leaked
   */
  static assertNoLeakedWorkspaces(): void {
    if (TestIsolation.activeWorkspaces.size > 0) {
      const leaked = Array.from(TestIsolation.activeWorkspaces);
      throw new Error(`Test leaked ${leaked.length} workspaces:\n  ${leaked.join('\n  ')}`);
    }
  }

  /**
   * Get diagnostic information
   */
  getDiagnostics(): string {
    const lines = ['TestIsolation diagnostics:'];
    lines.push(`  Test ID: ${this.testId}`);
    lines.push(`  Workspace: ${this.workspacePath || 'not created'}`);
    lines.push(`  Cache namespace: ${this.cacheNamespace}`);
    lines.push(`  Env overrides: ${Object.keys(this.envOverrides).join(', ') || 'none'}`);
    return lines.join('\n');
  }
}

/**
 * Jest test helpers for isolation
 */
export function setupTestIsolation(testName: string): TestIsolation {
  const isolation = new TestIsolation(testName);
  
  // Register cleanup in afterEach
  afterEach(async () => {
    await isolation.cleanup();
  });

  return isolation;
}

/**
 * Global test setup for isolation
 */
export async function globalTestSetup(): Promise<void> {
  // Clean up any leftover workspaces from previous runs
  await TestIsolation.cleanupAll();
}

/**
 * Global test teardown for isolation
 */
export async function globalTestTeardown(): Promise<void> {
  // Clean up all workspaces
  await TestIsolation.cleanupAll();
  
  // Assert no leaks
  TestIsolation.assertNoLeakedWorkspaces();
}