const { createSentryRpc, createSentryAdapter } = require('./sentryAdapter');
test('Sentry RPC transport preserves exact Core error codes without a caller-selected method', async () => {
  const client = { url: '/', instance: { post: jest.fn(async (_url, body) => ({ data: { id: body.id, error: { code: -8, message: 'Masternode has no active global key' } } })) } };
  await expect(createSentryRpc(client)('protx_operator_key_info', ['a'.repeat(64)])).rejects.toMatchObject({ code: -8, message: 'Masternode has no active global key' });
  await expect(createSentryRpc(client)('dumpprivkey', ['secret'])).rejects.toMatchObject({ code: 'rpc_method_forbidden' });
  expect(client.instance.post).toHaveBeenCalledTimes(1);
});
test('Sentry RPC rejects an unrelated response ID', async () => {
  const client = { url: '/', instance: { post: jest.fn(async () => ({ data: { id: 'stale', result: {} } })) } };
  await expect(createSentryRpc(client)('protx_capabilities')).rejects.toMatchObject({ code: 'sentry_rpc_response_mismatch' });
});
test('HTTP Core errors keep typed protocol rejection, network errors remain opaque', async () => {
  const client = { url: '/', instance: { post: jest.fn(async (_url, body) => { throw { response: { data: { id: body.id, error: { code: -5, message: 'Node not found' } } } }; }) } };
  await expect(createSentryRpc(client)('protx_info', ['a'.repeat(64)])).rejects.toMatchObject({ code: -5 });
  client.instance.post.mockRejectedValue(new Error('ECONNREFUSED private-host:8332'));
  await expect(createSentryRpc(client)('protx_capabilities')).rejects.toMatchObject({ code: 'sentry_rpc_unavailable' });
});

const absentTransaction = 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.';
function readbackFixture(observation, wrongGenesis = false) {
  const rpcCall = jest.fn(async (method) => {
    if (method === 'getrawtransaction') {
      if (observation instanceof Error) throw observation;
      return observation;
    }
    if (method === 'getblockchaininfo') return { chain: 'test' };
    if (method === 'getblockhash') return (wrongGenesis ? 'b' : 'a').repeat(64);
    if (method === 'protx_capabilities') return { version: 1, genesisHash: 'a'.repeat(64), network: 'test', height: 100, blockHash: 'c'.repeat(64), era: 'legacy-v3' };
    throw new Error(`Unexpected test RPC ${method}`);
  });
  return createSentryAdapter({ rpcCall, network: 'testnet', genesisHash: 'a'.repeat(64), sdk: {}, fundingClient: { bitcoinjs: {}, network: {} } });
}
test('readback recognizes only Core definitive transaction absence', async () => {
  const adapter = readbackFixture(Object.assign(new Error(absentTransaction), { code: -5 }));
  await expect(adapter.readback({ network: 'testnet', txid: 'b'.repeat(64) })).resolves.toEqual({ confirmed: false, matches: false });
});
test.each([
  ['sentry_rpc_unavailable', 'RPC unavailable'],
  ['sentry_rpc_response_mismatch', 'Unrelated response ID'],
  [-5, 'No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries. Use gettransaction for wallet transactions.'],
  [-5, 'No such mempool transaction. Blockchain transactions are still in the process of being indexed. Use gettransaction for wallet transactions.'],
  [-5, 'Block hash not found'],
])('readback propagates unverified state for %s: %s', async (code, message) => {
  const error = Object.assign(new Error(message), { code });
  await expect(readbackFixture(error).readback({ network: 'testnet', txid: 'b'.repeat(64) })).rejects.toBe(error);
});
test.each([
  Object.assign(new Error(absentTransaction), { code: -5 }),
  { confirmations: 0 },
])('wrong-genesis absence or pending evidence cannot update the journal', async (observation) => {
  await expect(readbackFixture(observation, true).readback({ network: 'testnet', txid: 'd'.repeat(64) }))
    .rejects.toMatchObject({ code: 'network_mismatch' });
});
