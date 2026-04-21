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
const TERMINAL_CORE_ERRORS = [
  /rate limit/i,
  /invalid/i,
  /Object submission rejected/i,
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
        // chain, but we don't yet have its hash locally (likely a
        // crash between gObject_submit succeeding and markSubmitted
        // persisting, or a second dispatcher/operator submitted it).
        // Leaving the row as-is lets us retry and, on the next tick,
        // compute the same hash and flip to `submitted` via the
        // existing governance_hash_clash path in the status handler.
        // Do NOT flip to failed — that would send a false failure
        // email for a successfully-published proposal.
        log('warn', 'submit_already_exists', {
          id,
          msg: String((err && err.message) || err),
        });
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
    //    repo's status-machine check turns a race into a no-op error.
    let submittedRow = null;
    try {
      submittedRow = submissions.markSubmitted(id, {
        governanceHash: hashStr,
      });
      log('info', 'submitted', { id, governanceHash: hashStr });
    } catch (err) {
      // status_not_awaiting: someone else moved the row ahead of us.
      // governance_hash_clash: we computed the same hash again for
      // the same row (safe; the UNIQUE index prevents a second row).
      log('warn', 'markSubmitted_raced', {
        id,
        code: err && err.code,
        msg: String(err && err.message),
      });
    }
    if (submittedRow) {
      await fireHook('onSubmitted', onSubmitted, { submission: submittedRow });
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
