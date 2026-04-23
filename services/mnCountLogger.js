'use strict';

// Daily masternode-count logger.
// -------------------------------
// Appends one row per UTC calendar day to `masternode_count_daily`,
// replacing the retired standalone `mnCount.js` daemon that wrote a
// CSV under /root/sysnode/ via hardcoded RPC credentials.
//
// Behaviour summary:
//
//   * On start(): kick a catch-up sample immediately if today's UTC
//     row is missing. The old script could only ever fire on its own
//     schedule; a restart between midnights meant that day was lost.
//     Catch-up closes that hole for any restart that lands before
//     the same UTC day rolls over.
//
//   * Regular tick: runs at 00:00:05 UTC (the +5s is intentional —
//     it protects against a ~second of clock skew causing the timer
//     to fire microseconds BEFORE the new day, so `new Date()` still
//     reports yesterday and we'd stamp the wrong row). INSERT OR
//     IGNORE in the repo makes the ±1s choice irrelevant for
//     correctness but not for observability; we prefer "the right
//     date" over "a warning log".
//
//   * Errors on the scheduled tick (RPC timeout, syscoind restart,
//     repo transient lock) back off exponentially from 60s up to
//     1h, capped separately at "do not wait longer than the next
//     midnight". A persistent failure therefore retries every hour
//     but never skips past the next day's boundary without at least
//     one attempt at it.
//
//   * stop() + __resetForTests() mirror the ergonomics of
//     services/sysMain.js so test harnesses can drive the logger
//     deterministically with fake timers.
//
// Non-goals:
//
//   * No backfill of intermediate missed days. Core does not expose
//     historical masternode counts; a linear interpolation would be
//     a lie and a constant-fill would be misleading. A gap is
//     visible on the chart as a flat segment between the two
//     bracketing points — the truthful representation.

const BASE_RETRY_MS = 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const POST_MIDNIGHT_SKEW_MS = 5 * 1000;

function utcDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Milliseconds from `fromMs` until (next-UTC-midnight + POST_MIDNIGHT_SKEW_MS),
// clamped to at least 1s so we never recurse synchronously if the
// clock is pathological.
function msUntilNextMidnightUtc(fromMs) {
  const d = new Date(fromMs);
  const nextMidnight = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return Math.max(1000, nextMidnight + POST_MIDNIGHT_SKEW_MS - fromMs);
}

function createMnCountLogger({
  repo,
  fetchTotal,
  now = () => Date.now(),
  log = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!repo) throw new Error('createMnCountLogger: repo is required');
  if (typeof fetchTotal !== 'function') {
    throw new Error('createMnCountLogger: fetchTotal must be a function');
  }

  let timer = null;
  let stopped = false;
  let started = false;
  let lastWriteAt = 0;
  let lastWriteDate = null;
  let lastError = null;
  let currentRetryMs = BASE_RETRY_MS;

  async function sampleAndWrite(label) {
    const total = await fetchTotal();
    if (!Number.isInteger(total) || total < 0) {
      throw new Error(
        `fetchTotal returned a non-integer or negative value: ${JSON.stringify(total)}`
      );
    }
    const ts = now();
    const date = utcDateString(ts);
    const result = repo.upsertByDate(date, total, ts);
    lastWriteAt = ts;
    lastWriteDate = date;
    lastError = null;
    currentRetryMs = BASE_RETRY_MS;
    log('info', 'mncount_write', {
      label,
      date,
      total,
      inserted: result.inserted,
    });
    return { date, total, inserted: result.inserted };
  }

  // Post-error reschedule helper used by every catch path below.
  // Keeps the schedule() argument logic (backoff, midnight clamp,
  // fallback when msUntilNextMidnightUtc itself rejects) in one
  // place so a rescue path on the outer try/catch cannot drift out
  // of sync with the main one.
  function scheduleBackoffRetry() {
    if (stopped) return;
    currentRetryMs = Math.min(currentRetryMs * 2, MAX_RETRY_MS);
    let untilMidnight;
    try {
      untilMidnight = msUntilNextMidnightUtc(now());
    } catch (innerErr) {
      // msUntilNextMidnightUtc wraps Math + Date only; a throw here
      // would be an invariant violation, but we handle it rather
      // than letting the scheduler die.
      log('error', 'mncount_schedule_invariant', {
        err: innerErr && innerErr.message,
      });
      untilMidnight = MAX_RETRY_MS;
    }
    schedule(Math.min(currentRetryMs, untilMidnight));
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    timer = setTimeoutImpl(() => {
      timer = null;
      // Belt-and-braces: runAndReschedule is documented never to
      // reject, but if it ever did (e.g. a future refactor drops
      // the outer try/catch below) an unhandled rejection here
      // would silently kill the logger until the next process
      // restart. Attach a last-resort catch that logs and arms a
      // short retry so the scheduler self-heals (Codex PR16 P2
      // round 2).
      runAndReschedule().catch((err) => {
        lastError = err && err.message;
        log('error', 'mncount_scheduler_invariant', {
          err: err && err.message,
        });
        try {
          scheduleBackoffRetry();
        } catch {
          /* final fallback: give up silently rather than crash */
        }
      });
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function runAndReschedule() {
    if (stopped) return;

    // Single outer try covers BOTH the pre-flight repo read and
    // the sample path. The pre-flight `repo.getLatestDate()` call
    // used to sit outside the try/catch; a transient SQLite read
    // failure there would reject the returned promise and — since
    // the scheduler callback doesn't await this function — silently
    // kill the logger's ability to reschedule future writes
    // (Codex PR16 P2 round 2). Treating any failure here as a
    // tick failure (log + backoff + clamp to this UTC day) keeps
    // the scheduler alive.
    try {
      // Fast-path: if today's row is already there (boot after a
      // successful earlier tick, or a spurious re-fire on the same
      // UTC day) skip the RPC entirely and arm for next midnight.
      // The INSERT OR IGNORE in the repo would collapse a duplicate
      // write anyway, but avoiding the RPC call keeps Core's load
      // bounded and stops a same-day re-sample from shadowing the
      // 00:00 snapshot with an afternoon value at the log layer.
      const today = utcDateString(now());
      if (repo.getLatestDate() === today) {
        if (stopped) return;
        schedule(msUntilNextMidnightUtc(now()));
        return;
      }

      await sampleAndWrite('tick');
      if (stopped) return;
      schedule(msUntilNextMidnightUtc(now()));
    } catch (err) {
      lastError = err && err.message;
      log('error', 'mncount_tick_failed', { err: err && err.message });
      scheduleBackoffRetry();
    }
  }

  // Exposed for tests / one-shot callers that just want the
  // "sample today if missing" decision without starting the
  // scheduler loop. The production boot path funnels through
  // runAndReschedule() instead so a boot-time failure is retried
  // with backoff before midnight (Codex PR16 P2).
  async function catchUpIfNeeded() {
    const today = utcDateString(now());
    const latest = repo.getLatestDate();
    if (latest === today) {
      return { skipped: true, reason: 'already-today' };
    }
    try {
      const out = await sampleAndWrite('catchup');
      return { skipped: false, ...out };
    } catch (err) {
      lastError = err && err.message;
      log('error', 'mncount_catchup_failed', { err: err && err.message });
      return { skipped: true, reason: 'error', err: err && err.message };
    }
  }

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    // Route the boot path through runAndReschedule() so all three
    // outcomes are handled uniformly by the scheduler:
    //   * today already recorded     → arm for next midnight.
    //   * sample succeeds now        → write, arm for next midnight.
    //   * sample fails now           → backoff retry, clamped to
    //                                  stay inside this UTC day.
    // The previous arrangement always armed for next midnight after
    // catch-up, so a transient RPC blip at boot would lose today
    // permanently instead of retrying (Codex PR16 P2).
    runAndReschedule().catch((err) => {
      lastError = err && err.message;
      log('error', 'mncount_start_failed', { err: err && err.message });
    });
  }

  function stop() {
    stopped = true;
    started = false;
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  function getDiagnostics() {
    return {
      started,
      stopped,
      lastWriteAt,
      lastWriteDate,
      lastError,
      currentRetryMs,
      hasPendingTimer: timer !== null,
    };
  }

  function __resetForTests() {
    stop();
    stopped = false;
    started = false;
    lastWriteAt = 0;
    lastWriteDate = null;
    lastError = null;
    currentRetryMs = BASE_RETRY_MS;
  }

  return {
    start,
    stop,
    catchUpIfNeeded,
    runAndReschedule,
    getDiagnostics,
    __resetForTests,
  };
}

module.exports = {
  createMnCountLogger,
  utcDateString,
  msUntilNextMidnightUtc,
  BASE_RETRY_MS,
  MAX_RETRY_MS,
  POST_MIDNIGHT_SKEW_MS,
};
