const securityLog = require('../lib/securityLog');

describe('securityLog structured logger', () => {
  // Silence real console output during the test run. We still capture
  // the calls to assert on format, but letting them reach stdout would
  // make Jest output noisy.
  let logSpy, warnSpy, errorSpy;
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  test('emits JSON line in production with required keys', () => {
    process.env.NODE_ENV = 'production';
    securityLog.event('auth.login_failed', {
      req: {
        method: 'POST',
        originalUrl: '/auth/login?hint=1',
        ip: '1.2.3.4',
      },
      reason: 'invalid_credentials',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0][0];
    expect(typeof line).toBe('string');
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('warn');
    expect(parsed.event).toBe('auth.login_failed');
    expect(parsed.method).toBe('POST');
    // Query string must be stripped — query params can echo user input.
    expect(parsed.path).toBe('/auth/login');
    expect(parsed.ip).toBe('1.2.3.4');
    expect(parsed.reason).toBe('invalid_credentials');
    expect(typeof parsed.ts).toBe('string');
    expect(Number.isFinite(Date.parse(parsed.ts))).toBe(true);
  });

  test('emits human-readable line in development', () => {
    process.env.NODE_ENV = 'development';
    securityLog.error('auth.kdf_config', {
      error: new Error('SYSNODE_AUTH_PEPPER missing'),
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [prefix, rest] = errorSpy.mock.calls[0];
    expect(prefix).toBe('[security:error] auth.kdf_config');
    expect(rest).toMatchObject({ error: 'SYSNODE_AUTH_PEPPER missing' });
    expect(rest.ts).toBeDefined();
  });

  test('extracts userId from req.user when present', () => {
    const record = securityLog._buildRecord('warn', 'gov.vote_rejected', {
      req: {
        method: 'POST',
        originalUrl: '/gov/vote',
        ip: '1.2.3.4',
        user: { id: 42, email: 'bob@example.com' },
      },
    });
    expect(record.userId).toBe(42);
    // email is PII and must not propagate into security records.
    expect(record.email).toBeUndefined();
  });

  test('redacts known-sensitive keys at the top level', () => {
    const record = securityLog._buildRecord('warn', 'test.redact', {
      authHash: 'ff'.repeat(32),
      password: 'hunter2',
      token: 'aa'.repeat(32),
      harmless: 'keep-me',
    });
    expect(record.authHash).toBe('[redacted]');
    expect(record.password).toBe('[redacted]');
    expect(record.token).toBe('[redacted]');
    expect(record.harmless).toBe('keep-me');
  });

  test('redacts sensitive keys nested inside object values', () => {
    const record = securityLog._buildRecord('warn', 'test.nested', {
      payload: {
        email: 'user@example.com',
        authHash: 'ff'.repeat(32),
        nested: { newAuthHash: 'aa'.repeat(32), ok: 1 },
      },
    });
    expect(record.payload.email).toBe('user@example.com');
    expect(record.payload.authHash).toBe('[redacted]');
    expect(record.payload.nested.newAuthHash).toBe('[redacted]');
    expect(record.payload.nested.ok).toBe(1);
  });

  test('Error instance surfaces message but not stack', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at fake:1:1';
    const record = securityLog._buildRecord('error', 'test.err', { error: err });
    expect(record.error).toBe('boom');
    expect(JSON.stringify(record)).not.toContain('fake:1:1');
  });

  test('never throws on pathological inputs (cycles, bigint, function)', () => {
    process.env.NODE_ENV = 'production';
    const cycle = {};
    cycle.self = cycle;
    expect(() =>
      securityLog.event('test.cycle', {
        cycle,
        n: 10n,
        fn: () => null,
      })
    ).not.toThrow();
    // At least one log call happened — either a clean JSON emit or the
    // log_error fallback line.
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
  });

  test('omits req fields when req is absent', () => {
    const record = securityLog._buildRecord('warn', 'test.no-req', {
      foo: 'bar',
    });
    expect(record.method).toBeUndefined();
    expect(record.path).toBeUndefined();
    expect(record.ip).toBeUndefined();
    expect(record.userId).toBeUndefined();
    expect(record.foo).toBe('bar');
  });

  test('level routing: info→log, warn→warn, error→error', () => {
    process.env.NODE_ENV = 'production';
    securityLog.info('t.info', {});
    securityLog.warn('t.warn', {});
    securityLog.error('t.error', {});
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
