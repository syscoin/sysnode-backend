// Governance voting — pure domain logic.
//
// Lives in lib/ (not routes/) so every branch can be unit-tested
// without Express, and so the RPC client + MN store can be injected
// at the HTTP seam in routes/gov.js. Nothing here reaches for the
// network.
//
// Scope (PR 5):
//   * MN lookup by votingaddress against the tracker's in-memory
//     cache. Used by the frontend to identify which of the user's
//     imported voting keys correspond to live masternodes.
//   * Vote-relay validation + fan-out. The browser signs locally
//     (VaultGovernanceSigner / voteSigner.js), and we relay each
//     compact ECDSA signature to Syscoin Core's `voteraw` RPC. We
//     intentionally enforce `voteSignal === "funding"` here — non-
//     funding signals (valid/delete/endorsed) use the BLS operator
//     key, NOT the voting key, and the vault doesn't hold operator
//     keys.
//
// Error taxonomy for validation: we return `{ ok: false, error: "<code>" }`
// rather than throwing, so the HTTP layer maps codes to 4xx without
// rebuilding error objects across module boundaries. Codes are stable
// (UI copy / i18n keys hang off them).

const HEX64 = /^[0-9a-fA-F]{64}$/;
// Permissive base64 charset guard: the real length/shape check happens
// via `Buffer.from(sig, 'base64').length === 65` plus a canonical
// re-encode roundtrip, so the regex is just a cheap filter that
// rejects obviously malformed input (whitespace, non-base64 chars)
// before we allocate a decode buffer.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// A recoverable ECDSA signature produced by CKey::SignCompact is
// exactly 65 bytes (1-byte header + 32-byte r + 32-byte s). Anything
// else is a programming or tampering error — Core would reject it at
// `voteraw` anyway, but we fail fast here with a stable error code
// so the UI can surface a precise message.
const VOTE_SIG_BYTES = 65;

const OUTCOMES = Object.freeze({ yes: 1, no: 2, abstain: 3 });
// PR5 intentionally supports only `funding`. The other signals
// (valid/delete/endorsed) require the masternode operator's BLS
// key — a separate custody story. We reject them here rather than
// silently accepting + failing at Core, so the UI can render an
// explicit "not supported" hint.
const SIGNALS = Object.freeze({ funding: 1 });

// Absolute caps, deliberate and defensible:
//   - lookup: 512 addresses per call (a heavy MN operator might
//     have ~100 keys; 512 leaves 5x headroom).
//   - vote:   256 entries per call (same ceiling with headroom).
// Both walk O(n) arrays; 512 × 2000 MNs is still <1M comparisons.
const MAX_LOOKUP_ADDRESSES = 512;
const MAX_VOTE_ENTRIES = 256;

// Core's `CGovernanceVote::IsValid` rejects votes with `nTime > now + 3600`.
// Anything older is accepted by Core (propagation / replay), so the
// lower bound we enforce is a soft antifraud window (2h back) — if a
// user's wall clock is >2h behind, they'll get a clear error here rather
// than a confusing downstream rejection.
const VOTE_TIME_MAX_SKEW_AHEAD_S = 60 * 60;          // +1 h (Core-enforced)
const VOTE_TIME_MAX_SKEW_BEHIND_S = 2 * 60 * 60;     // -2 h (client-hygiene)

// ---------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------

function validateLookupBody(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_body" };
  }
  const { votingAddresses } = body;
  if (!Array.isArray(votingAddresses)) {
    return { ok: false, error: "invalid_body" };
  }
  if (votingAddresses.length === 0) {
    return { ok: true, votingAddresses: [] };
  }
  if (votingAddresses.length > MAX_LOOKUP_ADDRESSES) {
    return { ok: false, error: "too_many_addresses" };
  }
  const cleaned = [];
  for (const a of votingAddresses) {
    if (typeof a !== "string" || a.length === 0 || a.length > 128) {
      return { ok: false, error: "invalid_address" };
    }
    // We don't validate the bech32 HRP here — Syscoin mainnet voting
    // addresses always start with `sys1q` in practice, but we want
    // the lookup to silently return no match for malformed inputs
    // rather than 400. That matches the frontend UX: a typo'd
    // address shows "no matching masternode" rather than a hard
    // error.
    cleaned.push(a.trim());
  }
  return { ok: true, votingAddresses: cleaned };
}

function validateVoteBody(body, { nowMs = Date.now() } = {}) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_body" };
  }
  const { proposalHash, voteOutcome, voteSignal, time, entries } = body;

  if (typeof proposalHash !== "string" || !HEX64.test(proposalHash)) {
    return { ok: false, error: "invalid_proposal_hash" };
  }
  if (typeof voteOutcome !== "string" || !(voteOutcome in OUTCOMES)) {
    return { ok: false, error: "invalid_vote_outcome" };
  }
  if (typeof voteSignal !== "string" || !(voteSignal in SIGNALS)) {
    // PR5 limits this to "funding" — see comment on SIGNALS above.
    return { ok: false, error: "unsupported_vote_signal" };
  }
  if (!Number.isInteger(time) || time < 0) {
    return { ok: false, error: "invalid_time" };
  }
  const nowS = Math.floor(nowMs / 1000);
  if (time > nowS + VOTE_TIME_MAX_SKEW_AHEAD_S) {
    return { ok: false, error: "time_in_future" };
  }
  if (time < nowS - VOTE_TIME_MAX_SKEW_BEHIND_S) {
    return { ok: false, error: "time_too_old" };
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: "no_entries" };
  }
  if (entries.length > MAX_VOTE_ENTRIES) {
    return { ok: false, error: "too_many_entries" };
  }

  const cleaned = [];
  const dupKey = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== "object") {
      return { ok: false, error: `invalid_entry:${i}` };
    }
    const { collateralHash, collateralIndex, voteSig } = e;
    if (typeof collateralHash !== "string" || !HEX64.test(collateralHash)) {
      return { ok: false, error: `invalid_entry:${i}:collateralHash` };
    }
    if (
      !Number.isInteger(collateralIndex) ||
      collateralIndex < 0 ||
      collateralIndex > 0xffffffff
    ) {
      return { ok: false, error: `invalid_entry:${i}:collateralIndex` };
    }
    if (typeof voteSig !== "string" || !BASE64.test(voteSig)) {
      return { ok: false, error: `invalid_entry:${i}:voteSig` };
    }
    // Decode and verify the exact raw length. The character-count
    // check we used to perform accepted `"A".repeat(88)` (decodes to
    // 66 bytes) and `"A".repeat(86) + "=="` (decodes to 64 bytes)
    // because both are syntactically valid base64 strings of the
    // "right" length. Decoding is the only way to enforce the 65-
    // byte invariant. We also require the roundtrip
    // (decode → re-encode) to equal the input so non-canonical
    // padding (extra "=" chars, non-zero trailing bits) is rejected.
    // `Buffer.from(_, 'base64')` never throws on junk input — it
    // silently coerces — so both checks are load-bearing here.
    const decodedSig = Buffer.from(voteSig, "base64");
    if (
      decodedSig.length !== VOTE_SIG_BYTES ||
      decodedSig.toString("base64") !== voteSig
    ) {
      return { ok: false, error: `invalid_entry:${i}:voteSig` };
    }
    const k = `${collateralHash.toLowerCase()}:${collateralIndex}`;
    if (dupKey.has(k)) {
      return { ok: false, error: `duplicate_entry:${i}` };
    }
    dupKey.add(k);
    cleaned.push({
      collateralHash: collateralHash.toLowerCase(),
      collateralIndex,
      voteSig,
    });
  }

  return {
    ok: true,
    proposalHash: proposalHash.toLowerCase(),
    voteOutcome,
    voteSignal,
    time,
    entries: cleaned,
  };
}

// ---------------------------------------------------------------------
// MN lookup
// ---------------------------------------------------------------------

// Project the tracker's MN object into the subset the frontend
// actually needs. Keeps the wire format stable even if the tracker
// grows more fields later.
function projectMatch(mn) {
  return {
    votingaddress: typeof mn.votingaddress === "string" ? mn.votingaddress : "",
    proTxHash: typeof mn.proTxHash === "string" ? mn.proTxHash : "",
    collateralHash:
      typeof mn.collateralHash === "string" ? mn.collateralHash : null,
    collateralIndex: Number.isInteger(mn.collateralIndex)
      ? mn.collateralIndex
      : null,
    status: typeof mn.status === "string" ? mn.status : "UNKNOWN",
    address: typeof mn.address === "string" ? mn.address : "",
    payee: typeof mn.payee === "string" ? mn.payee : "",
  };
}

function lookupMatches(masternodesArr, votingAddresses) {
  if (!Array.isArray(masternodesArr) || masternodesArr.length === 0) {
    return [];
  }
  if (!Array.isArray(votingAddresses) || votingAddresses.length === 0) {
    return [];
  }
  // Case-insensitive match. bech32 is lowercase by spec but we
  // normalise both sides so an uppercase paste still works.
  const want = new Set(
    votingAddresses.map((a) => String(a).toLowerCase())
  );
  const matches = [];
  // Single pass over the MN array. O(n) where n ≈ 2-3k MNs on
  // mainnet — trivial at any call rate the rate-limiter allows.
  for (const mn of masternodesArr) {
    if (!mn || typeof mn.votingaddress !== "string") continue;
    if (!want.has(mn.votingaddress.toLowerCase())) continue;
    // Only surface MNs with a usable collateral outpoint — a MN
    // without a parsed outpoint cannot participate in /gov/vote, so
    // including it would just mislead the UI into offering an action
    // that will fail downstream.
    if (
      typeof mn.collateralHash !== "string" ||
      !HEX64.test(mn.collateralHash) ||
      !Number.isInteger(mn.collateralIndex)
    ) {
      continue;
    }
    matches.push(projectMatch(mn));
  }
  return matches;
}

// ---------------------------------------------------------------------
// Vote relay
// ---------------------------------------------------------------------

// Run `work` with at most `concurrency` active promises at a time.
// Resolves to an array preserving input order. Rejections become
// resolved {ok:false,error} objects via the `wrap` contract so a
// single failing MN never sinks the batch.
async function mapLimited(items, concurrency, work) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: n }, () => worker());
  await Promise.all(workers);
  return out;
}

// Map RPC error messages into stable, UI-safe codes. Anything we
// don't recognise is passed through as a generic "rpc_error" so the
// frontend can show a fallback message without leaking internals
// (the full message is still available in logs server-side).
function classifyRpcError(msg) {
  if (typeof msg !== "string") return "rpc_error";
  const s = msg.toLowerCase();
  if (s.includes("failure to find masternode")) return "mn_not_found";
  if (s.includes("failure to verify vote")) return "signature_invalid";
  if (s.includes("masternode voting too often")) return "vote_too_often";
  if (s.includes("governance object not found")) return "proposal_not_found";
  if (s.includes("invalid vote signal")) return "invalid_vote_signal";
  if (s.includes("invalid vote outcome")) return "invalid_vote_outcome";
  if (s.includes("malformed base64")) return "signature_malformed";
  if (s.includes("already known valid vote")) return "already_voted";
  return "rpc_error";
}

// Relay a batch of pre-signed votes to Core via `voteraw`. `voteRaw` is
// injected — the production wiring is
//   rpcServices(client.callRpc).voteRaw(...).call(true)
// (see services/rpcClient.js). Tests pass a fake that resolves /
// rejects deterministically.
//
// Optional receipts layer:
//   - If `receipts` + `userId` are provided, every entry flows through
//     `receipts.decideRelay` first. Entries that match an
//     already-confirmed or very-recently-relayed receipt are
//     short-circuited: we return { ok: true, skipped: '<reason>' }
//     without calling voteraw. This is the smart-retry foundation —
//     hitting voteraw a second time on a confirmed vote produces a
//     harmless "already known valid vote" at best and a
//     "masternode voting too often" rejection at worst, neither of
//     which is useful UI signal.
//   - On a real voteraw call (success or failure), we upsert a
//     receipt with the corresponding status so "Retry failed" can
//     target just the rows we know didn't make it.
//   - Receipt writes are best-effort: if the DB write itself throws,
//     we log and continue, because the user's vote outcome (on or off
//     chain) is independent of our local bookkeeping.
async function relayVotes(
  voteRaw,
  { proposalHash, voteOutcome, voteSignal, time, entries },
  { concurrency = 4, receipts = null, userId = null } = {}
) {
  if (typeof voteRaw !== "function") {
    throw new Error("relayVotes: voteRaw function is required");
  }
  const hasReceipts =
    receipts &&
    typeof receipts.decideRelay === "function" &&
    typeof receipts.upsert === "function" &&
    Number.isInteger(userId) &&
    userId > 0;

  // Pre-decision pass. Runs synchronously over the prepared statements
  // in the receipts repo; no I/O, so no need to parallelise. We
  // collect decisions so the worker pool skips the ones we already
  // know we shouldn't relay.
  const decisions = new Array(entries.length);
  if (hasReceipts) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      decisions[i] = receipts.decideRelay({
        userId,
        collateralHash: e.collateralHash,
        collateralIndex: e.collateralIndex,
        proposalHash,
        voteOutcome,
        voteSignal,
      });
    }
  }

  function persistReceipt({ entry, status, lastError }) {
    if (!hasReceipts) return;
    try {
      receipts.upsert({
        userId,
        collateralHash: entry.collateralHash,
        collateralIndex: entry.collateralIndex,
        proposalHash,
        voteOutcome,
        voteSignal,
        voteTime: time,
        status,
        lastError,
      });
    } catch (err) {
      // Don't propagate: the user's vote is already in (or not in)
      // the chain regardless of our local record-keeping.
      // eslint-disable-next-line no-console
      console.error(
        "[relayVotes] failed to upsert receipt",
        { userId, proposalHash, outpoint: `${entry.collateralHash}:${entry.collateralIndex}` },
        err
      );
    }
  }

  const results = await mapLimited(entries, concurrency, async (e, i) => {
    const d = decisions[i];
    if (d && d.action === "skip") {
      return {
        collateralHash: e.collateralHash,
        collateralIndex: e.collateralIndex,
        ok: true,
        skipped: d.reason, // 'already_on_chain' | 'recently_relayed'
      };
    }
    try {
      // Core returns "Voted successfully" on success; we don't care
      // about the body, only the absence of a throw.
      await voteRaw(
        e.collateralHash,
        e.collateralIndex,
        proposalHash,
        voteSignal,
        voteOutcome,
        time,
        e.voteSig
      );
      persistReceipt({ entry: e, status: "relayed", lastError: null });
      return {
        collateralHash: e.collateralHash,
        collateralIndex: e.collateralIndex,
        ok: true,
      };
    } catch (err) {
      const message = (err && err.message) || String(err);
      const code = classifyRpcError(message);
      persistReceipt({ entry: e, status: "failed", lastError: code });
      return {
        collateralHash: e.collateralHash,
        collateralIndex: e.collateralIndex,
        ok: false,
        error: code,
      };
    }
  });
  return {
    accepted: results.filter((r) => r.ok).length,
    rejected: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = {
  OUTCOMES,
  SIGNALS,
  MAX_LOOKUP_ADDRESSES,
  MAX_VOTE_ENTRIES,
  VOTE_TIME_MAX_SKEW_AHEAD_S,
  VOTE_TIME_MAX_SKEW_BEHIND_S,
  validateLookupBody,
  validateVoteBody,
  lookupMatches,
  relayVotes,
  classifyRpcError,
};
