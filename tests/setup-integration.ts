import { ProcessManager } from '../src/test-utils/process-manager.js';
import { TestIsolation } from '../src/test-utils/test-isolation.js';
import { logger } from '../src/logger.js';

// Extend Jest matchers
declare global {
  namespace jest {
    interface Matchers<R> {
      toCompleteWithin(ms: number): Promise<R>;
      toLeakNoProcesses(): R;
      toLeakNoWorkspaces(): R;
    }
  }
}

// Custom Jest matchers
expect.extend({
  async toCompleteWithin(received: Promise<any>, ms: number) {
    const start = Date.now();
    
    try {
      await Promise.race([
        received,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), ms)
        )
      ]);
      
      const elapsed = Date.now() - start;
      
      if (elapsed > ms) {
        return {
          pass: false,
          message: () => `Expected to complete within ${ms}ms but took ${elapsed}ms`
        };
      }
      
      return {
        pass: true,
        message: () => `Completed in ${elapsed}ms (within ${ms}ms limit)`
      };
    } catch (error: any) {
      if (error.message === 'Timeout') {
        return {
          pass: false,
          message: () => `Failed to complete within ${ms}ms`
        };
      }
      throw error;
    }
  },

  toLeakNoProcesses() {
    const processManager = ProcessManager.getInstance();
    const running = processManager.getRunningProcesses();
    
    if (running.length > 0) {
      return {
        pass: false,
        message: () => {
          const diagnostics = processManager.getDiagnostics();
          return `Expected no leaked processes but found ${running.length}:\n${diagnostics}`;
        }
      };
    }
    
    return {
      pass: true,
      message: () => 'No processes leaked'
    };
  },

  toLeakNoWorkspaces() {
    try {
      TestIsolation.assertNoLeakedWorkspaces();
      return {
        pass: true,
        message: () => 'No workspaces leaked'
      };
    } catch (error: any) {
      return {
        pass: false,
        message: () => error.message
      };
    }
  }
});

// Global setup
beforeAll(async () => {
  logger.info('Integration test setup: Initializing test harnesses');
  
  // Clean up any leftover resources from previous runs
  await TestIsolation.cleanupAll();
  const processManager = ProcessManager.getInstance();
  await processManager.cleanup();
  
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.BRUTALIST_TEST = 'true';
  
  // Suppress console spam in tests
  if (!process.env.DEBUG_TESTS) {
    global.console.log = jest.fn();
    global.console.debug = jest.fn();
    global.console.info = jest.fn();
  }
});

// Global teardown
afterAll(async () => {
  logger.info('Integration test teardown: Cleaning up resources');
  
  const processManager = ProcessManager.getInstance();
  
  // Capture diagnostics before cleanup
  const processDiagnostics = processManager.getDiagnostics();
  
  // Clean up all resources
  await processManager.cleanup();
  await TestIsolation.cleanupAll();
  
  // Assert no leaks
  try {
    processManager.assertNoLeakedProcesses();
    TestIsolation.assertNoLeakedWorkspaces();
  } catch (error: any) {
    // Log diagnostics on failure
    console.error('Test leak detected!');
    console.error('Process diagnostics:', processDiagnostics);
    throw error;
  }
  
  // Restore console if it was mocked
  if (!process.env.DEBUG_TESTS) {
    global.console.log = console.log;
    global.console.debug = console.debug;
    global.console.info = console.info;
  }
});

// Per-test timeout enforcement
beforeEach(() => {
  // Set a reasonable default timeout for integration tests
  jest.setTimeout(30000);
});

// Per-test cleanup verification
afterEach(() => {
  const processManager = ProcessManager.getInstance();
  const running = processManager.getRunningProcesses();
  
  if (running.length > 0) {
    const diagnostics = processManager.getDiagnostics();
    logger.warn(`Test left ${running.length} processes running:\n${diagnostics}`);
    
    // Force cleanup
    processManager.cleanup().catch(err => {
      logger.error('Failed to cleanup leaked processes:', err);
    });
  }
});

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection in test:', reason);
  
  // Attempt emergency cleanup
  const processManager = ProcessManager.getInstance();
  processManager.cleanup().catch(() => {});
  TestIsolation.cleanupAll().catch(() => {});
});

// Export utilities for use in tests
export { ProcessManager, TestIsolation };

// Export test helpers
export function detectOpenHandles(): void {
  // This would use why-is-node-running or similar
  // For now, just log active handles
  const handles = (process as any)._getActiveHandles();
  const requests = (process as any)._getActiveRequests();
  
  if (handles.length > 0 || requests.length > 0) {
    logger.warn(`Open handles detected: ${handles.length} handles, ${requests.length} requests`);
  }
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}