'use strict';

// Proposal hash computation — JS port of Syscoin Core's
// `CGovernanceObject::GetHash()`.
//
// This function MUST produce the same bytes that Core computes, because
// the `OP_RETURN` output in the collateral transaction commits to those
// exact 32 bytes. If we are off by one bit, `gobject_submit` will reject
// our proposal with "collateral tx script not valid" — there is no
// silent failure mode, which is the one thing we have going for us.
//
// Reference (syscoin v4.x, same as Dash): src/governance/governancecommon.cpp
//
//   uint256 Object::GetHash() const {
//     CHashWriter ss(SER_GETHASH, PROTOCOL_VERSION);
//     ss << hashParent;           // uint256      -> 32 raw bytes
//     ss << revision;             // int32_t      -> 4 bytes LE
//     ss << time;                 // int64_t      -> 8 bytes LE
//     ss << HexStr(vchData);      // std::string  -> CompactSize(len) + ASCII bytes
//     ss << masternodeOutpoint;   // COutPoint    -> 32 raw bytes + uint32 LE
//     ss << vchSig;               // vector<u8>   -> CompactSize(len) + bytes
//     return ss.GetHash();        // SHA256(SHA256(stream))
//   }
//
// For a user-submitted top-level proposal:
//   - hashParent          = uint256() (all zeros)
//   - masternodeOutpoint  = default COutPoint() = uint256(0) + uint32_t(-1)
//                           (signals "not signed by a masternode")
//   - vchSig              = empty
//
// --- uint256 byte-order note (read this before editing) ---
//
// Bitcoin/Syscoin `uint256` stores 32 bytes internally; `ToString()`
// prints them in REVERSED hex ("big-endian display"), which is what
// humans see in block explorers, RPC outputs, OP_RETURN hex in the raw
// tx, and this app's UI. When those bytes are *serialized* into a
// stream (as in `ss << hashParent`), they are written AS-IS — i.e.
// little-endian relative to the display form.
//
// The final `GetHash()` result is also a `uint256`, so the same rule
// applies in reverse: `ToByteVector(hash)` (which builds the OP_RETURN
// payload) writes the internal LE bytes, while the 64-char hex string
// users see is the bytes REVERSED.
//
// We therefore return BOTH forms:
//   - `displayHex`   : the human hex you'd paste into a block explorer.
//                      This matches what `gobject_submit` returns and
//                      what `gobject_get <hash>` accepts.
//   - `opReturnBytes`: the 32 raw bytes to push after `OP_RETURN` in the
//                      collateral transaction.
//
// End-to-end correctness is validated against a live syscoind on
// staging/regtest before this reaches mainnet — see proposalHash.test.js
// for the property tests and the commented-out integration harness.

const crypto = require('crypto');

const PARENT_HASH_ZERO_HEX = '0';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX_ANY = /^[0-9a-f]*$/;

// Bitcoin Core's WriteCompactSize (src/serialize.h):
//   n < 253            -> [n]
//   n <= 0xFFFF        -> [0xFD, uint16 LE]
//   n <= 0xFFFFFFFF    -> [0xFE, uint32 LE]
//   else               -> [0xFF, uint64 LE]
//
// All governance fields we touch fit in the uint16 branch comfortably
// (dataHex is bounded at 1024 ASCII chars by the 512-byte payload
// limit, parent/sig/outpoint lengths are 0 or constant), but we
// implement the full spec to keep the function reusable.
function writeCompactSize(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('writeCompactSize: n must be a non-negative integer');
  }
  if (n < 253) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xff;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

// parentHash comes in as either the literal "0" (common for top-level
// proposals) or a 64-char hex string in display order. We return the
// 32 raw bytes in internal LE order, ready for `ss << hashParent`.
function normalizeParentHash(s) {
  if (s == null || s === '' || s === PARENT_HASH_ZERO_HEX) {
    return Buffer.alloc(32);
  }
  const h = String(s).toLowerCase();
  if (!HEX64.test(h)) {
    throw new Error('parentHash must be "0" or a 64-char hex string');
  }
  // Display -> internal: reverse the 32 bytes.
  const buf = Buffer.from(h, 'hex');
  return Buffer.from(buf).reverse();
}

// Core calls HexStr(vchData) before serializing, which lowercases the
// hex. We accept case-insensitive input for callers but normalize to
// lowercase before the string goes into the hash stream, otherwise
// the same proposal bytes would hash to different values depending on
// how the hex was typed.
function normalizeDataHex(s) {
  if (typeof s !== 'string') {
    throw new Error('dataHex must be a string');
  }
  const h = s.toLowerCase();
  if (!HEX_ANY.test(h)) {
    throw new Error('dataHex must contain only hex characters');
  }
  if (h.length % 2 !== 0) {
    throw new Error('dataHex must have even length');
  }
  return h;
}

function computeProposalHash({ parentHash = PARENT_HASH_ZERO_HEX, revision, time, dataHex } = {}) {
  if (!Number.isInteger(revision)) {
    throw new Error('revision must be an integer');
  }
  if (!Number.isInteger(time) || time <= 0) {
    throw new Error('time must be a positive integer (unix seconds)');
  }

  const parentBuf = normalizeParentHash(parentHash);
  const hexLower = normalizeDataHex(dataHex);

  const revBuf = Buffer.alloc(4);
  revBuf.writeInt32LE(revision, 0);

  const timeBuf = Buffer.alloc(8);
  timeBuf.writeBigInt64LE(BigInt(time), 0);

  const hexBytes = Buffer.from(hexLower, 'ascii');

  // Default COutPoint() serializes as 32 zero bytes (uint256 hash) +
  // 4 bytes of 0xFF (uint32_t n = (uint32_t)-1 = 0xFFFFFFFF).
  const outpointHash = Buffer.alloc(32);
  const outpointN = Buffer.from([0xff, 0xff, 0xff, 0xff]);

  const stream = Buffer.concat([
    parentBuf,
    revBuf,
    timeBuf,
    writeCompactSize(hexBytes.length),
    hexBytes,
    outpointHash,
    outpointN,
    writeCompactSize(0), // empty vchSig
  ]);

  const h1 = crypto.createHash('sha256').update(stream).digest();
  const h2 = crypto.createHash('sha256').update(h1).digest();

  return {
    displayHex: Buffer.from(h2).reverse().toString('hex'),
    opReturnBytes: Buffer.from(h2),
  };
}

// Utility for callers that have already computed (or received) a
// display-hex proposal hash and need the OP_RETURN bytes, or vice
// versa. Keeps the byte-order conversion in one place.
function displayHashToOpReturnBytes(displayHex) {
  const h = String(displayHex).toLowerCase();
  if (!HEX64.test(h)) {
    throw new Error('displayHex must be 64 hex chars');
  }
  return Buffer.from(h, 'hex').reverse();
}

function opReturnBytesToDisplayHash(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 32) {
    throw new Error('opReturnBytes must be a 32-byte Buffer');
  }
  return Buffer.from(buf).reverse().toString('hex');
}

module.exports = {
  computeProposalHash,
  writeCompactSize,
  displayHashToOpReturnBytes,
  opReturnBytesToDisplayHash,
};
