// Governance reminders use a fresh, tip-consistent Core snapshot. Selection
// can start at the maturity height; that is NOT a proposal-vote expiry. Match
// Core's fixed 150s projection and two-hour eligibility tolerance. A local
// successful receipt on any eligible proposal suppresses both reminder buckets.
// External-wallet votes are not inferable from encrypted vaults: never claim
// the recipient has not voted. Stable sb:<height> scopes deduplicate cycles.

const { supportedProposalWindow } = require('./reminderProposals');
const { CORE_BLOCK_SECONDS } = require('./reminderSource');
const GOVERNANCE_FUDGE_SECONDS = 2 * 60 * 60;
const MAX_SNAPSHOT_AGE_MS = 60 * 1000;

// Retained for consumers/tests describing the mainnet schedule only. Actual
// dispatch uses the fresh RPC maturity-block count, never this fixed duration.
// Core's nSuperblockMaturityWindow on Syscoin mainnet:
// 1728 blocks × 150 seconds/block = 259_200 seconds = 3 days.
// Kept as an explicit constant (instead of inlining 259200) so it
// stays in lockstep with Core if the network parameter ever
// changes — update both this constant and the frontend governance
// helper at the same time.
const SUPERBLOCK_MATURITY_WINDOW_SEC = 1728 * 150;

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

const BUCKET_FINAL_24H = 'final_24h';
const BUCKET_DAYS_BEFORE = 'days_before';

// Thresholds in milliseconds from "now" to the maturity-window
// opening moment (SB - 3 days).
//
//   remaining ≤ 24h             → BUCKET_FINAL_24H
//   24h < remaining ≤ 72h       → BUCKET_DAYS_BEFORE
//   remaining > 72h             → no bucket (too early)
//   remaining ≤ 0               → caller maps to 'maturity_window_open'
//
// Despite the constant names, the "24h" and "72h" are measured
// against the maturity-window start, NOT the superblock itself. In
// wall-clock terms against the SB this translates to ~3–4d before
// SB for final_24h and ~4–6d before SB for days_before.
const FINAL_24H_MS = 1 * MS_DAY;
const DAYS_BEFORE_MS = 3 * MS_DAY;

function bucketForTimeRemaining(msRemaining) {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return null;
  if (msRemaining <= FINAL_24H_MS) return BUCKET_FINAL_24H;
  if (msRemaining <= DAYS_BEFORE_MS) return BUCKET_DAYS_BEFORE;
  return null;
}

// Revalidate the notification presentation shape at the dispatch boundary.
// Explicit zero start is allowed; missing/malformed timestamps are not.
function normalizeProposal(raw, nowMs) {
  if (!raw || typeof raw !== 'object') return null;
  const hash = typeof raw.hash === 'string' ? raw.hash.toLowerCase() : null;
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const endEpoch = raw.endEpoch;
  const startEpoch = raw.startEpoch;
  if (!supportedProposalWindow(startEpoch, endEpoch)) return null;
  const endMs = endEpoch * 1000;
  if (endMs <= nowMs) return null;
  return { hash, startEpoch, endEpoch, startMs: startEpoch * 1000, endMs };
}

// Match Core IsWithinValidWindow's inclusive two-hour tolerance.
function proposalIsEligibleForSb(p, sbEpochSec) {
  if (!p) return false;
  if (!Number.isFinite(sbEpochSec) || sbEpochSec <= 0) return false;
  if (p.startEpoch - GOVERNANCE_FUDGE_SECONDS > sbEpochSec) return false;
  if (p.endEpoch + GOVERNANCE_FUDGE_SECONDS < sbEpochSec) return false;
  return true;
}

// Human-readable estimate for selection start; never a voting-expiry claim.
function formatDeadlineText(msRemaining) {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return 'soon';
  const hours = Math.floor(msRemaining / MS_HOUR);
  if (hours === 0) return 'in less than an hour';
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
  getNextSuperblock,
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
  if (typeof getNextSuperblock !== 'function') {
    throw new Error(
      'reminderDispatcher: getNextSuperblock function required'
    );
  }

  let running = false;
  async function runTick() {
    // Snapshot is independent of dashboard/market refreshes.
    let snapshot;
    try {
      snapshot = await getNextSuperblock();
    } catch (err) {
      log('warn', 'reminder_tick_sb_snapshot_failed', {
        err: err && err.message,
      });
      return { sent: 0, skipped: 'next_superblock_unavailable' };
    }
    const nowMs = now();
    const nowSec = Math.floor(nowMs / 1000);
    const height = snapshot && snapshot.height;
    const currentHeight = snapshot && snapshot.currentHeight;
    const maturityBlocks = snapshot && snapshot.maturityBlocks;
    const observedAt = snapshot && snapshot.observedAt;
    // Never trust an independently calculated wall-clock estimate. Derive
    // eligibility and selection timing from this same verified block snapshot.
    const sbEpochSec = Math.floor(observedAt / 1000) + (height - currentHeight) * CORE_BLOCK_SECONDS;
    if (
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      !Number.isSafeInteger(currentHeight) || currentHeight < 0 || currentHeight >= height ||
      !Number.isSafeInteger(maturityBlocks) || maturityBlocks <= 0 || maturityBlocks > height ||
      !Number.isSafeInteger(observedAt) || observedAt > nowMs + 1000 || nowMs - observedAt > MAX_SNAPSHOT_AGE_MS ||
      !Number.isSafeInteger(sbEpochSec) || sbEpochSec <= nowSec
    ) {
      return { sent: 0, skipped: 'next_superblock_unavailable' };
    }

    // Derive selection-start ETA consistently from remaining blocks.
    const maturityOpensEpochSec = Math.floor(observedAt / 1000) +
      (height - maturityBlocks - currentHeight) * CORE_BLOCK_SECONDS;
    const msRemaining = maturityOpensEpochSec * 1000 - nowMs;

    if (currentHeight >= height - maturityBlocks || msRemaining <= 0) {
      // Selection has begun; this is not a prohibition on later proposal votes.
      return {
        sent: 0,
        skipped: 'maturity_window_open',
        msRemaining,
        height,
      };
    }
    const bucket = bucketForTimeRemaining(msRemaining);
    if (!bucket) {
      return { sent: 0, skipped: 'too_early', msRemaining, height };
    }

    // --- Gate 2: proposals eligible for this SB ---
    let rawList;
    try {
      rawList = await getActiveProposals(snapshot);
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
        height,
      };
    }

    const scopeKey = `sb:${height}`;
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
      height,
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
      // A long SMTP backlog must not keep sending from a formerly fresh
      // snapshot. Resume next hourly tick with a new independently read tip.
      if (now() - observedAt > MAX_SNAPSHOT_AGE_MS) {
        result.skipped = 'snapshot_expired';
        break;
      }

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
      // SMTP and SQLite cannot commit atomically: a post-send crash or log
      // failure can still cause a later duplicate. Never claim exactly-once.
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

  async function tick() {
    // The interval may fire again while SMTP is blocked. The DB log prevents
    // later/restart duplicates; this per-process gate prevents overlap before
    // the first successful send can be logged. SMTP acceptance followed by a
    // process crash is not an exactly-once guarantee.
    if (running) return { sent: 0, skipped: 'tick_in_progress' };
    running = true;
    try { return await runTick(); }
    finally { running = false; }
  }

  return { tick };
}

module.exports = {
  createReminderDispatcher,
  BUCKET_FINAL_24H,
  BUCKET_DAYS_BEFORE,
  FINAL_24H_MS,
  DAYS_BEFORE_MS,
  SUPERBLOCK_MATURITY_WINDOW_SEC,
  bucketForTimeRemaining,
  formatDeadlineText,
  normalizeProposal,
  proposalIsEligibleForSb,
  GOVERNANCE_FUDGE_SECONDS,
  MAX_SNAPSHOT_AGE_MS,
};
