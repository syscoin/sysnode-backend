const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const { openDatabase } = require('../lib/db');
const { createUsersRepo } = require('../lib/users');
const { createSessionStore } = require('../lib/sessions');
const { createSessionMiddleware } = require('./session');
const { _resetPepperForTests } = require('../lib/kdf');

const AUTH =
  'a4f8b3c1d9e7f2a5b1c6d8e4f7a9b2c5d1e8f4a7b3c9d5e1f6a2b8c4d7e3f5a9';

function buildApp({ sessions, sessionMw, users }) {
  const app = express();
  app.use(cookieParser());
  app.use(sessionMw.parse);
  app.get('/whoami', sessionMw.requireAuth, (req, res) => {
    res.json({ id: req.user.id, expiresAt: req.session.expiresAt });
  });
  return app;
}

function extractExpires(setCookieHeader, name) {
  const found = setCookieHeader.find((c) => c.startsWith(`${name}=`));
  if (!found) return null;
  const m = found.match(/Expires=([^;]+)/i);
  return m ? new Date(m[1]).getTime() : null;
}

describe('sessionMw.parse cookie refresh', () => {
  let db;
  let sessions;
  let users;
  let app;
  let clock;

  beforeEach(() => {
    _resetPepperForTests();
    process.env.SYSNODE_AUTH_PEPPER = 'f'.repeat(64);
    process.env.NODE_ENV = 'test';
    clock = 1_700_000_000_000;
    db = openDatabase(':memory:');
    users = createUsersRepo(db, { now: () => clock });
    sessions = createSessionStore(db, { now: () => clock });
    const sessionMw = createSessionMiddleware({
      sessions,
      users,
      secureCookies: false,
    });
    app = buildApp({ sessions, sessionMw, users });

    // Seed a verified user + an active session.
    const u = users.create({ email: 'u@test.com', authHash: AUTH });
    users.markEmailVerified(u.id);
    const issued = sessions.issue(u.id);
    app.locals.sid = issued.token;
    app.locals.userId = u.id;
    app.locals.initialExpiresAt = issued.expiresAt;
  });

  afterEach(() => db.close());

  test('an authenticated request refreshes sid cookie with the new expiry', async () => {
    // Advance time one day; DB expiresAt should slide forward by one day.
    clock += 24 * 60 * 60 * 1000;
    const res = await request(app)
      .get('/whoami')
      .set('Cookie', `sid=${app.locals.sid}`);
    expect(res.status).toBe(200);
    const sidExpires = extractExpires(res.headers['set-cookie'], 'sid');
    expect(sidExpires).not.toBeNull();
    // New cookie expiry should match the new DB expiry, which is clock +
    // 14 days. That must be strictly greater than the original expiry.
    expect(sidExpires).toBeGreaterThan(app.locals.initialExpiresAt);
    expect(sidExpires).toBe(res.body.expiresAt);
  });

  test('csrf cookie is refreshed with the SAME token value, new expiry', async () => {
    clock += 24 * 60 * 60 * 1000;
    const res = await request(app)
      .get('/whoami')
      .set('Cookie', `sid=${app.locals.sid}; csrf=preexisting-token-value`);
    expect(res.status).toBe(200);
    const setCookies = res.headers['set-cookie'];
    const csrf = setCookies.find((c) => c.startsWith('csrf='));
    expect(csrf).toBeDefined();
    expect(csrf).toMatch(/^csrf=preexisting-token-value/);
    const csrfExpires = extractExpires(setCookies, 'csrf');
    expect(csrfExpires).toBeGreaterThan(app.locals.initialExpiresAt);
  });

  test('no csrf refresh when no csrf cookie is present on the request', async () => {
    const res = await request(app)
      .get('/whoami')
      .set('Cookie', `sid=${app.locals.sid}`);
    expect(res.status).toBe(200);
    const setCookies = res.headers['set-cookie'];
    expect(setCookies.some((c) => c.startsWith('csrf='))).toBe(false);
  });

  test('expired session yields no cookie refresh and 401 on requireAuth', async () => {
    clock += 31 * 24 * 60 * 60 * 1000; // past absolute cap
    const res = await request(app)
      .get('/whoami')
      .set('Cookie', `sid=${app.locals.sid}`);
    expect(res.status).toBe(401);
    const setCookies = res.headers['set-cookie'] || [];
    expect(setCookies.some((c) => c.startsWith('sid='))).toBe(false);
  });
});
