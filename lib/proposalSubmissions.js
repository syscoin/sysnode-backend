'use strict';

// proposal_submissions repository.
//
// A submission row represents a proposal the user has committed to
// publishing. The canonical hashing fields (parent_hash, revision,
// time_unix, data_hex, proposal_hash) are FROZEN at create() time —
// the repo exposes no API to mutate them afterwards because the
// collateral OP_RETURN commits to proposal_hash; changing any
// contributing field would de-couple the on-chain collateral from
// the object we later submit, which is unrecoverable.
//
// State machine (see db/migrations/001_init.sql for prose):
//
//       create()                attachCollateral(txid)
//          │                           │
//          ▼                           ▼
//     ┌──────────┐             ┌─────────────────────┐
//     │ prepared │────────────▶│ awaiting_collateral │
//     └──────────┘             └─────────────────────┘
//          │                          │  │
//          │ remove()                 │  │ markSubmitted({ governanceHash })
//          ▼                          │  ▼
//       (deleted)                     │ ┌───────────┐
//                                     │ │ submitted │ (terminal)
//                                     │ └───────────┘
//                                     │ markFailed({ reason, detail })
//                                     ▼
//                                  ┌────────┐
//                                  │ failed │ (terminal)
//                                  └────────┘
//
// Transitions are enforced by the repo; a transition the state
// machine does not allow raises an error with a stable `.code` string
// the route layer can surface.

const STATUS = Object.freeze({
  PREPARED: 'prepared',
  AWAITING_COLLATERAL: 'awaiting_collateral',
  SUBMITTED: 'submitted',
  FAILED: 'failed',
});

const ALL_STATUSES = new Set(Object.values(STATUS));

function toBigIntSats(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error('payment_amount_sats must be an integer');
    }
    return BigInt(v);
  }
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new Error('payment_amount_sats must be number | bigint | digit-string');
}

function mapRow(row) {
  if (!row) return null;
  const amount = row.payment_amount_sats;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    draftId: row.draft_id == null ? null : Number(row.draft_id),

    parentHash: row.parent_hash,
    revision: Number(row.revision),
    timeUnix: Number(row.time_unix),
    dataHex: row.data_hex,
    proposalHash: row.proposal_hash,

    title: row.title,
    name: row.name,
    url: row.url,
    paymentAddress: row.payment_address,
    paymentAmountSats:
      typeof amount === 'bigint' ? amount : BigInt(amount ?? 0),
    paymentCount: Number(row.payment_count),
    startEpoch: Number(row.start_epoch),
    endEpoch: Number(row.end_epoch),

    status: row.status,
    collateralTxid: row.collateral_txid,
    collateralConfs: Number(row.collateral_confs),
    governanceHash: row.governance_hash,
    failReason: row.fail_reason,
    failDetail: row.fail_detail,

    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function requireString(name, v) {
  if (typeof v !== 'string' || v.length === 0) {
    throw err(`${name}_required`, `${name} is required`);
  }
  return v;
}

function createProposalSubmissionsRepo(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());

  const insert = db
    .prepare(
      `INSERT INTO proposal_submissions (
         user_id, draft_id,
         parent_hash, revision, time_unix, data_hex, proposal_hash,
         title, name, url, payment_address, payment_amount_sats,
         payment_count, start_epoch, end_epoch,
         status, collateral_txid, collateral_confs,
         governance_hash, fail_reason, fail_detail,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .safeIntegers(true);

  const byIdStmt = db
    .prepare(`SELECT * FROM proposal_submissions WHERE id = ?`)
    .safeIntegers(true);
  const byIdForUserStmt = db
    .prepare(
      `SELECT * FROM proposal_submissions WHERE id = ? AND user_id = ?`
    )
    .safeIntegers(true);
  const listForUserStmt = db
    .prepare(
      `SELECT * FROM proposal_submissions
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC`
    )
    .safeIntegers(true);
  const byStatusStmt = db
    .prepare(
      `SELECT * FROM proposal_submissions
        WHERE status = ?
        ORDER BY updated_at ASC, id ASC`
    )
    .safeIntegers(true);
  const byTxidStmt = db
    .prepare(
      `SELECT * FROM proposal_submissions WHERE collateral_txid = ?`
    )
    .safeIntegers(true);
  const byGovHashStmt = db
    .prepare(
      `SELECT * FROM proposal_submissions WHERE governance_hash = ?`
    )
    .safeIntegers(true);
  const byProposalHashForUserStmt = db
    .prepare(
      `SELECT * FROM proposal_submissions
        WHERE user_id = ? AND proposal_hash = ?`
    )
    .safeIntegers(true);
  // Codex PR8 round 2 P1: proposalHash bakes in `time` (seconds since
  // epoch), so two retries of the same logical /prepare that cross a
  // one-second boundary hash differently and bypass a hash-keyed
  // idempotency check. Look up by the time-free canonical payload
  // (data_hex) instead. Scoped to the user so two different users
  // submitting coincidentally-identical text get independent rows.
  const byPreparedDataHexForUserStmt = db
    .prepare(
      `SELECT * FROM proposal_submissions
        WHERE user_id = ? AND data_hex = ? AND status = 'prepared'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`
    )
    .safeIntegers(true);

  const deleteForUserStmt = db.prepare(
    `DELETE FROM proposal_submissions
      WHERE id = ? AND user_id = ?
        AND status IN ('prepared', 'failed')`
  );

  function create(input) {
    const {
      userId,
      draftId = null,
      parentHash = '0',
      revision = 1,
      timeUnix,
      dataHex,
      proposalHash,
      title = '',
      name,
      url,
      paymentAddress,
      paymentAmountSats,
      paymentCount = 1,
      startEpoch,
      endEpoch,
    } = input || {};

    if (!Number.isInteger(userId) || userId <= 0) {
      throw err('user_required', 'userId is required');
    }
    if (!Number.isInteger(timeUnix) || timeUnix <= 0) {
      throw err('time_required', 'timeUnix must be positive integer');
    }
    requireString('dataHex', dataHex);
    if (!/^[0-9a-f]*$/.test(dataHex) || dataHex.length % 2 !== 0) {
      throw err('data_hex_invalid', 'dataHex must be lowercase hex, even length');
    }
    requireString('proposalHash', proposalHash);
    if (!/^[0-9a-f]{64}$/.test(proposalHash)) {
      throw err('proposal_hash_invalid', 'proposalHash must be 64 lowercase hex chars');
    }
    requireString('name', name);
    requireString('url', url);
    requireString('paymentAddress', paymentAddress);
    if (!Number.isInteger(startEpoch) || !Number.isInteger(endEpoch)) {
      throw err('epoch_required', 'startEpoch/endEpoch must be integers');
    }
    const amt = toBigIntSats(paymentAmountSats);
    if (amt <= 0n) throw err('amount_invalid', 'paymentAmountSats must be > 0');

    const t = now();
    const r = insert.run(
      userId,
      draftId,
      parentHash,
      revision,
      timeUnix,
      dataHex,
      proposalHash,
      title,
      name,
      url,
      paymentAddress,
      amt,
      Math.trunc(Number(paymentCount)) || 1,
      startEpoch,
      endEpoch,
      STATUS.PREPARED,
      null, // collateral_txid
      0, // collateral_confs
      null, // governance_hash
      null, // fail_reason
      null, // fail_detail
      t,
      t
    );
    return mapRow(byIdStmt.get(r.lastInsertRowid));
  }

  function getById(id) {
    return mapRow(byIdStmt.get(id));
  }
  function getByIdForUser(id, userId) {
    return mapRow(byIdForUserStmt.get(id, userId));
  }
  function listForUser(userId) {
    return listForUserStmt.all(userId).map(mapRow);
  }
  function listByStatus(status) {
    if (!ALL_STATUSES.has(status)) {
      throw err('status_invalid', `unknown status: ${status}`);
    }
    return byStatusStmt.all(status).map(mapRow);
  }
  function findByCollateralTxid(txid) {
    if (!txid) return null;
    return mapRow(byTxidStmt.get(txid));
  }
  function findByGovernanceHash(hash) {
    if (!hash) return null;
    return mapRow(byGovHashStmt.get(hash));
  }
  function findByProposalHashForUser(userId, hash) {
    if (!hash) return null;
    return mapRow(byProposalHashForUserStmt.get(userId, hash));
  }
  function findPreparedByDataHexForUser(userId, dataHex) {
    if (!dataHex) return null;
    return mapRow(byPreparedDataHexForUserStmt.get(userId, dataHex));
  }

  // prepared → awaiting_collateral
  function attachCollateral(id, userId, txid) {
    if (typeof txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw err('txid_invalid', 'txid must be 64-char hex');
    }
    const txidLower = txid.toLowerCase();
    const existing = byIdForUserStmt.get(id, userId);
    if (!existing) return null;
    if (existing.status !== STATUS.PREPARED) {
      throw err(
        'status_not_prepared',
        `cannot attach collateral from status "${existing.status}"`
      );
    }
    // Pre-check the txid to produce a friendly error rather than a
    // raw SQLite UNIQUE message.
    const clash = byTxidStmt.get(txidLower);
    if (clash) {
      throw err(
        'txid_already_used',
        'This transaction is already associated with another proposal.'
      );
    }
    db.prepare(
      `UPDATE proposal_submissions
          SET status = ?, collateral_txid = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`
    ).run(STATUS.AWAITING_COLLATERAL, txidLower, now(), id, userId);
    return mapRow(byIdStmt.get(id));
  }

  // Dispatcher: bump confs for a row the dispatcher already identified
  // via listByStatus('awaiting_collateral'). No user scope.
  function updateConfirmations(id, confs) {
    if (!Number.isInteger(confs) || confs < 0) {
      throw err('confs_invalid', 'confs must be non-negative integer');
    }
    db.prepare(
      `UPDATE proposal_submissions
          SET collateral_confs = ?, updated_at = ?
        WHERE id = ?`
    ).run(confs, now(), id);
    return mapRow(byIdStmt.get(id));
  }

  // awaiting_collateral → submitted (dispatcher only; no user scope)
  function markSubmitted(id, { governanceHash }) {
    if (!/^[0-9a-f]{64}$/i.test(governanceHash || '')) {
      throw err(
        'governance_hash_invalid',
        'governanceHash must be 64 hex chars'
      );
    }
    const row = byIdStmt.get(id);
    if (!row) return null;
    if (row.status !== STATUS.AWAITING_COLLATERAL) {
      throw err(
        'status_not_awaiting',
        `cannot mark submitted from status "${row.status}"`
      );
    }
    const gh = governanceHash.toLowerCase();
    const clash = byGovHashStmt.get(gh);
    if (clash && Number(clash.id) !== Number(id)) {
      throw err(
        'governance_hash_clash',
        'governance_hash already recorded on another row'
      );
    }
    db.prepare(
      `UPDATE proposal_submissions
          SET status = ?, governance_hash = ?, updated_at = ?
        WHERE id = ?`
    ).run(STATUS.SUBMITTED, gh, now(), id);
    return mapRow(byIdStmt.get(id));
  }

  // Any non-terminal state → failed. Terminal states are rejected so
  // we don't accidentally overwrite a 'submitted' row with 'failed'
  // due to a flaky secondary check.
  function markFailed(id, { reason, detail }) {
    requireString('reason', reason);
    const row = byIdStmt.get(id);
    if (!row) return null;
    if (row.status === STATUS.SUBMITTED || row.status === STATUS.FAILED) {
      throw err(
        'status_terminal',
        `cannot mark failed from terminal status "${row.status}"`
      );
    }
    db.prepare(
      `UPDATE proposal_submissions
          SET status = ?, fail_reason = ?, fail_detail = ?, updated_at = ?
        WHERE id = ?`
    ).run(STATUS.FAILED, reason, detail == null ? null : String(detail), now(), id);
    return mapRow(byIdStmt.get(id));
  }

  // Users can only delete rows that have NOT been published. This
  // matches the partial DELETE statement above. Returns the number of
  // rows affected.
  function remove(id, userId) {
    const info = deleteForUserStmt.run(id, userId);
    return Number(info.changes);
  }

  return {
    STATUS,
    create,
    getById,
    getByIdForUser,
    listForUser,
    listByStatus,
    findByCollateralTxid,
    findByGovernanceHash,
    findByProposalHashForUser,
    findPreparedByDataHexForUser,
    attachCollateral,
    updateConfirmations,
    markSubmitted,
    markFailed,
    remove,
  };
}

module.exports = {
  createProposalSubmissionsRepo,
  STATUS,
  mapRow,
};
