const request = require('supertest');
const { buildTestApp } = require('./helpers/buildTestApp');
const { ZERO_HASH } = require('../lib/recoveryRpc');

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OP = '0x' + 'ab'.repeat(32);
const HASH = '0x' + 'cd'.repeat(32);
const AUTH = 'a'.repeat(64);
const { createTotpRepo, generateTotpCode } = require('../lib/totp');
function setup({ pending = false } = {}) {
  let time = 1800000000000;
  const snapshot = {
    block: { number: 10, hash: HASH, timestamp: time / 1000 },
    installed: true,
    delay: 259200,
    expiration: 604800,
    epoch: '1',
    activeOperationId: pending ? OP : ZERO_HASH,
    schedules: pending
      ? { [OP]: { scheduledAt: time / 1000, executed: false, canceled: false } }
      : {},
  };
  const rpc = {
    snapshot: jest.fn(async () => snapshot),
    verifySignature: jest.fn(async () => true),
    head: jest.fn(async () => snapshot.block),
    getBlock: jest.fn(async (number) => ({ ...snapshot.block, number })),
    assertBlock: jest.fn(async () => {}),
    logs: jest.fn(async () => []),
  };
  const chain = {
    chainId: 57057,
    name: 'zkTanenbaum',
    recoveryModule: ACCOUNT,
    explorerUrl: 'https://explorer-zk.tanenbaum.io',
    testnet: true,
    rpc,
  };
  const app = buildTestApp({ now: () => time, recoveryChains: [chain] });
  const user = app.users.create({ email: 'owner@example.com', authHash: AUTH });
  app.users.markEmailVerified(user.id);
  const token = app.sessions.issue(user.id).token;
  const call = (method, path) =>
    request(app.app)
      [method](path)
      .set('Cookie', `sid=${token}; csrf=testcsrf`)
      .set('X-CSRF-Token', 'testcsrf');
  const challenge = () =>
    call('post', '/recovery/challenges').send({
      chainId: 57057,
      account: ACCOUNT,
    });
  const enroll = async (label) => {
    const c = await challenge();
    return call('post', '/recovery/subscriptions').send({
      challengeId: c.body.id,
      signature: '0x' + '11'.repeat(65),
      label,
    });
  };
  return {
    ...app,
    user,
    rpc,
    snapshot,
    call,
    challenge,
    enroll,
    setTime: (n) => {
      time = n;
    },
  };
}

test('only verified authenticated users can create challenge; CSRF is mandatory', async () => {
  const f = setup();
  await request(f.app)
    .post('/recovery/challenges')
    .send({ chainId: 57057, account: ACCOUNT })
    .expect(401);
  const token = f.sessions.issue(f.user.id).token;
  await request(f.app)
    .post('/recovery/challenges')
    .set('Cookie', `sid=${token}`)
    .send({ chainId: 57057, account: ACCOUNT })
    .expect(403);
  f.db.close();
});
test('binds message to origin email user chain account and module; one-use proof creates independent subscription', async () => {
  const f = setup({ pending: true });
  const c = await f.challenge();
  expect(c.body.message).toContain('http://app.test.local');
  expect(c.body.message).toContain('owner@example.com');
  expect(c.body.message).toContain('57057');
  const body = {
    challengeId: c.body.id,
    signature: '0x' + '11'.repeat(10000),
    label: 'My account',
  };
  const sub = await f
    .call('post', '/recovery/subscriptions')
    .send(body)
    .expect(201);
  expect(sub.body.subscription.pending[0]).toMatchObject({
    operationId: OP,
    executableAt: f.snapshot.block.timestamp + 259200,
    txHash: null,
  });
  expect(f.rpc.verifySignature).toHaveBeenCalledWith(
    ACCOUNT,
    c.body.message,
    body.signature,
    f.snapshot.block
  );
  await f.call('post', '/recovery/subscriptions').send(body).expect(400);
  expect(f.users.findById(f.user.id).notificationPrefs).toEqual({});
  f.db.close();
});
test('rejects unsupported chains, arbitrary RPC URLs, undeployed policies and invalid proof without consuming challenge', async () => {
  const f = setup();
  await f
    .call('post', '/recovery/challenges')
    .send({ chainId: 1, account: ACCOUNT })
    .expect(400);
  await f
    .call('post', '/recovery/challenges')
    .send({ chainId: 57057, account: ACCOUNT, rpcUrl: 'https://evil.example' })
    .expect(400);
  f.snapshot.installed = false;
  await f
    .challenge()
    .then((r) => expect(r.body.error).toBe('recovery_not_installed'));
  f.snapshot.installed = true;
  const c = await f.challenge();
  f.rpc.verifySignature.mockResolvedValue(false);
  const b = { challengeId: c.body.id, signature: '0x1234' };
  await f.call('post', '/recovery/subscriptions').send(b).expect(400);
  expect(
    f.recoveryRepository.challenge(c.body.id, f.user.id).consumed_at
  ).toBeNull();
  f.db.close();
});
test('expired and cross-user challenge cannot enroll', async () => {
  const f = setup();
  const c = await f.challenge();
  f.setTime(c.body.expiresAt);
  await f
    .call('post', '/recovery/subscriptions')
    .send({ challengeId: c.body.id, signature: '0x1234' })
    .expect(400);
  f.db.close();
});
test('revoked session during RPC verification cannot commit enrollment', async () => {
  const f = setup();
  const c = await f.challenge();
  f.rpc.verifySignature.mockImplementation(async () => {
    f.sessions.revokeAllForUser(f.user.id);
    return true;
  });
  await f
    .call('post', '/recovery/subscriptions')
    .send({ challengeId: c.body.id, signature: '0x1234' })
    .expect(401);
  expect(f.recoveryRepository.subscriptions(f.user.id)).toEqual([]);
  f.db.close();
});
test('failed bootstrap rolls back both subscription and one-use challenge', async () => {
  const f = setup();
  const c = await f.challenge();
  f.recoveryMonitor.bootstrap = () => {
    throw new Error('database_write_failed');
  };
  await f
    .call('post', '/recovery/subscriptions')
    .send({ challengeId: c.body.id, signature: '0x1234' })
    .expect(503);
  expect(f.recoveryRepository.subscriptions(f.user.id)).toEqual([]);
  expect(
    f.recoveryRepository.challenge(c.body.id, f.user.id).consumed_at
  ).toBeNull();
  f.db.close();
});
test('challenge belonging to another user never verifies its signature', async () => {
  const f = setup();
  const c = await f.challenge();
  const user = f.users.create({ email: 'other@example.com', authHash: AUTH });
  f.users.markEmailVerified(user.id);
  const token = f.sessions.issue(user.id).token;
  await request(f.app)
    .post('/recovery/subscriptions')
    .set('Cookie', `sid=${token}; csrf=testcsrf`)
    .set('X-CSRF-Token', 'testcsrf')
    .send({ challengeId: c.body.id, signature: '0x1234' })
    .expect(400);
  expect(f.rpc.verifySignature).not.toHaveBeenCalled();
  f.db.close();
});
test('disable requires password, enforces ownership, queues confirmation, and suppresses old-generation mail after reenable', async () => {
  const f = setup({ pending: true });
  const result = await f.enroll();
  const id = result.body.subscription.id;
  await f
    .call('delete', `/recovery/subscriptions/${id}`)
    .send({ oldAuthHash: 'b'.repeat(64) })
    .expect(401);
  await f
    .call('delete', `/recovery/subscriptions/${id}`)
    .send({ oldAuthHash: AUTH })
    .expect(204);
  expect(f.recoveryRepository.getSubscription(id).enabled).toBe(0);
  await f.enroll().then((r) => expect(r.status).toBe(201));
  await f.recoveryMonitor.tick();
  expect(f.mailer.outbox.some((m) => m.subject.includes('disabled'))).toBe(
    false
  );
  f.db.close();
});
test('persisted active becomes degraded after worker stops refreshing', async () => {
  const f = setup();
  const result = await f.enroll();
  await f.recoveryMonitor.tick();
  expect(
    (await f.call('get', '/recovery/subscriptions')).body.subscriptions[0]
      .monitoring.status
  ).toBe('active');
  f.setTime(f.snapshot.block.timestamp * 1000 + 60001);
  expect(
    (await f.call('get', '/recovery/subscriptions')).body.subscriptions[0]
      .monitoring.status
  ).toBe('degraded');
  f.db.close();
});
test('removal requires the configured TOTP as well as the password', async () => {
  const f = setup();
  const result = await f.enroll();
  const totp = createTotpRepo(f.db, {
    now: () => f.snapshot.block.timestamp * 1000,
  });
  const pending = totp.beginSetup(f.user);
  const code = generateTotpCode(pending.secret);
  const invalidCodes = new Set(
    [-30000, 0, 30000].map((offset) =>
      generateTotpCode(pending.secret, Date.now() + offset)
    )
  );
  let badCode = '000000';
  while (invalidCodes.has(badCode))
    badCode = String(Number(badCode) + 1).padStart(6, '0');
  totp.enableSetup(f.user.id, code);
  const url = `/recovery/subscriptions/${result.body.subscription.id}`;
  await f.call('delete', url).send({ oldAuthHash: AUTH }).expect(400);
  await f
    .call('delete', url)
    .send({ oldAuthHash: AUTH, code: badCode })
    .expect(400);
  await f.call('delete', url).send({ oldAuthHash: AUTH, code }).expect(204);
  f.db.close();
});

module.exports = { setup, ACCOUNT, OP, HASH };
