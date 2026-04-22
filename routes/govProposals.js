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

// Shape + safety validation for `payment_amount_sats` taken from the
// wire. Returns `{ ok: true, value: BigInt }` on success, or
// `{ ok: false, code, message }` with a stable machine-key code that
// callers wrap into their own `validation_failed` envelope.
//
// Accepted shapes:
//   - BigInt: must be >= 0n. Forwarded verbatim.
//   - string: must match `/^(0|[1-9][0-9]*)$/` (digit-only, no leading
//     zeros except "0", no decimal/sign/whitespace/exponent). This is
//     the recommended wire form for large amounts — strings carry
//     arbitrary precision, unlike JSON numbers.
//   - number: must be a SAFE integer (`Number.isSafeInteger`) and
//     >= 0. Codex PR8 round 17 P2: JS JSON.parse silently rounds
//     integers above `Number.MAX_SAFE_INTEGER (2^53 - 1)` at parse
//     time. If we accepted `Number.isInteger` alone and then
//     `BigInt(n)`'d, a caller that sent `9007199254740993` would
//     see us persist `9007199254740992` (or some other nearby
//     double-representable value) — a silent mismatch between the
//     bytes the user signed and what the server canonicalizes /
//     hashes. Forcing safe-integer input means callers MUST send
//     large amounts as digit strings, where `BigInt` parses them
//     without loss. Anything above int64 is still caught by the
//     MAX_PAYMENT_AMOUNT_SATS gate downstream, but that gate runs
//     AFTER the lossy number parse, so the safe-integer check has
//     to happen here — not there.
function parsePaymentAmountSatsInput(sats) {
  if (typeof sats === 'bigint') {
    if (sats < 0n) {
      return {
        ok: false,
        code: 'amount_sats_invalid',
        message: 'payment_amount_sats must be non-negative.',
      };
    }
    return { ok: true, value: sats };
  }
  if (typeof sats === 'number') {
    if (!Number.isSafeInteger(sats)) {
      // Covers: non-finite, non-integer, and integers above 2^53-1
      // that JSON.parse already rounded. Clients wanting amounts at
      // or above Number.MAX_SAFE_INTEGER must send a digit string.
      return {
        ok: false,
        code: 'amount_sats_unsafe_number',
        message:
          'payment_amount_sats as a JSON number must be a safe integer (|value| < 2^53). Use a digit-only string for larger amounts.',
      };
    }
    if (sats < 0) {
      return {
        ok: false,
        code: 'amount_sats_invalid',
        message: 'payment_amount_sats must be non-negative.',
      };
    }
    return { ok: true, value: BigInt(sats) };
  }
  if (typeof sats === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(sats)) {
      return {
        ok: false,
        code: 'amount_sats_invalid',
        message:
          'payment_amount_sats must be a non-negative integer (digit-only string, number, or bigint).',
      };
    }
    return { ok: true, value: BigInt(sats) };
  }
  return {
    ok: false,
    code: 'amount_sats_invalid',
    message:
      'payment_amount_sats must be a non-negative integer (digit-only string, number, or bigint).',
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
    const parsed = parsePaymentAmountSatsInput(f.paymentAmountSats);
    if (!parsed.ok) {
      const err = new Error('payment_amount_sats invalid');
      err.status = 400;
      err.body = {
        error: 'validation_failed',
        issues: [
          {
            field: 'payment_amount_sats',
            code: parsed.code,
            message: parsed.message,
          },
        ],
      };
      throw err;
    }
    // `parsePaymentAmountSatsInput` normalizes to BigInt so the
    // int64 gate below has a single type to compare against.
    patch.payment_amount_sats = parsed.value;
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

  // Codex PR8 round 16 P2: enforce the SQLite INTEGER (int64) ceiling
  // on any accepted payment_amount_sats BEFORE the draft hits the
  // DB layer. The structural validator applies the same gate for
  // submissions (see proposalValidate.MAX_PAYMENT_AMOUNT_SATS), but
  // draft validation is intentionally looser — it only checked the
  // digit-shape regex / BigInt >= 0 and forwarded arbitrarily large
  // values straight to `proposal_drafts.payment_amount_sats`, where
  // an int64 overflow surfaced as a generic 500 instead of a
  // deterministic 400. Normalize all three accepted shapes (BigInt
  // / Number / digit-string) to BigInt for the comparison, and
  // persist the normalized BigInt so the drafts repo never has to
  // re-parse a string. The `paymentAmount` branch above already
  // emits a BigInt from `parsePaymentAmountToSats`, so it flows
  // through this gate automatically.
  if (patch.payment_amount_sats !== undefined) {
    const asBig =
      typeof patch.payment_amount_sats === 'bigint'
        ? patch.payment_amount_sats
        : BigInt(patch.payment_amount_sats);
    if (asBig > proposalValidate.MAX_PAYMENT_AMOUNT_SATS) {
      const err = new Error('payment_amount_sats exceeds maximum');
      err.status = 400;
      err.body = {
        error: 'validation_failed',
        issues: [
          {
            field: 'payment_amount_sats',
            code: 'amount_too_large',
            message: 'Payment amount exceeds the maximum supported value.',
          },
        ],
      };
      throw err;
    }
    patch.payment_amount_sats = asBig;
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
  // Optional: info about the chain this backend is pinned to. Used by
  // GET /network and as the authoritative `networkKey` for PSBT builds.
  // When null, we treat the chain as unknown and skip network probes.
  // Shape: { chain: 'main'|'test'|'regtest', slip44: number,
  //          networkKey: 'mainnet'|'testnet' }.
  networkInfo = null,
  // Optional: collateral-PSBT builder. Injected by appFactory when
  // SYSCOIN_BLOCKBOOK_URL is set. A typed function:
  //   async ({ opReturnHex, xpub, changeAddress, feeRate }) ->
  //     { psbt, feeSats }
  // When null, POST /submissions/:id/collateral/psbt returns 503 and
  // GET /network reports paliPathEnabled=false so the FE can keep
  // the "Pay with Pali" button hidden.
  buildCollateralPsbt = null,
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
      // Codex PR8 round 17 P2: earlier this path used a bare
      // `BigInt(f.paymentAmountSats)` inside a try/catch. That
      // accepted raw JS numbers above `Number.MAX_SAFE_INTEGER`,
      // which `JSON.parse` has already rounded *before* we see
      // them. `BigInt(9007199254740993)` (what the caller typed)
      // never happens — what we actually hand to `BigInt` is the
      // already-rounded double, e.g. `9007199254740992`. We then
      // canonicalize + hash + persist THAT value, so the stored
      // submission encodes a different payment amount than the
      // caller sent, silently. Route through the shared
      // `parsePaymentAmountSatsInput` helper which enforces
      // `Number.isSafeInteger` for numeric input; clients that
      // legitimately need larger amounts must send a digit string
      // (which `BigInt` parses losslessly).
      const parsed = parsePaymentAmountSatsInput(f.paymentAmountSats);
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'validation_failed',
          issues: [
            {
              field: 'payment_amount_sats',
              code: parsed.code,
              message: parsed.message,
            },
          ],
        });
      }
      rawForCanon.payment_amount_sats = parsed.value;
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

    // Codex PR8 round 8 P1: this async route had several persistence
    // calls outside any try/catch, so a synchronous DB throw from
    // better-sqlite3 (SQLITE_BUSY / I/O error / corrupt-index, etc.)
    // became an unhandled promise rejection rather than a controlled
    // JSON 500. Express 4 does NOT catch async handler rejections —
    // in production those surface as hung requests and/or process-
    // level instability under transient faults. Wrap everything
    // from this point on in a top-level try/catch. The existing
    // inner try/catch blocks (gObjectCheck soft-fail, rehash,
    // hash-computation, persist-race) all do early `return
    // res.status(...)`, so they still short-circuit before reaching
    // this outer catch — the outer catch only fires for truly
    // unexpected DB / RPC / compute failures.
    let existingByPayload;
    try {
      existingByPayload = submissions.findPreparedByDataHexForUser(
        userId,
        canon.dataHex
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[POST /gov/proposals/prepare] findPreparedByDataHexForUser failed',
        err
      );
      return res.status(500).json({ error: 'internal' });
    }

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
        // Codex PR8 round 6 P1: Syscoin Core's `gobject_check` takes
        // exactly ONE positional arg — `hex_data` — see
        // syscoin/src/rpc/governance.cpp::gobject_check. Core
        // derives parentHash/revision/nTime internally just to
        // construct the validator; they do NOT participate in the
        // submission hash, so they are irrelevant to preflight. An
        // earlier iteration forwarded the full 4-tuple to match
        // `gobject_submit`; Core rejects that with
        //   RPC_INVALID_PARAMS: too many positional arguments
        // which our "terminal" heuristic below then misclassifies
        // as 422 core_rejected on perfectly valid proposals. Pass
        // just the canonical dataHex.
        const resp = await rpc.gObjectCheck(canon.dataHex);
        const result =
          resp && typeof resp === 'object' && 'result' in resp
            ? resp.result
            : resp;
        // Codex PR8 round 6 P1: Syscoin Core's `gobject_check`
        // returns `{ "Object status": "OK" }` on accept (literal
        // key with a space; see governance.cpp line 111:
        //   objResult.pushKV("Object status", "OK");
        // ). It does NOT use `{ "Object": "success" }` — that was
        // our previous (wrong) assumption, inherited from legacy
        // Dash docs. Without this fix, every successful preflight
        // fell through to the "reject" branch and surfaced as
        // 422 core_rejected. Be lenient on the "OK" casing but
        // strict on the key.
        const statusStr =
          result && (result['Object status'] || result['object status']);
        if (statusStr && String(statusStr).toUpperCase() === 'OK') {
          // accepted
        } else {
          const msg =
            (result && (result.Error || result.error || result['Error Message'])) ||
            JSON.stringify(result);
          const issues = proposalValidate.parseCoreRejectMessage(msg);
          return res.status(422).json({ error: 'core_rejected', issues });
        }
      } catch (err) {
        // Codex PR8 round 11 P1: the previous heuristic included a
        // bare /invalid/ token, which matched transport / parser
        // errors JSON-RPC clients commonly wrap with the word
        // "invalid" ("Invalid URL", "invalid response from server",
        // "invalid JSON-RPC response", "invalid utf-8 sequence in
        // headers", etc.). Those are temporary outages, not Core
        // rejections — classifying them as 422 core_rejected
        // blocks legitimate /prepare calls until the node/network
        // recovers.
        //
        // Terminal = phrases Syscoin Core explicitly emits from
        // CGovernanceObject::IsValidLocally() and gobject_check's
        // reject branches. Everything else (including anything
        // containing a bare "invalid" / "error" / "failed") is
        // treated as transient and soft-allowed, because JSON-RPC
        // clients routinely wrap transport and parser failures
        // with those tokens ("Invalid URL", "invalid response
        // from server", "invalid JSON-RPC response"). Note: we
        // deliberately do NOT use `parseCoreRejectMessage` for
        // classification — its final arm raises a catch-all
        // `core_rejected` issue for ANY non-empty string, which
        // would false-positive every transport error as a Core
        // rejection.
        const msg = String((err && err.message) || err);
        const terminalCorePhrases = [
          // CGovernanceObject::IsValidLocally phrases (same set
          // `parseCoreRejectMessage` maps to structured codes):
          /name exceeds/i,
          /name\s+(?:is\s+)?empty/i,
          /name contains invalid/i,
          /start_epoch/i,
          /end_epoch/i,
          /payment_amount is negative/i,
          /payment_amount\b.*not found/i,
          /payment_address is invalid/i,
          /payment_address\b.*not found/i,
          /payment_address can't have whitespaces/i,
          /script addresses are not supported/i,
          /url.*whitespaces/i,
          /url too short/i,
          /url invalid/i,
          /url\b.*not found/i,
          /data exceeds/i,
          /type is not 1/i,
          /type field not found/i,
          /governance object (?:is )?expired/i,
          /proposal (?:is )?expired/i,
          // gobject_check wrapper rejects:
          /Governance object is not valid/i,
          /Object submission rejected/i,
          /Invalid parent hash/i,
          /Invalid (?:object )?signature/i,
          /Invalid object type/i,
          /Invalid proposal/i,
          /Invalid data hex/i,
          /hash mismatch/i,
          /collateral (?:missing|invalid|rejected)/i,
        ];
        const isTerminal = terminalCorePhrases.some((re) => re.test(msg));
        if (isTerminal) {
          const issues = proposalValidate.parseCoreRejectMessage(msg);
          return res.status(422).json({ error: 'core_rejected', issues });
        }
        // eslint-disable-next-line no-console
        console.warn(
          '[POST /gov/proposals/prepare] gObjectCheck soft-fail',
          msg
        );
        // fall through — transient; let the idempotent replay
        // branch or subsequent insert handle it.
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
    //
    // Codex PR8 round 9 P2: the ownership lookup + insert USED to
    // straddle the `runAtomic` boundary: we read the draft, then
    // inserted with that cached id. A concurrent delete/consume of
    // the same draft (e.g. another tab, or an earlier /prepare on
    // the same draft that won a race) could therefore invalidate
    // the FK between the read and the insert, and the insert would
    // throw a SQLITE_CONSTRAINT foreign-key error that bled through
    // as a generic 500. That's a normal race we should degrade
    // gracefully through, not a server fault. Parse the candidate
    // id here (still pure), but defer the actual ownership lookup
    // (and the corresponding removal) to *inside* the atomic block
    // below so both see the same point-in-time view of `drafts`.
    const consumeDraft =
      body.consumeDraft !== undefined ? Boolean(body.consumeDraft) : true;
    let candidateDraftId = null;
    if (body.draftId !== undefined && body.draftId !== null) {
      candidateDraftId = parseIntId(body.draftId) || null;
    }

    let createdRow;
    try {
      createdRow = runAtomic(() => {
        // Resolve the draft *inside* the transaction so the ownership
        // check and the insert (and the optional delete) see a
        // consistent snapshot. better-sqlite3's `db.transaction`
        // holds a write lock for the duration of this callback, so
        // no other writer can delete the draft out from under us
        // between the getByIdForUser and the submissions.create.
        // If a concurrent delete already happened *before* we
        // grabbed the lock, the draft is gone — degrade to
        // draftId:null (no FK violation) rather than 500ing, since
        // from the user's perspective the wizard form data is
        // still perfectly publishable; the draft row is just
        // bookkeeping.
        let resolvedDraftId = null;
        if (candidateDraftId) {
          const d = drafts.getByIdForUser(candidateDraftId, userId);
          if (d) resolvedDraftId = candidateDraftId;
        }
        const row = submissions.create({
          userId,
          draftId: resolvedDraftId,
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
        if (resolvedDraftId && consumeDraft) {
          drafts.remove(resolvedDraftId, userId);
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
        // better-sqlite3 is synchronous and can throw (SQLITE_BUSY,
        // I/O, corrupt index, temp-write-failed) from this read.
        // Without a local try/catch the throw escapes into the
        // async Express 4 handler as an unhandled rejection —
        // Express 4 does not catch async handler errors, so in
        // prod that becomes a process-level UnhandledPromise-
        // Rejection warning and a client-visible hang/default
        // 500 HTML page instead of our structured JSON 500.
        // Swallow here and surface the same `internal` code the
        // rest of this handler uses for DB failures.
        let winner;
        try {
          winner = submissions.findPreparedByDataHexForUser(
            userId,
            canon.dataHex
          );
        } catch (lookupErr) {
          // eslint-disable-next-line no-console
          console.error(
            '[POST /gov/proposals/prepare] winner lookup after unique-race failed',
            lookupErr
          );
          return res.status(500).json({ error: 'internal' });
        }
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

  // -----------------------------------------------------------------
  // GET /gov/proposals/network
  //
  // Surfaces the chain this backend is pinned to so the frontend can
  // gate the "Pay with Pali" button on a chain match (and pick the
  // right copy — "Switch Pali to Syscoin mainnet", etc.). Purely
  // informational; never mutates state. Requires auth because it
  // rides the same router chain as the rest of /gov/proposals, which
  // is fine — callers that need it are authenticated by construction
  // (you have to be logged in to be in the proposal wizard).
  //
  // Output: 200 {
  //   chain: 'main' | 'test' | 'regtest' | 'unknown',
  //   slip44: 57 | 1 | null,
  //   networkKey: 'mainnet' | 'testnet' | null,
  //   paliPathEnabled: boolean        // true iff the PSBT builder is
  //                                     wired (= SYSCOIN_BLOCKBOOK_URL
  //                                     is set AND networkInfo is
  //                                     known)
  // }
  // -----------------------------------------------------------------
  router.get('/network', (req, res) => {
    const info = networkInfo || {};
    const paliPathEnabled =
      typeof buildCollateralPsbt === 'function' &&
      (info.networkKey === 'mainnet' || info.networkKey === 'testnet');
    return res.json({
      chain: info.chain || 'unknown',
      slip44: Number.isInteger(info.slip44) ? info.slip44 : null,
      networkKey: info.networkKey || null,
      paliPathEnabled,
    });
  });

  // -----------------------------------------------------------------
  // POST /gov/proposals/submissions/:id/collateral/psbt
  //
  // Build an UNSIGNED collateral PSBT for Pali to sign. Only callable
  // while the submission is still in `prepared` state; once the user
  // has attached a txid, the dispatcher owns the row and rebuilding
  // a PSBT would produce a second collateral tx that Core would
  // reject as a duplicate. Guards here mirror /attach-collateral so
  // the two paths can't race.
  //
  // Input:
  //   {
  //     xpub: string,           // Syscoin zpub (mainnet) or vpub (testnet)
  //     changeAddress: string,  // valid address on the same network
  //     feeRate?: number        // sat/vByte, default 10, clamped 1..1000
  //   }
  //
  // Output:
  //   200 { psbt: { psbt: '<base64>', assets: '[]' },
  //         feeSats: '<integer>',
  //         opReturnHex,              // echo for FE sanity-check
  //         collateralFeeSats: '15000000000',
  //         networkKey: 'mainnet' | 'testnet' }
  //
  // Errors:
  //   401 unauthorized              (sessionMw)
  //   403 csrf_missing / csrf_invalid
  //   404 not_found                 (unknown / other user's submission)
  //   409 conflict: status_not_prepared
  //   400 validation_failed         (bad_xpub, bad_change_address, bad_fee_rate,
  //                                  network_mismatch, bad_op_return)
  //   422 unprocessable             (insufficient_funds)
  //   503 pali_path_disabled        (no SYSCOIN_BLOCKBOOK_URL configured)
  //   502 upstream_unreachable      (Blockbook unreachable)
  //
  // The `insufficient_funds` -> 422 split (rather than 400) reflects
  // that the request shape was fine; the user's wallet just didn't
  // have 150+ SYS. The FE distinguishes on the status code so its
  // error copy can be specific.
  // -----------------------------------------------------------------
  router.post('/submissions/:id/collateral/psbt', async (req, res) => {
    if (typeof buildCollateralPsbt !== 'function') {
      return res
        .status(503)
        .json({ error: 'pali_path_disabled' });
    }

    const userId = req.user.id;
    const id = parseIntId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });

    const row = submissions.getByIdForUser(id, userId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status !== 'prepared') {
      return res
        .status(409)
        .json({ error: 'conflict', reason: 'status_not_prepared' });
    }

    const body = req.body || {};
    const xpub = typeof body.xpub === 'string' ? body.xpub.trim() : '';
    const changeAddress =
      typeof body.changeAddress === 'string' ? body.changeAddress.trim() : '';
    const feeRate = body.feeRate;

    if (!xpub) {
      return res.status(400).json({
        error: 'validation_failed',
        issues: [
          { field: 'xpub', code: 'required', message: 'xpub is required.' },
        ],
      });
    }
    if (!changeAddress) {
      return res.status(400).json({
        error: 'validation_failed',
        issues: [
          {
            field: 'changeAddress',
            code: 'required',
            message: 'changeAddress is required.',
          },
        ],
      });
    }

    // Recompute opReturnHex from the stored row so we're building
    // against the exact bytes Core will check. Mirrors the idempotent
    // replay at the top of /prepare (line ~819) rather than trusting
    // any FE-supplied hash.
    let opReturnHex;
    try {
      opReturnHex = computeProposalHash({
        parentHash: row.parentHash,
        revision: row.revision,
        time: row.timeUnix,
        dataHex: row.dataHex,
      }).opReturnBytes.toString('hex');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[POST /gov/proposals/submissions/:id/collateral/psbt] rehash',
        err
      );
      return res.status(500).json({ error: 'internal' });
    }

    let built;
    try {
      built = await buildCollateralPsbt({
        opReturnHex,
        xpub,
        changeAddress,
        feeRate,
      });
    } catch (err) {
      const code = err && err.code;
      if (
        code === 'bad_xpub' ||
        code === 'bad_change_address' ||
        code === 'bad_fee_rate' ||
        code === 'bad_op_return' ||
        code === 'network_mismatch'
      ) {
        return res.status(400).json({
          error: 'validation_failed',
          issues: [
            {
              field:
                code === 'bad_xpub'
                  ? 'xpub'
                  : code === 'bad_change_address'
                  ? 'changeAddress'
                  : code === 'bad_fee_rate'
                  ? 'feeRate'
                  : code === 'network_mismatch'
                  ? 'xpub'
                  : 'opReturnHex',
              code,
              message: (err && err.detail) || err.message || code,
            },
          ],
        });
      }
      if (code === 'insufficient_funds') {
        return res.status(422).json({
          error: 'insufficient_funds',
          shortfallSats: err.shortfallSats || null,
        });
      }
      if (code === 'blockbook_unreachable') {
        return res
          .status(502)
          .json({ error: 'upstream_unreachable', detail: err.detail });
      }
      // eslint-disable-next-line no-console
      console.error(
        '[POST /gov/proposals/submissions/:id/collateral/psbt] build',
        err
      );
      return res.status(500).json({ error: 'internal' });
    }

    return res.status(200).json({
      psbt: built.psbt,
      feeSats: built.feeSats,
      opReturnHex,
      collateralFeeSats: COLLATERAL_FEE_SATS.toString(),
      networkKey: (networkInfo && networkInfo.networkKey) || null,
    });
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
    // Codex PR8 round 7 P2: `submissions.remove` only deletes rows
    // still in `prepared` or `failed` (see the partial DELETE in
    // proposalSubmissions.js). A concurrent transition between our
    // pre-read above and this line — e.g. a sibling request flips
    // the row to `awaiting_collateral` via attach-collateral — is
    // perfectly possible in a multi-worker deployment, and leaves
    // `changes === 0`. Silently returning 204 in that case is a
    // false-success: the submission is still alive and may run to
    // completion on-chain even though the API told the client it
    // was deleted. Check the row count and translate a miss into a
    // 409 so the client can re-read the state and react.
    const removed = submissions.remove(id, userId);
    if (Number(removed) === 0) {
      // Re-read to produce the most actionable reason. If the row
      // is gone, another tab/device already deleted it — 404 is
      // correct. If it still exists, its status moved out of the
      // deletable set — 409 with `status_not_deletable` mirrors the
      // pre-read branch above.
      const again = submissions.getByIdForUser(id, userId);
      if (!again) return res.status(404).json({ error: 'not_found' });
      return res
        .status(409)
        .json({ error: 'conflict', reason: 'status_not_deletable' });
    }
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
