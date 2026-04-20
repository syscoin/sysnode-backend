const express = require('express');
const request = require('supertest');

// Codex P2 (round 2): rate-limit keys are only as good as the `req.ip`
// Express hands us. Behind a reverse proxy, Express returns the proxy's
// socket address unless we configure `trust proxy`. This test proves:
//   1. Default / loopback setting does NOT trust an arbitrary
//      X-Forwarded-For from the public internet (safe default).
//   2. With `trust proxy` configured to an explicit hop count, the
//      forwarded header is honored.
// server.js reads TRUST_PROXY from the env and calls app.set('trust proxy', ...)
// before any middleware runs; this unit-level reproduction mirrors that wiring.

function makeApp(trustProxySetting) {
  const app = express();
  if (trustProxySetting !== undefined) {
    app.set('trust proxy', trustProxySetting);
  }
  app.get('/whoami', (req, res) => res.json({ ip: req.ip }));
  return app;
}

describe('trust proxy wiring', () => {
  test('without trust proxy, X-Forwarded-For is ignored', async () => {
    const app = makeApp(undefined);
    const res = await request(app)
      .get('/whoami')
      .set('X-Forwarded-For', '203.0.113.9');
    // req.ip is the socket address (supertest loopback), never the header.
    expect(res.body.ip).not.toBe('203.0.113.9');
  });

  test('with trust proxy=loopback, X-Forwarded-For is honored for loopback-origin requests', async () => {
    const app = makeApp('loopback');
    const res = await request(app)
      .get('/whoami')
      .set('X-Forwarded-For', '203.0.113.9');
    // Supertest connects over 127.0.0.1, which matches 'loopback', so the
    // forwarded header is accepted.
    expect(res.body.ip).toBe('203.0.113.9');
  });

  test('with trust proxy=2 (socket + one proxy hop), the client IP is extracted', async () => {
    // proxy-addr walks the list [socketPeer, ...XFF.reverse()] and trusts
    // the first N entries as "hops". So N=2 trusts the loopback socket AND
    // the intermediate proxy (10.0.0.2), leaving the real client
    // (203.0.113.9) as req.ip.
    const app = makeApp(2);
    const res = await request(app)
      .get('/whoami')
      .set('X-Forwarded-For', '203.0.113.9, 10.0.0.2');
    expect(res.body.ip).toBe('203.0.113.9');
  });
});
