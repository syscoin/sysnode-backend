const express = require('express');

const {
  validateLookupBody,
  validateVoteBody,
  lookupMatches,
  relayVotes,
} = require('../lib/gov');

const HEX64 = /^[0-9a-f]{64}$/i;

// Freshness window for GET /gov/receipts. If every receipt for a
// proposal is already {confirmed} AND verified_at is within this
// window, we skip the `gobject_getcurrentvotes` RPC entirely and
// return the stored rows. The window matches the default
// currentVotes cache TTL so both layers decay together — keeping
// them in lock-step avoids a confusing "cache says fresh, receipts
// say stale" race. Callers that want stricter freshness can force
// a reconcile with `?refresh=1`.
const DEFAULT_RECEIPTS_FRESHNESS_MS = 2 * 60 * 1000;

// Governance HTTP surface.
//
//   POST /gov/mns/lookup  -> { matches: [{ votingaddress, proTxHash,
//                                          collateralHash, collateralIndex,
//                                          status, address, payee }, ...] }
//   POST /gov/vote        -> { accepted, rejected, results: [{
//                                   collateralHash, collateralIndex,
//                                   ok, error? }, ...] }
//
// Both endpoints are authenticated + CSRF-protected. /gov/vote
// additionally sits behind a per-user rate limiter. The signing
// happens client-side (voteSigner.js); we never see the WIF and we
// never generate signatures ourselves.
//
// Injectables (for testability):
//   - masternodesProvider: () => Array of enriched MN objects from
//     services/masternodeTracker. Called fresh on each request so the
//     tracker's 10s refresh is visible without our needing to import
//     the dataStore module directly (the production wiring just
//     returns `require('../data/dataStore').masternodesArr`, i.e.
//     reads the LIVE property that the tracker reassigns — avoid
//     destructuring the array into a stale reference).
//   - voteRaw: (collHash, collIdx, govHash, signal, outcome, time, sigB64)
//              => Promise<string>. Production passes the syscoin-js
//              wrapper; tests pass a mock.
//   - receipts: (optional) vote-receipts repo (see lib/voteReceipts).
//               When present, /gov/vote short-circuits already-on-chain
//               or recently-relayed entries and persists a receipt for
//               every real relay attempt (success or failure). When
//               absent, the route degrades gracefully to the PR5
//               fire-and-forget behaviour — useful for tests that
//               don't exercise the receipts layer.
//   - getCurrentVotes: (optional) (proposalHash) => Promise<Array> of
//               parsed on-chain vote entries (see lib/voteReceipts).
//               Production passes the `createCurrentVotesCache` getter
//               so concurrent reconciliation requests share one RPC.
//               GET /gov/receipts uses this to reconcile before
//               returning; when absent the route returns stored
//               receipts without a reconcile (reconciled:false in the
//               response payload so the UI knows the rows may be
//               stale).
//   - receiptsFreshnessMs: skip-reconcile window for GET /gov/receipts.
//               Defaults to 2 minutes and normally should not be
//               overridden outside tests.
//   - nowMs: injectable clock for deterministic time-window tests.
//   - voteLimiter: an express-rate-limit middleware (or a no-op in
//                  tests). Mounted only on POST /gov/vote.

function createGovRouter({
  masternodesProvider,
  voteRaw,
  sessionMw,
  csrfMw,
  receipts = null,
  getCurrentVotes = null,
  invalidateCurrentVotes = null,
  receiptsFreshnessMs = DEFAULT_RECEIPTS_FRESHNESS_MS,
  voteLimiter = (_req, _res, next) => next(),
  nowMs = () => Date.now(),
}) {
  if (typeof masternodesProvider !== 'function') {
    throw new Error('createGovRouter: masternodesProvider is required');
  }
  if (typeof voteRaw !== 'function') {
    throw new Error('createGovRouter: voteRaw is required');
  }
  if (!sessionMw || typeof sessionMw.requireAuth !== 'function') {
    throw new Error('createGovRouter: sessionMw is required');
  }
  if (!csrfMw || typeof csrfMw.require !== 'function') {
    throw new Error('createGovRouter: csrfMw is required');
  }

  const router = express.Router();

  // -------------------------------------------------------------------
  // POST /gov/mns/lookup
  //
  // Input : { votingAddresses: string[] }
  // Output: { matches: [...] }
  //
  // Semantics: "given these addresses, which of them correspond to a
  // currently-known, usable masternode?". Typos / unknown addresses
  // are silently dropped (200 OK with fewer results) rather than
  // 400'd, because the frontend pipes in every address from the
  // user's vault and a bad one there isn't a request-shape bug.
  // -------------------------------------------------------------------
  router.post(
    '/mns/lookup',
    sessionMw.requireAuth,
    csrfMw.require,
    (req, res) => {
      const parsed = validateLookupBody(req.body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const mnArr = masternodesProvider() || [];
      const matches = lookupMatches(mnArr, parsed.votingAddresses);
      return res.json({ matches });
    }
  );

  // -------------------------------------------------------------------
  // POST /gov/vote
  //
  // Input: {
  //   proposalHash: 64-hex,
  //   voteOutcome:  "yes" | "no" | "abstain",
  //   voteSignal:   "funding",                // PR 5 scope
  //   time:         unix-seconds,
  //   entries: [{
  //     collateralHash:  64-hex,
  //     collateralIndex: uint,
  //     voteSig:         base64(65 bytes)     // client-signed
  //   }, ...]
  // }
  //
  // Output: 200 { accepted, rejected, results: [...] } — returns 200
  // even if SOME entries failed, because the normal case with many MNs
  // is "most succeeded, one got an expected-and-recoverable error"
  // (e.g. vote_too_often). Per-entry {ok, error} lets the UI render a
  // mixed outcome without us picking a single HTTP status that'd
  // misrepresent it.
  //
  // Rejections before fan-out (validation, rate limit, auth) DO use
  // 4xx because those are request-shape problems, not chain-level
  // outcomes.
  // -------------------------------------------------------------------
  router.post(
    '/vote',
    sessionMw.requireAuth,
    csrfMw.require,
    voteLimiter,
    async (req, res) => {
      const parsed = validateVoteBody(req.body, { nowMs: nowMs() });
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      try {
        const out = await relayVotes(voteRaw, parsed, {
          receipts,
          userId: req.user && req.user.id,
        });
        // Invalidate the cached gobject_getcurrentvotes snapshot for
        // this proposal so the next /gov/receipts read observes the
        // votes we just relayed (or the chain state that followed
        // a vote change). Without this, the reconciler could keep
        // reading a pre-relay snapshot for up to TTL and either
        // delay the 'relayed'→'confirmed' transition or, on a
        // vote change, re-confirm the old outcome that is still
        // present in the stale snapshot. Invalidate regardless of
        // per-entry outcome: skip results didn't hit the chain
        // but other entries in the same batch likely did, and the
        // cost of a single cache drop is negligible.
        if (typeof invalidateCurrentVotes === 'function') {
          try {
            invalidateCurrentVotes(parsed.proposalHash);
          } catch (cacheErr) {
            // Never let a cache-eviction issue fail the user's
            // vote submission.
            // eslint-disable-next-line no-console
            console.warn(
              '[POST /gov/vote] invalidateCurrentVotes threw',
              cacheErr && cacheErr.message
            );
          }
        }
        return res.json(out);
      } catch (err) {
        // relayVotes only rejects on wiring bugs (no voteRaw passed).
        // A real RPC failure on an individual entry is surfaced in
        // results[i].error, not as an exception. So any throw here is
        // a 500-class problem.
        // eslint-disable-next-line no-console
        console.error('[POST /gov/vote] unexpected', err);
        return res.status(500).json({ error: 'internal' });
      }
    }
  );

  // -------------------------------------------------------------------
  // GET /gov/receipts?proposalHash=<64-hex>
  //
  // PURE READ — returns the user's stored receipts for the proposal.
  // No RPC, no reconciliation, no DB writes.
  //
  // The original implementation of this route also ran
  // `reconcileForProposal` (which performs DB writes + may issue
  // `gobject_getcurrentvotes`), but that made a CSRF-exempt GET
  // state-changing: a cross-site top-level navigation or <img> tag
  // against an authenticated user would silently trigger RPC traffic
  // and `verified_at` / status bookkeeping writes. Reconciliation
  // only ever converges to authoritative chain state so the impact
  // is bounded (the attacker can't flip your vote), but it still
  // violates the "GET = side-effect-free" trust model the rest of
  // the API relies on.
  //
  // Reconciliation now lives on POST /gov/receipts/reconcile, which
  // goes through the same CSRF double-submit protection as
  // /gov/vote. This GET stays safe to call from anywhere and the
  // UI calls POST explicitly when it wants fresh chain state.
  //
  // Response shape (stable across the split):
  //   { receipts: [...], reconciled: false }
  //
  // `reconciled` stays in the payload for backward compatibility
  // and is always `false` on GET — it's the POST /reconcile route's
  // job to set `true`.
  // -------------------------------------------------------------------
  router.get(
    '/receipts',
    sessionMw.requireAuth,
    (req, res) => {
      if (!receipts) {
        // Route was mounted without the receipts repo — in the
        // degraded PR5 wiring there's nothing to return. Surface
        // that as an empty list rather than a 500 so the UI can
        // render its "no data" state without special-casing.
        return res.json({ receipts: [], reconciled: false });
      }
      const proposalHash = (req.query && req.query.proposalHash) || '';
      if (typeof proposalHash !== 'string' || !HEX64.test(proposalHash)) {
        return res.status(400).json({ error: 'invalid_proposal_hash' });
      }
      const userId = req.user && req.user.id;
      const propLower = proposalHash.toLowerCase();
      try {
        const stored = receipts.listForProposal(userId, propLower);
        return res.json({ receipts: stored, reconciled: false });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[GET /gov/receipts] listForProposal failed', err);
        return res.status(500).json({ error: 'internal' });
      }
    }
  );

  // -------------------------------------------------------------------
  // POST /gov/receipts/reconcile
  //
  // Reconciles the user's stored receipts for a proposal against
  // `gobject_getcurrentvotes`. State-changing (may update receipt
  // `status` + `verified_at`), so CSRF-protected and rate-limited
  // via the same session/CSRF model as /gov/vote.
  //
  // Body: { proposalHash: 64-hex, refresh?: boolean }
  //
  // Response shape:
  //   { receipts: [...], reconciled: boolean, updated?: number,
  //     reconcileError?: 'rpc_failed' | 'reconcile_failed' }
  //
  // `reconciled: true` means we observed current on-chain state
  // this request (either via RPC or via the per-process cache).
  // `reconciled: false` means we short-circuited on the freshness
  // window (`verified_at` of every row is inside
  // receiptsFreshnessMs AND every row is 'confirmed') or the route
  // was mounted without `getCurrentVotes`. `refresh: true` forces a
  // reconcile regardless of freshness.
  //
  // `reconcileError` is only set if reconciliation was ATTEMPTED and
  // failed (RPC outage / shape mismatch). In that case we still
  // respond 200 with the pre-reconcile receipts so the UI can
  // render the rows it has and surface a soft warning instead of
  // blocking the user on a transient node issue.
  // -------------------------------------------------------------------
  router.post(
    '/receipts/reconcile',
    sessionMw.requireAuth,
    csrfMw.require,
    async (req, res) => {
      if (!receipts) {
        return res.json({ receipts: [], reconciled: false });
      }
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const proposalHash = typeof body.proposalHash === 'string'
        ? body.proposalHash
        : '';
      if (!HEX64.test(proposalHash)) {
        return res.status(400).json({ error: 'invalid_proposal_hash' });
      }
      const refresh = body.refresh === true;
      const userId = req.user && req.user.id;
      const propLower = proposalHash.toLowerCase();

      let stored;
      try {
        stored = receipts.listForProposal(userId, propLower);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          '[POST /gov/receipts/reconcile] listForProposal failed',
          err
        );
        return res.status(500).json({ error: 'internal' });
      }
      if (stored.length === 0) {
        return res.json({ receipts: [], reconciled: false });
      }

      const t = nowMs();
      // See the previous iteration of this route for the detailed
      // rationale: freshness requires NON-NEGATIVE age so a
      // future-stamped verified_at (host clock skew then correction)
      // doesn't pin rows as fresh indefinitely.
      const allFresh =
        !refresh &&
        stored.every((r) => {
          if (r.status !== 'confirmed') return false;
          if (!Number.isInteger(r.verifiedAt)) return false;
          const age = t - r.verifiedAt;
          return age >= 0 && age < receiptsFreshnessMs;
        });
      if (allFresh || typeof getCurrentVotes !== 'function') {
        return res.json({ receipts: stored, reconciled: false });
      }

      try {
        const out = await receipts.reconcileForProposal({
          userId,
          proposalHash: propLower,
          getCurrentVotes,
        });
        return res.json({
          receipts: out.receipts,
          reconciled: true,
          updated: out.updated,
        });
      } catch (err) {
        const code = err && err.message === 'reconcile_rpc_failed'
          ? 'rpc_failed'
          : 'reconcile_failed';
        // eslint-disable-next-line no-console
        console.warn(
          `[POST /gov/receipts/reconcile] reconcile ${code}`,
          err && err.message
        );
        return res.json({
          receipts: stored,
          reconciled: false,
          reconcileError: code,
        });
      }
    }
  );

  // -------------------------------------------------------------------
  // GET /gov/receipts/summary
  //
  // Returns a compact rollup across every proposal the user has any
  // receipt for. Pure SELECT — no RPC, no reconciliation. Callers
  // that need up-to-date confirmed counts should hit GET
  // /gov/receipts for the specific proposal first (which will
  // reconcile) before reading the summary.
  //
  // Response shape:
  //   { summary: [{ proposalHash, total, relayed, confirmed, stale,
  //                 failed, confirmedYes, confirmedNo, confirmedAbstain,
  //                 latestSubmittedAt, latestVerifiedAt }, ...] }
  //
  // Designed to be cheap enough to call on every Governance page load
  // — a single grouped query over the user's receipts.
  // -------------------------------------------------------------------
  router.get(
    '/receipts/summary',
    sessionMw.requireAuth,
    (req, res) => {
      if (!receipts) {
        return res.json({ summary: [] });
      }
      const userId = req.user && req.user.id;
      const summary = receipts.summaryForUser(userId);
      return res.json({ summary });
    }
  );

  // -------------------------------------------------------------------
  // GET /gov/receipts/recent?limit=<1..50>
  //
  // Returns the user's most recent receipts across ALL proposals,
  // ordered by submitted_at DESC. Drives the "Your activity" card on
  // the authenticated Governance page.
  //
  // PURE READ — no RPC, no reconciliation. The rows reflect whatever
  // the reconciler last wrote; the UI is expected to pair each entry
  // with its proposal from the governance feed to render titles.
  //
  // The `limit` query param is clamped to [1, 50]. The backing helper
  // caps at 100 as a hard ceiling, but we expose a tighter limit at
  // the route layer because the UI's card is intentionally small and
  // larger limits would only inflate payload size without use.
  //
  // Response shape:
  //   { receipts: [{ id, proposalHash, collateralHash, collateralIndex,
  //                  voteOutcome, voteSignal, voteTime, status,
  //                  lastError, submittedAt, verifiedAt }, ...] }
  // -------------------------------------------------------------------
  router.get(
    '/receipts/recent',
    sessionMw.requireAuth,
    (req, res) => {
      if (!receipts) {
        return res.json({ receipts: [] });
      }
      const rawLimit = req.query && req.query.limit;
      let limit = 10;
      if (typeof rawLimit === 'string' && rawLimit.length > 0) {
        // Strict digits-only validation: Number.parseInt would
        // happily accept "2abc" → 2, "1.5" → 1, "1e3" → 1, and
        // silently mask client bugs. The route contract promises
        // an integer in [1, 50] and that's what we enforce here.
        if (!/^\d+$/.test(rawLimit)) {
          return res.status(400).json({ error: 'invalid_limit' });
        }
        const parsed = Number(rawLimit);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          return res.status(400).json({ error: 'invalid_limit' });
        }
        limit = Math.min(parsed, 50);
      }
      const userId = req.user && req.user.id;
      try {
        const rows = receipts.listRecent(userId, limit);
        return res.json({ receipts: rows });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[GET /gov/receipts/recent] listRecent failed', err);
        return res.status(500).json({ error: 'internal' });
      }
    }
  );

  return router;
}

module.exports = { createGovRouter };
