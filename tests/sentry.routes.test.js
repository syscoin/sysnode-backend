const express = require('express');
const request = require('supertest');
const { createSentryRouter } = require('../routes/sentry');
const { createCsrfMiddleware } = require('../middleware/csrf');
const cookieParser = require('cookie-parser');
function fixture() {
  const app = express(); app.use(express.json()); app.use(cookieParser());
  const management = Object.fromEntries(['capabilities', 'context', 'watches', 'watch', 'operations', 'prepare', 'authorize', 'submit', 'reconcile'].map((method) => [method, jest.fn(async () => ({ ok: true }))]));
  app.use((req, res, next) => { if (req.get('x-test-user')) req.user = { id: 1 }; next(); });
  const sessionMw = { requireAuth: (req, res, next) => req.user ? next() : res.status(401).end() };
  app.use('/api/sentry/v1', createSentryRouter({ management, sessionMw, csrfMw: createCsrfMiddleware({ secureCookies: false }), frontendUrl: 'https://sysnode.info' }));
  return { app, management };
}
test('public context is read-only; writes need authenticated origin and CSRF', async () => {
  const { app, management } = fixture();
  await request(app).get('/api/sentry/v1/context?network=testnet&proTxHash=abc').expect(200);
  await request(app).post('/api/sentry/v1/operations').send({}).expect(401);
  await request(app).post('/api/sentry/v1/operations').set('x-test-user', '1').set('Origin', 'https://evil.example').send({}).expect(403);
  await request(app).post('/api/sentry/v1/operations').set('x-test-user', '1').set('Origin', 'https://sysnode.info').send({}).expect(403);
  await request(app).post('/api/sentry/v1/operations').set('x-test-user', '1').set('Origin', 'https://sysnode.info').set('Cookie', 'csrf=abc').set('X-CSRF-Token', 'abc').send({}).expect(200);
  expect(management.prepare).toHaveBeenCalledTimes(1);
});
