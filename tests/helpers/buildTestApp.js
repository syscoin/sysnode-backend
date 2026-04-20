const { openDatabase } = require('../../lib/db');
const { createMailer } = require('../../lib/mailer');
const { createApp } = require('../../lib/appFactory');
const { _resetPepperForTests } = require('../../lib/kdf');

function buildTestApp(overrides = {}) {
  _resetPepperForTests();
  process.env.SYSNODE_AUTH_PEPPER = 'd'.repeat(64);
  process.env.NODE_ENV = 'test';
  const db = openDatabase(':memory:');
  const mailer = createMailer({ transport: 'memory', from: 'test@example.com' });
  // Background work in the register flow is moved onto the event loop with
  // setImmediate in production so response latency is constant-time. In
  // tests we want outbox assertions to fire as soon as the supertest
  // request completes; running the scheduled fn inline guarantees the
  // microtask queue has drained (and therefore the memory mailer has
  // pushed) by the time the response round-trips back to the test.
  const syncScheduler = (fn) => {
    const p = fn();
    if (p && typeof p.then === 'function') {
      p.catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[buildTestApp.scheduler]', err);
      });
    }
  };
  const built = createApp({
    db,
    mailer,
    baseUrl: 'http://api.test.local',
    frontendUrl: 'http://app.test.local',
    corsOrigin: 'http://app.test.local',
    secureCookies: false,
    disableRateLimit: true,
    scheduler: syncScheduler,
    ...overrides,
  });
  return { db, mailer, ...built };
}

module.exports = { buildTestApp };
