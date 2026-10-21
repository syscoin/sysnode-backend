import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import {
  AbiCoder, ContractFactory, Contract, Interface, JsonRpcProvider,
  Wallet, TypedDataEncoder, ZeroAddress, concat, hashMessage, id, keccak256,
  toBeHex, zeroPadValue,
} from 'ethers';

const require = createRequire(import.meta.url);
const request = require('supertest');
const { buildTestApp } = require('./helpers/buildTestApp');
const { createRecoveryRpc } = require('../lib/recoveryRpc');
const { ZK_TANENBAUM } = require('../lib/recoveryRegistry');

// Immutable production bytecodes, not a signature mock. The optional local
// source must have the same digest as the pinned upstream source as well.
const PALI_SOURCE = 'https://raw.githubusercontent.com/syscoin/pali-wallet/2505f9a88d9a7bf3cc167bb08f39223ca95c378f/source/utils/smartAccount/deployment.ts';
const PALI_SOURCE_SHA256 = '073b5172698f9964b56fdbe2ff897024ec0b793fa8fa8b3df42b9335d858baa4';

// OZ ERC1967Proxy, solc 0.8.28/Cancun/viaIR/optimizer200/no metadata.
// Compiled beside the pinned Pali account. This fixture only supplies a real
// delegatecall proxy; authorization remains the unmodified Pali implementation.
const PROXY_CREATION = '0x608060405261026c803803806100148161016e565b9283398101604082820312610156578151916001600160a01b03831690818403610156576020810151906001600160401b038211610156570182601f82011215610156578051906001600160401b03821161015a5761007c601f8301601f191660200161016e565b938285526020838301011161015657815f9260208093018387015e8401015281511561014757823b15610135577f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc80546001600160a01b031916821790557fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b5f80a280511561011e5761010e91610193565b505b604051604c90816102208239f35b505034156101105763b398979f60e01b5f5260045ffd5b634c9c8ce360e01b5f5260045260245ffd5b6330a289cf60e21b5f5260045ffd5b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b6040519190601f01601f191682016001600160401b0381118382101761015a57604052565b905f8091602081519101845af4808061020c575b156101c75750506040513d81523d5f602083013e60203d82010160405290565b156101ec57639996b31560e01b5f9081526001600160a01b0391909116600452602490fd5b3d156101fd576040513d5f823e3d90fd5b63d6bda27560e01b5f5260045ffd5b503d1515806101a75750813b15156101a756fe60806040527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545f9081906001600160a01b0316368280378136915af43d5f803e156048573d5ff35b3d5ffd';
const ACCOUNT_ABI = [
  'function initializeAccount(bytes)',
  'function isValidSignature(bytes32,bytes) view returns(bytes4)',
];
const RECOVERY_ABI = [
  'function getRecoveryScheduleHash(address,bytes32,bytes32,bytes) view returns(bytes32)',
  'function getOperationId(address,bytes32,bytes32,bytes) view returns(bytes32)',
  'function scheduleRecovery(address,bytes32,bytes32,bytes,(address guardian,bytes signature)[]) returns(bytes32)',
  'function executeRecovery(address,bytes32,bytes32,bytes) returns(bytes[])',
];
const coder = AbiCoder.defaultAbiCoder();

async function loadBytecodes() {
  const text = process.env.PALI_DEPLOYMENT_SOURCE
    ? await readFile(process.env.PALI_DEPLOYMENT_SOURCE, 'utf8')
    : await fetch(PALI_SOURCE, { signal: AbortSignal.timeout(20000) }).then(async (response) => {
      assert.equal(response.status, 200, 'Pinned Pali source download failed');
      return response.text();
    });
  assert.equal(createHash('sha256').update(text).digest('hex'), PALI_SOURCE_SHA256, 'Pali bytecode source changed');
  const pick = (name) => {
    const match = text.match(new RegExp(`${name}:\\s*'(0x[0-9a-f]+)'`));
    assert.ok(match, `Missing pinned ${name} bytecode`);
    return match[1];
  };
  return {
    account: pick('accountImplementation'),
    ecdsa: pick('ecdsaValidator'),
    recovery: pick('guardianRecoveryModule'),
  };
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function launchAnvil() {
  const port = await freePort();
  const child = spawn(process.env.ANVIL_BIN || 'anvil', [
    '--silent', '--host', '127.0.0.1', '--port', String(port), '--chain-id', '57057', '--hardfork', 'cancun',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let startupError;
  child.once('error', (error) => { startupError = error; });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 57057, { staticNetwork: true });
  provider.pollingInterval = 25;
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Anvil stopped: ${stderr}`);
      try {
        assert.equal(await provider.send('eth_chainId', []), '0xdee1');
        return { child, provider };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`Anvil startup timed out: ${stderr}`);
  } catch (error) {
    provider.destroy();
    child.kill('SIGTERM');
    throw error;
  }
}

function accountSignature(owner, validator, account, message, chainId = 57057) {
  const domain = TypedDataEncoder.hashDomain({
    name: 'pali.smart-account.erc1271', version: '1', chainId, verifyingContract: account,
  });
  const struct = keccak256(coder.encode(['bytes32', 'bytes32'], [id('PersonalSign(bytes prefixed)'), hashMessage(message)]));
  const wrapped = keccak256(concat(['0x1901', domain, struct]));
  return concat([validator, owner.signingKey.sign(wrapped).serialized]);
}

test('real Pali ERC7739/1271 HTTP enrollment and recovery monitoring on isolated Anvil', { timeout: 120000 }, async (t) => {
  const bytecodes = await loadBytecodes();
  const { child, provider } = await launchAnvil();
  let fixture;
  try {
    const deployer = await provider.getSigner(0);
    // Test-only keys remain in this process; never load a real user's wallet.
    const owner = Wallet.createRandom();
    const deploy = async (abi, bytecode, args = []) => {
      const contract = await new ContractFactory(abi, bytecode, deployer).deploy(...args);
      await contract.waitForDeployment();
      return contract;
    };
    const validator = await deploy([], bytecodes.ecdsa);
    const recovery = await deploy(RECOVERY_ABI, bytecodes.recovery);
    const implementation = await deploy(ACCOUNT_ABI, bytecodes.account);
    const validatorAddress = await validator.getAddress();
    const recoveryAddress = await recovery.getAddress();
    assert.equal(keccak256(await provider.getCode(recoveryAddress)), ZK_TANENBAUM.runtimeHash, 'Real module differs from pinned runtime');
    const delay = 600;
    const expiration = 1200;
    const init = coder.encode([
      '(address module,bytes data)[]', '(address module,bytes data)[]', '(address module,bytes data)', '(address module,bytes data)[]',
    ], [
      [[validatorAddress, coder.encode(['address[]', 'uint64'], [[owner.address], 1])]],
      [[recoveryAddress, coder.encode(['uint32', 'uint32', 'address[]', 'uint64'], [delay, expiration, [owner.address], 1])]],
      [ZeroAddress, '0x'], [],
    ]);
    const createAccount = async () => deploy(['constructor(address implementation,bytes init)'], PROXY_CREATION, [
      await implementation.getAddress(), new Interface(ACCOUNT_ABI).encodeFunctionData('initializeAccount', [init]),
    ]);
    const account = await createAccount();
    const anotherAccount = await createAccount();
    const accountAddress = await account.getAddress();
    const anotherAddress = await anotherAccount.getAddress();
    const salt = toBeHex(BigInt(`0x${randomBytes(32).toString('hex')}`), 32);
    const mode = zeroPadValue('0x00', 32);
    // A harmless zero-value executor call, not a recovery configuration mock.
    const execution = concat([owner.address, zeroPadValue('0x00', 32)]);
    const recoveryHash = await recovery.getRecoveryScheduleHash(accountAddress, salt, mode, execution);
    const operationId = (await recovery.getOperationId(accountAddress, salt, mode, execution)).toLowerCase();
    const scheduledTx = await recovery.scheduleRecovery(accountAddress, salt, mode, execution, [[owner.address, owner.signingKey.sign(recoveryHash).serialized]]);
    const scheduledReceipt = await scheduledTx.wait();
    for (let n = 0; n < 3; n++) await provider.send('evm_mine', []);
    let nowMs = Date.now();
    const syncClock = async () => {
      const latest = await provider.send('eth_getBlockByNumber', ['latest', false]);
      nowMs = Math.max(Date.now(), Number(BigInt(latest.timestamp)) * 1000);
    };
    await syncClock();
    const config = { ...ZK_TANENBAUM, recoveryModule: recoveryAddress };
    const rpc = createRecoveryRpc(config, { request: (method, params) => provider.send(method, params), now: () => nowMs });
    const snapshot = await rpc.snapshot(accountAddress);
    assert.equal(snapshot.activeOperationId, operationId);
    assert.equal(snapshot.schedules[operationId].canceled, false);
    assert.equal(snapshot.schedules[operationId].executed, false);
    assert.equal(snapshot.delay, delay);
    fixture = buildTestApp({ now: () => nowMs, recoveryChains: [{ ...config, rpc }] });
    const auth = 'a'.repeat(64);
    const user = fixture.users.create({ email: 'anvil-owner@example.com', authHash: auth });
    fixture.users.markEmailVerified(user.id);
    const token = fixture.sessions.issue(user.id).token;
    const call = (method, path) => request(fixture.app)[method](path).set('Cookie', `sid=${token}; csrf=anvil-csrf`).set('X-CSRF-Token', 'anvil-csrf');
    const challenge = async () => (await call('post', '/recovery/challenges').send({ chainId: 57057, account: accountAddress }).expect(200)).body;

    await t.test('wrong-account, wrong-chain and raw EOA signatures fail real ERC1271; accepted proof cannot replay', async () => {
      const c = await challenge();
      for (const signature of [
        accountSignature(owner, validatorAddress, anotherAddress, c.message),
        accountSignature(owner, validatorAddress, accountAddress, c.message, 1),
        await owner.signMessage(c.message),
      ]) {
        const result = await call('post', '/recovery/subscriptions').send({ challengeId: c.id, signature }).expect(400);
        assert.equal(result.body.error, 'invalid_signature');
      }
      const signature = accountSignature(owner, validatorAddress, accountAddress, c.message);
      const result = await call('post', '/recovery/subscriptions').send({ challengeId: c.id, signature, label: 'Isolated QA account' }).expect(201);
      assert.equal(result.body.subscription.pending[0].operationId, operationId);
      assert.equal(result.body.subscription.pending[0].executableAt, snapshot.schedules[operationId].scheduledAt + delay);
      assert.equal(result.body.subscription.pending[0].expiresAt, snapshot.schedules[operationId].scheduledAt + delay + expiration);
      // The pending recovery was already older than the enrollment scan anchor.
      assert.ok(scheduledReceipt.blockNumber < snapshot.block.number);
      assert.equal(result.body.subscription.pending[0].txHash, null);
      await call('post', '/recovery/subscriptions').send({ challengeId: c.id, signature }).expect(400);
    });

    await t.test('worker detects the pending recovery without historical lookup and sends truthful notices', async () => {
      await fixture.recoveryMonitor.tick();
      const rows = (await call('get', '/recovery/subscriptions').expect(200)).body.subscriptions;
      assert.equal(rows[0].monitoring.status, 'active');
      assert.equal(rows[0].pending[0].status, 'pending');
      assert.ok(fixture.mailer.outbox.some((item) => item.subject === 'Sysnode: Recovery alerts enabled'));
      assert.ok(fixture.mailer.outbox.some((item) => item.subject === 'Sysnode: Smart account recovery detected'));
    });

    await t.test('permissionless execution after the delay is detected from the real module', async () => {
      const at = snapshot.schedules[operationId].scheduledAt + delay + 1;
      await provider.send('evm_setNextBlockTimestamp', [at]);
      await provider.send('evm_mine', []);
      const sent = await recovery.executeRecovery(accountAddress, salt, mode, execution);
      await sent.wait();
      for (let n = 0; n < 3; n++) await provider.send('evm_mine', []);
      await syncClock();
      await fixture.recoveryMonitor.tick();
      const rows = (await call('get', '/recovery/subscriptions').expect(200)).body.subscriptions;
      assert.equal(rows[0].pending[0].status, 'executed');
      assert.ok(fixture.mailer.outbox.some((item) => item.subject === 'Sysnode: Smart account recovery executed'));
      const count = fixture.mailer.outbox.length;
      await fixture.recoveryMonitor.tick();
      assert.equal(fixture.mailer.outbox.length, count, 'A repeated poll must not resend the same event');
    });

    const scheduleAnother = async () => {
      const nextSalt = toBeHex(BigInt(`0x${randomBytes(32).toString('hex')}`), 32);
      const nextHash = await recovery.getRecoveryScheduleHash(accountAddress, nextSalt, mode, execution);
      const nextId = (await recovery.getOperationId(accountAddress, nextSalt, mode, execution)).toLowerCase();
      const tx = await recovery.scheduleRecovery(accountAddress, nextSalt, mode, execution, [[owner.address, owner.signingKey.sign(nextHash).serialized]]);
      const receipt = await tx.wait();
      const block = await provider.send('eth_getBlockByNumber', [toBeHex(receipt.blockNumber), false]);
      return { salt: nextSalt, operationId: nextId, scheduledAt: Number(BigInt(block.timestamp)) };
    };
    const execute = async (op) => {
      await provider.send('evm_setNextBlockTimestamp', [op.scheduledAt + delay + 1]);
      const tx = await recovery.executeRecovery(accountAddress, op.salt, mode, execution);
      await tx.wait();
      for (let n = 0; n < 3; n++) await provider.send('evm_mine', []);
      await syncClock();
    };

    await t.test('a recovery initiated and executed entirely between polls still generates an alert', async () => {
      const second = await scheduleAnother();
      const before = fixture.mailer.outbox.length;
      await execute(second);
      await fixture.recoveryMonitor.tick();
      const rows = (await call('get', '/recovery/subscriptions').expect(200)).body.subscriptions;
      assert.equal(rows[0].pending.find((item) => item.operationId === second.operationId).status, 'executed');
      assert.ok(fixture.mailer.outbox.slice(before).some((item) => item.subject === 'Sysnode: Smart account recovery executed'));
    });

    let restoredPendingOperation;
    await t.test('a real chain reorganization restores pending state and sends a correction, not a cancellation', async () => {
      const third = await scheduleAnother();
      restoredPendingOperation = third;
      for (let n = 0; n < 3; n++) await provider.send('evm_mine', []);
      await syncClock();
      await fixture.recoveryMonitor.tick();
      const checkpoint = await provider.send('evm_snapshot', []);
      await execute(third);
      await fixture.recoveryMonitor.tick();
      const before = fixture.mailer.outbox.length;
      assert.equal(await provider.send('evm_revert', [checkpoint]), true);
      for (let n = 0; n < 3; n++) await provider.send('evm_mine', []);
      await syncClock();
      await fixture.recoveryMonitor.tick();
      const rows = (await call('get', '/recovery/subscriptions').expect(200)).body.subscriptions;
      assert.equal(rows[0].pending.find((item) => item.operationId === third.operationId).status, 'pending');
      const corrections = fixture.mailer.outbox.slice(before);
      assert.ok(corrections.some((item) => item.subject === 'Sysnode: Recovery monitoring detected a chain reorganization'));
      assert.ok(!corrections.some((item) => /canceled/.test(item.subject)));
    });

    await t.test('a reorganization removing a completed attempt does not leave a false executed history row', async () => {
      const checkpoint = await provider.send('evm_snapshot', []);
      await execute(restoredPendingOperation);
      const fourth = await scheduleAnother();
      await execute(fourth);
      await fixture.recoveryMonitor.tick();
      assert.equal(await provider.send('evm_revert', [checkpoint]), true);
      for (let n = 0; n < 3; n++) await provider.send('evm_mine', []);
      await syncClock();
      await fixture.recoveryMonitor.tick();
      const rows = (await call('get', '/recovery/subscriptions').expect(200)).body.subscriptions;
      assert.equal(rows[0].pending.find((item) => item.operationId === fourth.operationId).status, 'orphaned');
      assert.equal(rows[0].pending.find((item) => item.operationId === restoredPendingOperation.operationId).status, 'pending');
    });

    await t.test('disabling requires the verified account password and stops new notices', async () => {
      const subscription = (await call('get', '/recovery/subscriptions')).body.subscriptions[0];
      await call('delete', `/recovery/subscriptions/${subscription.id}`).send({ oldAuthHash: 'b'.repeat(64) }).expect(401);
      await call('delete', `/recovery/subscriptions/${subscription.id}`).send({ oldAuthHash: auth }).expect(204);
      await fixture.recoveryMonitor.tick();
      assert.ok(fixture.mailer.outbox.some((item) => item.subject === 'Sysnode: Recovery alerts disabled'));
      assert.deepEqual((await call('get', '/recovery/subscriptions')).body.subscriptions, []);
    });
  } finally {
    if (fixture) {
      fixture.recoveryMonitor.stop();
      fixture.db.close();
    }
    provider.destroy();
    child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
});
