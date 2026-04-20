const crypto = require('crypto');

// Vault repo.
//
// Storage contract (server is blind to contents):
// - `saltV`: 32 hex bytes of randomness, issued on first write. Feeds the
//   client's HKDF for vaultKey derivation so a password change rotates the
//   effective key material independent of the user's password.
// - `blob`: opaque ciphertext + IV + auth tag, base64url, bounded in size.
// - `etag`: SHA-256 of the blob. Clients send this as If-Match on PUT to
//   detect concurrent writes (e.g. two tabs). First write has etag '*'.
//
// Lazy creation: no vault row exists until the first PUT succeeds. GET on a
// user without a vault returns `null` so the client can display the empty
// "no keys imported yet" state.

const MAX_BLOB_BYTES = 256 * 1024; // 256 KiB, plenty for hundreds of MN keys

function etagFor(blob) {
  return crypto.createHash('sha256').update(blob, 'utf8').digest('hex');
}

function createVaultsRepo(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());

  const upsert = db.prepare(
    `INSERT INTO vaults (user_id, salt_v, blob, etag, updated_at)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       blob = excluded.blob,
       etag = excluded.etag,
       updated_at = excluded.updated_at`
  );
  const selectByUser = db.prepare(
    `SELECT salt_v AS saltV, blob, etag, updated_at AS updatedAt
     FROM vaults WHERE user_id = ?`
  );

  function get(userId) {
    return selectByUser.get(userId) || null;
  }

  function put(userId, { blob, ifMatch }) {
    if (typeof blob !== 'string') {
      const e = new Error('invalid_blob');
      e.code = 'invalid_blob';
      throw e;
    }
    if (blob.length === 0) {
      const e = new Error('invalid_blob');
      e.code = 'invalid_blob';
      throw e;
    }
    if (Buffer.byteLength(blob, 'utf8') > MAX_BLOB_BYTES) {
      const e = new Error('blob_too_large');
      e.code = 'blob_too_large';
      throw e;
    }

    const existing = selectByUser.get(userId);

    if (!existing) {
      // First write. Accept either '*' (explicit "no existing") or undefined.
      if (ifMatch && ifMatch !== '*') {
        const e = new Error('etag_mismatch');
        e.code = 'etag_mismatch';
        throw e;
      }
      const saltV = crypto.randomBytes(32).toString('hex');
      const etag = etagFor(blob);
      upsert.run(userId, saltV, blob, etag, now());
      return { saltV, etag };
    }

    if (!ifMatch) {
      const e = new Error('etag_required');
      e.code = 'etag_required';
      throw e;
    }
    // Once a vault row exists, the ETag contract is non-negotiable: clients
    // must echo the exact etag they last observed. Accepting `*` here would
    // let a stale or buggy client clobber newer data without detecting the
    // conflict, defeating the advertised optimistic-concurrency guarantee.
    // `*` is only meaningful on the very first write (handled above).
    if (ifMatch === '*' || ifMatch !== existing.etag) {
      const e = new Error('etag_mismatch');
      e.code = 'etag_mismatch';
      throw e;
    }
    const etag = etagFor(blob);
    upsert.run(userId, existing.saltV, blob, etag, now());
    return { saltV: existing.saltV, etag };
  }

  return { get, put, MAX_BLOB_BYTES };
}

module.exports = { createVaultsRepo, etagFor, MAX_BLOB_BYTES };
