const {
  assertProductionAuthConfig,
  buildServices,
} = require('../lib/appFactory');
const { openDatabase } = require('../lib/db');
const { _resetPepperForTests } = require('../lib/kdf');

describe('appFactory production auth config', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecureCookies = process.env.SYSNODE_SECURE_COOKIES;

  beforeEach(() => {
    _resetPepperForTests();
    process.env.SYSNODE_AUTH_PEPPER = 'f'.repeat(64);
    delete process.env.SYSNODE_SECURE_COOKIES;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalSecureCookies === undefined) {
      delete process.env.SYSNODE_SECURE_COOKIES;
    } else {
      process.env.SYSNODE_SECURE_COOKIES = originalSecureCookies;
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
});
