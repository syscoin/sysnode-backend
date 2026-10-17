import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const sdk = await import(process.env.SENTRY_SDK_TEST_MODULE || '@sidhujag/sysweb3-sentry');
const require = createRequire(import.meta.url);
const syscoinjs = require('syscoinjs-lib');
const { createSentryAdapter } = require('../lib/sentryAdapter');
const bitcoinjs = syscoinjs.utils.bitcoinjs;
const network = syscoinjs.utils.syscoinNetworks.testnet;
const ECPair = require('ecpair').ECPairFactory(require('@bitcoinerlab/secp256k1'));
const GENESIS = '12'.repeat(32);
const PROTX = '23'.repeat(32);

async function fixture(era = 'legacy-v3', { preparationActive = false, enrolled = true, pqOwner = false, banned = false } = {}) {
  const operator = era === 'legacy-v3'
    ? await sdk.importSentryOperatorKey('bls-basic', '00'.repeat(31) + '01')
    : await sdk.deriveSentryOperatorKey('slh-dsa-shake-128s', '03'.repeat(48));
  const payer = ECPair.fromPrivateKey(Buffer.from('01'.repeat(32), 'hex'));
  const owner = await sdk.importSentryAuthorityKey('owner', 'secp256k1', '02'.repeat(32));
  const ownerPayment = bitcoinjs.payments.p2wpkh({ pubkey: Buffer.from(owner.publicKey, 'hex'), network });
  const payment = bitcoinjs.payments.p2wpkh({ pubkey: payer.publicKey, network });
  const previous = new bitcoinjs.Transaction();
  previous.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from('0101', 'hex'));
  previous.addOutput(payment.output, 1000000n);
  const collateral = bitcoinjs.Transaction.fromHex(previous.toHex()); collateral.locktime = 1;
  const rpcCalls = [];
  let nevmAddress = '';
  const record = {
    publicKey: operator.publicKey, keyVersion: 1, recordVersion: 1, profile: 1,
    hasGlobalKey: true, active: true, revokedHeight: -1,
    childKeyCommitment: '01000100eb0010000100000064000000' + '66'.repeat(32) + '77'.repeat(32), activatedHeight: 1, genesisHash: GENESIS,
    height: 10, blockHash: 'ff'.repeat(32),
  };
  const node = { proTxHash: PROTX, operatorPublicKey: operator.publicKey, service: '1.2.3.4:18369',
    nevmAddress, operatorPayoutScript: '', collateralOutpoint: { txid: '78'.repeat(32), vout: 0 },
    ...(era === 'pq-v4' ? { globalKeyVersion: 1, pqRecord: { version: 1, profile: 1, keyVersion: 1, publicKey: operator.publicKey, childKeyCommitmentHex: record.childKeyCommitment, activatedHeight: 1 } } : {}),
  };
  const rpcCall = async (method, args) => {
    rpcCalls.push({ method, args });
    if (method === 'getblockchaininfo') return { chain: 'test' };
    if (method === 'getblockhash') return GENESIS;
    if (method === 'protx_capabilities') return { version: 1, genesisHash: GENESIS, network: 'test', era, height: 10, blockHash: 'ff'.repeat(32), requiredCollateralSatoshis: '1000000', preparationActive };
    if (method === 'protx_info') return { proTxHash: PROTX, collateralHash: node.collateralOutpoint.txid, collateralIndex: 0, state: { pubKeyOperator: operator.publicKey, ownerAddress: pqOwner ? undefined : ownerPayment.address, ...(pqOwner ? { ownerKeyType: 'slh-dsa', pqOwnerPublicKey: '55'.repeat(32), pqOwnerKeyVersion: 1, pqOwnerKeyActivationHeight: 5 } : {}), votingAddress: payment.address, payoutAddress: payment.address, PoSeBanHeight: banned ? 10 : -1, confirmedHash: '45'.repeat(32), service: node.service, nevmAddress } };
    if (method === 'protx_operator_key_info') { assert.deepEqual(args, [PROTX, true]); return enrolled ? record : { hasGlobalKey: false, active: false, revokedHeight: -1, genesisHash: GENESIS, height: 10, blockHash: 'ff'.repeat(32) }; }
    if (method === 'protx_list') return [{ proTxHash: PROTX, collateralHash: node.collateralOutpoint.txid, collateralIndex: 0 }];
    if (method === 'getrawtransaction') return args[1] === true ? { confirmations: 1 } : args[0] === collateral.getId() ? collateral.toHex() : previous.toHex();
    if (method === 'gettxout') return { confirmations: 10 };
    if (method === 'testmempoolaccept') return [{ allowed: true }];
    if (method === 'sendrawtransaction') return bitcoinjs.Transaction.fromHex(args[0]).getId();
    throw new Error(`unexpected ${method}`);
  };
  const fundingClient = {
    bitcoinjs, network, networkKey: 'testnet',
    async fetchUtxos() { return [{ txid: previous.getId(), vout: 0, confirmations: 1 }, { txid: node.collateralOutpoint.txid, vout: 0, confirmations: 100 }, { txid: '34'.repeat(32), vout: 0, confirmations: 1, assetInfo: {} }, { txid: '35'.repeat(32), vout: 0, confirmations: 0 }]; },
    async createTransaction(options, address, outputs, rate, xpub, unspent) {
      assert.deepEqual(unspent.utxos, [{ txid: previous.getId(), vout: 0, confirmations: 1 }]);
      const psbt = new bitcoinjs.Psbt({ network });
      psbt.addInput({ hash: previous.getId(), index: 0, witnessUtxo: { script: payment.output, value: 1000000n } });
      psbt.addOutput({ script: outputs[0].script, value: 0n });
      psbt.addOutput({ address, value: 990000n });
      psbt.addUnknownKeyValToOutput(1, { key: Buffer.from('address'), value: Buffer.from(address) });
      return { psbt };
    },
  };
  const adapter = createSentryAdapter({ rpcCall, network: 'testnet', genesisHash: GENESIS, sdk, fundingClient });
  return { adapter, operator, owner, ownerPayment, collateral, payer, payment, previous, node, rpcCalls, setNEVM: (value) => { nevmAddress = value; } };
}

for (const era of ['legacy-v3', 'pq-v4']) test(`${era}: prepare -> operator authorization -> fee signing -> exact-byte submission and readback`, async () => {
  const f = await fixture(era);
  const prepared = await f.adapter.prepare({ network: 'testnet', proTxHash: PROTX,
    changes: { nevmAddress: `0x${'56'.repeat(20)}` }, xpub: 'vpub12345678901234567890', changeAddress: f.payment.address });
  const context = { chain: prepared.request.chain, node: f.node, previousTransactions: [f.previous.toHex()], maxFeeSatoshis: '1000000' };
  const authorization = await sdk.signSentryOperation(prepared.request, context, f.operator);
  const row = { network: 'testnet', protx_hash: PROTX, prepared };
  const authorized = await f.adapter.authorize(row, authorization);
  const psbt = bitcoinjs.Psbt.fromBase64(authorized.psbt.psbt, { network });
  const finalOutput = psbt.txOutputs[psbt.txOutputs.length - 1];
  assert.equal(finalOutput.script[0], 0x6a);
  assert.equal(Buffer.from(psbt.data.outputs[0].unknownKeyVals[0].value).toString(), f.payment.address);
  assert.equal(psbt.data.outputs[1].unknownKeyVals, undefined);
  psbt.signAllInputs(f.payer); psbt.finalizeAllInputs();
  const verified = await f.adapter.validateSigned(row, psbt.toBase64());
  assert.equal(await f.adapter.broadcast(verified.transactionHex), verified.txid);
  assert.equal(f.rpcCalls.filter((call) => call.method === 'sendrawtransaction').length, 1);
  f.setNEVM(prepared.review.changes.nevmAddress.next);
  assert.deepEqual(await f.adapter.readback({ ...row, txid: verified.txid }), { confirmed: true, matches: true });
  await assert.rejects(f.adapter.authorize(row, authorization), /node_state_changed/);
  f.setNEVM('');
  const wrong = bitcoinjs.Psbt.fromBase64(authorized.psbt.psbt, { network });
  wrong.setLocktime(10); wrong.signAllInputs(f.payer); wrong.finalizeAllInputs();
  // lockTime is transaction semantics outside Core's operator digest. The
  // backend still binds it to the exact prepared unsigned transaction.
  await assert.rejects(f.adapter.validateSigned(row, wrong.toBase64()));
});

test('context keeps active PQ owners without requiring a removed legacy owner address', async () => {
  const f = await fixture('pq-v4', { pqOwner: true });
  const context = await f.adapter.context('testnet', PROTX);
  assert.equal(context.node.ownerKeyId, '00'.repeat(20));
  assert.deepEqual(context.node.pqOwnerRecord, { publicKey: '55'.repeat(32), keyVersion: 1, activatedHeight: 5 });
});

test('banned nodes may restore service but cannot change their NEVM address', async () => {
  const f = await fixture('legacy-v3', { banned: true });
  const base = { network: 'testnet', proTxHash: PROTX, xpub: 'vpub12345678901234567890', changeAddress: f.payment.address };
  await assert.rejects(f.adapter.prepare({ ...base, changes: { nevmAddress: `0x${'56'.repeat(20)}` } }), /node_banned/);
  const prepared = await f.adapter.prepare({ ...base, changes: { service: '1.2.3.5:18369' } });
  assert.equal(prepared.review.changes.service.next, '1.2.3.5:18369');
  assert.equal(prepared.review.changes.nevmAddress.next, '');
});

test('operator preparation requires owner and new operator proof before fee PSBT', async () => {
  const f = await fixture('legacy-v3', { preparationActive: true, enrolled: false });
  const candidate = await sdk.deriveSentryOperatorKey('slh-dsa-shake-128s', '04'.repeat(48));
  const prepared = await f.adapter.prepare({ operation: 'registerOperator', network: 'testnet', proTxHash: PROTX,
    changes: { operatorPublicKey: candidate.publicKey, childKeyCommitment: '01000100eb0010000100000064000000' + '66'.repeat(32) + '77'.repeat(32), keyVersion: 1 },
    xpub: 'vpub12345678901234567890', changeAddress: f.payment.address });
  const context = { ...await f.adapter.context('testnet', PROTX), previousTransactions: [f.previous.toHex()], maxFeeSatoshis: '1000000' };
  const row = { network: 'testnet', protx_hash: PROTX, prepared };
  const ownerSigned = await sdk.signSentryManagementOperation(prepared.request, context, f.owner);
  assert.equal(ownerSigned.complete, false);
  await assert.rejects(f.adapter.authorize(row, ownerSigned), /invalid_node_authorization/);
  const key = await sdk.importSentryAuthorityKey('operator', candidate.scheme, candidate.secretKey);
  const complete = await sdk.signSentryManagementOperation({ ...prepared.request, transactionHex: ownerSigned.transactionHex }, context, key);
  assert.equal(complete.complete, true);
  await f.adapter.authorize(row, complete);
});

test('legacy registration and owner update use separate required authorities before fee signing', async () => {
  const f = await fixture();
  const collateralKey = await sdk.importSentryAuthorityKey('collateral', 'secp256k1', '01'.repeat(32));
  const registration = await f.adapter.prepare({ operation: 'register', network: 'testnet', collateralOutpoint: { txid: f.collateral.getId(), vout: 0 },
    changes: { service: '1.2.3.4:18369', ownerAddress: f.ownerPayment.address, votingAddress: f.ownerPayment.address, operatorPublicKey: f.operator.publicKey,
      payoutAddress: f.payment.address, operatorRewardBasisPoints: 0 }, xpub: 'vpub12345678901234567890', changeAddress: f.payment.address });
  const registrationContext = await f.adapter.context('testnet', undefined, registration.collateralOutpoint);
  const signedRegistration = await sdk.signSentryManagementOperation(registration.request,
    { ...registrationContext, previousTransactions: [f.previous.toHex()], maxFeeSatoshis: '1000000' }, collateralKey);
  assert.equal(signedRegistration.complete, true);
  const registrationRow = { network: 'testnet', protx_hash: f.collateral.getId(), prepared: registration };
  const authorized = await f.adapter.authorize(registrationRow, signedRegistration);
  const funded = bitcoinjs.Psbt.fromBase64(authorized.psbt.psbt, { network }); funded.signAllInputs(f.payer); funded.finalizeAllInputs();
  await f.adapter.validateSigned(registrationRow, funded.toBase64());
  const update = await f.adapter.prepare({ operation: 'updateRegistrar', network: 'testnet', proTxHash: PROTX,
    changes: { payoutAddress: f.ownerPayment.address }, xpub: 'vpub12345678901234567890', changeAddress: f.payment.address });
  const updateContext = await f.adapter.context('testnet', PROTX);
  const signed = await sdk.signSentryManagementOperation(update.request, { ...updateContext, previousTransactions: [f.previous.toHex()], maxFeeSatoshis: '1000000' }, f.owner);
  assert.equal(signed.complete, true);
  await f.adapter.authorize({ network: 'testnet', protx_hash: PROTX, prepared: update }, signed);
});

for (const era of ['legacy-v3', 'pq-v4']) test(`${era}: revocation requires the registered operator key`, async () => {
  const f = await fixture(era);
  const prepared = await f.adapter.prepare({ operation: 'revoke', network: 'testnet', proTxHash: PROTX,
    changes: { reason: 1 }, xpub: 'vpub12345678901234567890', changeAddress: f.payment.address });
  const context = { ...await f.adapter.context('testnet', PROTX), previousTransactions: [f.previous.toHex()], maxFeeSatoshis: '1000000' };
  const key = await sdk.importSentryAuthorityKey('operator', f.operator.scheme, f.operator.secretKey);
  const signed = await sdk.signSentryManagementOperation(prepared.request, context, key);
  assert.equal(signed.complete, true);
  await f.adapter.authorize({ network: 'testnet', protx_hash: PROTX, prepared }, signed);
});
