'use strict';

const { createPrivacyRpc, ABI, DEPOSIT_TOPIC, quantity, MAX_RPC_BYTES } = require('../lib/privacyRpc');
const { POOLS, FIELD_SIZE } = require('../lib/privacyRegistry');
const pool = POOLS[0];
const w = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const q = (n) => `0x${n.toString(16)}`;
function fixture(overrides = {}) {
  const block = { number: q(12000000), hash: w(99), parentHash: w(98), timestamp: q(1700000000) };
  const values = { eth_chainId: '0x1', eth_getBlockByNumber: block, eth_getCode: '0x6000',
    eth_getLogs: [{ address: pool.address, removed: false, topics: [DEPOSIT_TOPIC, w(1)], data: ABI.encodeEventLog(ABI.getEvent('Deposit'), [w(1), 0, 123]).data,
      blockNumber: block.number, blockHash: block.hash, transactionHash: w(4), transactionIndex: '0x0', logIndex: '0x1' }], ...overrides };
  const post = jest.fn(async (_url, payload) => {
    let result = values[payload.method];
    if (payload.method === 'eth_call') {
      const fn = ABI.parseTransaction(payload.params[0]).name;
      result = ABI.encodeFunctionResult(fn, [{ levels: 20, denomination: pool.denomination, nextIndex: 1, getLastRoot: w(33) }[fn]]);
    }
    return { status: 200, data: { jsonrpc: '2.0', id: payload.id, result } };
  });
  return { post, values, rpc: createPrivacyRpc('https://archive.example/rpc', { post, now: () => 1700000000000 }) };
}
test('RPC has strict transport guards and only fixed read methods and pool address', async () => {
  const f = fixture(); const head = await f.rpc.head();
  expect((await f.rpc.state(pool, head)).nextIndex).toBe(1);
  expect((await f.rpc.deposits(pool, 12000000, 12000000))[0].leaf).toBe(w(1));
  expect(new Set(f.post.mock.calls.map(([, p]) => p.method))).toEqual(new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getLogs']));
  for (const [, , opts] of f.post.mock.calls) expect(opts).toMatchObject({ timeout: 10000, maxRedirects: 0, maxContentLength: MAX_RPC_BYTES });
});
test.each(['0x01', '0x', '0x-1', '1', 1, '0x20000000000000'])('rejects malformed/unsafe RPC quantity %p', (value) => { expect(() => quantity(value)).toThrow(); });
test('rejects wrong chain, stale headers and wrong block numbers', async () => {
  await expect(fixture({ eth_chainId: '0x39' }).rpc.head()).rejects.toThrow('privacy_wrong_chain');
  await expect(fixture({ eth_getBlockByNumber: { number: '0x1', hash: w(1), parentHash: w(0), timestamp: '0x1' } }).rpc.head()).rejects.toThrow('privacy_stale_chain');
  await expect(fixture().rpc.block(1)).rejects.toThrow('privacy_wrong_block');
});
test('rejects mismatched IDs, JSON-RPC error, status and failed transport without leaking upstream body', async () => {
  for (const response of [
    { status: 200, data: { jsonrpc: '2.0', id: 999, result: '0x1' } },
    { status: 302, data: { jsonrpc: '2.0', id: 1, result: '0x1' } },
  ]) await expect(createPrivacyRpc('https://a.example', { post: async () => response }).head()).rejects.toThrow('privacy_rpc_invalid_response');
  await expect(createPrivacyRpc('https://a.example', { post: async () => ({ status: 200, data: { jsonrpc: '2.0', id: 1, error: { message: 'secret' } } }) }).head()).rejects.toThrow('privacy_rpc_rejected');
  await expect(createPrivacyRpc('https://a.example', { post: async () => { throw new Error('https://a.example/secret'); } }).head()).rejects.toThrow('privacy_rpc_unavailable');
});
test('rejects wrong pool parameters', async () => {
  const f = fixture();
  const post = async (url, payload, opts) => {
    const response = await f.post(url, payload, opts);
    if (payload.method === 'eth_call' && ABI.parseTransaction(payload.params[0]).name === 'levels') response.data.result = ABI.encodeFunctionResult('levels', [21]);
    return response;
  };
  const rpc = createPrivacyRpc('https://a.example', { post });
  await expect(rpc.state(pool, { number: 12000000 })).rejects.toThrow('privacy_pool_mismatch');
});
test.each(['removed', 'address', 'field', 'range', 'data', 'index'])('rejects malicious %s log', async (kind) => {
  const f = fixture(); const row = f.values.eth_getLogs[0];
  if (kind === 'removed') row.removed = true;
  if (kind === 'address') row.address = POOLS[1].address;
  if (kind === 'field') row.topics[1] = w(FIELD_SIZE);
  if (kind === 'range') row.blockNumber = '0x1';
  if (kind === 'data') row.data += '00';
  if (kind === 'index') row.logIndex = '0x00';
  await expect(f.rpc.deposits(pool, 12000000, 12000000)).rejects.toThrow();
});
