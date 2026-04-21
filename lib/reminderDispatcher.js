// Governance reminder dispatcher — decides who gets an email and when.
//
// The module is framework-agnostic: all dependencies (the users /
// receipts / log repos, the mailer, the live proposal-source RPC, the
// clock, the logger) are injected. The boot wiring in server.js
// composes the pieces and schedules `tick()` on an interval. Tests
// hand in fakes and call tick() directly.
//
// --- What does a tick do, in plain English ---
//
// A tick asks a single question per user: "should this user receive a
// reminder right now, in either of the two time-based buckets?". We
// answer it with three gates, in order:
//
//   1. Is there an active governance cycle with a deadline in reach?
//      (If every proposal has already closed, nothing to remind about.)
//   2. Has the user explicitly opted out of vote reminders?
//      (users.listWithRemindersEnabled() already strips these out.)
//   3. Has the user already engaged with this cycle?
//      (hasAnyRelayedInCycle on the active proposal set. The spec is
//      explicit: if the user voted on ANY proposal in the cycle, skip
//      BOTH reminder buckets.)
//
// Only users that clear all three gates are emailed, and only in the
// bucket that corresponds to the current time-until-deadline. The
// reminder log is checked per (user, scope_key, bucket) so the
// dispatcher is idempotent across ticks — a server restart, a clock
// skew, or a manual tick replay does not cause duplicate emails.
//
// --- Bucket definitions ---
//
//   final_24h   — deadline is within 24h. Urgent tone.
//   days_before — deadline is within 72h but not 24h. Calm heads-up.
//
// Proposals whose deadline is > 72h away do not trigger any reminder.
// The 24h / 72h thresholds are exported as named constants so tests
// (and future tuning) don't sprinkle magic numbers.
//
// --- Why the dispatcher computes the cycle, not the caller ---
//
// "Cycle" is a concept the application owns, not the governance RPC.
// gObject_list returns a flat list of active proposals; the dispatcher
// projects them into a cycle by taking the earliest end_epoch among
// still-open proposals. That value becomes the scope_key, which makes
// a freshly-added proposal with an earlier deadline count as a new
// cycle (correct: the user may not have voted on the new proposal
// even if they voted on the old ones).

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

const BUCKET_FINAL_24H = 'final_24h';
const BUCKET_DAYS_BEFORE = 'days_before';

// Thresholds in milliseconds from "now" to "cycle deadline".
// Deadline ≤ 24h away       → BUCKET_FINAL_24H
// Deadline > 24h and ≤ 72h  → BUCKET_DAYS_BEFORE
// Deadline > 72h or ≤ 0     → no bucket (tick emits nothing)
const FINAL_24H_MS = 1 * MS_DAY;
const DAYS_BEFORE_MS = 3 * MS_DAY;

function bucketForTimeRemaining(msRemaining) {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return null;
  if (msRemaining <= FINAL_24H_MS) return BUCKET_FINAL_24H;
  if (msRemaining <= DAYS_BEFORE_MS) return BUCKET_DAYS_BEFORE;
  return null;
}

// Parses a shape emitted by governance RPC / test fakes. Required
// fields: { hash: string, endEpoch: number (unix seconds) }. Returns
// a sanitized, lowercased view, or null if the proposal is not usable
// (missing fields, malformed hash, past deadline).
function normalizeProposal(raw, nowMs) {
  if (!raw || typeof raw !== 'object') return null;
  const hash = typeof raw.hash === 'string' ? raw.hash.toLowerCase() : null;
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const endEpoch = Number(raw.endEpoch);
  if (!Number.isFinite(endEpoch) || endEpoch <= 0) return null;
  const deadlineMs = endEpoch * 1000;
  if (deadlineMs <= nowMs) return null;
  return { hash, endEpoch, deadlineMs };
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

  async function tick() {
    const nowMs = now();

    // --- Gate 1: active cycle & bucket window ---
    let rawList;
    try {
      rawList = await getActiveProposals();
    } catch (err) {
      log('warn', 'reminder_tick_proposals_failed', { err: err && err.message });
      return { sent: 0, skipped: 'proposals_unavailable' };
    }
    const proposals = Array.isArray(rawList)
      ? rawList.map((p) => normalizeProposal(p, nowMs)).filter(Boolean)
      : [];
    if (proposals.length === 0) {
      return { sent: 0, skipped: 'no_active_proposals' };
    }

    // Cycle = proposals sharing the earliest end_epoch among still-
    // open proposals. Proposals with later deadlines belong to a
    // FUTURE cycle — a user's vote on one of those must not suppress
    // this cycle's reminder. In Syscoin governance, proposals voting
    // for the same superblock share the same voting-deadline block
    // (and therefore the same end_epoch), so this mirrors the
    // consensus-level cycle grouping. Codex round-2 P2.
    //
    // scopeKey embeds the integer unix second of the earliest
    // end_epoch, so it is stable across ticks and can be inspected
    // in logs; a freshly-added proposal with an earlier deadline
    // becomes its own cycle on the next tick.
    const earliestDeadlineMs = Math.min(...proposals.map((p) => p.deadlineMs));
    const earliestEndEpoch = Math.floor(earliestDeadlineMs / 1000);
    const msRemaining = earliestDeadlineMs - nowMs;
    const bucket = bucketForTimeRemaining(msRemaining);
    if (!bucket) {
      return {
        sent: 0,
        skipped:
          msRemaining <= 0 ? 'deadline_passed' : 'too_early',
        msRemaining,
      };
    }

    // Membership test: exact-match on deadlineMs. Using endEpoch
    // equality would be equivalent (we floored to seconds above)
    // but deadlineMs stays in one unit for readability.
    const cycleProposals = proposals.filter(
      (p) => p.deadlineMs === earliestDeadlineMs
    );
    const scopeKey = `cycle:${earliestEndEpoch}`;
    const cycleProposalHashes = cycleProposals.map((p) => p.hash);
    const deadlineText = formatDeadlineText(msRemaining);

    // --- Gate 2: opted-in users only ---
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
      // proposalCount reflects the cycle the reminder is about, not
      // the total number of active proposals (which may span future
      // cycles). Keeps the email body and the tick-result metric in
      // agreement. Codex round-2 P2.
      proposalCount: cycleProposals.length,
    };

    for (const user of candidates) {
      if (!user || !Number.isInteger(user.id) || !user.email) continue;

      // --- Gate 3: has the user already voted in this cycle? ---
      //
      // The spec is "if user voted on ANY proposal in the current
      // cycle, suppress BOTH buckets". "Current cycle" is exactly
      // the proposal set filtered above — NOT the full active list
      // — otherwise a vote on a later-deadline proposal would
      // incorrectly cancel this earlier cycle's reminder. Codex
      // round-2 P2.
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
          // Report the cycle-scoped count so the email body matches
          // the cycle the reminder is actually about. Codex round-2 P2.
          proposalCount: cycleProposals.length,
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
};
