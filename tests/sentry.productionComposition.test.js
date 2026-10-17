const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { openDatabase } = require('../lib/db');
const { buildServices, mountAuthAndVault } = require('../lib/appFactory');
const { createMailer } = require('../lib/mailer');
const { _resetPepperForTests } = require('../lib/kdf');

const HASH = 'a'.repeat(64);
const ORIGIN = 'https://sysnode.info';
let db;
let app;
let cookie;
let services;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.SYSNODE_AUTH_PEPPER = 'd'.repeat(64);
  _resetPepperForTests();
  db = openDatabase(':memory:');
  services = buildServices({ db, secureCookies: false });
  const user = services.users.create({ email: 'owner@example.com', authHash: 'a'.repeat(64) });
  services.users.markEmailVerified(user.id);
  cookie = `sid=${services.sessions.issue(user.id).token}; csrf=test-csrf`;
  app = express();
  // Match server.js before its shared mount. Deliberately do not add a
  // global session parser like the old standalone test entrypoint did.
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  mountAuthAndVault(app, {
    services,
    mailer: createMailer({ transport: 'memory' }),
    frontendUrl: ORIGIN,
    disableRateLimit: true,
    sentryAdapter: {
      context: async () => ({ node: { proTxHash: HASH } }),
      capabilities: async () => ({ version: 1 }),
      prepare: async () => ({ request: { operation: 'updateService' } }),
    },
  });
  app.get('/govlist', (req, res) => res.json({ attachedUser: !!req.user }));
});
afterEach(() => db.close());

test('production route composition parses real sessions for authenticated Sentry reads and writes', async () => {
  await request(app).get('/api/sentry/v1/nodes').expect(401);
  await request(app).get('/api/sentry/v1/nodes').set('Cookie', 'sid=invalid').expect(401);
  const read = await request(app).get('/api/sentry/v1/nodes').set('Cookie', cookie).expect(200);
  expect(read.body).toEqual([]);
  expect(read.headers['set-cookie'].some((value) => value.startsWith('sid='))).toBe(true);
  await request(app).post('/api/sentry/v1/nodes').set('Cookie', cookie).set('Origin', ORIGIN)
    .set('X-CSRF-Token', 'test-csrf').send({ network: 'testnet', proTxHash: HASH, label: 'My node' }).expect(200);
  const nodes = await request(app).get('/api/sentry/v1/nodes').set('Cookie', cookie).expect(200);
  expect(nodes.body[0].proTxHash).toBe(HASH);
  const prepared = await request(app).post('/api/sentry/v1/operations').set('Cookie', cookie).set('Origin', ORIGIN)
    .set('X-CSRF-Token', 'test-csrf').send({ network: 'testnet', proTxHash: HASH, changes: { nevmAddress: `0x${'12'.repeat(20)}` } }).expect(200);
  const operations = await request(app).get('/api/sentry/v1/operations').set('Cookie', cookie).expect(200);
  expect(operations.body[0].id).toBe(prepared.body.id);
});

test('production composition retains origin, CSRF, verified-user and body-size gates', async () => {
  const path = '/api/sentry/v1/nodes';
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

test('public context stays readable and a sibling public route does not parse session cookies', async () => {
  await request(app).get(`/api/sentry/v1/context?network=testnet&proTxHash=${HASH}`).expect(200);
  const publicResponse = await request(app).get('/govlist').set('Cookie', cookie).expect(200);
  expect(publicResponse.body).toEqual({ attachedUser: false });
  expect(publicResponse.headers['set-cookie']).toBeUndefined();
});
