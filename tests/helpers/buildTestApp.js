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
  const built = createApp({
    db,
    mailer,
    baseUrl: 'http://test.local',
    corsOrigin: 'http://test.local',
    secureCookies: false,
    disableRateLimit: true,
    ...overrides,
  });
  return { db, mailer, ...built };
}

module.exports = { buildTestApp };
