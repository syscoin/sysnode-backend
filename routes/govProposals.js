'use strict';

// /gov/proposals — HTTP surface for the governance proposal wizard.
//
// Shape of the feature (front-to-back):
//
//   1. User opens the wizard.
//   2. User drafts content. `POST /drafts` / `PATCH /drafts/:id` persist
//      whatever they typed (title, description, name, url, amount, ...).
//      Drafts are server-side so the same user on another device picks
//      up where they left off — no banners, the drafts list on the
//      Governance page is enough.
//   3. When the user clicks "Continue → Review", the client sends the
//      full payload to `POST /prepare`. We canonicalize it, compute the
//      `proposal_hash` that the collateral OP_RETURN must commit to,
//      call `gObject_check` on the node as a pre-flight, and persist a
//      `proposal_submissions` row in `prepared` state. The response
//      gives the client everything it needs to build the 150 SYS
//      collateral PSBT (hash, amount, parent/time/revision).
//   4. The user pays the 150 SYS fee — either through Pali
//      (`sys_signAndSend` on a client-built PSBT) or manually via the
//      Syscoin-Qt console. Either path ends with the user's wallet
//      holding a txid.
//   5. The client calls `POST /submissions/:id/attach-collateral` with
//      that txid. We flip the row to `awaiting_collateral` and the
//      dispatcher takes over: it polls `getRawTransaction`, waits for
//      6 confirmations, then calls `gObject_submit`. On success the
//      row becomes `submitted` with the governance hash recorded.
//   6. The status page polls `GET /submissions/:id` during the wait;
//      the user sees a live confs counter and an ETA.
//
// Injectables (factory args):
//
//   - drafts             : proposal_drafts repo
//   - submissions        : proposal_submissions repo
//   - sessionMw          : auth middleware (exposes req.user)
//   - csrfMw             : CSRF protection
//   - rpc                : object with async methods:
//                            - gObjectCheck(dataHex)    → any
//                          (getRawTransaction / gObjectSubmit live on
//                           the dispatcher's rpc object, not here — the
//                           route layer only needs pre-flight check.)
//                          gObjectCheck is optional; when absent we
//                          skip the RPC pre-flight and fall back to
//                          structural validation only.
//   - runAtomic          : db.transaction wrapper (from appFactory) —
//                          used to atomically "create submission AND
//                          delete consumed draft" so a crash between
//                          the two can't leave an orphan draft.
//   - now                : injectable clock (ms).
//   - maxDraftsPerUser   : soft cap (default 50). Prevents a single
//                          account from squatting on hundreds of drafts.
//   - maxPaymentCount    : soft cap on the "how many monthly payments"
//                          display field (default 60 = five years).
//                          Core has NO bound on payment_count because
//                          the field isn't on-chain; we sanity-check it
//                          here so the wizard can't send "1,000,000".
//
// Error response contract (kept stable for the frontend):
//
//   400 { error: 'validation_failed', issues: [{ field, code, message }] }
//   400 { error: 'bad_request', detail?: string }
//   401 { error: 'unauthorized' }
//   403 { error: 'csrf_missing' | 'csrf_invalid' }
//   404 { error: 'not_found' }
//   409 { error: 'conflict', reason: <code> }
//   422 { error: 'core_rejected', issues: [{ field, code, message }] }
//   500 { error: 'internal' }

const express = require('express');

const proposalValidate = require('../lib/proposalValidate');
const { computeProposalHash } = require('../lib/proposalHash');

const HEX64 = /^[0-9a-f]{64}$/i;

// 150 SYS, hardcoded in Core's src/governance/governanceobject.h as
// GOVERNANCE_PROPOSAL_FEE_TX. BigInt so downstream JSON serializers
// never accidentally lose precision.
const COLLATERAL_FEE_SATS = 15000000000n;

// Kept in lock-step with lib/proposalDispatcher.REQUIRED_CONFS so the
// status page can render "x of 6 confs" without an extra round-trip
// just to learn the threshold.
const REQUIRED_CONFIRMATIONS = 6;

const DEFAULT_MAX_DRAFTS_PER_USER = 50;
const DEFAULT_MAX_PAYMENT_COUNT = 60;

// ---------------------------------------------------------------------
// Small helpers kept local — they aren't reusable across other routes
// and hoisting them out would just add indirection.
// ---------------------------------------------------------------------

// Accept a body shape with either camelCase (what the wizard sends)
// or snake_case (what the canonicalizer expects). Normalize to the
// snake_case form `proposalValidate` wants. We keep this tolerant on
// purpose: the wizard is JSON-shape-strict, but HTTP clients that
// humans might build in the future (e.g. a CLI) will naturally reach
// for snake_case — this layer hides the difference.
function readProposalFields(body) {
  const b = body || {};
  const pick = (camel, snake) => (b[camel] !== undefined ? b[camel] : b[snake]);
  return {
    title: pick('title', 'title'),
    description: pick('description', 'description'),
    name: pick('name', 'name'),
    url: pick('url', 'url'),
    paymentAddress: pick('paymentAddress', 'payment_address'),
    paymentAmountSats: pick('paymentAmountSats', 'payment_amount_sats'),
    paymentAmount: pick('paymentAmount', 'payment_amount'),
    paymentCount: pick('paymentCount', 'payment_count'),
    startEpoch: pick('startEpoch', 'start_epoch'),
    endEpoch: pick('endEpoch', 'end_epoch'),
  };
}

// Client-side payload shape for a draft. Accepts strings/numbers from
// JSON and normalizes to what proposalDrafts.create/update expect.
// BigInt payment amounts come in as either a digit-string or a SYS
// decimal; we normalize to satoshis (BigInt). payment_count is passed
// through sanity bounds so it can't be NaN, negative, or absurd.
function normalizeDraftPatch(body, maxPaymentCount) {
  const f = readProposalFields(body);
  const patch = {};
  if (f.title !== undefined) patch.title = String(f.title ?? '');
  if (f.description !== undefined) patch.description = String(f.description ?? '');
  if (f.name !== undefined) patch.name = String(f.name ?? '');
  if (f.url !== undefined) patch.url = String(f.url ?? '');
  if (f.paymentAddress !== undefined) {
    patch.payment_address = String(f.paymentAddress ?? '');
  }

  if (f.paymentAmountSats !== undefined) {
    // Codex PR8 round 5 P2: previously this path forwarded the raw
    // client value straight to the repo, which threw on malformed
    // input (`"12.5"`, `"-1"`, `"abc"`, objects, …). The route
    // catch-all rendered those throws as generic `500 internal`,
    // which looks like a server bug to the client for what is
    // actually a request-shape problem. Validate here so we surface
    // the same `400 validation_failed` shape as the `paymentAmount`
    // branch below.
    const sats = f.paymentAmountSats;
    let isValid = false;
    if (typeof sats === 'bigint' && sats >= 0n) {
      isValid = true;
    } else if (typeof sats === 'number') {
      isValid = Number.isInteger(sats) && sats >= 0;
    } else if (typeof sats === 'string') {
      // Require digit-only with no leading/trailing whitespace and
      // no leading zeros longer than 1 char (so "0" is fine but
      // "007" is not — matches the canonical serialization we
      // would later emit). An empty string is rejected.
      isValid = /^(0|[1-9][0-9]*)$/.test(sats);
    }
    if (!isValid) {
      const err = new Error('payment_amount_sats invalid');
      err.status = 400;
      err.body = {
        error: 'validation_failed',
        issues: [
          {
            field: 'payment_amount_sats',
            code: 'amount_sats_invalid',
            message:
              'payment_amount_sats must be a non-negative integer (digit-only string, number, or bigint).',
          },
        ],
      };
      throw err;
    }
    patch.payment_amount_sats = sats;
  } else if (f.paymentAmount !== undefined) {
    // Decimal SYS value — convert to sats up front so the draft row
    // matches the submission row's unit.
    try {
      patch.payment_amount_sats =
        proposalValidate.parsePaymentAmountToSats(f.paymentAmount);
    } catch (e) {
      const err = new Error('payment_amount invalid');
      err.status = 400;
      err.body = {
        error: 'validation_failed',
        issues: [
          {
            field: 'payment_amount',
            code: 'amount_invalid',
            message: e.message,
          },
        ],
      };
      throw err;
    }
  }

  if (f.paymentCount !== undefined) {
    const n = Math.trunc(Number(f.paymentCount));
    if (!Number.isFinite(n) || n < 1 || n > maxPaymentCount) {
      const err = new Error('payment_count out of range');
      err.status = 400;
      err.body = {
        error: 'validation_failed',
        issues: [
          {
            field: 'payment_count',
            code: 'payment_count_range',
            message: `payment_count must be between 1 and ${maxPaymentCount}.`,
          },
        ],
      };
      throw err;
    }
    patch.payment_count = n;
  }

  if (f.startEpoch !== undefined) {
    patch.start_epoch = f.startEpoch === null ? null : Math.trunc(Number(f.startEpoch));
  }
  if (f.endEpoch !== undefined) {
    patch.end_epoch = f.endEpoch === null ? null : Math.trunc(Number(f.endEpoch));
  }
  return patch;
}

// Drafts and submissions hold BigInts for payment_amount_sats; JSON
// can't serialize them. Mapper returns the JSON-safe shape the wizard
// will consume (stringified bigints, ISO-ish timestamps left as ms
// because the UI uses `new Date(ms)` directly).
function jsonDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    name: row.name,
    url: row.url,
    description: row.description,
    paymentAddress: row.paymentAddress,
    paymentAmountSats: row.paymentAmountSats.toString(),
    paymentCount: row.paymentCount,
    startEpoch: row.startEpoch,
    endEpoch: row.endEpoch,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function jsonSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    draftId: row.draftId,

    parentHash: row.parentHash,
    revision: row.revision,
    timeUnix: row.timeUnix,
    dataHex: row.dataHex,
    proposalHash: row.proposalHash,

    title: row.title,
    name: row.name,
    url: row.url,
    paymentAddress: row.paymentAddress,
    paymentAmountSats: row.paymentAmountSats.toString(),
    paymentCount: row.paymentCount,
    startEpoch: row.startEpoch,
    endEpoch: row.endEpoch,

    status: row.status,
    collateralTxid: row.collateralTxid,
    collateralConfs: row.collateralConfs,
    governanceHash: row.governanceHash,
    failReason: row.failReason,
    failDetail: row.failDetail,

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Validate :id parameter. Submission / draft IDs are SQLite integer
// rowids, always positive. Reject anything else as 404 (not 400) so
// scanners probing for /submissions/foo can't distinguish "doesn't
// exist" from "malformed id".
function parseIntId(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(raw)) return null;
  return n;
}

// ---------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------

function createGovProposalsRouter({
  drafts,
  submissions,
  sessionMw,
  csrfMw,
  rpc = {},
  runAtomic,
  now = () => Date.now(),
  maxDraftsPerUser = DEFAULT_MAX_DRAFTS_PER_USER,
  maxPaymentCount = DEFAULT_MAX_PAYMENT_COUNT,
} = {}) {
  if (!drafts || typeof drafts.create !== 'function') {
    throw new Error('createGovProposalsRouter: drafts repo is required');
  }
  if (!submissions || typeof submissions.create !== 'function') {
    throw new Error('createGovProposalsRouter: submissions repo is required');
  }
  if (!sessionMw || typeof sessionMw.requireAuth !== 'function') {
    throw new Error('createGovProposalsRouter: sessionMw is required');
  }
  if (!csrfMw || typeof csrfMw.require !== 'function') {
    throw new Error('createGovProposalsRouter: csrfMw is required');
  }
  if (typeof runAtomic !== 'function') {
    throw new Error('createGovProposalsRouter: runAtomic is required');
  }

  const router = express.Router();

  // Everything below requires auth + CSRF. We apply both at the router
  // level for brevity — matches the pattern used by /vault.
  router.use(sessionMw.requireAuth, csrfMw.require);

  // -----------------------------------------------------------------
  // Drafts
  // -----------------------------------------------------------------

  // POST /gov/proposals/drafts
  //
  // Input: partial draft body (all fields optional).
  // Output: 201 { draft }
  // Errors: 409 draft_limit when the user is already at maxDraftsPerUser.
  router.post('/drafts', (req, res) => {
    const userId = req.user.id;
    try {
      const count = drafts.countForUser(userId);
      if (count >= maxDraftsPerUser) {
        return res
          .status(409)
          .json({ error: 'conflict', reason: 'draft_limit' });
      }
      const patch = normalizeDraftPatch(req.body, maxPaymentCount);
      const created = drafts.create(userId, patch);
      return res.status(201).json({ draft: jsonDraft(created) });
    } catch (err) {
      if (err.status && err.body) {
        return res.status(err.status).json(err.body);
      }
      // eslint-disable-next-line no-console
      console.error('[POST /gov/proposals/drafts]', err);
      return res.status(500).json({ error: 'internal' });
    }
  });

  // GET /gov/proposals/drafts
  //
  // Output: { drafts: [...], total }
  router.get('/drafts', (req, res) => {
    const userId = req.user.id;
    const list = drafts.listForUser(userId);
    return res.json({ drafts: list.map(jsonDraft), total: list.length });
  });

  // GET /gov/proposals/drafts/:id
  router.get('/drafts/:id', (req, res) => {
    const userId = req.user.id;
    const id = parseIntId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const draft = drafts.getByIdForUser(id, userId);
    if (!draft) return res.status(404).json({ error: 'not_found' });
    return res.json({ draft: jsonDraft(draft) });
  });

  // PATCH /gov/proposals/drafts/:id
  router.patch('/drafts/:id', (req, res) => {
    const userId = req.user.id;
    const id = parseIntId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    try {
      const patch = normalizeDraftPatch(req.body, maxPaymentCount);
      const updated = drafts.update(id, userId, patch);
      if (!updated) return res.status(404).json({ error: 'not_found' });
      return res.json({ draft: jsonDraft(updated) });
    } catch (err) {
      if (err.status && err.body) {
        return res.status(err.status).json(err.body);
      }
      // eslint-disable-next-line no-console
      console.error('[PATCH /gov/proposals/drafts]', err);
      return res.status(500).json({ error: 'internal' });
    }
  });

  // DELETE /gov/proposals/drafts/:id
  router.delete('/drafts/:id', (req, res) => {
    const userId = req.user.id;
    const id = parseIntId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const changes = drafts.remove(id, userId);
    if (changes === 0) return res.status(404).json({ error: 'not_found' });
    return res.status(204).end();
  });

  // -----------------------------------------------------------------
  // POST /gov/proposals/prepare
  //
  // Input:  full proposal fields + optional `draftId` + optional
  //         `consumeDraft` bool (default true when draftId present).
  // Output: 201 {
  //           submission,                 // full jsonSubmission()
  //           opReturnHex,                // 64-char hex (OP_RETURN push)
  //           canonicalJson,              // exact bytes Core will hash
  //           payloadBytes,               // length of canonicalJson
  //           collateralFeeSats: "15000000000",
  //           requiredConfirmations: 6,
  //         }
  //
  // Semantics:
  //   1. Canonicalize + structurally validate. Field errors -> 400.
  //   2. Compute hash (deterministic, no RPC).
  //   3. If rpc.gObjectCheck is provided, call it. Core rejects -> 422.
  //   4. Persist submission in 'prepared' state. If draftId belongs
  //      to the user and consumeDraft is truthy, delete it in the
  //      same atomic block so a crash can't orphan it.
  //
  // Idempotency: if the same (userId, proposal_hash) submission already
  // exists AND is still in 'prepared' state, return it as-is instead
  // of creating a duplicate. This matters because the wizard may re-
  // call /prepare on refresh; we don't want to strand half-complete
  // rows every time.
  // -----------------------------------------------------------------
  router.post('/prepare', async (req, res) => {
    const userId = req.user.id;
    const body = req.body || {};
    const f = readProposalFields(body);

    // Merge canonical inputs. We take paymentAmount either as sats
    // (preferred) or as SYS-decimal string (wizard convenience).
    const rawForCanon = {
      name: f.name ?? '',
      url: f.url ?? '',
      payment_address: f.paymentAddress ?? '',
      start_epoch: f.startEpoch,
      end_epoch: f.endEpoch,
    };
    if (f.paymentAmountSats !== undefined) {
      try {
        rawForCanon.payment_amount_sats = BigInt(f.paymentAmountSats);
      } catch {
        return res.status(400).json({
          error: 'validation_failed',
          issues: [
            {
              field: 'payment_amount',
              code: 'amount_invalid',
              message: 'payment_amount_sats must be an integer.',
            },
          ],
        });
      }
    } else if (f.paymentAmount !== undefined) {
      rawForCanon.payment_amount = f.paymentAmount;
    }

    // Canonicalize & structurally validate.
    const canon = proposalValidate.canonicalize(rawForCanon);
    const nowSeconds = Math.floor(now() / 1000);
    const structural = proposalValidate.validateStructural(canon, {
      nowSeconds,
    });
    if (!structural.ok) {
      return res.status(400).json({
        error: 'validation_failed',
        issues: structural.issues,
      });
    }

    // payment_count: Core has no bound, we enforce a UX guardrail.
    let paymentCount = 1;
    if (f.paymentCount !== undefined) {
      const n = Math.trunc(Number(f.paymentCount));
      if (!Number.isFinite(n) || n < 1 || n > maxPaymentCount) {
        return res.status(400).json({
          error: 'validation_failed',
          issues: [
            {
              field: 'payment_count',
              code: 'payment_count_range',
              message: `payment_count must be between 1 and ${maxPaymentCount}.`,
            },
          ],
        });
      }
      paymentCount = n;
    }

    // Hashing fields are frozen at prepare time. parent_hash and
    // revision are fixed ('0'/1) for user-submitted top-level
    // proposals; time defaults to our clock so a stale client can't
    // backdate a submission to avoid the "expiration" check in Core.
    //
    // Codex PR8 round 2 P1: idempotency must key on the time-free
    // canonical payload (dataHex), NOT proposalHash, because
    // proposalHash bakes in `time`. Two retries of the same logical
    // /prepare across a one-second boundary would otherwise produce
    // different hashes and both land in the DB. If we already have a
    // `prepared` row for this user with the same dataHex, replay its
    // frozen fields and skip the insert entirely — this also skips
    // the RPC pre-flight, which is both redundant (Core already
    // accepted it once) and subject to rate-limiting on retries.
    const parentHash = '0';
    const revision = 1;

    const existingByPayload = submissions.findPreparedByDataHexForUser(
      userId,
      canon.dataHex
    );

    // Determine the hashing time. On the idempotent replay path we
    // MUST reuse the frozen `timeUnix` from the existing row — any
    // other value would change the proposal hash we commit to via
    // OP_RETURN, and the client already has the original envelope.
    // On the fresh path, use our server clock (`nowSeconds`) rather
    // than trust client input, so a stale client can't backdate the
    // submission past Core's expiration check.
    const timeUnix = existingByPayload
      ? existingByPayload.timeUnix
      : nowSeconds;

    // Preflight Core BEFORE branching on idempotency. Previously the
    // idempotent short-circuit returned early without re-running the
    // check, so if the original /prepare created the row during a
    // transient RPC outage (the `catch` block below soft-allows net
    // errors), every retry would replay the cached row and never
    // revalidate once Core recovered. A Core-invalid proposal could
    // then proceed to collateral payment and fail only in the
    // dispatcher — after the 150 SYS fee is already burned.
    // Running the preflight first ensures every /prepare response is
    // backed by a fresh Core ack (or an explicit soft-fail we logged).
    // (Codex PR8 round 5 P1.)
    //
    // `rpc` is advertised as optional and appFactory.js explicitly
    // passes `null` when no Core connection is wired (a valid default
    // deployment). Destructured defaults (`rpc = {}`) only fire for
    // `undefined`, so an explicit null would flow through and the
    // bare `typeof rpc.gObjectCheck` dereference would throw
    // TypeError inside this async handler, surfacing as an unhandled
    // rejection instead of a clean "skip preflight".
    if (rpc && typeof rpc.gObjectCheck === 'function') {
      try {
        // The production adapter in server.js has the full Core
        // signature `(parentHash, revision, time, dataHex)`. Earlier
        // iterations of this route passed only `dataHex`, which
        // silently shifted args so `dataHex` became `parentHash` and
        // the real payload was `undefined` — invalid-params errors
        // then matched the /invalid/ classifier below and masqueraded
        // as 422 core_rejected on perfectly valid proposals. Always
        // forward the full canonical argument tuple we just hashed.
        // (Codex PR8 round 1 P1.)
        const resp = await rpc.gObjectCheck(
          parentHash,
          revision,
          timeUnix,
          canon.dataHex
        );
        const result =
          resp && typeof resp === 'object' && 'result' in resp
            ? resp.result
            : resp;
        const okFlag = result && (result.Object || result.object);
        // Core 4.x returns { "Object": "success" } on accept. Anything
        // else is treated as a rejection; parse the message for codes.
        if (
          okFlag &&
          String(okFlag).toLowerCase() === 'success'
        ) {
          // accepted
        } else {
          const msg =
            (result && (result.Error || result.error || result['Error Message'])) ||
            JSON.stringify(result);
          const issues = proposalValidate.parseCoreRejectMessage(msg);
          return res.status(422).json({ error: 'core_rejected', issues });
        }
      } catch (err) {
        const msg = String((err && err.message) || err);
        // Heuristic: treat obvious validation errors as 422 terminal;
        // anything else (network/timeout) we soft-allow.
        if (
          /validation|invalid|exceeds|rejected|collateral|size/i.test(msg)
        ) {
          const issues = proposalValidate.parseCoreRejectMessage(msg);
          return res.status(422).json({ error: 'core_rejected', issues });
        }
        // eslint-disable-next-line no-console
        console.warn(
          '[POST /gov/proposals/prepare] gObjectCheck soft-fail',
          msg
        );
        // fall through
      }
    }

    // Idempotent replay: Core just re-acked (or we soft-failed), so
    // the cached envelope is safe to return.
    let proposalHash;
    let opReturnHex;
    if (existingByPayload) {
      proposalHash = existingByPayload.proposalHash;
      // Rebuild opReturnHex from the frozen fields; the stored hash
      // is the big-endian display form, so we rehash rather than
      // byte-reverse to keep the derivation honest (and to catch
      // any drift between computeProposalHash and the row).
      try {
        opReturnHex = computeProposalHash({
          parentHash,
          revision,
          time: timeUnix,
          dataHex: existingByPayload.dataHex,
        }).opReturnBytes.toString('hex');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          '[POST /gov/proposals/prepare] rehash error',
          err
        );
        return res.status(500).json({ error: 'internal' });
      }
      return res.status(200).json({
        submission: jsonSubmission(existingByPayload),
        opReturnHex,
        canonicalJson: canon.json,
        payloadBytes: canon.byteLength,
        collateralFeeSats: COLLATERAL_FEE_SATS.toString(),
        requiredConfirmations: REQUIRED_CONFIRMATIONS,
        idempotent: true,
      });
    }

    let hash;
    try {
      hash = computeProposalHash({
        parentHash,
        revision,
        time: timeUnix,
        dataHex: canon.dataHex,
      });
    } catch (err) {
      // Should be impossible post-validation; keep as 500 so we see it.
      // eslint-disable-next-line no-console
      console.error('[POST /gov/proposals/prepare] hash error', err);
      return res.status(500).json({ error: 'internal' });
    }
    proposalHash = hash.displayHex;
    opReturnHex = hash.opReturnBytes.toString('hex');

    // Draft consumption: default to "yes" if a draftId is supplied
    // and belongs to the user. The frontend explicitly opts out with
    // { consumeDraft: false } if it ever wants to publish from a
    // draft without deleting it.
    let draftIdToConsume = null;
    if (f && body.draftId !== undefined && body.draftId !== null) {
      const draftId = parseIntId(body.draftId);
      if (draftId) {
        const d = drafts.getByIdForUser(draftId, userId);
        if (d) draftIdToConsume = draftId;
      }
    }
    const consumeDraft =
      body.consumeDraft !== undefined ? Boolean(body.consumeDraft) : true;

    let createdRow;
    try {
      createdRow = runAtomic(() => {
        const row = submissions.create({
          userId,
          draftId: draftIdToConsume,
          parentHash,
          revision,
          timeUnix,
          dataHex: canon.dataHex,
          proposalHash,
          title: f.title ? String(f.title) : canon.payload.name,
          name: canon.payload.name,
          url: canon.payload.url,
          paymentAddress: canon.payload.payment_address,
          paymentAmountSats: canon.payload.payment_amount_sats,
          paymentCount,
          startEpoch: canon.payload.start_epoch,
          endEpoch: canon.payload.end_epoch,
        });
        if (draftIdToConsume && consumeDraft) {
          drafts.remove(draftIdToConsume, userId);
        }
        return row;
      });
    } catch (err) {
      // Codex PR8 round 3 P2: two concurrent /prepare requests with
      // the same canonical payload would both miss the pre-read
      // above (`findPreparedByDataHexForUser`) and both attempt to
      // insert. The partial unique index
      // `idx_proposal_submissions_user_payload_prepared`
      // (user_id, data_hex) WHERE status='prepared' will reject the
      // second insert with SQLITE_CONSTRAINT_UNIQUE. Re-read the
      // row the winner created and return it as an idempotent 200,
      // so the loser sees the same canonical envelope as the winner.
      const msg = String((err && err.message) || err);
      const constraintHit =
        (err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          err.code === 'SQLITE_CONSTRAINT')) ||
        /UNIQUE constraint failed/i.test(msg);
      if (constraintHit) {
        const winner = submissions.findPreparedByDataHexForUser(
          userId,
          canon.dataHex
        );
        if (winner) {
          let winnerOpReturnHex;
          try {
            winnerOpReturnHex = computeProposalHash({
              parentHash,
              revision,
              time: winner.timeUnix,
              dataHex: winner.dataHex,
            }).opReturnBytes.toString('hex');
          } catch (rehashErr) {
            // eslint-disable-next-line no-console
            console.error(
              '[POST /gov/proposals/prepare] rehash after race error',
              rehashErr
            );
            return res.status(500).json({ error: 'internal' });
          }
          return res.status(200).json({
            submission: jsonSubmission(winner),
            opReturnHex: winnerOpReturnHex,
            canonicalJson: canon.json,
            payloadBytes: canon.byteLength,
            collateralFeeSats: COLLATERAL_FEE_SATS.toString(),
            requiredConfirmations: REQUIRED_CONFIRMATIONS,
            idempotent: true,
          });
        }
        // Constraint fired but no winner row found — extremely odd
        // (e.g. another index clashed). Fall through to a generic 500.
      }
      // eslint-disable-next-line no-console
      console.error('[POST /gov/proposals/prepare] persist error', err);
      return res.status(500).json({ error: 'internal' });
    }

    return res.status(201).json({
      submission: jsonSubmission(createdRow),
      opReturnHex,
      canonicalJson: canon.json,
      payloadBytes: canon.byteLength,
      collateralFeeSats: COLLATERAL_FEE_SATS.toString(),
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
    });
  });

  // -----------------------------------------------------------------
  // Submissions
  // -----------------------------------------------------------------

  // GET /gov/proposals/submissions
  router.get('/submissions', (req, res) => {
    const userId = req.user.id;
    const list = submissions.listForUser(userId);
    return res.json({
      submissions: list.map(jsonSubmission),
      total: list.length,
    });
  });

  // GET /gov/proposals/submissions/:id
  router.get('/submissions/:id', (req, res) => {
    const userId = req.user.id;
    const id = parseIntId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const row = submissions.getByIdForUser(id, userId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ submission: jsonSubmission(row) });
  });

  // POST /gov/proposals/submissions/:id/attach-collateral
  //
  // Input: { collateralTxid: '<64-hex>' }
  // Output: 200 { submission }
  // Errors: 404 not_found (not owner / unknown id),
  //         409 status_not_prepared, 409 txid_already_used,
  //         400 validation_failed (bad txid).
  //
  // This is the "I paid the 150 SYS" handoff. From here the dispatcher
  // owns the row — the route doesn't need to know whether the user
  // paid via Pali or pasted from Syscoin-Qt.
  router.post('/submissions/:id/attach-collateral', (req, res) => {
    const userId = req.user.id;
    const id = parseIntId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const body = req.body || {};
    const txid =
      typeof body.collateralTxid === 'string'
        ? body.collateralTxid.trim()
        : '';
    if (!HEX64.test(txid)) {
      return res.status(400).json({
        error: 'validation_failed',
        issues: [
          {
            field: 'collateralTxid',
            code: 'txid_invalid',
            message: 'Collateral txid must be 64 hex characters.',
          },
        ],
      });
    }
    try {
      const updated = submissions.attachCollateral(id, userId, txid);
      if (!updated) return res.status(404).json({ error: 'not_found' });
      return res.json({ submission: jsonSubmission(updated) });
    } catch (err) {
      if (err && err.code === 'status_not_prepared') {
        return res
          .status(409)
          .json({ error: 'conflict', reason: 'status_not_prepared' });
      }
      if (err && err.code === 'txid_already_used') {
        return res
          .status(409)
          .json({ error: 'conflict', reason: 'txid_already_used' });
      }
      if (err && err.code === 'txid_invalid') {
        return res.status(400).json({
          error: 'validation_failed',
          issues: [
            {
              field: 'collateralTxid',
              code: 'txid_invalid',
              message: err.message,
            },
          ],
        });
      }
      // eslint-disable-next-line no-console
      console.error(
        '[POST /gov/proposals/submissions/:id/attach-collateral]',
        err
      );
      return res.status(500).json({ error: 'internal' });
    }
  });

  // DELETE /gov/proposals/submissions/:id
  //
  // The repo enforces "only `prepared` and `failed` are deletable";
  // trying to delete anything else returns 0 changes and we 409. We
  // explicitly check the row state first so the error reason is
  // actionable ("status_not_deletable") instead of generic 404.
  router.delete('/submissions/:id', (req, res) => {
    const userId = req.user.id;
    const id = parseIntId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const row = submissions.getByIdForUser(id, userId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status !== 'prepared' && row.status !== 'failed') {
      return res
        .status(409)
        .json({ error: 'conflict', reason: 'status_not_deletable' });
    }
    submissions.remove(id, userId);
    return res.status(204).end();
  });

  return router;
}

module.exports = {
  createGovProposalsRouter,
  COLLATERAL_FEE_SATS,
  REQUIRED_CONFIRMATIONS,
  DEFAULT_MAX_DRAFTS_PER_USER,
  DEFAULT_MAX_PAYMENT_COUNT,
};
