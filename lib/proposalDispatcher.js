'use strict';

// proposal dispatcher — advances proposal_submissions rows whose
// status is `awaiting_collateral` toward either `submitted` or
// `failed`.
//
// --- Responsibilities -------------------------------------------------
//   1. Poll the collateral tx's confirmation count.
//   2. Write the latest confirmation count back to the row so the UI
//      can show live progress (X / 6 confirmations).
//   3. Once >= GOVERNANCE_FEE_CONFIRMATIONS, call gObject_submit with
//      the frozen canonical fields (parent_hash, revision, time,
//      dataHex, collateral_txid). Record the returned governance hash
//      and flip status → submitted.
//   4. Fail closed after a bounded wait if the tx never appears on
//      chain (user entered the wrong txid or double-spent the output).
//
// --- Idempotency ------------------------------------------------------
// `gObject_submit` on Syscoin Core accepts re-submissions (it stores
// the object keyed by hash; a duplicate submit either no-ops or
// returns the same hash). So re-running tick() after a partial
// failure is safe: in the worst case we pay the RPC round-trip again
// and write the same governance_hash we already had. That said, we
// still scope work to `awaiting_collateral` rows — `submitted` and
// `failed` are terminal, so a successful tick cannot be re-run.
//
// --- Why separate from the email reminder dispatcher ----------------
// The existing reminderDispatcher is driven by time/deadlines and
// runs hourly. This dispatcher is driven by on-chain state and needs
// a much tighter cadence (2 min) to feel responsive to the user
// watching their proposal finalize. Mixing the two would either
// waste RPC calls (hourly is too slow for confirmations) or waste
// mailer calls (2-min cadence on reminders would be excessive), so
// they stay separate.

// Matches Syscoin Core's GOVERNANCE_FEE_CONFIRMATIONS constant in
// src/governance/governanceobject.h. Do NOT tune without first
// checking that Core still enforces the same threshold — being
// stricter than Core is safe, laxer is not.
const REQUIRED_CONFS = 6;

const MS_MINUTE = 60 * 1000;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

// Default time after which a row that never gets a valid collateral
// tx is marked `failed`. Seven days is a generous ceiling — users
// have a weekend-plus-workdays window to fix a broken txid. Adjust
// in the factory opts if operational experience suggests otherwise.
const DEFAULT_TIMEOUT_MS = 7 * MS_DAY;

// Core's error strings we want to match to decide retry-worthiness.
// Any match counts as a permanent rejection (terminal → failed).
//
// NOTE: we deliberately do NOT include /already exists/ here. A duplicate-
// submission error from Core is ambiguous: it can mean (a) we actually
// succeeded on a previous tick / worker / process and crashed before
// markSubmitted could persist, or (b) another actor posted the exact
// same governance object independently. In either case the governance
// object IS live on-chain, so flipping the row to `failed` (and firing
// a failure email) is a worse outcome than leaving it for the follow-up
// resolver to verify and promote to `submitted`. We classify it as a
// transient error and log loudly so operators can reconcile offline.
// (Codex PR8 round 1 P2.)
//
// Codex PR8 round 10 P2: these patterns MUST be anchored to
// validation phrasings Syscoin Core actually produces for
// unrecoverable governance-object rejections. A blanket /invalid/i
// catch is far too broad — transient RPC transport / JSON-parser
// errors (e.g. "invalid JSON-RPC response", "invalid response
// from server", "Invalid URL", socket errors wrapped with words
// like "invalid utf-8 sequence") frequently contain the word
// "invalid", and misclassifying those as permanent rejections
// flips rows to `failed` on a temporary outage and fires a failure
// email the user can never fix. Narrow to the exact phrases Core
// emits from CGovernanceObject::IsValidLocally / gobject_submit's
// explicit error branches (`Governance object is not valid`,
// `Invalid parent hash`, `Invalid signature`, `Invalid object
// type`), plus `Object submission rejected` which is Core's
// explicit permanent-reject wrapper, and the pre-validation hash
// mismatches. Anything else — including bare "invalid" in a
// transport string — stays classified as transient and gets
// retried.
const TERMINAL_CORE_ERRORS = [
  /rate limit/i,
  /Object submission rejected/i,
  /Governance object is not valid/i,
  /Invalid parent hash/i,
  /Invalid (?:object )?signature/i,
  /Invalid object type/i,
  /Invalid proposal/i,
  /Invalid data hex/i,
  /hash mismatch/i,
];

const DUPLICATE_CORE_ERROR = /already exists/i;

function isTerminalCoreError(err) {
  const msg = String((err && (err.message || err.reason)) || '');
  if (DUPLICATE_CORE_ERROR.test(msg)) return false;
  return TERMINAL_CORE_ERRORS.some((re) => re.test(msg));
}

function isDuplicateCoreError(err) {
  const msg = String((err && (err.message || err.reason)) || '');
  return DUPLICATE_CORE_ERROR.test(msg);
}

function createProposalDispatcher({
  submissions,
  rpc,
  log = () => {},
  now = () => Date.now(),
  opts = {},
  // Best-effort callbacks fired after a state transition. These are
  // the mailer hook: production wiring passes an onSubmitted that
  // looks up the user and sends sendProposalSubmitted, and an
  // onFailed that sends sendProposalFailed. Both receive the freshly
  // re-read submission row so the callback never has to trust what
  // the dispatcher "just wrote" (and, importantly, can never mutate
  // dispatcher state by accident). A callback throw is logged and
  // swallowed — the state transition itself already succeeded.
  onSubmitted = null,
  onFailed = null,
} = {}) {
  if (!submissions || typeof submissions.listByStatus !== 'function') {
    throw new Error('submissions repo is required');
  }
  if (!rpc || typeof rpc.getRawTransaction !== 'function') {
    throw new Error('rpc.getRawTransaction is required');
  }
  if (typeof rpc.gObjectSubmit !== 'function') {
    throw new Error('rpc.gObjectSubmit is required');
  }
  if (onSubmitted !== null && typeof onSubmitted !== 'function') {
    throw new Error('onSubmitted must be a function or null');
  }
  if (onFailed !== null && typeof onFailed !== 'function') {
    throw new Error('onFailed must be a function or null');
  }

  const requiredConfs = Number.isInteger(opts.requiredConfs)
    ? opts.requiredConfs
    : REQUIRED_CONFS;
  const timeoutMs = Number.isInteger(opts.timeoutMs)
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  // Swallow-and-log wrapper around the user-supplied hooks. We rely
  // on the caller to eat their own errors in prod, but tolerating a
  // crash here is strictly safer than letting a mailer blow up the
  // dispatcher loop (which would then stop advancing every other
  // row). Keep the hook call async-aware so async mailers work.
  async function fireHook(name, fn, arg) {
    if (!fn) return;
    try {
      await fn(arg);
    } catch (err) {
      log('error', 'hook_threw', {
        hook: name,
        id: arg && arg.submission && arg.submission.id,
        msg: String(err && err.message),
      });
    }
  }

  // Processes ONE row. Broken out so the tick loop can isolate per-row
  // failures — an error on row A must not stop us from handling row B.
  async function advance(row) {
    const { id, collateralTxid } = row;
    if (!collateralTxid) {
      // Shouldn't happen: attachCollateral enforces a non-null txid
      // before status flips to awaiting_collateral. Defensive only.
      log('warn', 'awaiting_collateral_without_txid', { id });
      return;
    }

    // 1. Look up the tx. Core throws "No such mempool or blockchain
    //    transaction" if it's unknown. Don't treat "unknown" as a
    //    hard failure right away — the user may have JUST broadcast
    //    and their node hasn't seen it yet. Only fail after timeoutMs.
    let tx;
    try {
      tx = await rpc.getRawTransaction(collateralTxid, 1);
    } catch (err) {
      const msg = String((err && err.message) || err);
      log('debug', 'getRawTransaction_error', { id, txid: collateralTxid, msg });
      const waitedMs = now() - row.updatedAt;
      if (/No such mempool or blockchain/i.test(msg) && waitedMs > timeoutMs) {
        let failedRow = null;
        try {
          failedRow = submissions.markFailed(id, {
            reason: 'collateral_not_found',
            detail: `Collateral tx ${collateralTxid} was not found after ${Math.round(
              waitedMs / MS_HOUR
            )}h.`,
          });
          log('warn', 'marked_failed_collateral_not_found', { id });
        } catch (markErr) {
          log('error', 'markFailed_threw', {
            id,
            msg: String(markErr && markErr.message),
          });
        }
        if (failedRow) {
          await fireHook('onFailed', onFailed, { submission: failedRow });
        }
      }
      return;
    }

    // `confirmations` is absent when the tx is in mempool only; in
    // some builds it may be 0. Normalize to a non-negative integer.
    const confs =
      Number.isFinite(Number(tx && tx.confirmations))
        ? Math.max(0, Math.trunc(Number(tx.confirmations)))
        : 0;

    // 2. Write latest conf count unless it'd be a no-op.
    if (confs !== row.collateralConfs) {
      try {
        submissions.updateConfirmations(id, confs);
      } catch (err) {
        log('error', 'updateConfirmations_failed', {
          id,
          msg: String(err && err.message),
        });
        return;
      }
      log('info', 'confs_updated', { id, confs });
    }

    if (confs < requiredConfs) {
      return;
    }

    // 3. Submit. Build args from the frozen snapshot. If ANYTHING
    //    changes between prepare-time and now, the collateral OP_RETURN
    //    won't match and Core rejects us — which is exactly why the
    //    hashing fields are immutable on the repo.
    let govHash;
    try {
      govHash = await rpc.gObjectSubmit(
        row.parentHash,
        row.revision,
        row.timeUnix,
        row.dataHex,
        row.collateralTxid
      );
    } catch (err) {
      // Terminal errors (validation, rate limit, "already exists")
      // are not going to get better on retry — fail the row so the
      // user gets a clear message instead of a silent retry loop.
      if (isTerminalCoreError(err)) {
        let failedRow = null;
        try {
          failedRow = submissions.markFailed(id, {
            reason: 'submit_rejected',
            detail: String((err && err.message) || err),
          });
          log('warn', 'submit_rejected', {
            id,
            msg: String((err && err.message) || err),
          });
        } catch (markErr) {
          log('error', 'markFailed_after_submit_reject_threw', {
            id,
            msg: String(markErr && markErr.message),
          });
        }
        if (failedRow) {
          await fireHook('onFailed', onFailed, { submission: failedRow });
        }
      } else if (isDuplicateCoreError(err)) {
        // "Governance object already exists" — the object is live on
        // chain. Core indexes governance objects by CGovernanceObject::
        // GetHash(parent, rev, time, vchData, outpoint, sig), which is
        // exactly what computeProposalHash() reproduces at prepare
        // time (outpoint + sig are empty for user-submitted top-level
        // proposals). So the existing on-chain hash MUST equal our
        // frozen row.proposalHash.
        //
        // Codex PR8 round 2 P1: previously we only logged here and
        // left the row in awaiting_collateral, which meant a genuine
        // duplicate (crash between gObjectSubmit succeeding and
        // markSubmitted persisting, or two dispatcher workers racing)
        // would loop forever with no terminal transition and no user
        // signal. Resolve by promoting the row with our known hash.
        log('warn', 'submit_already_exists', {
          id,
          msg: String((err && err.message) || err),
        });
        let submittedRow = null;
        let clashed = false;
        try {
          submittedRow = submissions.markSubmitted(id, {
            governanceHash: row.proposalHash,
          });
        } catch (markErr) {
          // Two CAS failure modes to distinguish:
          //   - status_not_awaiting: another dispatcher worker
          //     already moved THIS row forward. The state machine
          //     already reflects the truth; don't loop, don't
          //     double-fire hooks.
          //   - governance_hash_clash: a DIFFERENT row already
          //     claimed this governance hash (the UNIQUE index on
          //     `governance_hash` rejected our UPDATE). The on-
          //     chain object exists but belongs to that other row
          //     on our books — ours is a redundant duplicate that
          //     will never be promoted. Codex PR8 round 10 P1:
          //     previously we only logged and exited here, so the
          //     row stayed in `awaiting_collateral` and every
          //     subsequent tick re-hit Core's "already exists"
          //     and looped forever with no terminal user-visible
          //     outcome. Mark it terminally failed with a stable
          //     reason so the user gets a clear signal and the
          //     dispatcher stops spinning on it.
          clashed = markErr && markErr.code === 'governance_hash_clash';
          log('warn', 'markSubmitted_after_duplicate_failed', {
            id,
            code: markErr && markErr.code,
            msg: String((markErr && markErr.message) || markErr),
          });
        }
        if (submittedRow) {
          log('info', 'submitted_via_duplicate', {
            id,
            governanceHash: row.proposalHash,
          });
          await fireHook('onSubmitted', onSubmitted, {
            submission: submittedRow,
          });
        } else if (clashed) {
          // Terminal cleanup for the duplicate-hash case. Use
          // markFailed's CAS to avoid racing with yet another
          // dispatcher worker that might also be processing this
          // row. If markFailed returns null we know someone else
          // already transitioned the row to a terminal state.
          let failedRow = null;
          try {
            failedRow = submissions.markFailed(id, {
              reason: 'duplicate_governance_hash',
              detail:
                'The on-chain governance object with this hash is ' +
                'already tracked by another submission row. ' +
                'Collateral has been consumed on-chain; the original ' +
                'row carries the live status.',
            });
          } catch (markErr) {
            // status_terminal is the only expected throw — yet
            // another worker won the race to terminal. Safe to
            // ignore; no side effects owed by us.
            log('warn', 'markFailed_after_hash_clash_threw', {
              id,
              code: markErr && markErr.code,
              msg: String((markErr && markErr.message) || markErr),
            });
          }
          if (failedRow) {
            log('warn', 'failed_duplicate_governance_hash', { id });
            await fireHook('onFailed', onFailed, { submission: failedRow });
          }
        }
        // A null submittedRow + !clashed here means the CAS UPDATE
        // matched zero rows — another dispatcher worker already
        // promoted this row via the same duplicate path. No log
        // is emitted because the competing branches above handle
        // both failure modes (throws and CAS-miss null)
        // symmetrically: neither fires onSubmitted, and a
        // persistent race would surface through either the
        // already-exists branch repeating or the winner's
        // 'submitted' log. (Codex round 5 P1.)
      } else {
        // Transient (network, node restart). Leave the row as-is and
        // retry next tick.
        log('info', 'submit_transient_error', {
          id,
          msg: String((err && err.message) || err),
        });
      }
      return;
    }

    // Core returns the hash as a 64-char hex string. Normalize and
    // verify — an unexpected shape is a bug we'd rather loud-fail on
    // than silently persist.
    const hashStr =
      typeof govHash === 'string'
        ? govHash.toLowerCase().trim()
        : '';
    if (!/^[0-9a-f]{64}$/.test(hashStr)) {
      log('error', 'gObject_submit_bad_response', {
        id,
        raw: typeof govHash === 'string' ? govHash : JSON.stringify(govHash),
      });
      return;
    }

    // 4. Flip status → submitted. Even this can race with a concurrent
    //    tick or an operator running the same dispatcher twice; the
    //    repo's compare-and-swap (Codex round 5 P1) turns the race
    //    into a silent null return — the losing worker must NOT log
    //    "submitted" or fire onSubmitted, because the winning worker
    //    already did. Treat null the same as a throw: observability
    //    only, no side effects.
    let submittedRow = null;
    let raceAlreadyLogged = false;
    try {
      submittedRow = submissions.markSubmitted(id, {
        governanceHash: hashStr,
      });
    } catch (err) {
      // status_not_awaiting: someone else moved the row ahead of us.
      // governance_hash_clash: we computed the same hash again for
      // the same row (safe; the UNIQUE index prevents a second row).
      log('warn', 'markSubmitted_raced', {
        id,
        code: err && err.code,
        msg: String(err && err.message),
      });
      raceAlreadyLogged = true;
    }
    if (submittedRow) {
      log('info', 'submitted', { id, governanceHash: hashStr });
      await fireHook('onSubmitted', onSubmitted, { submission: submittedRow });
    } else if (!raceAlreadyLogged) {
      // CAS miss (Codex round 5 P1): another worker raced us and
      // already promoted the row between our pre-read status check
      // and the UPDATE. markSubmitted returned null instead of
      // throwing. Log so the race is visible but do NOT emit another
      // submitted-side effect — the winner already did.
      log('warn', 'markSubmitted_raced', {
        id,
        code: 'cas_miss',
        msg: 'row transitioned out of awaiting_collateral before UPDATE',
      });
    }
  }

  async function tick() {
    let rows;
    try {
      rows = submissions.listByStatus('awaiting_collateral');
    } catch (err) {
      log('error', 'listByStatus_failed', {
        msg: String(err && err.message),
      });
      return { advanced: 0, failed: 0 };
    }
    let advanced = 0;
    let failed = 0;
    for (const row of rows) {
      const before = row.status;
      try {
        await advance(row);
      } catch (err) {
        failed += 1;
        log('error', 'advance_threw', {
          id: row.id,
          msg: String(err && err.message),
        });
        continue;
      }
      // Re-read to count real transitions.
      const after = submissions.getById(row.id);
      if (after && after.status !== before) advanced += 1;
    }
    return { advanced, failed, scanned: rows.length };
  }

  return { tick, REQUIRED_CONFS: requiredConfs };
}

module.exports = {
  createProposalDispatcher,
  REQUIRED_CONFS,
  DEFAULT_TIMEOUT_MS,
  TERMINAL_CORE_ERRORS,
};
