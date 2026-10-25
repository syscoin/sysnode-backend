'use strict';

const fs = require('fs');
const path = require('path');
const { namehash, toQuantity } = require('ethers');
const { createPrivacyRelayerRpc, TOPIC } = require('../lib/privacyRelayerRpc');
const { ABI, REGISTRY, IMPLEMENTATION, ENS, IMPLEMENTATION_SLOT, urlNode } = require('../lib/privacyRelayerRegistry');
const code = fs.readFileSync(path.join(__dirname, 'fixtures/privacy-relayer-implementation.hex'), 'utf8').trim();
const owner = '0x1111111111111111111111111111111111111111';
const resolver = '0x2222222222222222222222222222222222222222';
const c = { ensName: 'relay.eth', ensHash: namehash('relay.eth'), registeredAddress: owner };
const header = { number: 20000000, hash: '0x' + 'aa'.repeat(32), timestamp: 1700000000 };
function fixture(overrides = {}) {
  const calls = [];
  const post = jest.fn(async (_url, body, options) => {
    calls.push(body);
    let result;
    if (overrides[body.method]) result = await overrides[body.method](body.params, body);
    else if (body.method === 'eth_chainId') result = '0x1';
    else if (body.method === 'eth_getBlockByNumber') result = { number: toQuantity(header.number), hash: header.hash, timestamp: toQuantity(header.timestamp) };
    else if (body.method === 'eth_getStorageAt') result = '0x' + '0'.repeat(24) + IMPLEMENTATION.slice(2);
    else if (body.method === 'eth_getCode') result = code;
    else if (body.method === 'eth_call') {
      const parsed = ABI.parseTransaction(body.params[0]);
      const values = { owner: [owner], resolver: [resolver], relayers: [123n, c.ensHash], isRelayerRegistered: [true], text: ['https://public.example'] };
      result = ABI.encodeFunctionResult(parsed.name, values[parsed.name]);
    } else if (body.method === 'eth_getLogs') result = [];
    else throw new Error('unexpected method');
    expect(options).toMatchObject({ timeout: 10000, maxRedirects: 0 });
    return { status: 200, data: { jsonrpc: '2.0', id: body.id, result } };
  });
  return { rpc: createPrivacyRelayerRpc('https://operator.example/rpc', { post, now: () => header.timestamp * 1000 }), post, calls };
}
test('relayer source checks mainnet, finalized block and pinned implementation runtime', async () => {
  const { rpc, calls } = fixture(); expect(await rpc.head()).toEqual(header); await rpc.assertSource(header);
  expect(calls).toContainEqual(expect.objectContaining({ method: 'eth_getStorageAt', params: [REGISTRY, IMPLEMENTATION_SLOT, toQuantity(header.number)] }));
  expect(calls).toContainEqual(expect.objectContaining({ method: 'eth_getCode', params: [IMPLEMENTATION, toQuantity(header.number)] }));
});
test('registry implementation upgrade and changed code fail closed', async () => {
  await expect(fixture({ eth_getStorageAt: () => '0x' + '00'.repeat(32) }).rpc.assertSource(header)).rejects.toThrow('source_changed');
  await expect(fixture({ eth_getCode: () => '0x00' }).rpc.assertSource(header)).rejects.toThrow('source_changed');
});
test('reads current owner, exact registered ENS identity and URL at the same block', async () => {
  const { rpc, calls } = fixture();
  expect(await rpc.resolve(c, header)).toEqual({ ensName: c.ensName, ensHash: c.ensHash, owner, registryBalance: '123', endpoint: 'https://public.example' });
  const reads = calls.filter((x) => x.method === 'eth_call');
  expect(reads.every((x) => x.params[1] === toQuantity(header.number))).toBe(true);
  expect(reads.map((x) => x.params[0].to)).toEqual([ENS, REGISTRY, REGISTRY, ENS, resolver]);
  const textCall = ABI.parseTransaction(reads.at(-1).params[0]); expect(textCall.args[0]).toBe(urlNode(c.ensHash));
});
test('past registration does not admit a deregistered owner or different current ENS node', async () => {
  const { rpc } = fixture({ eth_call: ([tx]) => {
    const parsed = ABI.parseTransaction(tx);
    return ABI.encodeFunctionResult(parsed.name, parsed.name === 'owner' ? [owner] : parsed.name === 'relayers' ? [999n, namehash('different.eth')] : [false]);
  } });
  expect(await rpc.resolve(c, header)).toBeNull();
  const { rpc: unregistered } = fixture({ eth_call: ([tx]) => {
    const parsed = ABI.parseTransaction(tx);
    return ABI.encodeFunctionResult(parsed.name, parsed.name === 'owner' ? [owner] : parsed.name === 'relayers' ? [123n, c.ensHash] : [false]);
  } });
  expect(await unregistered.resolve(c, header)).toBeNull();
});
test('registered worker rewards are admitted only by registry worker mapping', async () => {
  const { rpc, calls } = fixture(); expect(await rpc.rewardRegistered(owner, resolver, header)).toBe(true);
  const parsed = ABI.parseTransaction(calls.at(-1).params[0]); expect([...parsed.args]).toEqual([owner, resolver]);
});
function log(overrides = {}) {
  const event = ABI.encodeEventLog(ABI.getEvent('RelayerRegistered'), [c.ensHash, c.ensName, owner, 5000n]);
  return { address: REGISTRY, removed: false, ...event, blockNumber: toQuantity(header.number), blockHash: header.hash,
    transactionHash: '0x' + 'bb'.repeat(32), transactionIndex: '0x0', logIndex: '0x1', ...overrides };
}
test('registration discovery binds namehash and canonical log envelope', async () => {
  const { rpc, calls } = fixture({ eth_getLogs: () => [log()] });
  expect(await rpc.events(header.number, header.number)).toEqual([{ ...c, blockNumber: header.number, txIndex: 0, logIndex: 1 }]);
  expect(calls[0].params[0]).toEqual({ address: REGISTRY, topics: [TOPIC], fromBlock: toQuantity(header.number), toBlock: toQuantity(header.number) });
});
test.each([{ removed: true }, { address: owner }, { topics: [] }, { blockNumber: '0x1' }])('rejects invalid registry event %p', async (override) => {
  await expect(fixture({ eth_getLogs: () => [log(override)] }).rpc.events(header.number, header.number)).rejects.toThrow();
});
test('rejects duplicated event position', async () => {
  await expect(fixture({ eth_getLogs: () => [log(), log()] }).rpc.events(header.number, header.number)).rejects.toThrow();
});
test('every underlying RPC honors the deadline after an awaited reply', async () => {
  let stopped = false;
  const { rpc, post } = fixture({ eth_getStorageAt: async () => { stopped = true; return '0x' + '0'.repeat(24) + IMPLEMENTATION.slice(2); } });
  await expect(rpc.assertSource(header, { beforeRequest: () => { if (stopped) throw new Error('closed'); } })).rejects.toThrow('closed');
  expect(post).toHaveBeenCalledTimes(1);
});
