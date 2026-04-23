// Governance reminder dispatcher — decides who gets an email and when.
//
// The module is framework-agnostic: all dependencies (the users /
// receipts / log repos, the mailer, the live proposal-source RPC, the
// next-superblock anchor, the clock, the logger) are injected. The
// boot wiring in server.js composes the pieces and schedules `tick()`
// on an interval. Tests hand in fakes and call tick() directly.
//
// --- What does a tick do, in plain English ---
//
// A tick asks a single question per user: "should this user receive a
// reminder right now, in either of the two time-based buckets?". We
// answer it with four gates, in order:
//
//   1. Do we know when the next superblock is? (/mnStats populates
//      this; if it's missing or stale, skip — we can't compute time
//      remaining and would rather defer than send a bogus "closes
//      soon" email anchored to the wrong event.)
//   2. Is the next superblock inside the reminder-bucket window?
//      (> 72h away → too early; ≤ 0 → stale anchor, skip.)
//   3. Are there proposals eligible for that superblock? A proposal
//      P is eligible iff `P.startEpoch <= sbEpoch <= P.endEpoch`
//      (matches Core's superblock-payment window check). If none,
//      nothing to remind about.
//   4. Has the user already voted on ANY of those eligible
//      proposals? If so, suppress BOTH reminder buckets for this
//      cycle (spec: a user who has engaged with the cycle is done).
//
// Only users that clear all four gates are emailed, and only in the
// bucket that corresponds to the current time-until-superblock. The
// reminder log is checked per (user, scope_key, bucket) so the
// dispatcher is idempotent across ticks — a server restart, a clock
// skew, or a manual tick replay does not cause duplicate emails.
//
// --- Why "deadline = next superblock" and not "deadline = end_epoch" ---
//
// An earlier version of this dispatcher keyed off the earliest
// `end_epoch` among active proposals. That worked when proposers set
// end_epoch close to their last targeted superblock, but the new
// derive-window wizard intentionally places end_epoch ~15 days AFTER
// the last payout SB so Core prunes cleanly without allocating an
// extra superblock. With that layout, "≤72h to end_epoch" fires ~12
// days AFTER every meaningful voting decision has already been made
// — masternodes have committed, payments have landed or been missed,
// and the email is useless noise.
//
// The actually-meaningful deadline for a voter is the next upcoming
// superblock. Core re-evaluates each proposal's YES-FUNDING count
// during the ~3-day maturity window before each superblock, so
// voting on a proposal affects whether IT appears in that
// superblock's payment list. Buckets measured against the SB
// therefore tell users "vote now or this payout is gone", which is
// both true and actionable.
//
// --- Why we rotate scopeKey on the SB, not on end_epoch ---
//
// scopeKey embeds the integer unix second of the next superblock.
// It rotates automatically once the superblock executes and the
// next SB anchor shifts forward by one cycle, which means the
// dispatcher produces a fresh (user, scope, bucket) tuple for the
// next payout cycle — a user who got both reminders for SB_N will
// get both again for SB_{N+1} if they haven't voted yet.
//
// --- Bucket definitions ---
//
//   final_24h   — next SB is within 24h. Urgent tone.
//   days_before — next SB is within 72h but not 24h. Calm heads-up.
//
// Superblocks further than 72h away do not trigger any reminder.
// The 24h / 72h thresholds are exported as named constants so tests
// (and future tuning) don't sprinkle magic numbers.

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

const BUCKET_FINAL_24H = 'final_24h';
const BUCKET_DAYS_BEFORE = 'days_before';

// Thresholds in milliseconds from "now" to the next superblock.
// SB ≤ 24h away             → BUCKET_FINAL_24H
// SB > 24h and ≤ 72h        → BUCKET_DAYS_BEFORE
// SB > 72h or ≤ 0           → no bucket (tick emits nothing)
const FINAL_24H_MS = 1 * MS_DAY;
const DAYS_BEFORE_MS = 3 * MS_DAY;

function bucketForTimeRemaining(msRemaining) {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return null;
  if (msRemaining <= FINAL_24H_MS) return BUCKET_FINAL_24H;
  if (msRemaining <= DAYS_BEFORE_MS) return BUCKET_DAYS_BEFORE;
  return null;
}

// Parses a shape emitted by governance RPC / test fakes. Required
// fields: { hash: string, endEpoch: number (unix seconds) }.
// Optional: { startEpoch: number (unix seconds) }. A missing or
// zero startEpoch is treated as "always-started" (the proposal is
// eligible from the first superblock it encounters), which matches
// how legacy proposals without a startEpoch stored in DataString
// behave on Core. Returns a sanitized view or null if the proposal
// is not usable (missing fields, malformed hash, past endEpoch).
function normalizeProposal(raw, nowMs) {
  if (!raw || typeof raw !== 'object') return null;
  const hash = typeof raw.hash === 'string' ? raw.hash.toLowerCase() : null;
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const endEpoch = Number(raw.endEpoch);
  if (!Number.isFinite(endEpoch) || endEpoch <= 0) return null;
  const endMs = endEpoch * 1000;
  if (endMs <= nowMs) return null;
  // startEpoch is optional; 0 / negative / non-finite all map to
  // "no lower bound", which lets the SB-eligibility filter below
  // treat legacy payloads as still-eligible rather than silently
  // dropping them.
  const rawStart = Number(raw.startEpoch);
  const startEpoch = Number.isFinite(rawStart) && rawStart > 0 ? rawStart : 0;
  return { hash, startEpoch, endEpoch, startMs: startEpoch * 1000, endMs };
}

// A proposal P is eligible to be paid by the superblock at `sbEpoch`
// iff Core's on-chain payment window covers it:
//
//   P.startEpoch <= sbEpoch <= P.endEpoch
//
// A startEpoch of 0 is interpreted as "no lower bound" (see
// normalizeProposal). The upper bound is strict-enough: a
// proposal whose endEpoch is exactly the superblock second is
// still counted (Core's fudge window is 2h and our window has a
// ~15d trailing buffer, so boundary-second ties should never
// happen in practice — but being inclusive here keeps the math
// honest).
function proposalIsEligibleForSb(p, sbEpochSec) {
  if (!p) return false;
  if (!Number.isFinite(sbEpochSec) || sbEpochSec <= 0) return false;
  if (p.startEpoch > sbEpochSec) return false;
  if (p.endEpoch < sbEpochSec) return false;
  return true;
}

// Human-readable "closes in X" string for email body. Rounds down
// (conservative: "closes in 23h" while there are actually 23h 40m
// left is better UX than "closes in 24h" that tips over shortly).
function formatDeadlineText(msRemaining) {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return 'soon';
  const hours = Math.floor(msRemaining / MS_HOUR);
  if (hours < 24) return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(msRemaining / MS_DAY);
  return `in about ${days} day${days === 1 ? '' : 's'}`;
}

function createReminderDispatcher({
  users,
  voteReceipts,
  reminderLog,
  mailer,
  getActiveProposals,
  getNextSuperblockEpochSec,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!users || typeof users.listWithRemindersEnabled !== 'function') {
    throw new Error('reminderDispatcher: users.listWithRemindersEnabled required');
  }
  if (!voteReceipts || typeof voteReceipts.hasAnyRelayedInCycle !== 'function') {
    throw new Error('reminderDispatcher: voteReceipts.hasAnyRelayedInCycle required');
  }
  if (!reminderLog || typeof reminderLog.has !== 'function' || typeof reminderLog.insert !== 'function') {
    throw new Error('reminderDispatcher: reminderLog.has/insert required');
  }
  if (!mailer || typeof mailer.sendVoteReminder !== 'function') {
    throw new Error('reminderDispatcher: mailer.sendVoteReminder required');
  }
  if (typeof getActiveProposals !== 'function') {
    throw new Error('reminderDispatcher: getActiveProposals function required');
  }
  if (typeof getNextSuperblockEpochSec !== 'function') {
    throw new Error(
      'reminderDispatcher: getNextSuperblockEpochSec function required'
    );
  }

  async function tick() {
    const nowMs = now();

    // --- Gate 1: next-SB anchor & bucket window ---
    //
    // We fail-closed on any missing/stale anchor: if /mnStats is
    // lagging or the backend just booted and hasn't run a sysMain
    // pass yet, we'd rather skip the tick than fire an email keyed
    // to a stale/bogus SB time. The next tick (default hourly) will
    // retry once the anchor recovers.
    let sbEpochSec;
    try {
      sbEpochSec = await getNextSuperblockEpochSec();
    } catch (err) {
      log('warn', 'reminder_tick_sb_anchor_failed', { err: err && err.message });
      return { sent: 0, skipped: 'next_superblock_unavailable' };
    }
    sbEpochSec = Number(sbEpochSec);
    if (!Number.isFinite(sbEpochSec) || sbEpochSec <= 0) {
      return { sent: 0, skipped: 'next_superblock_unavailable' };
    }
    const sbEpochMs = sbEpochSec * 1000;
    const msRemaining = sbEpochMs - nowMs;
    if (msRemaining <= 0) {
      // /mnStats lagged past the superblock and the next anchor
      // hasn't been populated yet. Skip cleanly — a stale anchor
      // would put every cycle's proposals into final_24h on every
      // tick until sysMain refreshes.
      return {
        sent: 0,
        skipped: 'next_superblock_unavailable',
        msRemaining,
      };
    }
    const bucket = bucketForTimeRemaining(msRemaining);
    if (!bucket) {
      return { sent: 0, skipped: 'too_early', msRemaining };
    }

    // --- Gate 2: proposals eligible for this SB ---
    let rawList;
    try {
      rawList = await getActiveProposals();
    } catch (err) {
      log('warn', 'reminder_tick_proposals_failed', { err: err && err.message });
      return { sent: 0, skipped: 'proposals_unavailable' };
    }
    const normalized = Array.isArray(rawList)
      ? rawList.map((p) => normalizeProposal(p, nowMs)).filter(Boolean)
      : [];
    const eligibleProposals = normalized.filter((p) =>
      proposalIsEligibleForSb(p, sbEpochSec)
    );
    if (eligibleProposals.length === 0) {
      return {
        sent: 0,
        skipped: 'no_active_proposals',
        bucket,
        msRemaining,
      };
    }

    const scopeKey = `sb:${sbEpochSec}`;
    const cycleProposalHashes = eligibleProposals.map((p) => p.hash);
    const deadlineText = formatDeadlineText(msRemaining);

    // --- Gate 3: opted-in users only ---
    let candidates;
    try {
      candidates = users.listWithRemindersEnabled();
    } catch (err) {
      log('error', 'reminder_tick_users_failed', { err: err && err.message });
      return { sent: 0, skipped: 'users_unavailable' };
    }

    const result = {
      sent: 0,
      skippedVoted: 0,
      skippedLogged: 0,
      failed: 0,
      bucket,
      scopeKey,
      candidateCount: candidates.length,
      // proposalCount reflects the cycle the reminder is about
      // (proposals eligible for THIS superblock), not the total
      // active list (which may include pre-start proposals for
      // later cycles). Keeps the email body and the tick-result
      // metric in agreement.
      proposalCount: eligibleProposals.length,
    };

    for (const user of candidates) {
      if (!user || !Number.isInteger(user.id) || !user.email) continue;

      // --- Gate 4: has the user already voted in this cycle? ---
      //
      // The spec is "if user voted on ANY proposal eligible for
      // the upcoming SB, suppress BOTH buckets". "Eligible for the
      // upcoming SB" is exactly the filtered set above — NOT the
      // full active list — otherwise a vote on a later-cycle
      // proposal would incorrectly cancel this cycle's reminder.
      //
      // We check this BEFORE the already-logged check so that a
      // user who votes after the days_before email still has the
      // final_24h email suppressed (the cycle-vote check cancels
      // the urgent reminder too).
      let voted;
      try {
        voted = voteReceipts.hasAnyRelayedInCycle(user.id, cycleProposalHashes);
      } catch (err) {
        log('warn', 'reminder_tick_voted_check_failed', {
          userId: user.id,
          err: err && err.message,
        });
        continue;
      }
      if (voted) {
        result.skippedVoted++;
        continue;
      }

      // --- Idempotency: already-sent log ---
      let alreadySent;
      try {
        alreadySent = reminderLog.has(user.id, scopeKey, bucket);
      } catch (err) {
        log('warn', 'reminder_tick_log_check_failed', {
          userId: user.id,
          err: err && err.message,
        });
        continue;
      }
      if (alreadySent) {
        result.skippedLogged++;
        continue;
      }

      // --- Send + log. Order matters here.
      //
      // We SEND first, then LOG on success. That means a transient
      // mailer failure leaves the log untouched and the next tick
      // will retry. The alternative (log-first, send-after) would
      // drop retries on flaky SMTP, which is the wrong trade for an
      // opt-in reminder that can fire at most twice per cycle.
      //
      // If the log insert itself fails after a successful send
      // (e.g. disk error), the next tick will re-send — we accept
      // that as better-than-losing-the-reminder. In practice the
      // UNIQUE constraint on (user, scope_key, bucket) means any
      // race between two overlapping ticks also degrades to at most
      // one extra send per (user, cycle, bucket).
      try {
        await mailer.sendVoteReminder({
          to: user.email,
          bucket,
          proposalCount: eligibleProposals.length,
          deadlineText,
        });
      } catch (err) {
        result.failed++;
        log('warn', 'reminder_send_failed', {
          userId: user.id,
          bucket,
          err: err && err.message,
        });
        continue;
      }

      try {
        const ins = reminderLog.insert(user.id, scopeKey, bucket, nowMs);
        if (!ins.inserted) {
          // Race with a parallel tick. The email was already sent by
          // one instance; we shouldn't re-send. Don't count this as a
          // fresh send in our metrics.
          result.skippedLogged++;
        } else {
          result.sent++;
        }
      } catch (err) {
        // Log-insert failed for a reason other than UNIQUE (the log
        // module already swallows UNIQUE). We count this as a send
        // because the mail DID go out — just note the inconsistency.
        result.sent++;
        log('error', 'reminder_log_insert_failed', {
          userId: user.id,
          bucket,
          err: err && err.message,
        });
      }
    }

    log('info', 'reminder_tick_done', result);
    return result;
  }

  return { tick };
}

module.exports = {
  createReminderDispatcher,
  // Exported for tests and for boot wiring that wants to surface the
  // bucket names in admin logs or future /admin routes.
  BUCKET_FINAL_24H,
  BUCKET_DAYS_BEFORE,
  FINAL_24H_MS,
  DAYS_BEFORE_MS,
  bucketForTimeRemaining,
  formatDeadlineText,
  normalizeProposal,
  proposalIsEligibleForSb,
};
