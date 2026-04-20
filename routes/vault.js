const express = require('express');
const { z } = require('zod');

// Vault HTTP interface.
//
//   GET  /vault                -> { saltV, blob, etag } or { empty: true }
//   PUT  /vault  If-Match: <e> -> { saltV, etag }        (first write: *)
//
// The server is blind to contents. All it does is store-and-return the blob
// alongside the per-user saltV that the client uses (with its master key) to
// derive vaultKey for AES-GCM.

const PutSchema = z.object({
  blob: z.string().min(1),
});

function createVaultRouter({ vaults, sessionMw, csrfMw }) {
  const router = express.Router();

  router.get('/', sessionMw.requireAuth, (req, res) => {
    const row = vaults.get(req.user.id);
    if (!row) return res.json({ empty: true });
    res.set('ETag', row.etag);
    return res.json({
      saltV: row.saltV,
      blob: row.blob,
      etag: row.etag,
      updatedAt: row.updatedAt,
    });
  });

  router.put('/', sessionMw.requireAuth, csrfMw.require, (req, res) => {
    const parsed = PutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
    const ifMatch = req.get('If-Match') || undefined;
    try {
      const out = vaults.put(req.user.id, {
        blob: parsed.data.blob,
        ifMatch,
      });
      res.set('ETag', out.etag);
      return res.json(out);
    } catch (err) {
      if (err.code === 'etag_required') {
        return res.status(428).json({ error: 'if_match_required' });
      }
      if (err.code === 'etag_mismatch') {
        return res.status(412).json({ error: 'precondition_failed' });
      }
      if (err.code === 'blob_too_large') {
        return res.status(413).json({ error: 'payload_too_large' });
      }
      if (err.code === 'invalid_blob') {
        return res.status(400).json({ error: 'invalid_blob' });
      }
      // eslint-disable-next-line no-console
      console.error('[vault PUT]', err);
      return res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}

module.exports = { createVaultRouter };
