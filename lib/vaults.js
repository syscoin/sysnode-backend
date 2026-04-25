const crypto = require('crypto');

// Vault repo.
//
// Storage contract (server is blind to contents):
// - `blob`: opaque ciphertext + IV + auth tag, base64url, bounded in size.
// - `etag`: SHA-256 of the blob. Clients send this as If-Match on PUT to
//   detect concurrent writes (e.g. two tabs). First write has etag '*'.
//
// Lazy creation: no vault row exists until the first PUT succeeds. GET on a
// user without a vault returns `null` so the client can display the empty
// "no keys imported yet" state.
//
// NOTE on saltV: historically stored on this row (migration 001). Migration
// 004 moved it to users.salt_v — it is a per-user property, not a
// per-vault property, and the client must have it in hand BEFORE the first
// PUT so it can encrypt the blob. The vault row is now blob-only.

const MAX_BLOB_BYTES = 256 * 1024; // 256 KiB, plenty for hundreds of MN keys

function etagFor(blob) {
  return crypto.createHash('sha256').update(blob, 'utf8').digest('hex');
}

function mkErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function createVaultsRepo(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());

  // Two separate statements so ETag precondition is enforced at WRITE time,
  // not only via a pre-read check. A SELECT-then-UPDATE(unconditional) lets
  // two concurrent writers with the same stale etag both pass the pre-check
  // and clobber each other. The conditional UPDATE (WHERE etag = ?) pushes
  // the precondition into the storage layer so at most one concurrent
  // writer succeeds; the others see zero-row-affected and get a 412.
  //
  // First write uses INSERT. The primary key on user_id means concurrent
  // first-writes can't both succeed — the loser trips the UNIQUE constraint
  // and we treat that as a concurrent-create race (etag_mismatch).
  const insertFirst = db.prepare(
    `INSERT INTO vaults (user_id, blob, etag, updated_at)
       VALUES (?, ?, ?, ?)`
  );
  const conditionalUpdate = db.prepare(
    `UPDATE vaults
        SET blob = ?, etag = ?, updated_at = ?
      WHERE user_id = ? AND etag = ?`
  );
  const selectByUser = db.prepare(
    `SELECT blob, etag, updated_at AS updatedAt
     FROM vaults WHERE user_id = ?`
  );

  function get(userId) {
    return selectByUser.get(userId) || null;
  }

  function put(userId, { blob, ifMatch }) {
    if (typeof blob !== 'string' || blob.length === 0) {
      throw mkErr('invalid_blob');
    }
    if (Buffer.byteLength(blob, 'utf8') > MAX_BLOB_BYTES) {
      throw mkErr('blob_too_large');
    }

    const existing = selectByUser.get(userId);

    if (!existing) {
      // First writes must be explicit too. The frontend already sends
      // If-Match: *, and requiring it keeps blind creates from silently
      // bypassing the same precondition contract as updates.
      if (!ifMatch) throw mkErr('etag_required');
      if (ifMatch !== '*') throw mkErr('etag_mismatch');
      const etag = etagFor(blob);
      try {
        insertFirst.run(userId, blob, etag, now());
      } catch (err) {
        // Concurrent first-write race: another worker inserted between
        // our SELECT and INSERT. Surface as a 412 so the client re-reads
        // and retries rather than silently accepting a lost-create.
        if (
          err &&
          (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
            err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
            err.code === 'SQLITE_CONSTRAINT')
        ) {
          throw mkErr('etag_mismatch');
        }
        throw err;
      }
      return { etag };
    }

    if (!ifMatch) throw mkErr('etag_required');
    // Wildcard is only meaningful on the very first write; once a row
    // exists, clients must echo the exact observed etag.
    if (ifMatch === '*') throw mkErr('etag_mismatch');

    const etag = etagFor(blob);
    // The WHERE etag=? clause is the atomic precondition: exactly one
    // concurrent writer with the right etag wins, the rest see 0 rows.
    const info = conditionalUpdate.run(blob, etag, now(), userId, ifMatch);
    if (info.changes === 0) throw mkErr('etag_mismatch');
    return { etag };
  }

  return { get, put, MAX_BLOB_BYTES };
}

module.exports = { createVaultsRepo, etagFor, MAX_BLOB_BYTES };
