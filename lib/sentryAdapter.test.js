const { createSentryRpc } = require('./sentryAdapter');
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
