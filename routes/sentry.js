'use strict';
const express = require('express');
function createSentryRouter({ management, sessionMw, csrfMw, limiter, readLimiter, votingContextLimiter = (_req, _res, next) => next(), frontendUrl }) {
  const router = express.Router();
  const route = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (error) { res.status(error.status || 502).json({ error: error.code || 'sentry_unavailable' }); }
  };
  if (readLimiter) router.use(readLimiter);
  router.get('/capabilities', route(() => management.capabilities()));
  router.get('/context', route((req) => management.context(req.query.network, req.query.proTxHash,
    req.query.collateralTxid ? { txid: req.query.collateralTxid, vout: Number(req.query.collateralVout) } : undefined)));
  router.get('/voting-context', votingContextLimiter, route((req) => management.votingContext(req.query)));
  // The public context is read-only. Every management route requires a
  // verified session. State-changing calls additionally bind the exact origin.
  router.use(sessionMw.requireAuth);
  router.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('Origin') !== new URL(frontendUrl).origin) return res.status(403).json({ error: 'origin_mismatch' });
    return csrfMw.require(req, res, next);
  });
  if (limiter) router.use(limiter);
  router.get('/nodes', route((req) => management.watches(req.user.id)));
  router.post('/nodes', route((req) => management.watch(req.user.id, req.body)));
  router.delete('/nodes/:network/:proTxHash', route((req) => {
    management.unwatch(req.user.id, req.params.network, req.params.proTxHash); return { ok: true };
  }));
  router.get('/operations', route((req) => management.operations(req.user.id)));
  router.post('/operations', route((req) => management.prepare(req.user.id, req.body)));
  router.post('/operations/:id/authorize', route((req) => management.authorize(req.user.id, req.params.id, req.body)));
  router.post('/operations/:id/submit', route((req) => management.submit(req.user.id, req.params.id, req.body)));
  router.post('/operations/:id/retry', route((req) => management.retry(req.user.id, req.params.id, req.body)));
  router.get('/operations/:id', route((req) => management.reconcile(req.user.id, req.params.id)));
  return router;
}
module.exports = { createSentryRouter };
