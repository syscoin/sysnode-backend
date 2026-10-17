'use strict';

// Operator-side, read-only verification. This does not change the wallet's
// trusted service configuration and never sends cookies, credentials or writes.
const LEGACY_OPERATIONS = ['register', 'updateService', 'updateRegistrar', 'revoke'];
const PQ_OPERATIONS = ['registerOperator', 'rotateOperator'];
const HASH = /^[0-9a-f]{64}$/;

class VerificationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function failure(code, message) {
  return new VerificationError(code, message);
}

function configuration(options) {
  let origin;
  try { origin = new URL(options.origin); }
  catch { throw failure('invalid_origin', 'Provide an HTTPS origin.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw failure('invalid_origin', 'Use an HTTPS origin without credentials, path, query or fragment.');
  }
  if (!['mainnet', 'testnet', 'regtest'].includes(options.network)) {
    throw failure('invalid_network', 'Expected network: mainnet, testnet or regtest.');
  }
  if (!HASH.test(options.genesisHash || '')) {
    throw failure('invalid_genesis', 'Expected a trusted, lowercase 64-character genesis hash.');
  }
  if (!['legacy-v3', 'pq-v4'].includes(options.era)) {
    throw failure('invalid_era', 'Expected era: legacy-v3 or pq-v4.');
  }
  if (options.proTxHash !== undefined && !HASH.test(options.proTxHash)) {
    throw failure('invalid_node', 'Expected a lowercase 64-character ProTx hash.');
  }
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxResponseBytes = options.maxResponseBytes ?? 128 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 30000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 64 || maxResponseBytes > 1024 * 1024) {
    throw failure('invalid_limit', 'Use a bounded request timeout and response limit.');
  }
  return { ...options, origin: origin.origin, timeoutMs, maxResponseBytes };
}

async function readJson(config, pathname, expectedStatus) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.timeoutMs);
  try {
    const response = await config.fetchImpl(new URL(pathname, config.origin), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: abort.signal,
    });
    if (response.status !== expectedStatus) {
      throw failure('unexpected_status', `GET ${pathname} returned ${response.status}; expected ${expectedStatus}. Check the deployed route and proxy prefix.`);
    }
    if (!/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      throw failure('non_json_response', `GET ${pathname} did not return JSON. Check for an SPA fallback or proxy rewrite.`);
    }
    const advertisedLength = Number(response.headers.get('content-length'));
    if (advertisedLength > config.maxResponseBytes) {
      throw failure('response_too_large', `GET ${pathname} exceeded the response limit.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw failure('invalid_json', `GET ${pathname} returned an empty response.`);
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > config.maxResponseBytes) {
          throw failure('response_too_large', `GET ${pathname} exceeded the response limit.`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    let json;
    try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw failure('invalid_json', `GET ${pathname} returned invalid JSON.`); }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw failure('invalid_json', `GET ${pathname} must return a JSON object.`);
    }
    return json;
  } catch (error) {
    if (abort.signal.aborted) throw failure('request_timeout', `GET ${pathname} exceeded ${config.timeoutMs} ms.`);
    if (error instanceof VerificationError) throw error;
    // Do not print server bodies, URLs from redirects, or transport credentials.
    throw failure('request_failed', `GET ${pathname} failed. Check TLS, reachability and redirects.`);
  } finally {
    abort.abort();
    clearTimeout(timer);
  }
}

function assertChain(value, config) {
  if (value?.genesisHash !== config.genesisHash || value?.era !== config.era) {
    throw failure('chain_mismatch', 'The service chain/genesis/era does not match the trusted configuration.');
  }
}

/** The optional fetch implementation is only an injection seam for local tests. */
async function verifySentryDeployment(options = {}) {
  const config = configuration(options);
  config.fetchImpl = options.fetchImpl || globalThis.fetch;
  const capabilities = await readJson(config, '/api/sentry/v1/capabilities', 200);
  if (capabilities.version !== 1 || capabilities.network !== config.network ||
      !Array.isArray(capabilities.operations) ||
      capabilities.operations.some((operation) => typeof operation !== 'string') ||
      new Set(capabilities.operations).size !== capabilities.operations.length ||
      typeof capabilities.preparationActive !== 'boolean') {
    throw failure('invalid_capabilities', 'The service returned an unsupported capability envelope.');
  }
  assertChain(capabilities.chain, config);
  const required = config.era === 'legacy-v3' ? LEGACY_OPERATIONS : [...LEGACY_OPERATIONS, ...PQ_OPERATIONS];
  if (!required.every((operation) => capabilities.operations.includes(operation)) ||
      capabilities.operations.some((operation) => !required.includes(operation))) {
    throw failure('unexpected_operations', 'The advertised operations do not match the expected deployment era.');
  }
  if (config.era === 'legacy-v3' && capabilities.preparationActive !== false) {
    throw failure('pq_not_disabled', 'Legacy rollout requires PQ preparation to be explicitly disabled.');
  }
  const unauthorized = await readJson(config, '/api/sentry/v1/operations', 401);
  if (unauthorized.error !== 'unauthorized' || Object.keys(unauthorized).length !== 1) {
    throw failure('invalid_auth_boundary', 'Unauthenticated management reads must return the standard unauthorized response.');
  }
  const checks = ['capabilities', 'expected-chain', 'expected-operations', 'unauthenticated-management'];
  if (config.proTxHash) {
    const query = new URLSearchParams({ network: config.network, proTxHash: config.proTxHash });
    const context = await readJson(config, `/api/sentry/v1/context?${query}`, 200);
    assertChain(context.chain, config);
    const node = context.node;
    const collateral = node?.collateralOutpoint;
    if (node?.proTxHash !== config.proTxHash || !HASH.test(collateral?.txid || '') ||
        !Number.isSafeInteger(collateral.vout) || collateral.vout < 0 || collateral.vout > 0xffffffff ||
        (config.era === 'legacy-v3' && !/^[0-9a-f]{96}$/.test(node.operatorPublicKey || ''))) {
      throw failure('invalid_node_context', 'The public node context did not match the requested node and expected protocol.');
    }
    checks.push('public-node-context');
  }
  return { ok: true, origin: config.origin, network: config.network,
    genesisHash: config.genesisHash, era: config.era,
    pqEnabled: config.era === 'pq-v4', checks };
}

function parseArguments(args) {
  const names = { '--origin': 'origin', '--network': 'network', '--genesis': 'genesisHash',
    '--era': 'era', '--pro-tx-hash': 'proTxHash', '--timeout-ms': 'timeoutMs' };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]], value = args[index + 1];
    if (!key || value === undefined || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw failure('invalid_arguments', 'Use --origin, --network, --genesis, --era and optional --pro-tx-hash / --timeout-ms once each.');
    }
    options[key] = key === 'timeoutMs' ? Number(value) : value;
  }
  return options;
}

if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('Usage: npm run verify:sentry-deployment -- --origin https://HOST --network mainnet|testnet|regtest --genesis HASH --era legacy-v3|pq-v4 [--pro-tx-hash HASH] [--timeout-ms 10000]\nRead-only anonymous GET checks; legacy-v3 requires PQ preparation and operations disabled.\n');
  } else {
    Promise.resolve().then(() => verifySentryDeployment(parseArguments(process.argv.slice(2))))
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'verification_failed', message: error.message })}\n`);
        process.exitCode = 1;
      });
  }
}

module.exports = { verifySentryDeployment, parseArguments };
