const {
  assertProductionAuthConfig,
  buildServices,
  createApp,
  normalizeProductionCorsOrigin,
} = require('../lib/appFactory');
const { openDatabase } = require('../lib/db');
const { createMailer } = require('../lib/mailer');
const { _resetPepperForTests } = require('../lib/kdf');
const request = require('supertest');

describe('appFactory production auth config', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecureCookies = process.env.SYSNODE_SECURE_COOKIES;
  const originalCorsOrigin = process.env.CORS_ORIGIN;
  const originalFrontendUrl = process.env.FRONTEND_URL;

  beforeEach(() => {
    _resetPepperForTests();
    process.env.SYSNODE_AUTH_PEPPER = 'f'.repeat(64);
    delete process.env.SYSNODE_SECURE_COOKIES;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalSecureCookies === undefined) {
      delete process.env.SYSNODE_SECURE_COOKIES;
    } else {
      process.env.SYSNODE_SECURE_COOKIES = originalSecureCookies;
    }
    if (originalCorsOrigin === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = originalCorsOrigin;
    }
    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = originalFrontendUrl;
    }
  });

  test('production refuses non-secure cookies', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      assertProductionAuthConfig({
        secureCookies: false,
        corsOrigin: 'https://sysnode.info',
        frontendUrl: 'https://sysnode.info',
      })
    ).toThrow('secure_cookies_required_in_production');
  });

  test('production requires same frontend and credentialed CORS origin', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      assertProductionAuthConfig({
        secureCookies: true,
        corsOrigin: 'https://api.sysnode.info',
        frontendUrl: 'https://sysnode.info',
      })
    ).toThrow('same_origin_cors_required_in_production');
  });

  test('production accepts equivalent same-origin URLs after normalization', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      assertProductionAuthConfig({
        secureCookies: true,
        corsOrigin: 'https://sysnode.info/',
        frontendUrl: 'https://sysnode.info/path-that-is-not-used',
      })
    ).not.toThrow();
  });

  test('production requires an https frontend origin', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      assertProductionAuthConfig({
        secureCookies: true,
        corsOrigin: 'http://sysnode.info',
        frontendUrl: 'http://sysnode.info',
      })
    ).toThrow('frontend_https_url_required_in_production');
  });

  test('SYSNODE_SECURE_COOKIES=false is rejected in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SYSNODE_SECURE_COOKIES = 'false';
    const db = openDatabase(':memory:');
    try {
      expect(() => buildServices({ db })).toThrow(
        'secure_cookies_required_in_production'
      );
    } finally {
      db.close();
    }
  });

  test('explicit secureCookies option ignores malformed env override', () => {
    process.env.NODE_ENV = 'test';
    process.env.SYSNODE_SECURE_COOKIES = '0';
    const db = openDatabase(':memory:');
    try {
      expect(() => buildServices({ db, secureCookies: false })).not.toThrow();
    } finally {
      db.close();
    }
  });

  test('standalone createApp accepts FRONTEND_URL as production CORS origin fallback', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ORIGIN;
    process.env.FRONTEND_URL = 'https://sysnode.info';
    const db = openDatabase(':memory:');
    const mailer = createMailer({ transport: 'memory', from: 't@x.com' });
    try {
      expect(() => createApp({ db, mailer })).not.toThrow();
    } finally {
      db.close();
    }
  });

  test('standalone createApp emits normalized production CORS origin', async () => {
    process.env.NODE_ENV = 'production';
    const db = openDatabase(':memory:');
    const mailer = createMailer({ transport: 'memory', from: 't@x.com' });
    const { app } = createApp({
      db,
      mailer,
      corsOrigin: 'https://sysnode.info/',
      frontendUrl: 'https://sysnode.info/path-that-is-not-used',
    });
    try {
      const res = await request(app)
        .get('/health')
        .set('Origin', 'https://sysnode.info');
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://sysnode.info'
      );
    } finally {
      db.close();
    }
  });

  test('normalizes production CORS origins and preserves development values', () => {
    process.env.NODE_ENV = 'production';
    expect(normalizeProductionCorsOrigin('https://sysnode.info/')).toBe(
      'https://sysnode.info'
    );
    process.env.NODE_ENV = 'development';
    expect(normalizeProductionCorsOrigin('http://localhost:3000')).toBe(
      'http://localhost:3000'
    );
  });
});
