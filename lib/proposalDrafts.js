'use strict';

// proposal_drafts repository.
//
// Drafts are plaintext, per-user, and meant to survive across devices
// and sessions — the user taps "Save to drafts" on their phone and
// opens the wizard again from their laptop with the content intact.
// We store what the user typed, not the canonical form; canonicalization
// happens at "prepare" time (see proposalValidate.canonicalize).
//
// BigInt handling: payment_amount_sats is returned as a JavaScript
// BigInt so callers can't silently lose precision for large amounts.
// On write, we accept number | bigint | decimal-string and coerce via
// BigInt(). Callers that need to serialize to JSON convert with
// .toString() since JSON.stringify can't handle BigInt natively.

const VALID_PATCH_KEYS = [
  'title',
  'name',
  'url',
  'description',
  'payment_address',
  'payment_amount_sats',
  'payment_count',
  'start_epoch',
  'end_epoch',
];

function toBigIntSats(v) {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error('payment_amount_sats must be an integer');
    }
    return BigInt(v);
  }
  if (typeof v === 'string') {
    if (!/^-?\d+$/.test(v)) {
      throw new Error('payment_amount_sats string must be digits');
    }
    return BigInt(v);
  }
  throw new Error('payment_amount_sats must be number | bigint | string');
}

// Shape returned to callers. All integer columns are normalized:
//   ids / timestamps / payment_count   → Number   (fits easily in 2^53)
//   payment_amount_sats                → BigInt   (can legitimately exceed)
//   start/end epoch                    → Number | null
function mapRow(row) {
  if (!row) return null;
  const amount = row.payment_amount_sats;
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    title: row.title,
    name: row.name,
    url: row.url,
    description: row.description,
    paymentAddress: row.payment_address,
    // Coerce to BigInt defensively; better-sqlite3 may return Number or
    // BigInt depending on whether .safeIntegers() is enabled.
    paymentAmountSats:
      typeof amount === 'bigint' ? amount : BigInt(amount ?? 0),
    paymentCount: Number(row.payment_count),
    startEpoch: row.start_epoch == null ? null : Number(row.start_epoch),
    endEpoch: row.end_epoch == null ? null : Number(row.end_epoch),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function createProposalDraftsRepo(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());

  // Enable BigInt mode on the prepared statements that touch
  // payment_amount_sats, so reads preserve precision past 2^53.
  const insert = db
    .prepare(
      `INSERT INTO proposal_drafts (
         user_id, title, name, url, description,
         payment_address, payment_amount_sats, payment_count,
         start_epoch, end_epoch,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .safeIntegers(true);

  const byIdForUser = db
    .prepare(
      `SELECT * FROM proposal_drafts WHERE id = ? AND user_id = ?`
    )
    .safeIntegers(true);

  const listForUserStmt = db
    .prepare(
      `SELECT * FROM proposal_drafts
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC`
    )
    .safeIntegers(true);

  const countForUserStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM proposal_drafts WHERE user_id = ?`
  );

  const deleteForUserStmt = db.prepare(
    `DELETE FROM proposal_drafts WHERE id = ? AND user_id = ?`
  );

  function create(userId, patch = {}) {
    const t = now();
    const p = patch || {};
    const r = insert.run(
      userId,
      String(p.title ?? ''),
      String(p.name ?? ''),
      String(p.url ?? ''),
      String(p.description ?? ''),
      String(p.payment_address ?? ''),
      toBigIntSats(p.payment_amount_sats),
      Number.isFinite(Number(p.payment_count))
        ? Math.trunc(Number(p.payment_count))
        : 1,
      p.start_epoch == null ? null : Math.trunc(Number(p.start_epoch)),
      p.end_epoch == null ? null : Math.trunc(Number(p.end_epoch)),
      t,
      t
    );
    return mapRow(byIdForUser.get(r.lastInsertRowid, userId));
  }

  function getByIdForUser(id, userId) {
    return mapRow(byIdForUser.get(id, userId));
  }

  function listForUser(userId) {
    return listForUserStmt.all(userId).map(mapRow);
  }

  function countForUser(userId) {
    const { c } = countForUserStmt.get(userId);
    return Number(c);
  }

  // Partial update: only the fields present in the patch are touched.
  // An update on a row the user does not own returns null (so callers
  // can 404 without a separate existence check).
  function update(id, userId, patch = {}) {
    const existing = byIdForUser.get(id, userId);
    if (!existing) return null;
    const sets = [];
    const values = [];
    for (const key of VALID_PATCH_KEYS) {
      if (!(key in patch)) continue;
      const val = patch[key];
      if (key === 'payment_amount_sats') {
        sets.push('payment_amount_sats = ?');
        values.push(toBigIntSats(val));
      } else if (key === 'payment_count') {
        sets.push('payment_count = ?');
        values.push(
          Number.isFinite(Number(val)) ? Math.trunc(Number(val)) : 1
        );
      } else if (key === 'start_epoch' || key === 'end_epoch') {
        sets.push(`${key} = ?`);
        values.push(val == null ? null : Math.trunc(Number(val)));
      } else {
        // All other updatable columns are strings.
        sets.push(`${key} = ?`);
        values.push(String(val ?? ''));
      }
    }
    if (sets.length === 0) {
      // No-op update: still bump updated_at so the UI knows "touched"
      // (e.g. if the user opened the draft and closed it without
      // editing, we still want it on top). Use a dedicated statement
      // since better-sqlite3 requires a non-empty set clause.
      db.prepare(
        `UPDATE proposal_drafts SET updated_at = ? WHERE id = ? AND user_id = ?`
      ).run(now(), id, userId);
      return mapRow(byIdForUser.get(id, userId));
    }
    sets.push('updated_at = ?');
    values.push(now());
    values.push(id, userId);
    db.prepare(
      `UPDATE proposal_drafts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
    ).run(...values);
    return mapRow(byIdForUser.get(id, userId));
  }

  function remove(id, userId) {
    const info = deleteForUserStmt.run(id, userId);
    return Number(info.changes);
  }

  return {
    create,
    getByIdForUser,
    listForUser,
    countForUser,
    update,
    remove,
  };
}

module.exports = {
  createProposalDraftsRepo,
  mapRow,
};
