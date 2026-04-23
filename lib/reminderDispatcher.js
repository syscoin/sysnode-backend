// Governance reminder dispatcher — decides who gets an email and when.
//
// The module is framework-agnostic: all dependencies (the users /
// receipts / log repos, the mailer, the live proposal-source RPC, the
// next-superblock snapshot, the clock, the logger) are injected. The
// boot wiring in server.js composes the pieces and schedules `tick()`
// on an interval. Tests hand in fakes and call tick() directly.
//
// --- What deadline does this dispatcher use? ---
//
// The actionable "voting deadline" from a voter's point of view is
// NOT the superblock itself — it's the start of Core's superblock
// maturity window (~3 days before the SB on Syscoin mainnet;
// nSuperblockMaturityWindow = 1728 blocks × 150 s/block). Once the
// maturity window opens, masternodes begin committing YES-FUNDING
// trigger votes and (per governance.cpp) an MN that has voted
// YES-FUNDING for one trigger cannot switch to another for the same
// cycle. So a user who only finds out about a proposal AFTER the
// maturity window opens is already watching some fraction of MNs
// lock in their choice. Reminding them then is mostly useless noise.
//
// The dispatcher therefore anchors to the maturity-window start:
//
//   deadlineSec = nextSuperblockEpochSec - SUPERBLOCK_MATURITY_WINDOW_SEC
//
// and buckets the time remaining until THAT moment:
//
//   days_before   — deadline is 24h < remaining ≤ 72h away
//                   (≈ 4–6 days before the superblock itself)
//   final_24h     — deadline is 0 < remaining ≤ 24h away
//                   (≈ 3–4 days before the superblock itself)
//   maturity_window_open  — remaining ≤ 0 (we're already inside the
//                           maturity window; suppress — too late for
//                           the reminder to affect voting outcomes)
//   too_early     — remaining > 72h (not worth bothering anyone yet)
//
// Both email buckets fire OUTSIDE the maturity window by design.
//
// --- Cycle definition and scope key stability ---
//
// A proposal P is eligible to be paid by the upcoming superblock iff
// Core's payment window covers it:
//
//   P.startEpoch <= sbEpochSec <= P.endEpoch
//
// Eligibility uses the SB time itself (not the maturity start),
// because that matches Core's IsWithinValidWindow check for what
// gets paid at that SB. (The maturity anchor is only about *when*
// voters should be reminded, not about *which* proposals are in
// the cycle.)
//
// `scopeKey` keys the reminder log entries for idempotency. It is
// critical that the scope key be STABLE across ticks that refer to
// the same superblock — otherwise `reminderLog.has()` won't
// deduplicate and a user could be re-emailed every hour for 72
// hours. We therefore key the scope on the next-superblock's BLOCK
// HEIGHT (an integer that only changes once the SB executes), NOT
// on the epochSec estimate (which `sysMain.js` recomputes from
// `Date.now() + diffBlock * avgBlockTime` every 20s and therefore
// drifts continuously as wall-clock time advances).
//
//   scopeKey = `sb:${height}`
//
// When the chain advances past the current SB, the height jumps by
// exactly `nSuperblockCycle` (17520 on mainnet) and the scope
// rotates — which is the correct moment: a user who got both
// reminders for SB_N and didn't vote should get both again for the
// fresh cycle SB_{N+1}.
//
// --- Failure modes ---
//
//   - `getNextSuperblock` throws / returns anything but
//     `{ height: positive int, epochSec: > now }` → skip with
//     `next_superblock_unavailable`. The next hourly tick retries.
//   - `getActiveProposals` throws → skip with `proposals_unavailable`.
//   - Mailer send throws → record `failed++`, do NOT write the
//     reminder-log entry, so the next tick in the same bucket
//     retries. UNIQUE race behavior (parallel tick sends same
//     email) is covered by the UNIQUE(user, scope, bucket)
//     constraint on reminderLog.

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

// A proposal P is eligible to be paid by the superblock at
// `sbEpochSec` iff Core's on-chain payment window covers it:
//
//   P.startEpoch <= sbEpochSec <= P.endEpoch
//
// A startEpoch of 0 is interpreted as "no lower bound" (see
// normalizeProposal). The bounds are inclusive; boundary-second
// ties should never happen in practice because derived windows
// carry a ~15-day buffer on each side, but being inclusive here
// keeps the math honest.
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

  async function tick() {
    const nowMs = now();
    const nowSec = Math.floor(nowMs / 1000);

    // --- Gate 1: next-SB snapshot & bucket window ---
    //
    // A single atomic snapshot `{ height, epochSec }` so height
    // and epochSec are consistent with each other even if the
    // caller's underlying data source (sysMain) gets refreshed
    // mid-tick.
    //
    // `height` is the canonical identifier — stable until the SB
    // executes, at which point it jumps by exactly
    // nSuperblockCycle. It drives scopeKey, so reminderLog.has()
    // actually deduplicates across the 72h reminder window (the
    // old epoch-based scopeKey drifted every 20s with sysMain's
    // wall-clock-driven estimate and defeated dedup entirely —
    // Codex PR14 P1).
    //
    // `epochSec` is the drifting estimate used for *time*
    // calculations only. Minute-scale drift is harmless because
    // bucket thresholds are in hours.
    let snapshot;
    try {
      snapshot = await getNextSuperblock();
    } catch (err) {
      log('warn', 'reminder_tick_sb_snapshot_failed', {
        err: err && err.message,
      });
      return { sent: 0, skipped: 'next_superblock_unavailable' };
    }
    const height = snapshot && Number(snapshot.height);
    const sbEpochSec = snapshot && Number(snapshot.epochSec);
    if (
      !Number.isInteger(height) ||
      height <= 0 ||
      !Number.isFinite(sbEpochSec) ||
      sbEpochSec <= nowSec
    ) {
      return { sent: 0, skipped: 'next_superblock_unavailable' };
    }

    // Voters' actual deadline = when the maturity window opens.
    const maturityOpensEpochSec = sbEpochSec - SUPERBLOCK_MATURITY_WINDOW_SEC;
    const msRemaining = maturityOpensEpochSec * 1000 - nowMs;

    if (msRemaining <= 0) {
      // The maturity window has already opened for the upcoming
      // SB. Any email we'd send now would ask voters to vote on a
      // trigger set where some fraction of masternodes have
      // already committed — too late to influence the outcome,
      // and worse than useless UX. Suppress.
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
  BUCKET_FINAL_24H,
  BUCKET_DAYS_BEFORE,
  FINAL_24H_MS,
  DAYS_BEFORE_MS,
  SUPERBLOCK_MATURITY_WINDOW_SEC,
  bucketForTimeRemaining,
  formatDeadlineText,
  normalizeProposal,
  proposalIsEligibleForSb,
};
