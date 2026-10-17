const { createSentryAdapter, createSentryRpc } = require('./sentryAdapter');

const GENESIS = 'a'.repeat(64);
const PROPOSAL = 'b'.repeat(64);
const PROTX = 'c'.repeat(64);
const COLLATERAL = 'd'.repeat(64);
const BLOCK = 'e'.repeat(64);
const KEY_ID = 'f'.repeat(40);
const NOW = 1_800_000_000_000;
function fixture() {
  const payload = JSON.stringify({ type: 1, name: 'known-proposal', url: 'https://example.org/proposal' });
  const proposal = { Hash: PROPOSAL, ObjectType: 1, fLocalValidity: true, fCachedValid: true,
    fCachedDelete: false, DataString: payload, DataHex: Buffer.from(payload).toString('hex') };
  const node = { proTxHash: PROTX, collateralHash: COLLATERAL, collateralIndex: 1,
    state: { votingAddress: 'current-voting-address', confirmedHash: BLOCK } };
  const capabilities = { version: 1, genesisHash: GENESIS, network: 'test', height: 100, blockHash: BLOCK, era: 'legacy-v3' };
  const implementation = async (method, args) => {
    if (method === 'getblockchaininfo') return { chain: 'test' };
    if (method === 'getblockhash') return GENESIS;
    if (method === 'protx_capabilities') return capabilities;
    if (method === 'gobject_get') return proposal;
    if (method === 'protx_info') return { ...node, proTxHash: args[0] };
    if (method === 'getrawtransaction') return { confirmations: 10 };
    throw new Error(`Unexpected test method ${method}`);
  };
  const rpcCall = jest.fn(implementation);
  const fundingClient = { network: {}, bitcoinjs: { address: { toOutputScript: jest.fn(() => Buffer.from(`0014${KEY_ID}`, 'hex')) } } };
  const adapter = createSentryAdapter({ rpcCall, network: 'testnet', genesisHash: GENESIS, fundingClient, sdk: {}, now: () => NOW });
  return { adapter, rpcCall, proposal, node, capabilities, fundingClient, implementation };
}

test('voting context binds the exact Core proposal and current collateral/voting identity', async () => {
  const f = fixture();
  const context = await f.adapter.votingContext('testnet', PROPOSAL, [PROTX]);
  expect(context).toEqual({ chain: { genesisHash: GENESIS, era: 'legacy-v3' }, now: NOW / 1000,
    proposalHash: PROPOSAL, proposal: { name: 'known-proposal', url: 'https://example.org/proposal' },
    nodes: [{ proTxHash: PROTX, collateralOutpoint: { txid: COLLATERAL, vout: 1 }, votingKeyId: KEY_ID, valid: true }] });
  expect(f.rpcCall.mock.calls.every(([, , options]) => options.timeout === 10_000 && options.maxContentLength === 65536)).toBe(true);
  expect(f.rpcCall.mock.calls.map(([method]) => method)).not.toEqual(expect.arrayContaining(['sendrawtransaction', 'testmempoolaccept']));
});

test.each([
  [], Array(21).fill(PROTX), [PROTX, PROTX], ['bad'], [null], ['0'.repeat(64)], 'not-array',
])('rejects invalid or oversized node lists before any RPC (%p)', async (nodes) => {
  const f = fixture();
  await expect(f.adapter.votingContext('testnet', PROPOSAL, nodes)).rejects.toMatchObject({ code: 'invalid_voting_nodes' });
  expect(f.rpcCall).not.toHaveBeenCalled();
});

test('wrong selected network is rejected before RPC', async () => {
  const f = fixture();
  await expect(f.adapter.votingContext('mainnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'network_unavailable' });
  expect(f.rpcCall).not.toHaveBeenCalled();
});

test('coercible proposal arrays are rejected before RPC', async () => {
  const f = fixture();
  await expect(f.adapter.votingContext('testnet', [PROPOSAL], [PROTX])).rejects.toMatchObject({ code: 'invalid_voting_nodes' });
  expect(f.rpcCall).not.toHaveBeenCalled();
});

test('zero proposal hash is rejected before RPC', async () => {
  const f = fixture();
  await expect(f.adapter.votingContext('testnet', '0'.repeat(64), [PROTX])).rejects.toMatchObject({ code: 'invalid_voting_nodes' });
  expect(f.rpcCall).not.toHaveBeenCalled();
});

test('wrong genesis and active PQ era never return legacy voting authority', async () => {
  const f = fixture();
  f.rpcCall.mockImplementation((method, args) => method === 'getblockhash' ? Promise.resolve('0'.repeat(64)) : f.implementation(method, args));
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'network_mismatch' });
  expect(f.rpcCall.mock.calls.some(([method]) => method === 'gobject_get')).toBe(false);
  f.rpcCall.mockImplementation(f.implementation);
  f.capabilities.era = 'pq-v4';
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'voting_protocol_not_supported' });
});

test.each([
  { Hash: '0'.repeat(64) }, { ObjectType: 2 }, { fLocalValidity: false }, { fCachedValid: false },
  { fCachedDelete: true }, { DataString: 'invalid json', DataHex: '00' },
  { DataString: 'x'.repeat(513) }, { DataHex: 'ff' },
])('rejects invalid, deleted or mismatched Core proposals (%p)', async (change) => {
  const f = fixture(); Object.assign(f.proposal, change);
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'invalid_voting_proposal' });
});

test.each([
  { type: 1, name: '<script>' }, { type: 2, name: 'proposal' }, { type: 1, name: 'x'.repeat(41) },
  { type: 1, name: 'proposal', url: 'https://example.org/has space' },
])('hostile proposal display data is not passed to the wallet (%p)', async (data) => {
  const f = fixture(); f.proposal.DataString = JSON.stringify(data); f.proposal.DataHex = Buffer.from(f.proposal.DataString).toString('hex');
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'invalid_voting_proposal' });
});

test.each(['javascript:alert(1)', 'https://user:pass@example.org', 'ftp://example.org', 'example.org/path'])('omits unsafe optional URL without excluding a Core-valid proposal (%s)', async (url) => {
  const f = fixture();
  f.proposal.DataString = JSON.stringify({ type: 1, name: 'proposal', url });
  f.proposal.DataHex = Buffer.from(f.proposal.DataString).toString('hex');
  expect((await f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).proposal).toEqual({ name: 'proposal' });
});

test('an unknown governance object has an explicit error, not an invented title', async () => {
  const f = fixture();
  f.rpcCall.mockImplementation((method, args) => method === 'gobject_get'
    ? Promise.reject(Object.assign(new Error('Unknown governance object'), { code: -8 })) : f.implementation(method, args));
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'proposal_not_found', status: 404 });
});

test.each([
  { collateralHash: 'bad' }, { collateralIndex: -1 }, { collateralIndex: 0x80000000 },
  { state: { votingAddress: 'address', confirmedHash: '0'.repeat(64) } },
])('rejects malformed or unconfirmed collateral identities (%p)', async (change) => {
  const f = fixture(); Object.assign(f.node, change);
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'invalid_voting_node' });
});

test('rejects a node substitution, non-keyhash voting script, and pending registration', async () => {
  const f = fixture();
  f.rpcCall.mockImplementation((method, args) => method === 'protx_info' ? Promise.resolve({ ...f.node, proTxHash: '0'.repeat(64) }) : f.implementation(method, args));
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'invalid_voting_node' });
  f.rpcCall.mockImplementation(f.implementation);
  f.fundingClient.bitcoinjs.address.toOutputScript.mockReturnValue(Buffer.from('51', 'hex'));
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'invalid_authority_address' });
  f.rpcCall.mockImplementation((method, args) => method === 'getrawtransaction' ? Promise.resolve({ confirmations: 0 }) : f.implementation(method, args));
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'node_not_confirmed' });
});

test('a changed chain tip invalidates the combined observation', async () => {
  const f = fixture(); let reads = 0;
  f.rpcCall.mockImplementation((method, args) => method === 'protx_capabilities'
    ? Promise.resolve({ ...f.capabilities, height: ++reads === 1 ? 100 : 101 }) : f.implementation(method, args));
  await expect(f.adapter.votingContext('testnet', PROPOSAL, [PROTX])).rejects.toMatchObject({ code: 'chain_context_changed' });
});

test('twenty nodes are read in order with no more than four in flight', async () => {
  const f = fixture(); let active = 0; let peak = 0;
  f.rpcCall.mockImplementation(async (method, args) => {
    if (method === 'protx_info') {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve)); active -= 1;
    }
    return f.implementation(method, args);
  });
  const hashes = Array.from({ length: 20 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
  const value = await f.adapter.votingContext('testnet', PROPOSAL, hashes);
  expect(value.nodes.map((node) => node.proTxHash)).toEqual(hashes);
  expect(peak).toBe(4);
});

test('the entire context has a bounded deadline and aborts pending transport', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    f.rpcCall.mockImplementation((method, args) => method === 'gobject_get' ? new Promise(() => {}) : f.implementation(method, args));
    const pending = f.adapter.votingContext('testnet', PROPOSAL, [PROTX]);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'sentry_context_timeout', status: 503 });
    await jest.advanceTimersByTimeAsync(10_000); await rejected;
    expect(f.rpcCall.mock.calls[0][2].signal.aborted).toBe(true);
  } finally { jest.useRealTimers(); }
});

test('fixed RPC transport forwards the bounded internal read options', async () => {
  const client = { url: '/', instance: { post: jest.fn(async (_url, body) => ({ data: { id: body.id, result: {} } })) } };
  const options = { timeout: 10_000, maxContentLength: 65536, signal: new AbortController().signal };
  await createSentryRpc(client)('gobject_get', [PROPOSAL], options);
  expect(client.instance.post.mock.calls[0][2]).toBe(options);
});
