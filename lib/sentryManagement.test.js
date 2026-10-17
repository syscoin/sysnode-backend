const { openDatabase } = require('./db');
const { createSentryRepository, createSentryManagement } = require('./sentryManagement');

const HASH = 'aa'.repeat(32);
const TXID = 'bb'.repeat(32);
function fixture() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (id,email,stored_auth,email_verified,salt_v,notification_prefs,created_at,updated_at) VALUES (1,'a@test','x',1,'a','{}',1,1)").run();
  db.prepare("INSERT INTO users (id,email,stored_auth,email_verified,salt_v,notification_prefs,created_at,updated_at) VALUES (2,'b@test','x',1,'b','{}',1,1)").run();
  let time = 1000;
  const repository = createSentryRepository(db, { now: () => time });
  const adapter = {
    capabilities: jest.fn(async () => ({ operations: ['updateService'] })),
    context: jest.fn(async () => ({ node: { proTxHash: HASH } })),
    prepare: jest.fn(async () => ({ request: { transactionHex: '00' }, review: { feeSatoshis: '1' } })),
    authorize: jest.fn(async () => ({ psbt: 'authorized' })),
    validateSigned: jest.fn(async () => ({ transactionHex: 'beef', txid: TXID })),
    validateStored: jest.fn(async () => undefined),
    broadcast: jest.fn(async () => TXID),
    readback: jest.fn(async () => ({ confirmed: true, matches: true })),
  };
  const management = createSentryManagement({ repository, adapter, now: () => time });
  return { db, repository, management, adapter, advance: (ms) => { time += ms; } };
}
const body = (changes = { nevmAddress: `0x${'12'.repeat(20)}` }) => ({ network: 'testnet', proTxHash: HASH, changes, xpub: 'vpub', changeAddress: 'tsys' });

describe('Sentry operation boundary and durable journal', () => {
  let f;
  beforeEach(() => { f = fixture(); });
  afterEach(() => f.db.close());
  test('watch identity is network plus ProTx hash and is user-scoped', async () => {
    await f.management.watch(1, { network: 'testnet', proTxHash: HASH, label: 'test' });
    await f.management.watch(1, { network: 'mainnet', proTxHash: HASH, label: 'main' });
    expect(f.management.watches(1)).toHaveLength(2);
    expect(f.management.watches(2)).toHaveLength(0);
  });
  test('rejects secrets, arbitrary RPC fields and malformed NEVM', async () => {
    await expect(f.management.prepare(1, { ...body(), privateKey: 'secret' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.management.prepare(1, body({ rpc: 'sendrawtransaction' }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.management.prepare(1, body({ nevmAddress: '0x12' }))).rejects.toMatchObject({ code: 'invalid_nevm_address' });
    expect(f.adapter.prepare).not.toHaveBeenCalled();
  });
  test('preserves omitted NEVM and supports explicit empty removal', async () => {
    await f.management.prepare(1, body({ service: '1.2.3.4:8369' }));
    expect(f.adapter.prepare.mock.calls[0][0].changes).not.toHaveProperty('nevmAddress');
    await f.management.prepare(1, body({ nevmAddress: '' }));
    expect(f.adapter.prepare.mock.calls[1][0].changes.nevmAddress).toBe('');
  });
  test('other users cannot authorize or submit an operation', async () => {
    const row = await f.management.prepare(1, body());
    await expect(f.management.authorize(2, row.id, { authorization: {} })).rejects.toMatchObject({ status: 404 });
    await expect(f.management.submit(2, row.id, { signedPsbt: 'a' })).rejects.toMatchObject({ status: 404 });
    expect(f.adapter.broadcast).not.toHaveBeenCalled();
  });
  test('concurrent submissions occupy journal once and publish once', async () => {
    const row = await f.management.prepare(1, body());
    await Promise.all([f.management.submit(1, row.id, { signedPsbt: 'a' }), f.management.submit(1, row.id, { signedPsbt: 'a' })]);
    expect(f.adapter.broadcast).toHaveBeenCalledTimes(1);
    expect(f.repository.read(row.id, 1)).toMatchObject({ status: 'submitted', txid: TXID, signed_hex: 'beef' });
  });
  test('unknown broadcast survives reconstruction without automatic retry', async () => {
    f.adapter.broadcast.mockRejectedValue(new Error('timeout'));
    const row = await f.management.prepare(1, body());
    expect(await f.management.submit(1, row.id, { signedPsbt: 'a' })).toMatchObject({ status: 'submission_unknown', txid: TXID });
    const recovered = createSentryManagement({ repository: createSentryRepository(f.db), adapter: f.adapter });
    await recovered.submit(1, row.id, { signedPsbt: 'a' });
    expect(f.adapter.broadcast).toHaveBeenCalledTimes(1);
    expect(await recovered.reconcile(1, row.id)).toMatchObject({ status: 'confirmed' });
  });
  test('expired or rejected intent cannot broadcast', async () => {
    const row = await f.management.prepare(1, body());
    f.advance(16 * 60_000);
    await expect(f.management.submit(1, row.id, { signedPsbt: 'a' })).rejects.toMatchObject({ code: 'operation_expired' });
    expect(f.adapter.broadcast).not.toHaveBeenCalled();
  });
  test('manual retry recovers unknown publication with exactly the stored bytes', async () => {
    f.adapter.broadcast.mockRejectedValueOnce(new Error('timeout'));
    const row = await f.management.prepare(1, body());
    await f.management.submit(1, row.id, { signedPsbt: 'a' });
    f.adapter.readback.mockResolvedValue({ confirmed: false, matches: false });
    await expect(f.management.retry(1, row.id, {})).rejects.toMatchObject({ code: 'retry_not_ready' });
    f.advance(30_000);
    expect(await f.management.retry(1, row.id, {})).toMatchObject({ status: 'submitted', txid: TXID });
    expect(f.adapter.broadcast.mock.calls).toEqual([['beef'], ['beef']]);
    expect(f.adapter.validateStored).toHaveBeenCalledTimes(1);
    expect(f.repository.read(row.id, 1)).toMatchObject({ signed_hex: 'beef', txid: TXID });
  });
  test('retry reconciles known pending or confirmed transactions without broadcasting', async () => {
    const row = await f.management.prepare(1, body());
    await f.management.submit(1, row.id, { signedPsbt: 'a' });
    f.adapter.readback.mockResolvedValue({ confirmed: false, matches: false, known: true });
    expect(await f.management.retry(1, row.id, {})).toMatchObject({ status: 'submitted' });
    f.adapter.readback.mockResolvedValue({ confirmed: true, matches: true });
    expect(await f.management.retry(1, row.id, {})).toMatchObject({ status: 'confirmed' });
    expect(f.adapter.broadcast).toHaveBeenCalledTimes(1);
    expect(f.adapter.validateStored).not.toHaveBeenCalled();
  });
  test.each(['submission_unknown', 'confirmed', 'state_changed'])('concurrent manual retries from %s claim one publication and reject replacement data', async (status) => {
    f.adapter.broadcast.mockRejectedValueOnce(new Error('timeout'));
    const row = await f.management.prepare(1, body());
    await f.management.submit(1, row.id, { signedPsbt: 'a' });
    f.repository.status(row.id, 1, status);
    f.adapter.readback.mockResolvedValue({ confirmed: false, matches: false });
    f.advance(30_000);
    await Promise.all([f.management.retry(1, row.id, {}), f.management.retry(1, row.id, {})]);
    expect(f.adapter.broadcast).toHaveBeenCalledTimes(2);
    await expect(f.management.retry(1, row.id, { transactionHex: 'replacement' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.management.retry(2, row.id, {})).rejects.toMatchObject({ code: 'operation_not_found' });
  });
  test('registration journal identifies the created node after submission and confirmation', async () => {
    f.adapter.prepare.mockResolvedValue({ request: { operation: 'register', transactionHex: '00' }, review: { feeSatoshis: '1' } });
    const row = await f.management.prepare(1, { operation: 'register', network: 'testnet', collateralOutpoint: { txid: HASH, vout: 0 }, changes: { service: '1.2.3.4:8369' } });
    await f.management.submit(1, row.id, { signedPsbt: 'a' });
    expect(f.management.operations(1).find((operation) => operation.id === row.id).proTxHash).toBe(TXID);
    expect(await f.management.reconcile(1, row.id)).toMatchObject({ status: 'confirmed', proTxHash: TXID });
    expect(f.repository.read(row.id, 1).protx_hash).toBe(TXID);
  });
  test.each(['confirmed', 'state_changed'])('retry directly recovers a %s transaction removed by a reorg', async (status) => {
    const row = await f.management.prepare(1, body());
    await f.management.submit(1, row.id, { signedPsbt: 'a' });
    f.repository.status(row.id, 1, status);
    f.adapter.readback.mockResolvedValue({ confirmed: false, matches: false });
    f.advance(30_000);
    const result = await f.management.retry(1, row.id, {});
    expect(result).toMatchObject({ status: 'submitted', txid: TXID });
    expect(f.adapter.broadcast.mock.calls).toEqual([['beef'], ['beef']]);
    expect(f.adapter.validateStored).toHaveBeenCalledTimes(1);
    expect(f.repository.read(row.id, 1)).toMatchObject({ signed_hex: 'beef', txid: TXID });
  });
  test.each([
    ['sentry_rpc_unavailable', 'RPC unavailable'],
    [-5, 'No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries. Use gettransaction for wallet transactions.'],
    [-5, 'No such mempool transaction. Blockchain transactions are still in the process of being indexed. Use gettransaction for wallet transactions.'],
  ])('unverified readback %s never changes confirmed status or signed journal', async (code, message) => {
    const row = await f.management.prepare(1, body());
    await f.management.submit(1, row.id, { signedPsbt: 'a' });
    await f.management.reconcile(1, row.id);
    const before = f.repository.read(row.id, 1);
    f.adapter.readback.mockRejectedValue(Object.assign(new Error(message), { code }));
    await expect(f.management.reconcile(1, row.id)).rejects.toMatchObject({ code });
    await expect(f.management.retry(1, row.id, {})).rejects.toMatchObject({ code });
    expect(f.repository.read(row.id, 1)).toEqual(before);
    expect(f.adapter.broadcast).toHaveBeenCalledTimes(1);
  });
  test('mismatching readback never reports success', async () => {
    const row = await f.management.prepare(1, body());
    await f.management.submit(1, row.id, { signedPsbt: 'a' });
    f.adapter.readback.mockResolvedValue({ confirmed: true, matches: false });
    expect(await f.management.reconcile(1, row.id)).toMatchObject({ status: 'state_changed' });
  });
  test('a lost confirmation is not left labelled confirmed', async () => {
    const row = await f.management.prepare(1, body());
    await f.management.submit(1, row.id, { signedPsbt: 'a' });
    expect(await f.management.reconcile(1, row.id)).toMatchObject({ status: 'confirmed' });
    f.adapter.readback.mockResolvedValue({ confirmed: false, matches: false });
    expect(await f.management.reconcile(1, row.id)).toMatchObject({ status: 'submission_unknown' });
  });
  test('later node updates do not erase an already confirmed transaction success', async () => {
    const row = await f.management.prepare(1, body());
    await f.management.submit(1, row.id, { signedPsbt: 'a' });
    expect(await f.management.reconcile(1, row.id)).toMatchObject({ status: 'confirmed' });
    f.adapter.readback.mockResolvedValue({ confirmed: true, matches: false });
    expect(await f.management.reconcile(1, row.id)).toMatchObject({ status: 'confirmed', errorCode: null });
  });
});
