import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BN = require('bn.js');
const syscoinjs = require('syscoinjs-lib');
const { buildCollateralPsbt, createDefaultSyscoinClient } = require('../lib/proposalPsbt');
const bitcoinjs = syscoinjs.utils.bitcoinjs;
const network = syscoinjs.utils.syscoinNetworks.testnet;
const ECPair = require('ecpair').ECPairFactory(require('@bitcoinerlab/secp256k1'));
// Synthetic public test identities only. No node or wallet broadcasts occur.
const payer = ECPair.fromPrivateKey(Buffer.alloc(32, 1));
const recipient = ECPair.fromPrivateKey(Buffer.alloc(32, 2));
const changeAddress = bitcoinjs.payments.p2wpkh({ pubkey: payer.publicKey, network }).address;
const recipientAddress = bitcoinjs.payments.p2wpkh({ pubkey: recipient.publicKey, network }).address;
const xpub = 'vpub' + '1'.repeat(40);

function rawUtxo(value, tag, extra = {}) {
  return { txid: tag.repeat(64), vout: 0, value: String(value), address: changeAddress,
    confirmations: 10, path: "m/84'/1'/0'/0/0", ...extra };
}

async function withBlockbook(utxos, check) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'GET' || request.url !== `/api/v2/utxo/${xpub}`) {
      response.writeHead(404); response.end('{}'); return;
    }
    response.end(JSON.stringify(utxos));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = createDefaultSyscoinClient({ blockbookURL: `http://127.0.0.1:${server.address().port}`, networkKey: 'testnet' });
    await check(client);
    assert.ok(requests.length > 0);
    assert.ok(requests.every(request => request.method === 'GET' && request.url === `/api/v2/utxo/${xpub}`));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function finalizeAndCheckFee(psbt, expectedFee) {
  const inputTotal = psbt.data.inputs.reduce((sum, input) => sum + input.witnessUtxo.value, 0n);
  psbt.signAllInputs(payer);
  psbt.finalizeAllInputs();
  const transaction = psbt.extractTransaction();
  const outputTotal = transaction.outs.reduce((sum, output) => sum + output.value, 0n);
  assert.equal(inputTotal - outputTotal, BigInt(String(expectedFee)));
  assert.ok(inputTotal > outputTotal);
  return transaction;
}

test('production collateral builder preserves exact OP_RETURN, non-RBF inputs and actual fee', async () => {
  const hash = 'ab'.repeat(32);
  await withBlockbook([rawUtxo(20_000_000_000, '1')], async client => {
    const result = await buildCollateralPsbt({ opReturnHex: hash, xpub, changeAddress, feeRate: 10, syscoinClient: client });
    const psbt = bitcoinjs.Psbt.fromBase64(result.psbt.psbt, { network });
    assert.equal(result.psbt.assets, '[]');
    assert.equal(psbt.txOutputs.length, 2);
    assert.equal(Buffer.from(psbt.txOutputs[0].script).toString('hex'), `6a20${hash}`);
    assert.equal(psbt.txOutputs[0].value, 15_000_000_000n);
    assert.ok(psbt.txInputs.every(input => input.sequence >= 0xfffffffe));
    const transaction = finalizeAndCheckFee(psbt, result.feeSats);
    assert.ok(BigInt(result.feeSats) >= BigInt(transaction.virtualSize() * 10));
  });
});

test('native send retains its recipient and reports the exact serialized input/output fee', async () => {
  await withBlockbook([rawUtxo(100_000_000, '2')], async client => {
    const result = await client.createTransaction({ rbf: false }, changeAddress,
      [{ address: recipientAddress, value: new BN(50_000_000) }], new BN(10), xpub);
    const transaction = finalizeAndCheckFee(result.psbt, result.fee);
    assert.equal(transaction.outs[0].value, 50_000_000n);
    assert.deepEqual(Buffer.from(transaction.outs[0].script), Buffer.from(bitcoinjs.address.toOutputScript(recipientAddress, network)));
    assert.ok(BigInt(String(result.fee)) >= BigInt(transaction.virtualSize() * 10));
  });
});

test('modern per-UTXO SPT metadata retains all allocations and exact native fees', async () => {
  const utxos = [rawUtxo(100_000_000, '3'), rawUtxo(546, '4', { assetInfo: { assetGuid: '123456', value: '1000' } })];
  await withBlockbook(utxos, async client => {
    const assetMap = new Map([['123456', { changeAddress, outputs: [{ address: recipientAddress, value: new BN(300) }] }]]);
    const library = new syscoinjs.SyscoinJSLib(null, null, network);
    const fetched = await client.fetchUtxos(xpub);
    const result = await library.assetAllocationSend({ rbf: false }, assetMap, changeAddress, new BN(10), xpub, fetched);
    const transaction = finalizeAndCheckFee(result.psbt, result.fee);
    const allocation = syscoinjs.utils.getAllocationsFromTx(transaction).find(entry => entry.assetGuid.toString() === '123456');
    assert.ok(allocation);
    assert.equal(allocation.values.reduce((sum, output) => sum.add(output.value), new BN(0)).toString(), '1000');
    const received = allocation.values.filter(output => Buffer.from(transaction.outs[output.n].script).equals(Buffer.from(bitcoinjs.address.toOutputScript(recipientAddress, network))));
    assert.equal(received.reduce((sum, output) => sum.add(output.value), new BN(0)).toString(), '300');
    assert.ok(BigInt(String(result.fee)) >= BigInt(transaction.virtualSize() * 10));
  });
});

test('dust-valued MAX fails instead of silently dropping the intended recipient', async () => {
  await withBlockbook([rawUtxo(1000, '5')], async client => {
    await assert.rejects(client.createTransaction({ rbf: false }, changeAddress,
      [{ address: recipientAddress, value: new BN(1000), subtractFeeFrom: true }], new BN(10), xpub), /dust|below|fee/i);
  });
});
