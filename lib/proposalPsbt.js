'use strict';

// Governance-collateral PSBT builder. This module is the server side of
// the "Pay with Pali" path: the frontend hands us the connected wallet's
// xpub + change address, we ask syscoinjs-lib to pick UTXOs off Blockbook
// and compose a transaction with a single OP_RETURN output committing to
// the proposal hash for 150 SYS, and we return the unsigned PSBT in the
// JSON envelope that Pali's `sys_signAndSend` expects.
//
// Everything this module knows about Syscoin's governance collateral
// rule traces back to one function in Core —
// CGovernanceObject::IsCollateralValid
// (src/governance/governanceobject.cpp). The relevant slice:
//
//     CScript findScript;
//     findScript << OP_RETURN << ToByteVector(nExpectedHash);
//     ...
//     if (output.scriptPubKey.IsUnspendable()
//         && output.scriptPubKey == findScript
//         && output.nValue >= nMinFee) {
//       foundOpReturn = true;
//     }
//
// Three things worth underlining from that:
//
//   1. The OP_RETURN output itself must carry >= 150 SYS. The 150 SYS is
//      "burned" simply by virtue of OP_RETURN being unspendable — there
//      is no separate burn-address step and no second output.
//   2. The script must be EXACTLY `OP_RETURN <push 32 bytes of hash>`.
//      That's `0x6a 0x20 <32 bytes>`. Any other push op (e.g. an
//      OP_PUSHDATA1 wrapper the encoder might emit for marginal sizes)
//      would make `scriptPubKey == findScript` false and Core would
//      reject the collateral.
//   3. The expected hash is the 32 raw bytes of `GetHash()` in internal
//      byte order. We already have that buffer from proposalHash.js's
//      `opReturnBytes` field; the route passes the hex form through.
//
// syscoinjs-lib's path to compose this (via SyscoinJSLib.createTransaction)
// does the right thing for us so long as we pass a script-only output
// (no address) with a BN value — its internal coin-selector
// (`coinselectsyscoin/utils.js`) sizes OP_RETURN outputs with
// `output.script.length + 5 + 8` and includes them verbatim in the
// output set. The `createPSBTFromRes` finalizer then adds the script as
// an `addOutput({ script, address: null, value })`, which is a standard
// bitcoinjs Psbt output and produces exactly the 0x6a 0x20 <hash>
// scriptPubKey Core looks for.

const BN = require('bn.js');

// 150 SYS — identical constant to the one in routes/govProposals.js.
// Duplicated here rather than imported to keep this module standalone
// (it is used from both a route handler and a dispatcher test harness).
const COLLATERAL_FEE_SATS_BN = new BN('15000000000');

// Default fee rate (sat/vByte). Matches syscoinjs-lib's own default,
// but named here so callers can see what they're getting without
// reading the library.
const DEFAULT_FEE_RATE = 10;

// Generous sanity bounds. A rate of 0 would fail at the `coinSelect`
// step but with a less helpful error; a rate above this is almost
// certainly a typo (500 sat/vB would pay >$150 for a 300-byte tx at
// $0.001/sat).
const MIN_FEE_RATE = 1;
const MAX_FEE_RATE = 1000;

// Syscoin zpub / vpub prefixes. These are the ONLY two forms Pali
// currently emits for a connected UTXO account; anything else is
// either a Bitcoin xpub/ypub or an EVM artifact and would build a
// PSBT on the wrong network.
const MAINNET_XPUB_PREFIX = 'zpub';
const TESTNET_XPUB_PREFIX = 'vpub';

// Script helper: compose `OP_RETURN <push-32-bytes>` with a literal
// OP_PUSHBYTES_32 opcode so there's no ambiguity about which push op
// bitcoinjs would pick. Core compares the serialized script byte-for
// -byte, so we build the bytes ourselves rather than call
// `bitcoinjs.payments.embed` (which uses the minimal push encoding —
// for 32 bytes that's 0x20, but we leave nothing to chance).
function buildOpReturnScript(opReturnHex) {
  if (typeof opReturnHex !== 'string' || !/^[0-9a-f]{64}$/.test(opReturnHex)) {
    const e = new Error('bad_op_return');
    e.code = 'bad_op_return';
    throw e;
  }
  const OP_RETURN = 0x6a;
  const PUSH_32 = 0x20;
  return Buffer.concat([
    Buffer.from([OP_RETURN, PUSH_32]),
    Buffer.from(opReturnHex, 'hex'),
  ]);
}

// Validate xpub shape + network affinity. We don't try to decode the
// base58 body — that's the signer's job; we just refuse obviously
// wrong inputs so a typo doesn't turn into a 500 from deep inside
// syscoinjs-lib.
//
// `networkKey` is 'mainnet' or 'testnet' (as set by the caller from
// Core's getblockchaininfo).
function assertXpubMatchesNetwork(xpub, networkKey) {
  if (typeof xpub !== 'string' || xpub.length < 20 || xpub.length > 120) {
    const e = new Error('bad_xpub');
    e.code = 'bad_xpub';
    throw e;
  }
  if (networkKey === 'mainnet' && !xpub.startsWith(MAINNET_XPUB_PREFIX)) {
    const e = new Error('network_mismatch');
    e.code = 'network_mismatch';
    e.field = 'xpub';
    e.detail = `expected ${MAINNET_XPUB_PREFIX}... for mainnet`;
    throw e;
  }
  if (networkKey === 'testnet' && !xpub.startsWith(TESTNET_XPUB_PREFIX)) {
    const e = new Error('network_mismatch');
    e.code = 'network_mismatch';
    e.field = 'xpub';
    e.detail = `expected ${TESTNET_XPUB_PREFIX}... for testnet`;
    throw e;
  }
}

// Validate the change address by asking bitcoinjs to turn it into an
// output script on the selected network. Wrong-network addresses
// throw with the bitcoinjs-specific message, which we translate to a
// clear `bad_change_address` or `network_mismatch`.
function assertChangeAddress(bitcoinjs, address, network, networkKey) {
  if (typeof address !== 'string' || address.length < 10 || address.length > 100) {
    const e = new Error('bad_change_address');
    e.code = 'bad_change_address';
    throw e;
  }
  try {
    bitcoinjs.address.toOutputScript(address, network);
  } catch (err) {
    // bitcoinjs says things like "Invalid checksum" or "has no matching
    // Script". "has no matching" strongly implies a cross-network
    // address (e.g. sys1... on a testnet build). We separate the two
    // because one is the user's fault and the other is the wrong-
    // wallet-network case that needs a different UI hint.
    const msg = String(err && err.message ? err.message : '');
    if (/has no matching/i.test(msg) || /Invalid version/i.test(msg)) {
      const e = new Error('network_mismatch');
      e.code = 'network_mismatch';
      e.field = 'changeAddress';
      e.detail = `change address is not valid on ${networkKey}`;
      throw e;
    }
    const e = new Error('bad_change_address');
    e.code = 'bad_change_address';
    e.detail = msg || 'invalid address';
    throw e;
  }
}

// Fee rate validation. syscoinjs-lib accepts both plain numbers and
// BN for the feeRate arg; we normalize to a BN to avoid floating-
// point surprises in the coin-selector.
function normalizeFeeRate(feeRate) {
  if (feeRate === undefined || feeRate === null || feeRate === '') {
    return new BN(DEFAULT_FEE_RATE);
  }
  const n = Number(feeRate);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_FEE_RATE || n > MAX_FEE_RATE) {
    const e = new Error('bad_fee_rate');
    e.code = 'bad_fee_rate';
    throw e;
  }
  return new BN(n);
}

// Map a syscoinjs-lib error back to our typed-code vocabulary.
// createTransaction throws with `code: 402` for any coinselect
// failure (insufficient funds, unreachable Blockbook, empty UTXO
// set, etc.). We pull the original message + any shortfall the
// library computed so the UI can render "need X more SYS".
// Walk `err.cause` chains (up to a small depth to avoid adversarial
// cycles) looking for a transport-layer errno string. Node 18+'s
// undici `fetch` throws `TypeError('fetch failed')` with the real
// errno nested under `.cause.code`, so a top-level-only check would
// misclassify those as generic build failures and 500 the client.
function findTransientCode(err) {
  const transient = new Set([
    'ENOTFOUND',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ECONNRESET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
  ]);
  const seen = new Set();
  let cur = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object' && !seen.has(cur); i++) {
    seen.add(cur);
    if (typeof cur.code === 'string' && transient.has(cur.code)) {
      return cur.code;
    }
    cur = cur.cause;
  }
  return null;
}

function translateSyscoinError(err) {
  if (!err || typeof err !== 'object') {
    const e = new Error('pali_psbt_build_failed');
    e.code = 'pali_psbt_build_failed';
    e.cause = err;
    return e;
  }
  const msg = typeof err.message === 'string' ? err.message : '';

  // Network-layer: axios surfaces a `.code` string on connection
  // failures ('ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', ...). In
  // Node 18+ environments using undici/fetch, the errno is nested
  // under `.cause.code` with a top-level `TypeError: fetch failed`;
  // walk the cause chain so both reach this branch.
  const transientCode = findTransientCode(err);
  if (transientCode) {
    const e = new Error('blockbook_unreachable');
    e.code = 'blockbook_unreachable';
    e.detail = transientCode;
    e.cause = err;
    return e;
  }
  // fetch 'TypeError: fetch failed' with no identifiable errno in
  // the cause chain — still a transport failure from our
  // perspective, just one we can't attribute more precisely.
  if (err instanceof TypeError && /fetch failed/i.test(msg)) {
    const e = new Error('blockbook_unreachable');
    e.code = 'blockbook_unreachable';
    e.detail = 'fetch_failed';
    e.cause = err;
    return e;
  }
  // axios HTTP-level: 5xx from Blockbook itself.
  if (err.response && err.response.status && err.response.status >= 500) {
    const e = new Error('blockbook_unreachable');
    e.code = 'blockbook_unreachable';
    e.detail = `upstream_${err.response.status}`;
    e.cause = err;
    return e;
  }

  // syscoinjs-lib's coinselect wrapping: the library sets
  // `err.code === 402` and attaches `.shortfall` / `.outputTotal`
  // on insufficient funds.
  if (err.code === 402 || /insufficient/i.test(msg)) {
    const e = new Error('insufficient_funds');
    e.code = 'insufficient_funds';
    if (err.shortfall) {
      try {
        e.shortfallSats = err.shortfall.toString();
      } catch (_e) {
        /* BN with a weird backing; ignore */
      }
    }
    e.cause = err;
    return e;
  }

  const e = new Error(msg || 'pali_psbt_build_failed');
  e.code = 'pali_psbt_build_failed';
  e.cause = err;
  return e;
}

// Build an unsigned collateral PSBT.
//
// Parameters:
//   - opReturnHex    : 64-char lowercase hex, 32-byte OP_RETURN payload
//                      (this is the 32-byte internal-order proposal hash,
//                      i.e. what proposalHash.js returns as `opReturnBytes`)
//   - xpub           : connected Pali account's zpub/vpub
//   - changeAddress  : connected Pali account's next change address
//                      (sys_getChangeAddress result)
//   - feeRate        : optional sat/vByte integer, defaults to 10
//   - syscoinClient  : { network, networkKey, createTransaction(txOpts, change, outs, feeRate, xpub) }
//                      — abstraction so tests stub without standing up
//                      a real Blockbook. In production, factoryForEnv()
//                      builds one around a SyscoinJSLib instance.
//
// Returns: { psbt: { psbt: <base64>, assets: <stringified-map> },
//            feeSats: "<integer>" }
//
// Throws: Error with `.code` from the taxonomy above. All other errors
// are re-thrown after wrapping in a generic `pali_psbt_build_failed`,
// never as a raw library error — callers can rely on the code set.
async function buildCollateralPsbt({
  opReturnHex,
  xpub,
  changeAddress,
  feeRate,
  syscoinClient,
} = {}) {
  if (!syscoinClient || typeof syscoinClient.createTransaction !== 'function') {
    throw new Error('buildCollateralPsbt: syscoinClient is required');
  }
  const { network, networkKey, bitcoinjs, exportPsbtToJson } = syscoinClient;
  if (!network || !networkKey || !bitcoinjs || typeof exportPsbtToJson !== 'function') {
    throw new Error('buildCollateralPsbt: syscoinClient is malformed');
  }

  assertXpubMatchesNetwork(xpub, networkKey);
  assertChangeAddress(bitcoinjs, changeAddress, network, networkKey);
  const feeRateBN = normalizeFeeRate(feeRate);

  const script = buildOpReturnScript(opReturnHex);
  const outputs = [
    {
      // Intentionally no `address` field so syscointx-js's
      // "if (!output.address) output.address = changeAddress" branch
      // DOES fire — Pali's request-pipeline uses that proprietary
      // address metadata to route the signing popup to the account
      // that owns the change address (which is the same account that
      // owns the inputs we're selecting). Leaving it unset would
      // work, but having the library fill it in with our change
      // address is the cleanest signal for Pali's routing.
      script,
      value: COLLATERAL_FEE_SATS_BN,
    },
  ];

  let result;
  try {
    // rbf:false matches Core's `gobject_prepare` wallet RPC, which
    // produces non-RBF collateral txs. We explicitly opt-out of the
    // syscoinjs-lib default (`rbf: true`) so the dispatcher's 6-conf
    // wait doesn't race with an RBF bump by the user. If a user
    // really needs to bump, they create a new proposal — the
    // original 150 SYS is a sunk cost regardless.
    result = await syscoinClient.createTransaction(
      { rbf: false },
      changeAddress,
      outputs,
      feeRateBN,
      xpub
    );
  } catch (err) {
    throw translateSyscoinError(err);
  }

  if (!result || !result.psbt) {
    const e = new Error('pali_psbt_build_failed');
    e.code = 'pali_psbt_build_failed';
    throw e;
  }

  // syscoinjs-lib's `exportPsbtToJson` emits exactly the shape Pali's
  // `PsbtUtils.fromPali` expects: { psbt: <base64>, assets: <JSON> }.
  // We pass no assetsMap because native-coin sends don't have one.
  const envelope = exportPsbtToJson(result.psbt, undefined);

  // Fee is reported as a number of sats from syscoinjs-lib
  // (`res.fee`). We stringify to keep JSON-number precision honest
  // even though 10 sat/vB * ~200 vB fits comfortably in a Number.
  const feeSatsStr = String(result.fee != null ? result.fee : 0);

  return { psbt: envelope, feeSats: feeSatsStr };
}

// Factory for the production syscoinClient wrapper. Reads
// `SYSCOIN_BLOCKBOOK_URL` from the env and instantiates a
// `SyscoinJSLib` bound to a given network. Returns `null` when the
// env var is missing — the caller (appFactory.js) then omits the
// /collateral/psbt route, so the FE feature-detects the absence and
// keeps the manual fallback visible.
//
// `networkKey`: 'mainnet' | 'testnet' — picked by the caller from
// Core's getblockchaininfo.chain ('main' -> mainnet, anything else
// -> testnet).
function createDefaultSyscoinClient({ blockbookURL, networkKey } = {}) {
  if (!blockbookURL || typeof blockbookURL !== 'string') return null;
  if (networkKey !== 'mainnet' && networkKey !== 'testnet') {
    throw new Error(`createDefaultSyscoinClient: bad networkKey ${networkKey}`);
  }
  // Lazy require: tests that stub the client never pull syscoinjs-lib
  // into the require graph, which keeps unit-test startup fast.
  // eslint-disable-next-line global-require
  const syscoinjs = require('syscoinjs-lib');
  const network = syscoinjs.utils.syscoinNetworks[networkKey];
  const lib = new syscoinjs.SyscoinJSLib(null, blockbookURL, network);
  return {
    network,
    networkKey,
    bitcoinjs: syscoinjs.utils.bitcoinjs,
    exportPsbtToJson: syscoinjs.utils.exportPsbtToJson,
    createTransaction: (txOpts, changeAddress, outputs, feeRate, xpub) =>
      lib.createTransaction(txOpts, changeAddress, outputs, feeRate, xpub),
  };
}

module.exports = {
  buildCollateralPsbt,
  createDefaultSyscoinClient,
  // Exposed for tests.
  _internal: {
    buildOpReturnScript,
    assertXpubMatchesNetwork,
    assertChangeAddress,
    normalizeFeeRate,
    translateSyscoinError,
    COLLATERAL_FEE_SATS_BN,
    DEFAULT_FEE_RATE,
    MIN_FEE_RATE,
    MAX_FEE_RATE,
  },
};
