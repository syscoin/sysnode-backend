const express = require('express');

const {
  validateLookupBody,
  validateVoteBody,
  lookupMatches,
  relayVotes,
} = require('../lib/gov');

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
//   - nowMs: injectable clock for deterministic time-window tests.
//   - voteLimiter: an express-rate-limit middleware (or a no-op in
//                  tests). Mounted only on POST /gov/vote.

function createGovRouter({
  masternodesProvider,
  voteRaw,
  sessionMw,
  csrfMw,
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
        const out = await relayVotes(voteRaw, parsed);
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

  return router;
}

module.exports = { createGovRouter };
