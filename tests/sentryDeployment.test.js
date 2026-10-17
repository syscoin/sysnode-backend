'use strict';
const http = require('node:http');
const { verifySentryDeployment, parseArguments } = require('../scripts/verify-sentry-deployment');

const HASH = 'a'.repeat(64);
const NODE = 'b'.repeat(64);
const base = { origin: 'https://deployment.example', network: 'testnet', genesisHash: HASH, era: 'legacy-v3' };
const capabilities = () => ({ version: 1, network: 'testnet', chain: { genesisHash: HASH, era: 'legacy-v3' },
  preparationActive: false, operations: ['register', 'updateService', 'updateRegistrar', 'revoke'] });
let server;
let localOrigin;
let handler;
let requests;
let transports;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, headers: request.headers });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  localOrigin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  requests = [];
  transports = [];
  handler = (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/sentry/v1/capabilities') response.end(JSON.stringify(capabilities()));
    else if (request.url === '/api/sentry/v1/operations') {
      response.statusCode = 401; response.end(JSON.stringify({ error: 'unauthorized' }));
    } else {
      response.end(JSON.stringify({ chain: capabilities().chain, node: { proTxHash: NODE,
        operatorPublicKey: 'c'.repeat(96), collateralOutpoint: { txid: 'd'.repeat(64), vout: 1 } } }));
    }
  };
});
const verify = (options = {}) => verifySentryDeployment({ ...base, fetchImpl: (url, init) => {
  transports.push({ url: String(url), init });
  return fetch(new URL(`${url.pathname}${url.search}`, localOrigin), init);
}, ...options });
const jsonHandler = (body, status = 200) => (_request, response) => {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
};

test('checks the exact public paths and node using anonymous GETs only', async () => {
  await expect(verify({ proTxHash: NODE })).resolves.toMatchObject({ ok: true, pqEnabled: false,
    checks: ['capabilities', 'expected-chain', 'expected-operations', 'unauthenticated-management', 'public-node-context'] });
  expect(requests.map((request) => request.path)).toEqual(['/api/sentry/v1/capabilities', '/api/sentry/v1/operations', `/api/sentry/v1/context?network=testnet&proTxHash=${NODE}`]);
  for (const { method, headers } of requests) {
    expect(method).toBe('GET'); expect(headers.authorization).toBeUndefined(); expect(headers.cookie).toBeUndefined();
  }
  for (const { url, init } of transports) {
    expect(url).toMatch(/^https:\/\/deployment\.example\//);
    expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ Accept: 'application/json' });
  }
});

test.each([200, 404])('rejects an HTML SPA or rewritten error response (%s)', async (status) => {
  handler = (_request, response) => { response.writeHead(status, { 'Content-Type': 'text/html' }); response.end('<html>Cannot GET /sentry/v1/capabilities</html>'); };
  await expect(verify()).rejects.toMatchObject({ code: status === 200 ? 'non_json_response' : 'unexpected_status' });
});
test.each([
  [{ chain: { genesisHash: 'f'.repeat(64), era: 'legacy-v3' } }, 'chain_mismatch'],
  [{ chain: { genesisHash: HASH, era: 'pq-v4' } }, 'chain_mismatch'],
  [{ network: 'mainnet' }, 'invalid_capabilities'],
  [{ preparationActive: true }, 'pq_not_disabled'],
  [{ preparationActive: undefined }, 'invalid_capabilities'],
  [{ operations: [...capabilities().operations, 'registerOperator'] }, 'unexpected_operations'],
  [{ operations: ['updateService'] }, 'unexpected_operations'],
])('rejects mismatched or unexpectedly enabled capabilities: %j', async (patch, code) => {
  handler = jsonHandler({ ...capabilities(), ...patch });
  await expect(verify()).rejects.toMatchObject({ code });
  expect(requests).toHaveLength(1);
});
test('rejects unauthenticated management data instead of 401', async () => {
  handler = (request, response) => jsonHandler(request.url.endsWith('/capabilities') ? capabilities() : { operations: [] })(request, response);
  await expect(verify()).rejects.toMatchObject({ code: 'unexpected_status' });
});
test('rejects an incorrect unauthorized envelope', async () => {
  handler = (request, response) => request.url.endsWith('/capabilities')
    ? jsonHandler(capabilities())(request, response) : jsonHandler({ error: 'other' }, 401)(request, response);
  await expect(verify()).rejects.toMatchObject({ code: 'invalid_auth_boundary' });
});
test('rejects a different public node context', async () => {
  const normal = handler;
  handler = (request, response) => request.url.includes('/context?')
    ? jsonHandler({ chain: capabilities().chain, node: { proTxHash: 'f'.repeat(64) } })(request, response)
    : normal(request, response);
  await expect(verify({ proTxHash: NODE })).rejects.toMatchObject({ code: 'invalid_node_context' });
});
test.each(['headers', 'body'])('bounds a stalled response at %s', async (stage) => {
  handler = (_request, response) => {
    if (stage === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); }
  };
  await expect(verify({ timeoutMs: 50 })).rejects.toMatchObject({ code: 'request_timeout' });
});
test('bounds a streamed response without content-length', async () => {
  handler = (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value: 'a'.repeat(1000) })); };
  await expect(verify({ maxResponseBytes: 128 })).rejects.toMatchObject({ code: 'response_too_large' });
});
test('rejects invalid JSON without reporting the body', async () => {
  handler = (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('sensitive backend diagnostic'); };
  await expect(verify()).rejects.toMatchObject({ code: 'invalid_json' });
  await expect(verify()).rejects.not.toThrow('sensitive backend diagnostic');
});
test('does not propagate transport diagnostics that could contain credentials', async () => {
  await expect(verifySentryDeployment({ ...base, fetchImpl: async () => {
    throw Object.assign(new Error('sensitive transport diagnostic'), { code: 'NETWORK_ERROR' });
  } })).rejects.toMatchObject({ code: 'request_failed' });
});
test('does not follow redirects', async () => {
  handler = (_request, response) => { response.writeHead(302, { Location: '/private' }); response.end(); };
  await expect(verify()).rejects.toMatchObject({ code: 'request_failed' });
  expect(requests).toHaveLength(1);
});
test.each(['http://deployment.example', 'https://user:secret@deployment.example', 'https://deployment.example/api', 'https://deployment.example/?token=x', 'https://deployment.example/#x'])('rejects unsafe origin %s before any network call', async (origin) => {
  await expect(verify({ origin })).rejects.toMatchObject({ code: 'invalid_origin' });
  expect(transports).toHaveLength(0);
});
test('parses explicit CLI expectations and rejects unknown or duplicated flags', () => {
  expect(parseArguments(['--origin', base.origin, '--network', 'testnet', '--genesis', HASH, '--era', 'legacy-v3', '--timeout-ms', '500'])).toEqual({ ...base, timeoutMs: 500 });
  expect(() => parseArguments(['--cookie', 'secret'])).toThrow('Use --origin');
  expect(() => parseArguments(['--origin', base.origin, '--origin', base.origin])).toThrow('Use --origin');
});
test.each([{ timeoutMs: 0 }, { timeoutMs: 30001 }, { maxResponseBytes: 1024 * 1024 + 1 }])('rejects unbounded configuration before fetching: %j', async (options) => {
  await expect(verify(options)).rejects.toMatchObject({ code: 'invalid_limit' });
  expect(transports).toHaveLength(0);
});
