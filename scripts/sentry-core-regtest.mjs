// Opt-in consensus smoke test. A fresh, disconnected Core regtest instance
// and synthetic wallet are created; this never connects to a public network.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
const sdk = await import(process.env.SENTRY_SDK_TEST_MODULE || '@sidhujag/sysweb3-sentry');

const require = createRequire(import.meta.url);
const { createSentryAdapter } = require('../lib/sentryAdapter');
const { createSentryRepository, createSentryManagement } = require('../lib/sentryManagement');
const { openDatabase } = require('../lib/db');
const { utils, SyscoinJSLib } = require('syscoinjs-lib');
const exec = promisify(execFile);
const core = process.env.SENTRY_CORE_BIN;
assert(core, 'Set SENTRY_CORE_BIN to the directory containing syscoind and syscoin-cli');
const datadir = await mkdtemp(join(tmpdir(), 'sentry-core-regtest-'));
const server = createServer();
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const args = ['-regtest', `-datadir=${datadir}`, `-rpcport=${port}`, '-server=1', '-listen=0', '-connect=0', '-dnsseed=0', '-discover=0', '-txindex=1', '-fallbackfee=0.0001', '-dip3params=1:1', '-dip19params=1', '-mncollateral=100'];
const daemon = spawn(resolve(core, 'syscoind'), args, { stdio: 'ignore' });
let wallet = false;
let indexer;
let database;
async function rpc(method, params = []) {
  const result = await exec(resolve(core, 'syscoin-cli'), ['-regtest', `-datadir=${datadir}`, `-rpcport=${port}`, ...(wallet ? ['-rpcwallet=sentry-qa'] : []), method,
    ...params.map((param) => typeof param === 'string' ? param : JSON.stringify(param))], { maxBuffer: 4 * 1024 * 1024 });
  const value = result.stdout.trim();
  try { return JSON.parse(value); } catch { return value; }
}
try {
  await exec(resolve(core, 'syscoin-cli'), ['-regtest', `-datadir=${datadir}`, `-rpcport=${port}`, '-rpcwait', '-rpcwaittimeout=30', 'getblockchaininfo']);
  await rpc('createwallet', ['sentry-qa', false, false, '', false, true]);
  wallet = true;
  // The installed general-purpose address classifier supports the standard
  // Bitcoin testnet legacy prefix but does not include bcrt. Use Core legacy
  // addresses in this regtest; public-network addresses are not substituted.
  const address = () => rpc('getnewaddress', ['', 'legacy']);
  const mining = await address();
  await rpc('generatetoaddress', [120, mining]);
  const capabilities = await rpc('protx_capabilities');
  assert.equal(capabilities.era, 'legacy-v3');
  assert.equal(capabilities.requiredCollateralSatoshis, '10000000000');
  const owner = await rpc('getnewaddress');
  const collateralAddress = await rpc('getnewaddress');
  const payout = await rpc('getnewaddress');
  const feeAddress = await address();
  const initialOperator = await sdk.importSentryOperatorKey('bls-basic', '00'.repeat(31) + '01');
  const operator = await sdk.importSentryOperatorKey('bls-basic', '00'.repeat(31) + '02');
  await rpc('sendtoaddress', [feeAddress, 200]);
  await rpc('generatetoaddress', [1, mining]);
  const proTxHash = await rpc('protx_register_fund', [collateralAddress, '1.2.3.4:18369', owner, initialOperator.publicKey, owner, 0, payout, feeAddress, true, false]);
  // Confirmation is evaluated from the previous block after two node-payment
  // rounds, so the registering block itself is not one of these confirmations.
  await rpc('generatetoaddress', [5, mining]);
  const info = await rpc('protx_info', [proTxHash]);
  assert(info.state.confirmedHash && !/^0+$/.test(info.state.confirmedHash), 'Registered node must be confirmed before NEVM updates');
  // Operator rotation resets service and bans until the new operator supplies
  // a service update. Recover that genuine Core lifecycle through the SDK.
  await rpc('protx_update_registrar', [proTxHash, operator.publicKey, '', '', feeAddress, false]);
  await rpc('generatetoaddress', [1, mining]);
  const resetState = (await rpc('protx_info', [proTxHash])).state;
  assert(resetState.PoSeBanHeight >= 0);
  console.log(JSON.stringify({ stage: 'operator-reset', service: resetState.service, poseBanHeight: resetState.PoSeBanHeight }));
  const bitcoinjs = utils.bitcoinjs;
  // Core regtest deliberately uses Bitcoin regtest address prefixes; this
  // isolated harness must not label those addresses as Tanenbaum testnet.
  const network = { ...utils.syscoinNetworks.testnet, bech32: 'bcrt', pubKeyHash: 111 };
  // Minimal local read-only Blockbook-compatible raw-tx endpoint for the
  // library's legacy-input PSBT population. The data comes from real Core.
  indexer = createHttpServer(async (request, response) => {
    const match = request.method === 'GET' && /^\/api\/v2\/tx\/([0-9a-f]{64})$/.exec(request.url);
    if (!match) { response.writeHead(404); response.end(); return; }
    try {
      const hex = await rpc('getrawtransaction', [match[1], false]);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ hex }));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((done) => indexer.listen(0, '127.0.0.1', done));
  const fundingLibrary = new SyscoinJSLib(null, `http://127.0.0.1:${indexer.address().port}`, network);
  const fundingClient = {
    bitcoinjs, network,
    async fetchUtxos() {
      return (await rpc('listunspent', [1])).map((utxo) => ({ ...utxo, value: Math.round(utxo.amount * 1e8) }));
    },
    createTransaction: (...parameters) => fundingLibrary.createTransaction(...parameters),
  };
  const genesisHash = await rpc('getblockhash', [0]);
  const adapter = createSentryAdapter({ rpcCall: rpc, network: 'regtest', genesisHash, sdk, fundingClient });
  database = openDatabase(':memory:');
  database.prepare("INSERT INTO users (id,email,stored_auth,email_verified,salt_v,notification_prefs,created_at,updated_at) VALUES (1,'fixture@example.test','x',1,'a','{}',1,1)").run();
  let now = Date.now();
  let broadcastAttempts = 0;
  let simulateOutage = true;
  const repository = createSentryRepository(database, { now: () => now });
  const management = createSentryManagement({ repository, now: () => now, adapter: {
    ...adapter,
    broadcast: async (hex) => { broadcastAttempts++; if (simulateOutage) throw new Error('Simulated transport outage before delivery'); return adapter.broadcast(hex); },
  } });
  const observed = [];
  let tamperedAddressRejection;
  const updates = [
    { operation: 'revive service', changes: { service: '1.2.3.4:18369' } },
    { operation: 'add', changes: { nevmAddress: `0x${'12'.repeat(20)}` } },
    { operation: 'update', changes: { nevmAddress: `0x${'34'.repeat(20)}` } },
    { operation: 'remove', changes: { nevmAddress: '' } },
  ];
  for (const update of updates) {
    const prepared = await adapter.prepare({ network: 'regtest', proTxHash, changes: update.changes, xpub: 'vpub-synthetic-regtest-fee-account', changeAddress: feeAddress, feeRate: 10 });
    const context = await adapter.context('regtest', proTxHash);
    const inputs = sdk.decodeSentryTransaction(prepared.request.transactionHex).inputs;
    const previousTransactions = await Promise.all([...new Set(inputs.map((input) => input.txid))].map((txid) => rpc('getrawtransaction', [txid, false])));
    const authorization = await sdk.signSentryOperation(prepared.request, { ...context, previousTransactions, maxFeeSatoshis: '1000000' }, operator);
    const row = { network: 'regtest', protx_hash: proTxHash, prepared };
    const authorized = await adapter.authorize(row, authorization);
    if (!tamperedAddressRejection && update.changes.nevmAddress) {
      // Change one address byte after operator approval, then legitimately
      // re-sign only the fee input. Core must still reject the authorization.
      const original = bitcoinjs.Psbt.fromBase64(authorized.psbt.psbt, { network });
      const tampered = new bitcoinjs.Psbt({ network });
      tampered.setVersion(original.version); tampered.setLocktime(original.locktime);
      original.txInputs.forEach((input, index) => tampered.addInput({ ...original.data.inputs[index], ...input }));
      original.txOutputs.forEach((output) => {
        const script = Buffer.from(output.script);
        if (script[0] === 0x6a) script[script.length - 1] ^= 1;
        tampered.addOutput({ script, value: output.value });
      });
      const feeSigned = await rpc('walletprocesspsbt', [tampered.toBase64()]);
      assert.equal(feeSigned.complete, true);
      const tamperedHex = bitcoinjs.Psbt.fromBase64(feeSigned.psbt, { network }).extractTransaction().toHex();
      const [rejected] = await rpc('testmempoolaccept', [[tamperedHex]]);
      assert.equal(rejected.allowed, false, 'Changing NEVM after operator approval must fail Core verification');
      tamperedAddressRejection = rejected['reject-reason'];
      assert.match(tamperedAddressRejection, /bad-protx-bls-sig/);
    }
    const signed = await rpc('walletprocesspsbt', [authorized.psbt.psbt]);
    assert.equal(signed.complete, true);
    const verified = await adapter.validateSigned(row, signed.psbt);
    if (!observed.length) {
      const journal = repository.create(1, 'regtest', proTxHash, prepared);
      assert.equal((await management.submit(1, journal.id, { signedPsbt: signed.psbt })).status, 'submission_unknown');
      simulateOutage = false; now += 30_000;
      assert.equal((await management.retry(1, journal.id, {})).status, 'submitted');
      assert.equal((await management.retry(1, journal.id, {})).status, 'submitted');
      assert.equal(broadcastAttempts, 2, 'A known mempool transaction must not be broadcast again');
      assert.equal(repository.read(journal.id, 1).signed_hex, verified.transactionHex);
      assert.equal(repository.read(journal.id, 1).txid, verified.txid);
    } else assert.equal(await adapter.broadcast(verified.transactionHex), verified.txid);
    assert.deepEqual(await adapter.readback({ ...row, txid: verified.txid }), { confirmed: false, matches: false, known: true });
    await rpc('generatetoaddress', [1, mining]);
    assert.deepEqual(await adapter.readback({ ...row, txid: verified.txid }), { confirmed: true, matches: true });
    const state = (await rpc('protx_info', [proTxHash])).state;
    assert.equal(state.nevmAddress || '', update.changes.nevmAddress || '');
    if (update.changes.service) { assert.equal(state.service, update.changes.service); assert.equal(state.PoSeBanHeight, -1); }
    observed.push({ operation: update.operation, txid: verified.txid, nevmAddress: state.nevmAddress || '' });
  }
  console.log(JSON.stringify({ result: 'passed', scope: 'disconnected synthetic legacy-v3 regtest', proTxHash, tamperedAddressRejection, manualRetry: 'same bytes and txid after simulated transport outage; known mempool retry skipped', observed, datadir }, null, 2));
} finally {
  database?.close();
  if (indexer) await new Promise((done) => indexer.close(done));
  await rpc('stop').catch(() => daemon.kill('SIGTERM'));
  await new Promise((done) => daemon.exitCode !== null ? done() : daemon.once('exit', done));
}
