const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const request = require('supertest');
const { once } = require('node:events');
const { openDatabase } = require('../lib/db');
const { buildServices, mountAuthAndVault } = require('../lib/appFactory');
const { createMailer } = require('../lib/mailer');
const { _resetPepperForTests } = require('../lib/kdf');
const { isCredentialedPath } = require('../lib/credentialedPaths');

const HASH = 'a'.repeat(64);
const ORIGIN = 'https://sysnode.info';
let db;
let app;
let cookie;
let services;

function mount(disableRateLimit = true) {
  app = express();
  // Match server.js before its shared mount. Deliberately do not add a
  // global session parser like the old standalone test entrypoint did.
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  const authCors = cors({ origin: ORIGIN, credentials: true });
  const legacyCors = cors({ origin: '*', optionsSuccessStatus: 200 });
  app.use((req, res, next) => (isCredentialedPath(req.path) ? authCors : legacyCors)(req, res, next));
  mountAuthAndVault(app, {
    services,
    mailer: createMailer({ transport: 'memory' }),
    frontendUrl: ORIGIN,
    disableRateLimit,
    sentryAdapter: {
      context: async () => ({ node: { proTxHash: HASH } }),
      votingContext: async (network, proposalHash, hashes) => ({ chain: { genesisHash: HASH, era: 'legacy-v3' },
        now: 1800000000, proposalHash, proposal: { name: 'verified-proposal' }, nodes: hashes.map((proTxHash) => ({ proTxHash })) }),
      capabilities: async () => ({ version: 1 }),
      prepare: async () => ({ request: { operation: 'updateService' } }),
    },
  });
  app.get('/govlist', (req, res) => res.json({ attachedUser: !!req.user }));
}
beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.SYSNODE_AUTH_PEPPER = 'd'.repeat(64);
  _resetPepperForTests();
  db = openDatabase(':memory:');
  services = buildServices({ db, secureCookies: false });
  const user = services.users.create({ email: 'owner@example.com', authHash: 'a'.repeat(64) });
  services.users.markEmailVerified(user.id);
  cookie = `sid=${services.sessions.issue(user.id).token}; csrf=test-csrf`;
  mount();
});
afterEach(() => db.close());

async function withListener(run) {
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  try { await run(request(listener)); }
  finally { await new Promise((resolve) => listener.close(resolve)); }
}

test.each(['/api/sentry/v1', '/sentry/v1'])('production composition parses real sessions through %s', async (prefix) => {
  await request(app).get(`${prefix}/nodes`).expect(401);
  await request(app).get(`${prefix}/nodes`).set('Cookie', 'sid=invalid').expect(401);
  const read = await request(app).get(`${prefix}/nodes`).set('Cookie', cookie).expect(200);
  expect(read.body).toEqual([]);
  expect(read.headers['set-cookie'].some((value) => value.startsWith('sid='))).toBe(true);
  expect(read.headers['set-cookie'].find((value) => value.startsWith('sid='))).toContain('Path=/');
  await request(app).post(`${prefix}/nodes`).set('Cookie', cookie).set('Origin', ORIGIN)
    .set('X-CSRF-Token', 'test-csrf').send({ network: 'testnet', proTxHash: HASH, label: 'My node' }).expect(200);
  const nodes = await request(app).get(`${prefix}/nodes`).set('Cookie', cookie).expect(200);
  expect(nodes.body[0].proTxHash).toBe(HASH);
  const prepared = await request(app).post(`${prefix}/operations`).set('Cookie', cookie).set('Origin', ORIGIN)
    .set('X-CSRF-Token', 'test-csrf').send({ network: 'testnet', proTxHash: HASH, changes: { nevmAddress: `0x${'12'.repeat(20)}` } }).expect(200);
  const operations = await request(app).get(`${prefix}/operations`).set('Cookie', cookie).expect(200);
  expect(operations.body[0].id).toBe(prepared.body.id);
});

test.each(['/api/sentry/v1', '/sentry/v1'])('production CORS remains credentialed and exact-origin through %s', async (prefix) => {
  for (const origin of [ORIGIN, 'https://other.example']) {
    const response = await request(app).options(`${prefix}/nodes`)
      .set('Origin', origin).set('Access-Control-Request-Method', 'POST').expect(204);
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  }
  const publicResponse = await request(app).get('/govlist').set('Origin', 'https://other.example').expect(200);
  expect(publicResponse.headers['access-control-allow-origin']).toBe('*');
  expect(publicResponse.headers['access-control-allow-credentials']).toBeUndefined();
});

test.each(['/api/sentry/v1', '/sentry/v1'])('production composition retains origin, CSRF, verified-user and body-size gates through %s', async (prefix) => {
  const path = `${prefix}/nodes`;
  const body = { network: 'testnet', proTxHash: HASH };
  await request(app).post(path).set('Origin', ORIGIN).send(body).expect(401);
  await request(app).post(path).set('Cookie', cookie).set('Origin', 'https://other.example').set('X-CSRF-Token', 'test-csrf').send(body).expect(403);
  await request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body).expect(403);
  await request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).set('X-CSRF-Token', 'wrong').send(body).expect(403);
  const unverified = services.users.create({ email: 'unverified@example.com', authHash: 'b'.repeat(64) });
  await request(app).get(path).set('Cookie', `sid=${services.sessions.issue(unverified.id).token}`).expect(403);
  await request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).set('X-CSRF-Token', 'test-csrf')
    .send({ ...body, label: 'x'.repeat(256 * 1024) }).expect(413);
});

test.each(['/api/sentry/v1', '/sentry/v1'])('public context stays readable through %s and siblings do not parse sessions', async (prefix) => {
  await request(app).get(`${prefix}/context?network=testnet&proTxHash=${HASH}`).expect(200);
  const publicResponse = await request(app).get('/govlist').set('Cookie', cookie).expect(200);
  expect(publicResponse.body).toEqual({ attachedUser: false });
  expect(publicResponse.headers['set-cookie']).toBeUndefined();
});

test('both proxy forms access the same authenticated watch and operation records', async () => {
  await request(app).post('/sentry/v1/nodes').set('Cookie', cookie).set('Origin', ORIGIN)
    .set('X-CSRF-Token', 'test-csrf').send({ network: 'testnet', proTxHash: HASH, label: 'Shared node' }).expect(200);
  const watches = await request(app).get('/api/sentry/v1/nodes').set('Cookie', cookie).expect(200);
  expect(watches.body).toEqual([{ network: 'testnet', proTxHash: HASH, label: 'Shared node' }]);
  const prepared = await request(app).post('/api/sentry/v1/operations').set('Cookie', cookie).set('Origin', ORIGIN)
    .set('X-CSRF-Token', 'test-csrf').send({ network: 'testnet', proTxHash: HASH, changes: { nevmAddress: `0x${'12'.repeat(20)}` } }).expect(200);
  const operations = await request(app).get('/sentry/v1/operations').set('Cookie', cookie).expect(200);
  expect(operations.body[0].id).toBe(prepared.body.id);
});

test('batch watch import preserves labels through both aliases with unchanged authentication', async () => {
  const original = { network: 'testnet', proTxHash: HASH, label: 'Saved label' };
  const incoming = { ...original, label: 'Batch label', preserveExisting: true };
  await request(app).post('/api/sentry/v1/nodes').set('Cookie', cookie).set('Origin', ORIGIN)
    .set('X-CSRF-Token', 'test-csrf').send(original).expect(200);
  await request(app).post('/sentry/v1/nodes').set('Origin', ORIGIN).send(incoming).expect(401);
  await request(app).post('/sentry/v1/nodes').set('Cookie', cookie).set('Origin', ORIGIN).send(incoming).expect(403);
  await request(app).post('/sentry/v1/nodes').set('Cookie', cookie).set('Origin', 'https://other.example')
    .set('X-CSRF-Token', 'test-csrf').send(incoming).expect(403);
  const saved = await request(app).post('/sentry/v1/nodes').set('Cookie', cookie).set('Origin', ORIGIN)
    .set('X-CSRF-Token', 'test-csrf').send(incoming).expect(200);
  expect(saved.body).toEqual([original]);
  const read = await request(app).get('/api/sentry/v1/nodes').set('Cookie', cookie).expect(200);
  expect(read.body).toEqual([original]);
});

test.each(['/api/sentry/v1', '/sentry/v1'])('voting context is public, read-only and strictly bounded through %s', async (prefix) => {
  const query = `network=testnet&proposalHash=${HASH}&proTxHashes=${HASH}`;
  const response = await request(app).get(`${prefix}/voting-context?${query}`).expect(200);
  expect(response.body).toMatchObject({ proposalHash: HASH, proposal: { name: 'verified-proposal' }, nodes: [{ proTxHash: HASH }] });
  await request(app).get(`${prefix}/voting-context?${query}&privateKey=forbidden`).expect(422);
  await request(app).get(`${prefix}/voting-context?network=testnet&proposalHash=${HASH}&proTxHashes[]=${HASH}`).expect(422);
  await request(app).get(`${prefix}/voting-context?network=testnet&proposalHash=${HASH}&proTxHashes=${HASH},${HASH}`).expect(422);
  await request(app).post(`${prefix}/voting-context`).send({}).expect(401);
  expect(db.prepare('SELECT COUNT(*) AS n FROM sentry_operations').get().n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM sentry_watches').get().n).toBe(0);
});

test('alternating proxy forms share one anonymous read quota', async () => {
  mount(false);
  await withListener(async (client) => {
    for (let count = 0; count < 120; count++) {
      await client.get(`${count % 2 ? '/sentry/v1' : '/api/sentry/v1'}/capabilities`).expect(200);
    }
    const limited = await client.get('/sentry/v1/capabilities').expect(429);
    expect(limited.body).toEqual({ error: 'too_many_sentry_requests' });
  });
});

test('alternating proxy forms share one authenticated management quota across client IPs', async () => {
  mount(false);
  app.set('trust proxy', 1);
  await withListener(async (client) => {
    for (let count = 0; count < 120; count++) {
      await client.get(`${count % 2 ? '/sentry/v1' : '/api/sentry/v1'}/nodes`)
        .set('Cookie', cookie).set('X-Forwarded-For', `192.0.2.${count + 1}`).expect(200);
    }
    const limited = await client.get('/sentry/v1/nodes').set('Cookie', cookie)
      .set('X-Forwarded-For', '192.0.2.121').expect(429);
    expect(limited.body).toEqual({ error: 'too_many_sentry_requests' });
  });
});

test('both proxy forms share the tighter voting-context quota without exhausting ordinary reads', async () => {
  mount(false);
  await withListener(async (client) => {
    const query = `network=testnet&proposalHash=${HASH}&proTxHashes=${HASH}`;
    for (let count = 0; count < 12; count++) {
      await client.get(`${count % 2 ? '/sentry/v1' : '/api/sentry/v1'}/voting-context?${query}`).expect(200);
    }
    const limited = await client.get(`/api/sentry/v1/voting-context?${query}`).expect(429);
    expect(limited.body).toEqual({ error: 'too_many_sentry_requests' });
    await client.get('/api/sentry/v1/capabilities').expect(200);
    await client.get('/sentry/v1/nodes').set('Cookie', cookie).expect(200);
  });
});
