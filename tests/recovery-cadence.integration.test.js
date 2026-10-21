const request = require('supertest');
const { keccak256, toQuantity, toBeHex, zeroPadValue } = require('ethers');
const { buildTestApp } = require('./helpers/buildTestApp');
const {
  createRecoveryRpc,
  MODULE_ABI,
  ACCOUNT_ABI,
  ZERO_HASH,
  slot,
} = require('../lib/recoveryRpc');
const { ZK_TANENBAUM } = require('../lib/recoveryRegistry');
const ACCOUNT = '0x' + '11'.repeat(20),
  MODULE = '0x' + '22'.repeat(20);
const OP = '0x' + '33'.repeat(32),
  TX = '0x' + '44'.repeat(32);
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');

function fixture() {
  let now = 1800000000000;
  let block = { number: 100, timestamp: now / 1000 - 330, hash: hash(100) };
  let active = false,
    logs = [];
  const headers = new Map([[100, { ...block }]]);
  const rpcRequest = jest.fn(async (method, args) => {
    if (method === 'eth_chainId') return '0xdee1';
    if (method === 'eth_getBlockByNumber') {
      const header =
        args[0] === 'latest' ? block : headers.get(Number(BigInt(args[0])));
      if (!header) throw new Error('unexpected_historical_read');
      return {
        number: toQuantity(header.number),
        timestamp: toQuantity(header.timestamp),
        hash: header.hash,
      };
    }
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_getLogs') return logs;
    if (method === 'eth_getStorageAt') {
      if (active && args[1] === slot('address', ACCOUNT, 3)) return OP;
      if (active && args[1] === slot('bytes32', OP, 4))
        return zeroPadValue(toBeHex(block.timestamp), 32);
      return ZERO_HASH;
    }
    if (method === 'eth_call') {
      const data = args[0].data;
      if (data.startsWith(MODULE_ABI.getFunction('config').selector))
        return MODULE_ABI.encodeFunctionResult('config', [
          [600, 3600, 1, true],
        ]);
      if (data.startsWith(MODULE_ABI.getFunction('policyEpoch').selector))
        return MODULE_ABI.encodeFunctionResult('policyEpoch', [1]);
      if (
        data.startsWith(ACCOUNT_ABI.getFunction('isModuleInstalled').selector)
      )
        return ACCOUNT_ABI.encodeFunctionResult('isModuleInstalled', [true]);
      if (data.startsWith(ACCOUNT_ABI.getFunction('isValidSignature').selector))
        return ACCOUNT_ABI.encodeFunctionResult('isValidSignature', [
          '0x1626ba7e',
        ]);
    }
    throw new Error('unexpected_rpc_call');
  });
  const chain = {
    ...ZK_TANENBAUM,
    recoveryModule: MODULE,
    runtimeHash: keccak256('0x6000'),
  };
  chain.rpc = createRecoveryRpc(chain, { request: rpcRequest, now: () => now });
  const built = buildTestApp({ now: () => now, recoveryChains: [chain] });
  const user = built.users.create({
    email: 'owner@example.com',
    authHash: 'a'.repeat(64),
  });
  built.users.markEmailVerified(user.id);
  const token = built.sessions.issue(user.id).token;
  const call = (method, path) =>
    request(built.app)
      [method](path)
      .set('Cookie', `sid=${token}; csrf=testcsrf`)
      .set('X-CSRF-Token', 'testcsrf');
  const enroll = async () => {
    const challenge = await call('post', '/api/recovery/challenges')
      .send({ chainId: 57057, account: ACCOUNT })
      .expect(200);
    return call('post', '/api/recovery/subscriptions')
      .send({ challengeId: challenge.body.id, signature: '0x1234' })
      .expect(201);
  };
  function schedule() {
    block = { number: 101, timestamp: now / 1000, hash: hash(101) };
    headers.set(101, { ...block });
    active = true;
    const event = MODULE_ABI.encodeEventLog(
      MODULE_ABI.getEvent('RecoveryScheduled'),
      [ACCOUNT, OP, block.timestamp + 600]
    );
    logs = [
      {
        ...event,
        address: MODULE,
        blockNumber: toQuantity(101),
        blockHash: block.hash,
        transactionHash: TX,
        logIndex: '0x0',
        removed: false,
      },
    ];
  }
  return {
    ...built,
    call,
    enroll,
    schedule,
    rpcRequest,
    age: (seconds) => {
      now += seconds * 1000;
    },
    reorg: () => {
      block = { ...block, hash: hash(201) };
      headers.set(101, { ...block });
      active = false;
      logs = [];
    },
  };
}

test('normal sparse cadence permits enrollment and immediate initiation without two future blocks', async () => {
  const f = fixture();
  try {
    await f.enroll();
    await f.recoveryMonitor.tick();
    f.schedule();
    await f.recoveryMonitor.tick();
    const subscriptions = await f
      .call('get', '/api/recovery/subscriptions')
      .expect(200);
    expect(subscriptions.body.subscriptions[0]).toMatchObject({
      monitoring: { status: 'active' },
      pending: [{ operationId: OP, status: 'pending' }],
    });
    expect(
      f.mailer.outbox.filter((mail) =>
        mail.subject.includes('recovery detected')
      )
    ).toHaveLength(1);
    // The schedule's block is still the tip. No fabricated successors or time
    // advancement is needed to observe the risk and deliver the first alert.
    expect(
      f.rpcRequest.mock.calls
        .filter(([method]) => method === 'eth_getBlockByNumber')
        .every(
          ([, args]) => args[0] === 'latest' || Number(BigInt(args[0])) <= 101
        )
    ).toBe(true);
  } finally {
    f.db.close();
  }
});

test('finite sparse-chain limit degrades monitoring instead of claiming old state is healthy', async () => {
  const f = fixture();
  try {
    await f.enroll();
    await f.recoveryMonitor.tick();
    f.age(91); // Existing tip was already 330 seconds old.
    await f.recoveryMonitor.tick();
    const subscriptions = await f
      .call('get', '/api/recovery/subscriptions')
      .expect(200);
    expect(subscriptions.body.subscriptions[0].monitoring.status).toBe(
      'degraded'
    );
  } finally {
    f.db.close();
  }
});

test('latest-observed initiation is corrected when its unfinalized block is replaced', async () => {
  const f = fixture();
  try {
    await f.enroll();
    f.schedule();
    await f.recoveryMonitor.tick();
    f.reorg();
    await f.recoveryMonitor.tick();
    const subscriptions = await f
      .call('get', '/api/recovery/subscriptions')
      .expect(200);
    expect(subscriptions.body.subscriptions[0].pending[0].status).toBe(
      'orphaned'
    );
    expect(
      f.mailer.outbox.some((mail) =>
        mail.subject.includes('no longer on the current chain')
      )
    ).toBe(true);
    expect(
      f.mailer.outbox.some((mail) =>
        mail.subject.includes('canceled or invalidated')
      )
    ).toBe(false);
  } finally {
    f.db.close();
  }
});
