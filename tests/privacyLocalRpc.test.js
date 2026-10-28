'use strict';

const http = require('http');
const { privacyRpcUrl } = require('../lib/privacyRpcUrl');
const { createPrivacyRpc } = require('../lib/privacyRpc');
const { createPrivacyRelayerRpc } = require('../lib/privacyRelayerRpc');

test.each(['http://localhost:8545', 'http://127.0.0.1:8545', 'http://[::1]:8545/rpc'])('permits explicit local node %s', (input) => {
  expect(privacyRpcUrl(input).localHttp).toBe(true);
  expect(() => createPrivacyRpc(input)).not.toThrow();
  expect(() => createPrivacyRelayerRpc(input)).not.toThrow();
});
test('maps localhost to literal IPv4 and retains supported remote HTTPS', () => {
  expect(privacyRpcUrl('http://localhost:8545/path').url.href).toBe('http://127.0.0.1:8545/path');
  expect(privacyRpcUrl('https://rpc.example/v2/token?x=1').localHttp).toBe(false);
});
test.each([
  'http://example.com:8545', 'http://localhost.example:8545', 'http://localhost:80',
  'http://127.0.0.2:8545', 'http://127.1:8545', 'http://2130706433:8545',
  'http://0x7f000001:8545', 'http://[::ffff:127.0.0.1]:8545', 'http://192.168.1.1:8545',
  'http://user:password@127.0.0.1:8545', 'http://127.0.0.1:8545/#fragment',
  'https://user:password@rpc.example', 'https://rpc.example/#fragment', 'file:///tmp/rpc',
])('rejects unsafe or ambiguous RPC endpoint %s', (input) => {
  expect(() => createPrivacyRpc(input)).toThrow('privacy_rpc_url_invalid');
  expect(() => createPrivacyRelayerRpc(input)).toThrow('privacy_rpc_url_invalid');
});

test('both clients use the real loopback node without proxy, preserve finalized and reject the wrong chain', async () => {
  let requests = 0, proxyRequests = 0, chainId = '0x1';
  const rpcServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests++;
      const { id, method, params } = JSON.parse(body);
      const block = { number: '0x1', hash: `0x${'11'.repeat(32)}`,
        parentHash: `0x${'22'.repeat(32)}`, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
      const result = method === 'eth_chainId' ? chainId : params[0] === 'finalized' ? block : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  const proxy = http.createServer((_req, res) => { proxyRequests++; res.writeHead(500).end(); });
  await Promise.all([rpcServer, proxy].map((s) => new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))));
  const original = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy,
    NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  try {
    process.env.HTTP_PROXY = process.env.http_proxy = `http://127.0.0.1:${proxy.address().port}`;
    process.env.NO_PROXY = process.env.no_proxy = '';
    const url = `http://localhost:${rpcServer.address().port}`;
    const rpc = createPrivacyRpc(url), relay = createPrivacyRelayerRpc(url);
    expect((await rpc.head()).number).toBe(1);
    expect((await relay.head()).number).toBe(1);
    expect(requests).toBe(4);
    expect(proxyRequests).toBe(0);
    chainId = '0xaa36a7';
    await expect(rpc.head()).rejects.toThrow('privacy_wrong_chain');
    await expect(relay.head()).rejects.toThrow('privacy_relayer_wrong_chain');
  } finally {
    for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await Promise.all([rpcServer, proxy].map((s) => new Promise((resolve) => s.close(resolve))));
  }
});

test('both clients refuse HTTP redirects from a local node', async () => {
  let redirected = 0;
  const other = http.createServer((_req, res) => { redirected++; res.end('{}'); });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${other.address().port}` }).end();
  });
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${redirect.address().port}`;
    await expect(createPrivacyRpc(url).head()).rejects.toThrow('privacy_rpc_unavailable');
    await expect(createPrivacyRelayerRpc(url).head()).rejects.toThrow('privacy_relayer_rpc_unavailable');
    expect(redirected).toBe(0);
  } finally {
    await Promise.all([redirect, other].map((s) => new Promise((resolve) => s.close(resolve))));
  }
});
