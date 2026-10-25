'use strict';

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { getPool } = require('../lib/privacyRegistry');

const PRIVACY_PREFIX = '/api/privacy/v1';
function createPrivacyRouter({ index = null, limiter } = {}) {
  const router = express.Router();
  router.use(cors({ origin: '*', credentials: false, exposedHeaders: ['ETag', 'X-Privacy-Index-State', 'Retry-After'] }));
  router.use(limiter || rateLimit({ windowMs: 60000, limit: 60,
    keyGenerator: (req) => ipKeyGenerator(req.ip || ''), standardHeaders: true, legacyHeaders: false,
    message: { error: 'too_many_privacy_requests' } }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'privacy_read_only' });
    if (req.url.includes('?') || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0 ||
        (req.body && Object.keys(req.body).length)) return res.status(400).json({ error: 'privacy_request_parameters_not_allowed' });
    next();
  });
  router.get('/pools/:poolId/snapshot', async (req, res) => {
    if (!getPool(req.params.poolId)) return res.status(404).json({ error: 'unknown_privacy_pool' });
    if (!index) return res.status(503).json({ error: 'privacy_index_disabled' });
    try {
      const result = await index.read(req.params.poolId);
      if (result.status === 200) {
        res.set('Cache-Control', 'public, max-age=0, must-revalidate');
        res.set('ETag', result.etag);
        res.set('X-Privacy-Index-State', result.phase);
        if (req.fresh) return res.status(304).end();
        return res.status(200).type('json').send(result.encoded);
      }
      res.set('Retry-After', result.status === 202 ? '2' : '30');
      return res.status(result.status).json(result.body);
    } catch (_) { return res.status(503).json({ error: 'privacy_index_unavailable' }); }
  });
  router.use((_req, res) => res.status(404).json({ error: 'unknown_privacy_route' }));
  return router;
}
module.exports = { PRIVACY_PREFIX, createPrivacyRouter };
