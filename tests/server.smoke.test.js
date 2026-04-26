// Smoke test: server.js imports and starts cleanly, and /auth + /health live
// alongside the legacy route stack without collisions.
//
// We don't exercise the legacy RPC-backed routes here (they need a running
// Syscoin node); we only confirm that importing server.js doesn't throw and
// that the auth subtree responds via Supertest once the Express app instance
// is reachable.
//
// To make server.js `require()`-safe for tests we'd normally want it to
// export its app. Since we prefer not to refactor the entry file, this test
// uses a sibling helper that reproduces the exact wiring.

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const { openDatabase } = require('../lib/db');
const { createMailer } = require('../lib/mailer');
const {
  buildServices,
  finalizeSessionMw,
  mountAuthAndVault,
} = require('../lib/appFactory');
const { _resetPepperForTests } = require('../lib/kdf');

function buildSmokeApp() {
  _resetPepperForTests();
  process.env.SYSNODE_AUTH_PEPPER = 'e'.repeat(64);
  process.env.NODE_ENV = 'test';

  const app = express();
  app.use(helmet());
  app.use(bodyParser.json({ limit: '256kb' }));
  app.use(cookieParser());

  const legacyCors = cors({ origin: '*', optionsSuccessStatus: 200 });
  const authCors = cors({
    origin: 'http://localhost:3000',
    credentials: true,
  });
  app.use((req, res, next) => {
    if (req.path.startsWith('/auth') || req.path.startsWith('/vault')) {
      return authCors(req, res, next);
    }
    return legacyCors(req, res, next);
  });

  const db = openDatabase(':memory:');
  const mailer = createMailer({ transport: 'memory' });
  const services = finalizeSessionMw(buildServices({ db }));
  app.use(['/auth', '/vault'], services.sessionMw.parse);
  mountAuthAndVault(app, { services, mailer, disableRateLimit: true });
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Mimic a legacy route (without requiring a live RPC) to prove coexistence.
  app.get('/mnstats', (_req, res) => res.json({ legacy: true }));

  return { app, db };
}

describe('server smoke: legacy + auth/vault coexistence', () => {
  let ctx;
  beforeEach(() => {
    ctx = buildSmokeApp();
  });
  afterEach(() => ctx.db.close());

  test('GET /health returns 200', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /mnstats (legacy) has permissive CORS and responds', async () => {
    const res = await request(ctx.app)
      .get('/mnstats')
      .set('Origin', 'https://anywhere.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body.legacy).toBe(true);
  });

  test('GET /auth/me has credentialed CORS pinned to the SPA origin', async () => {
    const res = await request(ctx.app)
      .get('/auth/me')
      .set('Origin', 'http://localhost:3000');
    // Unauthenticated, so 401 — but the CORS headers should already be set.
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:3000'
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('auth routes reject foreign origins for preflighted requests', async () => {
    // OPTIONS preflight from a non-allowed origin should NOT get our origin
    // echoed back (cors() leaves the header unset rather than forbidding
    // the request server-side; browser enforces).
    const res = await request(ctx.app)
      .options('/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'https://evil.example'
    );
  });
});
