'use strict';

// Proposal validation + canonicalization.
//
// Responsibilities:
//   1. canonicalize(input)   — Normalize user input into a stable, byte-
//                              deterministic dataHex. The hash commits to
//                              EXACTLY these bytes, so any non-determinism
//                              here (JS's default `JSON.stringify` number
//                              representation, map key order, locale) would
//                              break the proposal at submit time. We
//                              serialize the JSON by hand.
//   2. validateStructural()  — Catch every failure mode that Syscoin Core's
//                              `CProposalValidator` enforces, plus a few
//                              stricter UX rules (requiring a URL scheme;
//                              sane epoch bounds) so users never learn
//                              about an issue for the first time after
//                              paying 150 SYS.
//
// On-chain validation (`gObject_check`) is called SEPARATELY from the
// route layer after structural checks pass; see routes/govProposals.js.
// Keeping the RPC call out of this module lets tests stay pure.
//
// Error shape:
//   { ok: false, issues: [{ field, code, message }] }
// where `code` is a machine-stable key the frontend maps to copy, and
// `message` is a human-readable fallback. Multiple issues are returned
// in one call so the UI can highlight every broken field at once.
//
// References (syscoin tag v4.x):
//   src/governance/governancevalidators.cpp
//     - MAX_DATA_SIZE = 512      — whole payload, post-hex-decode
//     - MAX_NAME_SIZE = 40       — after-lowercase length
//     - name charset             — "-_abcdefghijklmnopqrstuvwxyz0123456789"
//     - ValidateStartEndEpoch    — end > start
//     - ValidatePaymentAmount    — double > 0
//     - ValidatePaymentAddress   — DecodeDestination (we defer to RPC)
//     - ValidateURL              — len >= 4, no whitespace, CheckURL
//   src/governance/governanceobject.h
//     - GOVERNANCE_OBJECT_PROPOSAL = 1

const MAX_DATA_SIZE = 512;
const MAX_NAME_SIZE = 40;
const MIN_URL_SIZE = 4;

const SATS_PER_SYS = 100000000n;
const NAME_ALLOWED_RE = /^[-_a-z0-9]+$/;
const NAME_SANITIZE_RE = /[^-_a-z0-9]/g;

// Minimal address sanity check. Syscoin addresses are either bech32
// (sys1...) or base58 (S.../s.../3.../...). Full validation requires
// decoding + checksum verification; we delegate that to `gObject_check`
// on the backend node. Here we only weed out obvious garbage so we
// fail fast before the RPC round-trip.
const ADDRESS_RE = /^[A-Za-z0-9]{20,100}$/;

// We are strictly stricter than Core's CheckURL on purpose: a
// governance proposal URL that users paste into their wallet is
// social-engineering-adjacent, and Core will accept `javascript:foo`
// happily. We require an http(s) scheme and no whitespace.
const URL_SCHEME_RE = /^https?:\/\/[^\s]{3,}$/i;

// Type 1 = GOVERNANCE_OBJECT_PROPOSAL. We never emit anything else.
const PROPOSAL_TYPE = 1;

// --- Canonicalization --------------------------------------------------

// Format a satoshi amount as the minimal-precision SYS decimal string
// the JSON will contain. Never uses scientific notation. We bypass
// `JSON.stringify` for this number specifically because node's
// formatter emits "1e-8" for very small floats, which — while valid
// JSON — would differ byte-for-byte depending on how the number was
// constructed, and that would propagate into the hash.
//
// Examples:
//   0n                 -> "0"       (rejected upstream; we format anyway)
//   100_000_000n       -> "1"
//   42_500_000_00n     -> "425"     (wait — see tests)
//   4_250_000_000n     -> "42.5"
//   1n                 -> "0.00000001"
//   1_000n             -> "0.00001"
function formatSysAmount(sats) {
  const s = BigInt(sats);
  const neg = s < 0n;
  const abs = neg ? -s : s;
  const whole = abs / SATS_PER_SYS;
  const frac = abs % SATS_PER_SYS;
  let out;
  if (frac === 0n) {
    out = whole.toString();
  } else {
    const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
    out = `${whole}.${fracStr}`;
  }
  return neg ? `-${out}` : out;
}

// Case-insensitive input is accepted (user types "Test-Name"); Core
// stores the lowercased form. We lowercase AND strip disallowed chars
// so the canonical form matches what Core would compute internally.
// The UI previews the sanitized form beside the raw input so the user
// isn't surprised by what lands on chain.
function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(NAME_SANITIZE_RE, '');
}

// Accept either SYS (string or number with decimals) or sats (bigint-
// safe integer string) as input and normalize to sats. We prefer
// string input at the API boundary because JS numbers lose precision
// past 2^53.
//
// Returns bigint (sats) on success, throws on invalid.
function parsePaymentAmountToSats(input) {
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('payment_amount must be finite');
    // Codex PR8 round 13 P2: JS `Number.toString()` falls back to
    // scientific notation for both very small (|x| < 1e-6) and
    // very large (|x| >= 1e21) magnitudes. The decimal-only regex
    // below then rejects legitimate satoshi-scale values like
    // `0.00000001` (stringifies to `"1e-8"`), so callers that pass
    // numbers from plain JSON get a spurious `validation_failed`.
    // `Number.prototype.toFixed(8)` always returns decimal form
    // for values in `[1e-21, 1e21)`; outside that range payment
    // amounts are astronomically unrealistic for SYS (10^13 sats
    // already far exceeds total supply). Route through a fixed
    // decimal form so the regex/BigInt path below stays the sole
    // format of record.
    return parsePaymentAmountToSats(input.toFixed(8));
  }
  if (typeof input !== 'string') {
    throw new Error('payment_amount must be a number or string');
  }
  const s = input.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) {
    throw new Error('payment_amount is not a decimal number');
  }
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const [whole, frac = ''] = abs.split('.');
  if (frac.length > 8) {
    throw new Error('payment_amount has more than 8 decimal places');
  }
  const fracPadded = frac.padEnd(8, '0');
  const sats = BigInt(whole) * SATS_PER_SYS + BigInt(fracPadded);
  return neg ? -sats : sats;
}

// Escape per JSON spec (RFC 8259): quotes, backslash, control chars.
// We avoid JSON.stringify for strings too, for symmetry with the
// number formatter, but defer to it: JSON.stringify of a string IS
// deterministic across engines for ASCII strings; for non-ASCII it
// may encode as \uXXXX or as raw UTF-8 depending on the engine flags.
// Node's v8 always emits raw UTF-8 for non-control non-ASCII. We
// accept that as the reference form (stable within this runtime).
function jsonString(s) {
  return JSON.stringify(String(s));
}

// Build the canonical JSON payload. Order is fixed; omit no fields.
// ANY change to this function (new field, different order, different
// number format) will produce different bytes and therefore a
// different proposal hash. Do NOT edit casually.
function buildCanonicalJSON(p) {
  // Epochs are emitted as integers. normalizeInput already trunc'd
  // them to integers, but we coerce again to defend against callers
  // that assemble the payload manually in tests.
  const startEpoch = Math.trunc(Number(p.start_epoch));
  const endEpoch = Math.trunc(Number(p.end_epoch));
  return (
    '{' +
    `"type":${PROPOSAL_TYPE}` +
    `,"name":${jsonString(p.name)}` +
    `,"start_epoch":${startEpoch}` +
    `,"end_epoch":${endEpoch}` +
    `,"payment_address":${jsonString(p.payment_address)}` +
    `,"payment_amount":${formatSysAmount(p.payment_amount_sats)}` +
    `,"url":${jsonString(p.url)}` +
    '}'
  );
}

// Turn loose user input into a normalized payload. Returns the same
// object shape the route will store/return; does NOT validate. (This
// lets the wizard preview a "what the chain will see" section even
// while the user is still editing and fields might be bad.)
function normalizeInput(raw) {
  const obj = raw || {};
  const normalized = {
    name: sanitizeName(obj.name ?? obj.title ?? ''),
    start_epoch: Number.isFinite(Number(obj.start_epoch))
      ? Math.trunc(Number(obj.start_epoch))
      : null,
    end_epoch: Number.isFinite(Number(obj.end_epoch))
      ? Math.trunc(Number(obj.end_epoch))
      : null,
    payment_address:
      typeof obj.payment_address === 'string' ? obj.payment_address.trim() : '',
    url: typeof obj.url === 'string' ? obj.url.trim() : '',
    // payment_amount_sats is the bigint-safe integer form. Callers
    // that pass SYS decimals go through parsePaymentAmountToSats.
    payment_amount_sats: null,
  };
  try {
    if (obj.payment_amount_sats !== undefined) {
      normalized.payment_amount_sats = BigInt(obj.payment_amount_sats);
    } else if (obj.payment_amount !== undefined) {
      normalized.payment_amount_sats = parsePaymentAmountToSats(
        obj.payment_amount
      );
    } else {
      normalized.payment_amount_sats = 0n;
    }
  } catch {
    normalized.payment_amount_sats = null; // signal unparsable; structural validator will flag
  }
  return normalized;
}

// Main entry point: from user input, produce the canonical form plus
// the hex-encoded payload. Throws only on truly unrecoverable shape
// issues (missing required strings); everything else flows through
// validateStructural so the UI can show field-level errors.
function canonicalize(raw) {
  const payload = normalizeInput(raw);
  // Defensive: if payment_amount_sats failed to parse, use 0 so we
  // can still produce a deterministic (albeit invalid) payload the
  // validator will flag.
  const payloadForJSON = {
    ...payload,
    payment_amount_sats:
      typeof payload.payment_amount_sats === 'bigint'
        ? payload.payment_amount_sats
        : 0n,
    start_epoch: payload.start_epoch ?? 0,
    end_epoch: payload.end_epoch ?? 0,
  };
  const json = buildCanonicalJSON(payloadForJSON);
  const dataHex = Buffer.from(json, 'utf8').toString('hex');
  return {
    payload,
    json,
    dataHex,
    byteLength: Buffer.byteLength(json, 'utf8'),
  };
}

// --- Validation -------------------------------------------------------

function issue(field, code, message) {
  return { field, code, message };
}

function validateStructural(canon, { nowSeconds } = {}) {
  const issues = [];
  const { payload, byteLength } = canon;

  // Name
  if (!payload.name) {
    issues.push(issue('name', 'name_required', 'Name is required.'));
  } else if (payload.name.length > MAX_NAME_SIZE) {
    issues.push(
      issue(
        'name',
        'name_too_long',
        `Name must be ${MAX_NAME_SIZE} characters or fewer.`
      )
    );
  } else if (!NAME_ALLOWED_RE.test(payload.name)) {
    issues.push(
      issue(
        'name',
        'name_invalid_chars',
        'Name may only contain lowercase letters, digits, dashes, and underscores.'
      )
    );
  }

  // Epochs
  if (!Number.isInteger(payload.start_epoch) || payload.start_epoch <= 0) {
    issues.push(
      issue('start_epoch', 'epoch_missing', 'A valid start time is required.')
    );
  }
  if (!Number.isInteger(payload.end_epoch) || payload.end_epoch <= 0) {
    issues.push(
      issue('end_epoch', 'epoch_missing', 'A valid end time is required.')
    );
  }
  if (
    Number.isInteger(payload.start_epoch) &&
    Number.isInteger(payload.end_epoch) &&
    payload.end_epoch <= payload.start_epoch
  ) {
    issues.push(
      issue(
        'end_epoch',
        'epoch_order',
        'End time must be after the start time.'
      )
    );
  }
  // Reject obviously-expired end_epoch when nowSeconds is provided.
  // Core enforces this in gObject_check (fCheckExpiration=true), but
  // doing it here gives a nicer error and removes an RPC round-trip.
  if (
    Number.isInteger(payload.end_epoch) &&
    Number.isInteger(nowSeconds) &&
    payload.end_epoch <= nowSeconds
  ) {
    issues.push(
      issue(
        'end_epoch',
        'epoch_past',
        'End time is in the past; proposals must close in the future.'
      )
    );
  }

  // Amount
  if (
    typeof payload.payment_amount_sats !== 'bigint' ||
    payload.payment_amount_sats <= 0n
  ) {
    issues.push(
      issue(
        'payment_amount',
        'amount_not_positive',
        'Payment amount must be greater than zero.'
      )
    );
  }

  // Address (sanity — real validation at RPC)
  if (!payload.payment_address) {
    issues.push(
      issue('payment_address', 'address_required', 'Payment address is required.')
    );
  } else if (/\s/.test(payload.payment_address)) {
    issues.push(
      issue(
        'payment_address',
        'address_whitespace',
        'Payment address cannot contain spaces.'
      )
    );
  } else if (!ADDRESS_RE.test(payload.payment_address)) {
    issues.push(
      issue(
        'payment_address',
        'address_invalid',
        'Payment address doesn\u2019t look like a valid Syscoin address.'
      )
    );
  }

  // URL
  if (!payload.url) {
    issues.push(issue('url', 'url_required', 'A URL is required.'));
  } else if (/\s/.test(payload.url)) {
    issues.push(issue('url', 'url_whitespace', 'URL cannot contain spaces.'));
  } else if (payload.url.length < MIN_URL_SIZE) {
    issues.push(issue('url', 'url_too_short', 'URL is too short.'));
  } else if (!URL_SCHEME_RE.test(payload.url)) {
    issues.push(
      issue(
        'url',
        'url_scheme',
        'URL must start with http:// or https://.'
      )
    );
  }

  // Payload size — hard consensus limit. This is the reason the UI
  // must show a byte counter in the Review step.
  if (byteLength > MAX_DATA_SIZE) {
    issues.push(
      issue(
        '_payload',
        'payload_too_large',
        `Proposal exceeds the 512-byte on-chain limit (currently ${byteLength} bytes). Shorten the name, URL, or address.`
      )
    );
  }

  return issues.length === 0
    ? { ok: true, issues: [] }
    : { ok: false, issues };
}

// Maps Core's freeform "Invalid X;Invalid Y" error strings to our
// structured codes. Core concatenates reasons with ";" so multiple
// failures can come back in one message.
function parseCoreRejectMessage(raw) {
  const msg = String(raw || '');
  const out = [];
  if (/name exceeds/i.test(msg))
    out.push(issue('name', 'name_too_long', 'Name exceeds 40 characters.'));
  if (/name.*empty/i.test(msg))
    out.push(issue('name', 'name_required', 'Name cannot be empty.'));
  if (/name contains invalid/i.test(msg))
    out.push(
      issue('name', 'name_invalid_chars', 'Name contains invalid characters.')
    );
  if (/start_epoch|end_epoch|end_epoch <= start_epoch/i.test(msg))
    out.push(
      issue(
        'end_epoch',
        'epoch_order',
        'Start/end times are invalid or out of order.'
      )
    );
  if (/expired/i.test(msg))
    out.push(
      issue('end_epoch', 'epoch_past', 'End time must be in the future.')
    );
  if (/payment_amount is negative|payment_amount.*not found/i.test(msg))
    out.push(
      issue(
        'payment_amount',
        'amount_not_positive',
        'Payment amount must be greater than zero.'
      )
    );
  if (
    /payment_address is invalid|payment_address.*not found|payment_address can't have whitespaces/i.test(
      msg
    )
  )
    out.push(
      issue(
        'payment_address',
        'address_invalid',
        'Payment address is not a valid Syscoin address.'
      )
    );
  if (/script addresses are not supported/i.test(msg))
    out.push(
      issue(
        'payment_address',
        'address_script_type',
        'This type of address cannot receive governance payments.'
      )
    );
  if (/url.*whitespaces|url too short|url invalid|url.*not found/i.test(msg))
    out.push(
      issue('url', 'url_invalid', 'URL is not valid.')
    );
  if (/data exceeds/i.test(msg))
    out.push(
      issue(
        '_payload',
        'payload_too_large',
        'Proposal exceeds the 512-byte on-chain limit.'
      )
    );
  if (/type is not 1|type field not found/i.test(msg))
    out.push(issue('_payload', 'type_invalid', 'Invalid proposal type.'));

  // If we couldn't classify, surface the raw message as a catch-all so
  // the user at least sees something actionable.
  if (out.length === 0 && msg.trim()) {
    out.push(issue('_payload', 'core_rejected', msg.trim()));
  }
  return out;
}

module.exports = {
  MAX_DATA_SIZE,
  MAX_NAME_SIZE,
  MIN_URL_SIZE,
  SATS_PER_SYS,
  PROPOSAL_TYPE,
  formatSysAmount,
  sanitizeName,
  parsePaymentAmountToSats,
  normalizeInput,
  canonicalize,
  buildCanonicalJSON,
  validateStructural,
  parseCoreRejectMessage,
};
