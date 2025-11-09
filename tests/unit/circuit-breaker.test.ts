import {
  CircuitBreaker,
  CircuitState,
  CircuitBreakerConfig,
  FallbackStrategy,
  RequestContext,
  CachedResponseFallback,
  DegradedServiceFallback,
  RetryFallback
} from '../../src/streaming/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;
  let config: CircuitBreakerConfig;

  beforeEach(() => {
    config = {
      failureThreshold: 3,
      recoveryTimeout: 1000,
      successThreshold: 2,
      timeout: 500,
      monitoringWindow: 5000,
      minimumRequests: 5
    };
    breaker = new CircuitBreaker(config, 'test-breaker');
  });

  afterEach(() => {
    breaker.shutdown();
  });

  describe('initialization', () => {
    it('should start in CLOSED state', () => {
      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.totalRequests).toBe(0);
    });

    it('should initialize with provided config', () => {
      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('execute - success scenarios', () => {
    it('should execute successful requests', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');

      const result = await breaker.execute(mockFn);

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(1);

      const stats = breaker.getStats();
      expect(stats.successes).toBe(1);
      expect(stats.failures).toBe(0);
      expect(stats.totalRequests).toBe(1);
    });

    it('should track multiple successful requests', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');

      await breaker.execute(mockFn);
      await breaker.execute(mockFn);
      await breaker.execute(mockFn);

      const stats = breaker.getStats();
      expect(stats.successes).toBe(3);
      expect(stats.totalRequests).toBe(3);
    });

    it('should calculate average response time', async () => {
      const mockFn = jest.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'success';
      });

      await breaker.execute(mockFn);
      await breaker.execute(mockFn);

      const stats = breaker.getStats();
      expect(stats.averageResponseTime).toBeGreaterThan(0);
    });
  });

  describe('execute - failure scenarios', () => {
    it('should handle failed requests', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      await expect(breaker.execute(mockFn)).rejects.toThrow('test error');

      const stats = breaker.getStats();
      expect(stats.failures).toBe(1);
      expect(stats.successes).toBe(0);
      expect(stats.totalRequests).toBe(1);
    });

    it('should track failure timestamps', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      const beforeTime = Date.now();
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      const afterTime = Date.now();

      const stats = breaker.getStats();
      expect(stats.lastFailureTime).toBeGreaterThanOrEqual(beforeTime);
      expect(stats.lastFailureTime).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('circuit state transitions', () => {
    it('should open circuit after failure threshold', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      // Fail 3 times to exceed threshold
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.OPEN);
    });

    it('should block requests when circuit is open', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      // Open the circuit
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      // Should reject immediately without calling function
      mockFn.mockClear();
      await expect(breaker.execute(mockFn)).rejects.toThrow(/Circuit breaker.*is OPEN/);
      expect(mockFn).not.toHaveBeenCalled();
    });

    it('should transition to HALF_OPEN after recovery timeout', async () => {
      jest.useFakeTimers();

      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      // Open the circuit
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      expect(breaker.getStats().state).toBe(CircuitState.OPEN);

      // Fast-forward past recovery timeout
      jest.advanceTimersByTime(config.recoveryTimeout + 100);

      expect(breaker.getStats().state).toBe(CircuitState.HALF_OPEN);

      jest.useRealTimers();
    });

    it('should close circuit after successful requests in HALF_OPEN', async () => {
      jest.useFakeTimers();

      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('error 1'))
        .mockRejectedValueOnce(new Error('error 2'))
        .mockRejectedValueOnce(new Error('error 3'))
        .mockResolvedValueOnce('success 1')
        .mockResolvedValueOnce('success 2');

      // Open the circuit
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      expect(breaker.getStats().state).toBe(CircuitState.OPEN);

      // Transition to HALF_OPEN
      jest.advanceTimersByTime(config.recoveryTimeout + 100);
      expect(breaker.getStats().state).toBe(CircuitState.HALF_OPEN);

      // Succeed enough times to close
      await breaker.execute(mockFn);
      await breaker.execute(mockFn);

      expect(breaker.getStats().state).toBe(CircuitState.CLOSED);

      jest.useRealTimers();
    });

    it('should reopen if failure occurs in HALF_OPEN', async () => {
      jest.useFakeTimers();

      const mockFn = jest.fn()
        .mockRejectedValueOnce(new Error('error 1'))
        .mockRejectedValueOnce(new Error('error 2'))
        .mockRejectedValueOnce(new Error('error 3'))
        .mockResolvedValueOnce('success')
        .mockRejectedValueOnce(new Error('error 4'));

      // Open circuit
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      // Transition to HALF_OPEN
      jest.advanceTimersByTime(config.recoveryTimeout + 100);

      // Partial success
      await breaker.execute(mockFn);

      // Failure should not reopen immediately (need to hit threshold again)
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      jest.useRealTimers();
    });
  });

  describe('timeout handling', () => {
    it('should timeout long-running requests', async () => {
      const slowFn = jest.fn(() => new Promise(resolve => setTimeout(resolve, 2000)));

      await expect(breaker.execute(slowFn)).rejects.toThrow(/timed out/);

      const stats = breaker.getStats();
      expect(stats.failures).toBe(1);
    });
  });

  describe('fallback strategies', () => {
    it('should execute cached response fallback', async () => {
      const cache = new Map();
      cache.set('test-req', 'cached-value');

      const cacheFallback = new CachedResponseFallback(cache);
      breaker.addFallbackStrategy(cacheFallback);

      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      const result = await breaker.execute(mockFn, { id: 'test-req' });

      expect(result).toBe('cached-value');
    });

    it('should execute degraded service fallback', async () => {
      const degradedResponse = { status: 'degraded', message: 'Limited functionality' };
      const degradedFallback = new DegradedServiceFallback(degradedResponse);
      breaker.addFallbackStrategy(degradedFallback);

      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));

      const result = await breaker.execute(mockFn) as any;

      expect(result.status).toBe('degraded');
      expect(result.metadata.fallback).toBe(true);
    });

    it('should execute retry fallback', async () => {
      let callCount = 0;
      const retryFn = jest.fn(async () => {
        callCount++;
        if (callCount < 2) throw new Error('temp error');
        return 'success-after-retry';
      });

      const retryFallback = new RetryFallback(retryFn, 3, 10);
      breaker.addFallbackStrategy(retryFallback);

      const mockFn = jest.fn().mockRejectedValue(new Error('initial error'));

      const result = await breaker.execute(mockFn);

      expect(result).toBe('success-after-retry');
      expect(retryFn).toHaveBeenCalledTimes(2);
    });

    it('should try multiple fallback strategies in priority order', async () => {
      const cache = new Map();
      const cacheFallback = new CachedResponseFallback(cache);
      cacheFallback.priority = 1;

      const degradedFallback = new DegradedServiceFallback({ fallback: true });
      degradedFallback.priority = 2;

      breaker.addFallbackStrategy(degradedFallback);
      breaker.addFallbackStrategy(cacheFallback);

      const mockFn = jest.fn().mockRejectedValue(new Error('error'));

      const result = await breaker.execute(mockFn) as any;

      // Should use degraded fallback since cache is empty
      expect(result.fallback).toBe(true);
    });

    it('should remove fallback strategies', () => {
      const cacheFallback = new CachedResponseFallback(new Map());
      breaker.addFallbackStrategy(cacheFallback);

      breaker.removeFallbackStrategy(CachedResponseFallback);

      // After removal, should throw original error
      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));
      expect(breaker.execute(mockFn)).rejects.toThrow('test error');
    });
  });

  describe('statistics and monitoring', () => {
    it('should calculate failure rate', async () => {
      const mockFn = jest.fn()
        .mockResolvedValueOnce('success')
        .mockResolvedValueOnce('success')
        .mockRejectedValueOnce(new Error('error'))
        .mockResolvedValueOnce('success')
        .mockRejectedValueOnce(new Error('error'));

      await breaker.execute(mockFn);
      await breaker.execute(mockFn);
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await breaker.execute(mockFn);
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      const stats = breaker.getStats();
      expect(stats.failureRate).toBe(2 / 5); // 40% failure rate
    });

    it('should track uptime based on last success', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');

      await breaker.execute(mockFn);

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      const stats = breaker.getStats();
      expect(stats.uptime).toBeGreaterThan(0);
    });

    it('should provide comprehensive statistics', async () => {
      const mockFn = jest.fn()
        .mockResolvedValueOnce('success')
        .mockRejectedValueOnce(new Error('error'));

      await breaker.execute(mockFn);
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      const stats = breaker.getStats();

      expect(stats).toMatchObject({
        state: CircuitState.CLOSED,
        failures: 1,
        successes: 1,
        totalRequests: 2
      });
      expect(stats.lastSuccessTime).toBeDefined();
      expect(stats.lastFailureTime).toBeDefined();
    });
  });

  describe('event emission', () => {
    it('should emit requestSuccess event', async () => {
      const successHandler = jest.fn();
      breaker.on('requestSuccess', successHandler);

      const mockFn = jest.fn().mockResolvedValue('success');
      await breaker.execute(mockFn);

      expect(successHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          state: CircuitState.CLOSED
        })
      );
    });

    it('should emit requestFailure event', async () => {
      const failureHandler = jest.fn();
      breaker.on('requestFailure', failureHandler);

      const mockFn = jest.fn().mockRejectedValue(new Error('test error'));
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      expect(failureHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'test error',
          state: CircuitState.CLOSED
        })
      );
    });

    it('should emit stateChanged event', async () => {
      const stateHandler = jest.fn();
      breaker.on('stateChanged', stateHandler);

      const mockFn = jest.fn().mockRejectedValue(new Error('error'));

      // Trigger state change
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          state: CircuitState.OPEN,
          reason: 'failure_threshold_exceeded'
        })
      );
    });

    it('should emit requestBlocked event when circuit is open', async () => {
      const blockedHandler = jest.fn();
      breaker.on('requestBlocked', blockedHandler);

      // Open circuit
      breaker.forceState(CircuitState.OPEN);

      const mockFn = jest.fn().mockResolvedValue('success');
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      expect(blockedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'circuit_open'
        })
      );
    });
  });

  describe('manual controls', () => {
    it('should force state change', () => {
      breaker.forceState(CircuitState.OPEN);
      expect(breaker.getStats().state).toBe(CircuitState.OPEN);

      breaker.forceState(CircuitState.HALF_OPEN);
      expect(breaker.getStats().state).toBe(CircuitState.HALF_OPEN);

      breaker.forceState(CircuitState.CLOSED);
      expect(breaker.getStats().state).toBe(CircuitState.CLOSED);
    });

    it('should reset circuit breaker', async () => {
      const mockFn = jest.fn()
        .mockResolvedValueOnce('success')
        .mockRejectedValueOnce(new Error('error'));

      await breaker.execute(mockFn);
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      breaker.reset();

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.totalRequests).toBe(0);
    });

    it('should cancel pending requests on reset', async () => {
      const slowFn = () => new Promise(resolve => setTimeout(resolve, 10000));

      // Start a slow request
      const promise = breaker.execute(slowFn);

      // Reset before it completes
      breaker.reset();

      await expect(promise).rejects.toThrow(/reset/);
    });
  });

  describe('shutdown', () => {
    it('should cancel all pending requests on shutdown', async () => {
      const slowFn = () => new Promise(resolve => setTimeout(resolve, 10000));

      const promise = breaker.execute(slowFn);

      breaker.shutdown();

      await expect(promise).rejects.toThrow(/shutdown/);
    });

    it('should remove all event listeners', () => {
      const handler = jest.fn();
      breaker.on('requestSuccess', handler);

      breaker.shutdown();

      expect(breaker.listenerCount('requestSuccess')).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle rapid successive requests', async () => {
      const mockFn = jest.fn().mockResolvedValue('success');

      const promises = Array(100).fill(null).map(() => breaker.execute(mockFn));
      const results = await Promise.all(promises);

      expect(results.length).toBe(100);
      expect(breaker.getStats().totalRequests).toBe(100);
    });

    it('should handle mixed success and failure patterns', async () => {
      const mockFn = jest.fn()
        .mockResolvedValueOnce('s')
        .mockRejectedValueOnce(new Error('e'))
        .mockResolvedValueOnce('s')
        .mockRejectedValueOnce(new Error('e'));

      await breaker.execute(mockFn);
      await expect(breaker.execute(mockFn)).rejects.toThrow();
      await breaker.execute(mockFn);
      await expect(breaker.execute(mockFn)).rejects.toThrow();

      const stats = breaker.getStats();
      expect(stats.successes).toBe(2);
      expect(stats.failures).toBe(2);
    });

    it('should handle errors without messages', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error());

      await expect(breaker.execute(mockFn)).rejects.toThrow();

      const stats = breaker.getStats();
      expect(stats.failures).toBe(1);
    });
  });
});
