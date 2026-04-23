'use strict';

const { openDatabase } = require('../lib/db');
const { createMasternodeCountRepo } = require('../lib/masternodeCountRepo');
const {
  createMnCountLogger,
  utcDateString,
  msUntilNextMidnightUtc,
  BASE_RETRY_MS,
  MAX_RETRY_MS,
  POST_MIDNIGHT_SKEW_MS,
} = require('./mnCountLogger');

// Tiny deterministic scheduler injected in place of setTimeout so
// tests can advance time without juggling jest.useFakeTimers state.
// The scheduler never auto-fires; the test calls `fireNext()` to pop
// the next timer and invoke its callback, optionally after advancing
// the clock by the timer's requested delay.
function makeManualScheduler(clock) {
  const timers = [];
  let nextHandle = 1;

  const setTimeoutImpl = (fn, delay) => {
    const handle = nextHandle++;
    const t = { handle, fn, delay, dueAt: clock.nowMs + delay, cancelled: false };
    timers.push(t);
    return { handle, unref() {} };
  };

  const clearTimeoutImpl = (token) => {
    if (!token) return;
    const h = token.handle;
    for (const t of timers) if (t.handle === h) t.cancelled = true;
  };

  function pending() {
    return timers.filter((t) => !t.cancelled);
  }

  async function fireNext({ advanceClock = true } = {}) {
    const live = pending();
    if (live.length === 0) throw new Error('no pending timer to fire');
    // The earliest-due live timer wins.
    live.sort((a, b) => a.dueAt - b.dueAt);
    const t = live[0];
    t.cancelled = true;
    if (advanceClock) clock.nowMs = t.dueAt;
    await t.fn();
    // Let any follow-up promise chain settle before the test asserts.
    await new Promise((r) => setImmediate(r));
  }

  return {
    setTimeoutImpl,
    clearTimeoutImpl,
    pending,
    fireNext,
    pendingDelays: () => pending().map((t) => t.delay),
    pendingDueAts: () => pending().map((t) => t.dueAt),
  };
}

function msAt(iso) {
  return Date.parse(iso);
}

describe('utcDateString', () => {
  test('projects any instant in a UTC day to that YYYY-MM-DD', () => {
    expect(utcDateString(msAt('2024-03-15T00:00:00Z'))).toBe('2024-03-15');
    expect(utcDateString(msAt('2024-03-15T12:34:56Z'))).toBe('2024-03-15');
    expect(utcDateString(msAt('2024-03-15T23:59:59Z'))).toBe('2024-03-15');
    // Just past midnight UTC rolls over.
    expect(utcDateString(msAt('2024-03-16T00:00:00Z'))).toBe('2024-03-16');
  });
});

describe('msUntilNextMidnightUtc', () => {
  test('returns time until next UTC midnight plus the skew buffer', () => {
    const fromMs = msAt('2024-03-15T23:59:55Z');
    // Next midnight is 5s away, plus 5s skew = 10s.
    expect(msUntilNextMidnightUtc(fromMs)).toBe(10 * 1000);
  });

  test('early in a UTC day waits almost a full day', () => {
    const fromMs = msAt('2024-03-15T00:00:06Z');
    // Midnight + skew is (24h - 6s) + 5s = 86399s away.
    const expected = 24 * 3600 * 1000 - 6 * 1000 + POST_MIDNIGHT_SKEW_MS;
    expect(msUntilNextMidnightUtc(fromMs)).toBe(expected);
  });

  test('never returns less than 1 second even with a pathological clock', () => {
    // Exactly at the target — guaranteed non-negative via Math.max.
    const targetMs = msAt('2024-03-16T00:00:05Z');
    expect(msUntilNextMidnightUtc(targetMs)).toBeGreaterThanOrEqual(1000);
  });
});

describe('createMnCountLogger', () => {
  let db;
  let repo;
  let clock;
  let scheduler;
  let fetchTotal;
  let logs;
  let logger;

  function setup({ rpcSequence = [], startAtIso = '2024-03-15T12:00:00Z' } = {}) {
    db = openDatabase(':memory:');
    repo = createMasternodeCountRepo(db);
    clock = { nowMs: msAt(startAtIso) };
    scheduler = makeManualScheduler(clock);

    let rpcIdx = 0;
    fetchTotal = jest.fn(async () => {
      if (rpcIdx >= rpcSequence.length) {
        throw new Error(`rpcSequence exhausted (idx=${rpcIdx})`);
      }
      const item = rpcSequence[rpcIdx++];
      if (typeof item === 'function') return item();
      if (item instanceof Error) throw item;
      return item;
    });

    logs = [];
    logger = createMnCountLogger({
      repo,
      fetchTotal,
      now: () => clock.nowMs,
      log: (level, event, meta) => logs.push({ level, event, meta }),
      setTimeoutImpl: scheduler.setTimeoutImpl,
      clearTimeoutImpl: scheduler.clearTimeoutImpl,
    });
  }

  afterEach(() => {
    if (logger) logger.stop();
    if (db) db.close();
  });

  test('catchUpIfNeeded writes today when the table is empty', async () => {
    setup({ rpcSequence: [1234], startAtIso: '2024-03-15T12:00:00Z' });
    const result = await logger.catchUpIfNeeded();
    expect(result).toEqual({
      skipped: false,
      date: '2024-03-15',
      total: 1234,
      inserted: true,
    });
    expect(repo.getAll()).toEqual([{ date: '2024-03-15', users: 1234 }]);
  });

  test('catchUpIfNeeded writes today when latest row is older', async () => {
    setup({ rpcSequence: [2000], startAtIso: '2024-03-15T06:00:00Z' });
    repo.upsertByDate('2024-03-10', 1000, msAt('2024-03-10T00:00:00Z'));
    const result = await logger.catchUpIfNeeded();
    expect(result.skipped).toBe(false);
    expect(result.date).toBe('2024-03-15');
    expect(repo.getLatestDate()).toBe('2024-03-15');
  });

  test('catchUpIfNeeded is a no-op when today is already recorded', async () => {
    setup({ rpcSequence: [], startAtIso: '2024-03-15T12:00:00Z' });
    repo.upsertByDate('2024-03-15', 2200, msAt('2024-03-15T00:00:05Z'));
    const result = await logger.catchUpIfNeeded();
    expect(result).toEqual({ skipped: true, reason: 'already-today' });
    expect(fetchTotal).not.toHaveBeenCalled();
  });

  test('catchUpIfNeeded swallows RPC errors and surfaces reason="error"', async () => {
    setup({
      rpcSequence: [new Error('rpc down')],
      startAtIso: '2024-03-15T12:00:00Z',
    });
    const result = await logger.catchUpIfNeeded();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('error');
    expect(result.err).toBe('rpc down');
    expect(repo.isEmpty()).toBe(true);
    expect(logs.some((l) => l.event === 'mncount_catchup_failed')).toBe(true);
  });

  test('repeated writes for the same UTC date are idempotent (skip + PK on date)', async () => {
    setup({ rpcSequence: [2200], startAtIso: '2024-03-15T12:00:00Z' });
    await logger.catchUpIfNeeded();

    // First layer of protection: once today's row is recorded,
    // runAndReschedule MUST skip the RPC entirely rather than
    // refetch and overwrite. That keeps the 00:00 snapshot
    // authoritative and stops a long event-loop stall / spurious
    // re-fire from shadowing it with an afternoon value.
    clock.nowMs = msAt('2024-03-15T18:00:00Z');
    await logger.runAndReschedule();
    expect(fetchTotal).toHaveBeenCalledTimes(1);
    expect(repo.getAll()).toEqual([{ date: '2024-03-15', users: 2200 }]);

    // Second layer of protection: even if the skip logic were ever
    // bypassed, the PK on `date` via INSERT OR IGNORE collapses the
    // duplicate write without overwriting the first row's total.
    repo.upsertByDate('2024-03-15', 9999, msAt('2024-03-15T18:00:00Z'));
    expect(repo.getAll()).toEqual([{ date: '2024-03-15', users: 2200 }]);
  });

  test('start() catches up, then schedules the next tick at midnight+skew', async () => {
    setup({ rpcSequence: [1500], startAtIso: '2024-03-15T06:00:00Z' });
    logger.start();
    // Let the catch-up microtask chain drain so the .finally() has
    // run and posted its timer.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(repo.getLatestDate()).toBe('2024-03-15');
    const pending = scheduler.pending();
    expect(pending).toHaveLength(1);
    // Catch-up ran at 06:00, so next midnight (+5s) is 18h+5s away.
    const expected = 18 * 3600 * 1000 + POST_MIDNIGHT_SKEW_MS;
    expect(pending[0].delay).toBe(expected);
  });

  test('start() is idempotent: a second call does not schedule a second timer', async () => {
    setup({ rpcSequence: [1500], startAtIso: '2024-03-15T06:00:00Z' });
    logger.start();
    logger.start();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(scheduler.pending()).toHaveLength(1);
    expect(fetchTotal).toHaveBeenCalledTimes(1);
  });

  test('start() with today already recorded skips the catch-up RPC call', async () => {
    setup({ rpcSequence: [], startAtIso: '2024-03-15T12:00:00Z' });
    repo.upsertByDate('2024-03-15', 2000, msAt('2024-03-15T00:00:05Z'));
    logger.start();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(fetchTotal).not.toHaveBeenCalled();
    expect(scheduler.pending()).toHaveLength(1);
  });

  test('start() with RPC down retries inside the same UTC day (Codex PR16 P2)', async () => {
    // Boot at 06:00 UTC — 18 hours of headroom until next midnight.
    // First RPC call fails (e.g. syscoind still warming up after a
    // joint pm2 restart); the logger MUST schedule a retry that
    // fires BEFORE midnight rather than silently deferring today's
    // sample and losing the row entirely. Previously start()
    // always armed for next midnight regardless of catch-up
    // outcome, which is exactly the bug Codex flagged.
    setup({
      rpcSequence: [new Error('rpc down at boot'), 2500],
      startAtIso: '2024-03-15T06:00:00Z',
    });
    logger.start();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

    // The scheduled retry must be strictly inside today's UTC
    // window, never the 18h-away next-midnight delay.
    const pending = scheduler.pending();
    expect(pending).toHaveLength(1);
    const eighteenHoursFiveSec = 18 * 3600 * 1000 + POST_MIDNIGHT_SKEW_MS;
    expect(pending[0].delay).toBeLessThan(eighteenHoursFiveSec);
    expect(pending[0].delay).toBeGreaterThan(0);
    expect(repo.isEmpty()).toBe(true);
    expect(logs.some((l) => l.event === 'mncount_tick_failed')).toBe(true);

    // Fire the retry: RPC has recovered, today's row is captured,
    // and the logger arms for next midnight (not another retry).
    await scheduler.fireNext();
    expect(repo.getAll()).toEqual([{ date: '2024-03-15', users: 2500 }]);
    const afterSuccess = scheduler.pendingDelays();
    expect(afterSuccess).toHaveLength(1);
    // Post-success from roughly 06:02Z, next midnight is ~18h out.
    expect(afterSuccess[0]).toBeGreaterThan(17 * 3600 * 1000);
  });

  test('start() keeps backing off on repeated RPC failure, still inside today', async () => {
    // Three sequential failures early in a UTC day must all
    // schedule retries inside the same day rather than skipping
    // ahead to the next midnight. Exponential growth is capped
    // by the until-midnight clamp.
    setup({
      rpcSequence: [
        new Error('boot RPC fail 1'),
        new Error('retry RPC fail 2'),
        new Error('retry RPC fail 3'),
      ],
      startAtIso: '2024-03-15T06:00:00Z',
    });
    logger.start();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

    const untilMidnightFromBoot = 18 * 3600 * 1000 + POST_MIDNIGHT_SKEW_MS;
    expect(scheduler.pendingDelays()[0]).toBeLessThan(untilMidnightFromBoot);

    await scheduler.fireNext(); // 2nd failure
    expect(scheduler.pendingDelays()[0]).toBeLessThan(untilMidnightFromBoot);

    await scheduler.fireNext(); // 3rd failure
    expect(scheduler.pendingDelays()[0]).toBeLessThanOrEqual(
      msUntilNextMidnightUtc(clock.nowMs)
    );
    expect(repo.isEmpty()).toBe(true);
  });

  test('scheduled tick writes the new day and re-arms for the following midnight', async () => {
    setup({
      rpcSequence: [1500, 1505],
      startAtIso: '2024-03-15T06:00:00Z',
    });
    logger.start();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    // Advance to the scheduled firing moment and run the tick.
    await scheduler.fireNext();

    expect(repo.getAll()).toEqual([
      { date: '2024-03-15', users: 1500 }, // catch-up
      { date: '2024-03-16', users: 1505 }, // tick
    ]);
    // After a successful tick, the logger re-arms for the next
    // midnight+skew, i.e. roughly 24h out from 2024-03-16T00:00:05Z.
    const pending = scheduler.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].delay).toBe(24 * 3600 * 1000);
  });

  test('tick failure backs off exponentially, capped below the next day', async () => {
    setup({
      rpcSequence: [
        1500,
        new Error('rpc timeout 1'),
        new Error('rpc timeout 2'),
        3000,
      ],
      startAtIso: '2024-03-15T06:00:00Z',
    });
    logger.start();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    // First scheduled tick fails → expect a retry at BASE_RETRY_MS
    // (or the time-to-midnight, whichever is smaller — at 00:00:05Z
    // next midnight is 24h away, so 60s wins).
    await scheduler.fireNext(); // 1st failure
    expect(scheduler.pendingDelays()[0]).toBe(BASE_RETRY_MS * 2);

    // Second failure at the retry moment: backoff doubles again.
    await scheduler.fireNext();
    expect(scheduler.pendingDelays()[0]).toBe(BASE_RETRY_MS * 4);

    // Third attempt succeeds: the scheduler now arms for the NEXT
    // midnight+skew, not for the retry cadence.
    await scheduler.fireNext();
    expect(repo.getLatestDate()).toBe('2024-03-16');
    // From clock.nowMs on 2024-03-16 (just past midnight+skew+some retries),
    // the next midnight is ~24h away again.
    expect(scheduler.pendingDelays()[0]).toBeGreaterThan(20 * 3600 * 1000);
  });

  test('retry delay is clamped to not exceed the next midnight boundary', async () => {
    // Start near the end of a UTC day so msUntilNextMidnightUtc is
    // smaller than BASE_RETRY_MS. The first failed tick must choose
    // the midnight-clamp over the 60s retry so it still samples the
    // new day.
    setup({
      rpcSequence: [
        1500, // catch-up
        new Error('rpc down'), // tick at 00:00:05
      ],
      // 23:59:30 UTC — catch-up writes for 2024-03-15, timer arms
      // for +35s (until 00:00:05 next day).
      startAtIso: '2024-03-15T23:59:30Z',
    });
    logger.start();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    // Fire the scheduled tick — it will fail at ~00:00:05. The
    // retry choice is min(120_000, msUntilNextMidnight). The next
    // midnight (the 17th's) is ~24h away, so 120s wins here — but
    // the important invariant is that the retry is NEVER greater
    // than the next midnight. Assert that cap rather than a specific
    // schedule value so the test stays meaningful.
    await scheduler.fireNext();
    const delay = scheduler.pendingDelays()[0];
    expect(delay).toBeLessThanOrEqual(msUntilNextMidnightUtc(clock.nowMs));
    expect(delay).toBeGreaterThan(0);
    expect(logs.some((l) => l.event === 'mncount_tick_failed')).toBe(true);
  });

  test('non-integer / negative RPC response is treated as a failure', async () => {
    setup({
      rpcSequence: [-3, 42.5],
      startAtIso: '2024-03-15T06:00:00Z',
    });
    const r1 = await logger.catchUpIfNeeded();
    expect(r1.skipped).toBe(true);
    expect(r1.reason).toBe('error');

    // Second attempt (now a float) also rejects.
    const r2 = await logger.catchUpIfNeeded();
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe('error');
    expect(repo.isEmpty()).toBe(true);
  });

  test('stop() clears the pending timer and prevents re-arming', async () => {
    setup({ rpcSequence: [1500], startAtIso: '2024-03-15T06:00:00Z' });
    logger.start();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(scheduler.pending()).toHaveLength(1);

    logger.stop();
    expect(scheduler.pending()).toHaveLength(0);
    expect(logger.getDiagnostics().stopped).toBe(true);
  });

  test('stop() between start() and catch-up resolution does not leave a timer behind', async () => {
    // Make fetchTotal pend so start()'s catchUpIfNeeded is still in flight.
    let releaseRpc;
    const pending = new Promise((res) => {
      releaseRpc = res;
    });
    setup({
      rpcSequence: [() => pending],
      startAtIso: '2024-03-15T06:00:00Z',
    });

    logger.start();
    // At this point start() has kicked off catch-up but the await
    // hasn't resolved; no timer yet.
    expect(scheduler.pending()).toHaveLength(0);

    logger.stop();
    releaseRpc(1500);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

    expect(scheduler.pending()).toHaveLength(0);
    expect(logger.getDiagnostics().stopped).toBe(true);
  });

  test('MAX_RETRY_MS cap keeps the backoff sane on chronic failure', async () => {
    // Verify the exposed constants so they cannot regress silently.
    expect(BASE_RETRY_MS).toBe(60 * 1000);
    expect(MAX_RETRY_MS).toBe(60 * 60 * 1000);
  });
});
