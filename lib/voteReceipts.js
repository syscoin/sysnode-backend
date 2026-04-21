// Vote receipts — persistent per-user record of which governance votes
// we relayed on their behalf, joined against Core's live tally via
// `gobject_getcurrentvotes` for on-chain confirmation.
//
// Design:
//
// - One row per (user, collateral outpoint, proposal). A vote change
//   is an UPDATE in place (the UNIQUE constraint on the table turns
//   a fresh INSERT into UPSERT), so the row always represents the
//   user's current intent, not their history. Previous intents are
//   not retained — the governance protocol itself does not keep
//   historical votes for the same (MN, proposal, signal) tuple either.
//
// - Statuses form a small, closed set:
//     * 'relayed'   — voteraw returned success, not yet reconciled
//                     against the chain. Transient: the reconciler
//                     flips it to 'confirmed' or 'stale' on next read.
//     * 'confirmed' — present in `gobject_getcurrentvotes` with our
//                     signal type. The canonical outcome is the
//                     chain's (may differ from our stored outcome if
//                     the user voted differently from another device —
//                     we adopt the chain's value since it's truth).
//     * 'stale'     — was 'relayed' but has been absent from chain
//                     beyond the grace window. Typical causes: the
//                     vote never propagated past our node's peer set,
//                     or the chain rotated it off the current-tally
//                     window. UI shows "needs retry".
//     * 'failed'    — voteraw itself rejected (signature_invalid,
//                     mn_not_found, vote_too_often, ...). `last_error`
//                     carries the classified error code. Not retried
//                     automatically — the user must initiate "Retry
//                     failed" after fixing whatever caused it.
//
// - No vote_sig is stored. Signatures are 65 bytes and only valid
//   within the preimage's nTime window (Core rejects drift beyond
//   ±1h); keeping them server-side adds zero replay value and expands
//   the radius of a DB compromise. A retry regenerates a fresh sig
//   client-side from the vault.
//
// - `submitted_at` moves on every relay attempt (first INSERT or
//   UPSERT driven by /gov/vote). `verified_at` moves only when the
//   reconciler observes the receipt on chain. Split timestamps keep
//   "when did the user last ask?" distinct from "when did we last
//   confirm it stuck?".
//
// The RPC call to `gobject_getcurrentvotes` is expensive on hot
// proposals (hundreds of MNs × short vote-string bodies) but trivial
// otherwise. Callers that may run the reconciler repeatedly within a
// short window should wrap the RPC in `createCurrentVotesCache` so
// concurrent requests for the same proposal share one round-trip.

const HEX64 = /^[0-9a-f]{64}$/i;

// Full set of outcomes Core understands. We store whatever the chain
// emits so that a multi-device user who voted "abstain" from another
// wallet ends up with an accurate receipt here, even though this
// server currently only lets users submit yes/no/abstain.
const VALID_OUTCOMES = new Set(['yes', 'no', 'abstain', 'none']);
const VALID_SIGNALS = new Set(['funding', 'valid', 'delete', 'endorsed']);
const VALID_STATUSES = new Set(['relayed', 'confirmed', 'stale', 'failed']);

// Defaults for the reconciler. Kept as exports so routes / tests can
// tune them without reaching into the module's internals.
const DEFAULT_STALE_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_CURRENT_VOTES_CACHE_MS = 2 * 60 * 1000;
// How long a successful 'relayed' receipt is treated as "recently
// relayed" for the purpose of short-circuiting a fresh POST /gov/vote
// for the same (user, MN, proposal, outcome). Deliberately short — the
// only point is to dedupe duplicate submit clicks and multi-device
// races; anything longer than ~1 min and the user would be surprised
// we "ignored" their re-submission.
const DEFAULT_RECENT_RELAY_MS = 60 * 1000;

// -----------------------------------------------------------------------
// Parsing Core's vote string format.
//
// `CGovernanceVote::ToString` (src/governance/governancevote.cpp:110)
// emits "<txid>-<n>:<nTime>:<outcome>:<signal>" where:
//   - txid is 64-hex (always), `n` is the vout index.
//   - nTime is the seconds-since-epoch the signer captured in the
//     preimage. Stored as int64, rendered as a decimal integer.
//   - outcome ∈ {none, yes, no, abstain}.
//   - signal  ∈ {funding, valid, delete, endorsed}.
//
// The outpoint separator is `-` (see COutPoint::ToStringShort); the
// tuple separator is `:`. Since txid is 64 hex chars (never contains
// `:`), a simple split on `:` produces exactly 4 parts; the first
// part is "<txid>-<n>".
// -----------------------------------------------------------------------

function parseVoteString(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split(':');
  if (parts.length !== 4) return null;
  const [outpointStr, nTimeStr, outcome, signal] = parts;
  const dash = outpointStr.lastIndexOf('-');
  if (dash <= 0 || dash === outpointStr.length - 1) return null;
  const hash = outpointStr.slice(0, dash);
  const idxStr = outpointStr.slice(dash + 1);
  if (!HEX64.test(hash)) return null;
  if (!/^\d+$/.test(idxStr)) return null;
  const idx = Number(idxStr);
  if (!Number.isInteger(idx) || idx < 0 || idx > 0xffffffff) return null;
  if (!/^-?\d+$/.test(nTimeStr)) return null;
  const nTime = Number(nTimeStr);
  if (!Number.isInteger(nTime)) return null;
  if (!VALID_OUTCOMES.has(outcome)) return null;
  if (!VALID_SIGNALS.has(signal)) return null;
  return {
    collateralHash: hash.toLowerCase(),
    collateralIndex: idx,
    voteTime: nTime,
    voteOutcome: outcome,
    voteSignal: signal,
  };
}

// Accept the full `gobject_getcurrentvotes` payload shape: an object
// keyed by vote hash, values being the ToString() format. Returns an
// array of parsed entries, silently dropping any we can't parse so a
// single malformed row doesn't sink the whole reconciliation. We
// attach the voteHash alongside the parsed fields because the UI
// surfaces it as the "on-chain proof" handle.
function parseCurrentVotes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  for (const [voteHash, voteStr] of Object.entries(raw)) {
    const parsed = parseVoteString(voteStr);
    if (parsed) out.push({ voteHash, ...parsed });
  }
  return out;
}

// -----------------------------------------------------------------------
// Cache for gobject_getcurrentvotes results.
//
// Per-process LRU-of-one-per-proposal with a TTL. Call sites create a
// single cache at boot and reuse it across requests; the cache is
// keyed on proposalHash and returns the same Promise to concurrent
// callers (preventing a thundering-herd on a hot proposal). On error,
// the cache entry is dropped so the next call retries.
// -----------------------------------------------------------------------

function createCurrentVotesCache({
  callRpc,
  ttlMs = DEFAULT_CURRENT_VOTES_CACHE_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof callRpc !== 'function') {
    throw new Error('createCurrentVotesCache: callRpc is required');
  }
  const entries = new Map(); // proposalHash -> { expiresAt, promise }

  async function get(proposalHash) {
    if (typeof proposalHash !== 'string' || !HEX64.test(proposalHash)) {
      throw new Error('invalid_proposal_hash');
    }
    const key = proposalHash.toLowerCase();
    const t = now();
    const cached = entries.get(key);
    if (cached && cached.expiresAt > t) {
      return cached.promise;
    }
    const promise = Promise.resolve()
      .then(() => callRpc(key))
      .then((raw) => parseCurrentVotes(raw))
      .catch((err) => {
        // Drop the cache entry so the next caller retries the RPC.
        // We only evict if we're still the current entry; concurrent
        // refreshes must not clobber each other.
        if (entries.get(key) === record) entries.delete(key);
        throw err;
      });
    const record = { expiresAt: t + ttlMs, promise };
    entries.set(key, record);
    return promise;
  }

  function invalidate(proposalHash) {
    if (typeof proposalHash !== 'string') return;
    entries.delete(proposalHash.toLowerCase());
  }

  function clear() {
    entries.clear();
  }

  return { get, invalidate, clear };
}

// -----------------------------------------------------------------------
// Receipts repo.
// -----------------------------------------------------------------------

function createVoteReceiptsRepo(db, opts = {}) {
  if (!db) throw new Error('createVoteReceiptsRepo: db is required');
  const now = opts.now ?? (() => Date.now());
  const staleGraceMs = opts.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
  const recentRelayMs = opts.recentRelayMs ?? DEFAULT_RECENT_RELAY_MS;

  // SQLite UPSERT: INSERT ... ON CONFLICT(...) DO UPDATE. The UNIQUE
  // constraint on (user_id, collateral_txid, collateral_vout,
  // proposal_hash) is the conflict target. Updates always bump
  // submitted_at (this helper is called from the relay path) and
  // null-out verified_at so a reconciler pass re-verifies freshly
  // — a vote change invalidates the previous confirmation.
  const upsertStmt = db.prepare(`
    INSERT INTO vote_receipts (
      user_id, collateral_txid, collateral_vout, proposal_hash,
      vote_outcome, vote_signal, vote_time,
      status, last_error, submitted_at, verified_at
    ) VALUES (
      @userId, @collateralHash, @collateralIndex, @proposalHash,
      @voteOutcome, @voteSignal, @voteTime,
      @status, @lastError, @submittedAt, NULL
    )
    ON CONFLICT(user_id, collateral_txid, collateral_vout, proposal_hash)
    DO UPDATE SET
      vote_outcome = excluded.vote_outcome,
      vote_signal  = excluded.vote_signal,
      vote_time    = excluded.vote_time,
      status       = excluded.status,
      last_error   = excluded.last_error,
      submitted_at = excluded.submitted_at,
      verified_at  = NULL
  `);

  // Distinct from upsertStmt: this one NEVER touches submitted_at
  // (which is the last relay time, not an observation), and
  // intentionally preserves NULL vs. value semantics on last_error by
  // taking whatever the caller passes in.
  const markReconciledStmt = db.prepare(`
    UPDATE vote_receipts
       SET vote_outcome = @voteOutcome,
           vote_signal  = @voteSignal,
           vote_time    = @voteTime,
           status       = @status,
           last_error   = @lastError,
           verified_at  = @verifiedAt
     WHERE user_id          = @userId
       AND collateral_txid  = @collateralHash
       AND collateral_vout  = @collateralIndex
       AND proposal_hash    = @proposalHash
  `);

  // Less common: flip status only, when the receipt wasn't observed
  // on chain but the grace window has passed. Touching only the
  // needed columns keeps the row auditable (submitted_at preserved).
  const markStaleStmt = db.prepare(`
    UPDATE vote_receipts
       SET status = 'stale'
     WHERE user_id         = @userId
       AND collateral_txid = @collateralHash
       AND collateral_vout = @collateralIndex
       AND proposal_hash   = @proposalHash
       AND status IN ('relayed')
       AND submitted_at < @cutoff
  `);

  const getByOutpointStmt = db.prepare(`
    SELECT id,
           user_id          AS userId,
           collateral_txid  AS collateralHash,
           collateral_vout  AS collateralIndex,
           proposal_hash    AS proposalHash,
           vote_outcome     AS voteOutcome,
           vote_signal      AS voteSignal,
           vote_time        AS voteTime,
           status,
           last_error       AS lastError,
           submitted_at     AS submittedAt,
           verified_at      AS verifiedAt
      FROM vote_receipts
     WHERE user_id         = ?
       AND collateral_txid = ?
       AND collateral_vout = ?
       AND proposal_hash   = ?
  `);

  const listByProposalStmt = db.prepare(`
    SELECT id,
           user_id          AS userId,
           collateral_txid  AS collateralHash,
           collateral_vout  AS collateralIndex,
           proposal_hash    AS proposalHash,
           vote_outcome     AS voteOutcome,
           vote_signal      AS voteSignal,
           vote_time        AS voteTime,
           status,
           last_error       AS lastError,
           submitted_at     AS submittedAt,
           verified_at      AS verifiedAt
      FROM vote_receipts
     WHERE user_id = ? AND proposal_hash = ?
     ORDER BY submitted_at DESC
  `);

  // Rollup: one row per proposal the user has a receipt for. We
  // collapse status counts + per-outcome confirmed counts in the same
  // query so the UI can render a cohort-aware chip without a second
  // fetch. Confirmed-outcome counts let the page show "Yes · 3 of 5"
  // without streaming the full receipt list.
  const summaryStmt = db.prepare(`
    SELECT proposal_hash AS proposalHash,
           COUNT(*)                                                 AS total,
           SUM(CASE WHEN status = 'relayed'   THEN 1 ELSE 0 END)    AS relayed,
           SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END)    AS confirmed,
           SUM(CASE WHEN status = 'stale'     THEN 1 ELSE 0 END)    AS stale,
           SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END)    AS failed,
           SUM(CASE WHEN status = 'confirmed' AND vote_outcome = 'yes'
                    THEN 1 ELSE 0 END)                              AS confirmedYes,
           SUM(CASE WHEN status = 'confirmed' AND vote_outcome = 'no'
                    THEN 1 ELSE 0 END)                              AS confirmedNo,
           SUM(CASE WHEN status = 'confirmed' AND vote_outcome = 'abstain'
                    THEN 1 ELSE 0 END)                              AS confirmedAbstain,
           MAX(submitted_at)                                        AS latestSubmittedAt,
           MAX(verified_at)                                         AS latestVerifiedAt
      FROM vote_receipts
     WHERE user_id = ?
     GROUP BY proposal_hash
     ORDER BY latestSubmittedAt DESC
  `);

  const listRecentStmt = db.prepare(`
    SELECT id,
           proposal_hash    AS proposalHash,
           collateral_txid  AS collateralHash,
           collateral_vout  AS collateralIndex,
           vote_outcome     AS voteOutcome,
           vote_signal      AS voteSignal,
           vote_time        AS voteTime,
           status,
           last_error       AS lastError,
           submitted_at     AS submittedAt,
           verified_at      AS verifiedAt
      FROM vote_receipts
     WHERE user_id = ?
     ORDER BY submitted_at DESC
     LIMIT ?
  `);

  // Input-shape guardrails. These are programmer-error checks: callers
  // are the route handlers + reconciler, both of which are trusted.
  // We still validate because a silent bad INSERT (wrong case on the
  // hash, for instance) would corrupt the UNIQUE join key.
  function normalizeReceiptInput(r) {
    const {
      userId,
      collateralHash,
      collateralIndex,
      proposalHash,
      voteOutcome,
      voteSignal,
      voteTime,
      status,
      lastError = null,
    } = r || {};
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error('upsert: invalid userId');
    }
    if (typeof collateralHash !== 'string' || !HEX64.test(collateralHash)) {
      throw new Error('upsert: invalid collateralHash');
    }
    if (
      !Number.isInteger(collateralIndex) ||
      collateralIndex < 0 ||
      collateralIndex > 0xffffffff
    ) {
      throw new Error('upsert: invalid collateralIndex');
    }
    if (typeof proposalHash !== 'string' || !HEX64.test(proposalHash)) {
      throw new Error('upsert: invalid proposalHash');
    }
    if (!VALID_OUTCOMES.has(voteOutcome)) {
      throw new Error('upsert: invalid voteOutcome');
    }
    if (!VALID_SIGNALS.has(voteSignal)) {
      throw new Error('upsert: invalid voteSignal');
    }
    if (!Number.isInteger(voteTime) || voteTime < 0) {
      throw new Error('upsert: invalid voteTime');
    }
    if (!VALID_STATUSES.has(status)) {
      throw new Error('upsert: invalid status');
    }
    if (lastError !== null && typeof lastError !== 'string') {
      throw new Error('upsert: lastError must be string or null');
    }
    return {
      userId,
      collateralHash: collateralHash.toLowerCase(),
      collateralIndex,
      proposalHash: proposalHash.toLowerCase(),
      voteOutcome,
      voteSignal,
      voteTime,
      status,
      lastError,
    };
  }

  function upsert(input) {
    const norm = normalizeReceiptInput(input);
    upsertStmt.run({ ...norm, submittedAt: now() });
    return getByOutpointStmt.get(
      norm.userId,
      norm.collateralHash,
      norm.collateralIndex,
      norm.proposalHash
    );
  }

  function getByOutpoint({
    userId,
    collateralHash,
    collateralIndex,
    proposalHash,
  }) {
    if (!Number.isInteger(userId) || userId <= 0) return null;
    if (typeof collateralHash !== 'string' || !HEX64.test(collateralHash)) {
      return null;
    }
    if (!Number.isInteger(collateralIndex)) return null;
    if (typeof proposalHash !== 'string' || !HEX64.test(proposalHash)) {
      return null;
    }
    return (
      getByOutpointStmt.get(
        userId,
        collateralHash.toLowerCase(),
        collateralIndex,
        proposalHash.toLowerCase()
      ) || null
    );
  }

  function listForProposal(userId, proposalHash) {
    if (!Number.isInteger(userId) || userId <= 0) return [];
    if (typeof proposalHash !== 'string' || !HEX64.test(proposalHash)) {
      return [];
    }
    return listByProposalStmt.all(userId, proposalHash.toLowerCase());
  }

  function summaryForUser(userId) {
    if (!Number.isInteger(userId) || userId <= 0) return [];
    return summaryStmt.all(userId);
  }

  function listRecent(userId, limit = 10) {
    if (!Number.isInteger(userId) || userId <= 0) return [];
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
    return listRecentStmt.all(userId, n);
  }

  // Decide whether a fresh /gov/vote entry can short-circuit because
  // we already did this work. Returns a discriminated shape:
  //
  //   { action: 'skip',  reason: 'already_on_chain' | 'recently_relayed' }
  //   { action: 'relay' }  // no existing receipt, or vote is changing,
  //                        // or existing state warrants a retry.
  //
  // The caller (lib/gov.js) still runs voteraw for 'relay' and upserts
  // the result regardless of whether the previous receipt was 'relayed'
  // or 'failed' — we don't remember anything useful from a failed
  // previous run beyond "not on chain yet".
  function decideRelay({
    userId,
    collateralHash,
    collateralIndex,
    proposalHash,
    voteOutcome,
    voteSignal,
  }) {
    const existing = getByOutpoint({
      userId,
      collateralHash,
      collateralIndex,
      proposalHash,
    });
    if (!existing) return { action: 'relay' };
    const sameVote =
      existing.voteOutcome === voteOutcome &&
      existing.voteSignal === voteSignal;
    if (!sameVote) {
      // Vote change or signal change — always relay so the chain gets
      // the new intent. The upsert after the relay replaces the
      // previous receipt in place.
      return { action: 'relay', previous: existing };
    }
    if (existing.status === 'confirmed') {
      // On-chain with the same outcome: no need to relay again and
      // possibly trip Core's "voting too often" rate limit. Surface
      // this as a first-class ok-but-skipped shape so the UI can
      // render "Already on-chain" instead of the generic "accepted".
      return { action: 'skip', reason: 'already_on_chain', previous: existing };
    }
    if (existing.status === 'relayed') {
      const age = now() - existing.submittedAt;
      if (age >= 0 && age < recentRelayMs) {
        // Someone (maybe the same user from a second tab, maybe a
        // duplicate submit) relayed an identical vote very recently.
        // Short-circuit so we don't queue a second voteraw that Core
        // will reject with "masternode voting too often".
        return {
          action: 'skip',
          reason: 'recently_relayed',
          previous: existing,
        };
      }
      // Older 'relayed' receipt that hasn't been reconciled yet.
      // Re-relay so the vote actually makes it on-chain if the first
      // attempt's propagation stalled.
      return { action: 'relay', previous: existing };
    }
    // status ∈ {'stale', 'failed'}: retry was the whole point of
    // persisting these. Relay again.
    return { action: 'relay', previous: existing };
  }

  async function reconcileForProposal({
    userId,
    proposalHash,
    getCurrentVotes,
    staleGraceMs: staleGraceOverride,
  }) {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error('reconcile: invalid userId');
    }
    if (typeof proposalHash !== 'string' || !HEX64.test(proposalHash)) {
      throw new Error('reconcile: invalid proposalHash');
    }
    if (typeof getCurrentVotes !== 'function') {
      throw new Error('reconcile: getCurrentVotes is required');
    }
    const propLower = proposalHash.toLowerCase();
    const receipts = listForProposal(userId, propLower);
    if (receipts.length === 0) return { updated: 0, receipts: [] };
    const grace = Number.isInteger(staleGraceOverride)
      ? staleGraceOverride
      : staleGraceMs;

    let onChain;
    try {
      onChain = await getCurrentVotes(propLower);
    } catch (err) {
      // RPC outage is treated as "we don't know" — receipts are left
      // alone. This is safer than flipping a batch to 'stale' on a
      // transient network glitch.
      const e = new Error('reconcile_rpc_failed');
      e.cause = err;
      throw e;
    }
    if (!Array.isArray(onChain)) {
      throw new Error('reconcile: getCurrentVotes must return an array');
    }

    // Index on-chain votes by (outpoint, signal). Multi-signal voting
    // means a single MN can legitimately have N entries for the same
    // proposal (funding + valid, say), so the key must include the
    // signal. We only have 'funding' receipts in v1, but indexing
    // correctly today avoids a quiet bug when a future signal lands.
    const byKey = new Map();
    for (const v of onChain) {
      const key = `${v.collateralHash}:${v.collateralIndex}:${v.voteSignal}`;
      byKey.set(key, v);
    }

    const t = now();
    const cutoff = t - grace;
    let updated = 0;
    const txn = db.transaction(() => {
      for (const r of receipts) {
        const key = `${r.collateralHash}:${r.collateralIndex}:${r.voteSignal}`;
        const chain = byKey.get(key);
        if (chain) {
          // Present on chain: adopt the chain's outcome + time. That
          // handles the vote-from-another-device case without
          // clobbering the user's intent here (they intended "funding"
          // from this MN; the only thing they can disagree with us
          // about is the outcome).
          markReconciledStmt.run({
            userId,
            collateralHash: r.collateralHash,
            collateralIndex: r.collateralIndex,
            proposalHash: propLower,
            voteOutcome: chain.voteOutcome,
            voteSignal: chain.voteSignal,
            voteTime: chain.voteTime,
            status: 'confirmed',
            lastError: null,
            verifiedAt: t,
          });
          updated += 1;
          continue;
        }
        // Not on chain.
        if (r.status === 'failed' || r.status === 'stale') {
          // Already reflecting "not on chain" — nothing to do. We
          // don't touch verified_at here since the receipt wasn't
          // verified (it was observed-absent), and flipping it
          // would blur what "verified" means for UIs downstream.
          continue;
        }
        if (r.status === 'confirmed') {
          // Previously confirmed but chain no longer reports it in
          // its current-tally window. Syscoin eventually drops old
          // votes; this isn't a failure. Leave status=confirmed so
          // the UI doesn't flap. The verified_at timestamp decays
          // naturally and the UI can show "verified X min ago".
          continue;
        }
        // status === 'relayed'.
        if (r.submittedAt < cutoff) {
          markStaleStmt.run({
            userId,
            collateralHash: r.collateralHash,
            collateralIndex: r.collateralIndex,
            proposalHash: propLower,
            cutoff,
          });
          updated += 1;
        }
        // else: still within grace window — keep status='relayed'.
      }
    });
    txn();

    return { updated, receipts: listForProposal(userId, propLower) };
  }

  return {
    upsert,
    getByOutpoint,
    listForProposal,
    listRecent,
    summaryForUser,
    decideRelay,
    reconcileForProposal,
  };
}

module.exports = {
  createVoteReceiptsRepo,
  createCurrentVotesCache,
  parseVoteString,
  parseCurrentVotes,
  VALID_OUTCOMES,
  VALID_SIGNALS,
  VALID_STATUSES,
  DEFAULT_STALE_GRACE_MS,
  DEFAULT_CURRENT_VOTES_CACHE_MS,
  DEFAULT_RECENT_RELAY_MS,
};
