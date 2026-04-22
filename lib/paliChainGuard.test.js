'use strict';

const { createPaliChainGuard, _internal } = require('./paliChainGuard');

// Scheduler fake: captures delays, gives the test code manual
// control of when a scheduled callback fires. We avoid Jest's fake
// timers because the guard's async probe interleaves with timer
// callbacks, and flushing microtasks between setTimeout callbacks
// with jest.runAllTimersAsync() adds noise that makes the sequence
// harder to read.
function makeScheduler() {
  let nextId = 1;
  const pending = new Map(); // id -> { fn, delay }
  return {
    setTimeout(fn, delay) {
      const id = nextId++;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    // Test helpers.
    _pending: () => pending,
    _flush: async () => {
      // Run at most one timer per iteration, re-reading pending
      // after the callback since runOnce may re-schedule.
      while (pending.size) {
        const [id] = pending.keys();
        const { fn } = pending.get(id);
        pending.delete(id);
        await fn();
      }
    },
    _flushOne: async () => {
      if (!pending.size) return;
      const [id] = pending.keys();
      const { fn } = pending.get(id);
      pending.delete(id);
      await fn();
    },
  };
}

describe('normalizeChainString', () => {
  const { normalizeChainString } = _internal;
  test('accepts canonical core chains', () => {
    expect(normalizeChainString('main')).toBe('main');
    expect(normalizeChainString('test')).toBe('test');
    expect(normalizeChainString('regtest')).toBe('regtest');
    expect(normalizeChainString('signet')).toBe('signet');
  });
  test('trims + lowercases', () => {
    expect(normalizeChainString('  MAIN ')).toBe('main');
  });
  test('rejects everything else', () => {
    expect(normalizeChainString('mainnet')).toBe(null);
    expect(normalizeChainString(null)).toBe(null);
    expect(normalizeChainString(undefined)).toBe(null);
    expect(normalizeChainString(42)).toBe(null);
  });
});

describe('createPaliChainGuard', () => {
  test('throws when fetchActualChain is missing', () => {
    expect(() => createPaliChainGuard({ declaredChain: 'main' })).toThrow(
      /fetchActualChain/
    );
  });

  test('constructs as unverified/unready with no schedule until start()', () => {
    const scheduler = makeScheduler();
    const guard = createPaliChainGuard({
      declaredChain: 'main',
      fetchActualChain: jest.fn(),
      scheduler,
    });
    expect(guard.isReady()).toBe(false);
    expect(guard.reason()).toBe(null);
    expect(guard.snapshot().status).toBe('unverified');
    expect(scheduler._pending().size).toBe(0);
  });

  test('verifies when declared === observed (terminal success, no retries)', async () => {
    const scheduler = makeScheduler();
    const fetchActualChain = jest.fn().mockResolvedValue('main');
    const guard = createPaliChainGuard({
      declaredChain: 'main',
      fetchActualChain,
      scheduler,
      initialDelayMs: 1,
    });
    guard.start();
    expect(scheduler._pending().size).toBe(1);
    await scheduler._flushOne();
    expect(guard.isReady()).toBe(true);
    expect(guard.reason()).toBe(null);
    expect(guard.snapshot()).toMatchObject({
      status: 'verified',
      actualChain: 'main',
      attempts: 1,
    });
    // No re-arm after success.
    expect(scheduler._pending().size).toBe(0);
  });

  test('mismatch is terminal and logs ERROR (no further probes)', async () => {
    const scheduler = makeScheduler();
    const log = jest.fn();
    const fetchActualChain = jest.fn().mockResolvedValue('test');
    const guard = createPaliChainGuard({
      declaredChain: 'main',
      fetchActualChain,
      scheduler,
      log,
      initialDelayMs: 1,
    });
    guard.start();
    await scheduler._flushOne();
    expect(guard.isReady()).toBe(false);
    expect(guard.reason()).toBe('pali_path_chain_mismatch');
    expect(guard.snapshot()).toMatchObject({
      status: 'mismatch',
      actualChain: 'test',
    });
    expect(scheduler._pending().size).toBe(0);
    expect(fetchActualChain).toHaveBeenCalledTimes(1);
    const errorLogs = log.mock.calls.filter((c) => c[0] === 'error');
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0][1]).toBe('paliChainGuard.mismatch');
  });

  test('rpc_down is transient: retries with exponential backoff, eventually verifies', async () => {
    const scheduler = makeScheduler();
    let calls = 0;
    const fetchActualChain = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return 'main';
    });
    const guard = createPaliChainGuard({
      declaredChain: 'main',
      fetchActualChain,
      scheduler,
      initialDelayMs: 100,
      retryMinMs: 10,
      retryMaxMs: 10000,
      backoffFactor: 2,
    });
    guard.start();
    const [first] = scheduler._pending().values();
    expect(first.delay).toBe(100);

    await scheduler._flushOne();
    expect(guard.reason()).toBe('pali_path_rpc_down');
    // After first failure: retryMin * 2^0 = 10
    expect([...scheduler._pending().values()][0].delay).toBe(10);

    await scheduler._flushOne();
    // After second failure: retryMin * 2^1 = 20
    expect([...scheduler._pending().values()][0].delay).toBe(20);

    await scheduler._flushOne();
    // Third call succeeds.
    expect(guard.isReady()).toBe(true);
    expect(fetchActualChain).toHaveBeenCalledTimes(3);
    expect(scheduler._pending().size).toBe(0);
  });

  test('retry delay is clamped to retryMaxMs', async () => {
    const scheduler = makeScheduler();
    const fetchActualChain = jest.fn().mockRejectedValue(new Error('down'));
    const guard = createPaliChainGuard({
      declaredChain: 'main',
      fetchActualChain,
      scheduler,
      initialDelayMs: 1,
      retryMinMs: 100,
      retryMaxMs: 250,
      backoffFactor: 10,
    });
    guard.start();
    await scheduler._flushOne(); // attempt 1; next delay = 100
    expect([...scheduler._pending().values()][0].delay).toBe(100);
    await scheduler._flushOne(); // attempt 2; next delay = min(250, 1000) = 250
    expect([...scheduler._pending().values()][0].delay).toBe(250);
    await scheduler._flushOne(); // attempt 3; next delay = min(250, 10000) = 250
    expect([...scheduler._pending().values()][0].delay).toBe(250);
    guard.stop();
  });

  test('stop() cancels the pending timer and halts further probes', async () => {
    const scheduler = makeScheduler();
    const fetchActualChain = jest.fn().mockRejectedValue(new Error('down'));
    const guard = createPaliChainGuard({
      declaredChain: 'main',
      fetchActualChain,
      scheduler,
      initialDelayMs: 10,
      retryMinMs: 10,
    });
    guard.start();
    guard.stop();
    expect(scheduler._pending().size).toBe(0);
    // Even if something tries to re-run, the stopped flag guards.
    await scheduler._flush();
    expect(fetchActualChain).not.toHaveBeenCalled();
  });

  test('declaredChain missing or malformed => permanent unconfigured state', async () => {
    const scheduler = makeScheduler();
    const fetchActualChain = jest.fn();
    const guard = createPaliChainGuard({
      declaredChain: null,
      fetchActualChain,
      scheduler,
    });
    guard.start();
    expect(scheduler._pending().size).toBe(0);
    expect(guard.isReady()).toBe(false);
    expect(guard.reason()).toBe('pali_not_configured');
    expect(fetchActualChain).not.toHaveBeenCalled();
  });

  test('unparseable chain response is treated as rpc_down (transient)', async () => {
    const scheduler = makeScheduler();
    const fetchActualChain = jest
      .fn()
      .mockResolvedValueOnce('') // bogus
      .mockResolvedValueOnce('main');
    const guard = createPaliChainGuard({
      declaredChain: 'main',
      fetchActualChain,
      scheduler,
      initialDelayMs: 1,
      retryMinMs: 1,
    });
    guard.start();
    await scheduler._flushOne();
    expect(guard.reason()).toBe('pali_path_rpc_down');
    await scheduler._flushOne();
    expect(guard.isReady()).toBe(true);
  });
});
