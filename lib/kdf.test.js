const {
  verifyAuthHash,
  hashAuthHash,
  generateSalt,
  constantTimeEqualHex,
  assertPepperConfigured,
  KdfConfigError,
  _resetPepperForTests,
} = require('./kdf');

const sampleAuthHash =
  'a4f8b3c1d9e7f2a5b1c6d8e4f7a9b2c5d1e8f4a7b3c9d5e1f6a2b8c4d7e3f5a9';
const PEPPER_HEX = 'a'.repeat(64);

beforeEach(() => {
  _resetPepperForTests();
  process.env.SYSNODE_AUTH_PEPPER = PEPPER_HEX;
  process.env.NODE_ENV = 'test';
});

describe('kdf.generateSalt', () => {
  test('returns 16 hex bytes (32 chars) by default', () => {
    const salt = generateSalt();
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  test('produces distinct salts across calls', () => {
    expect(generateSalt()).not.toBe(generateSalt());
  });

  test('honors requested byte length', () => {
    expect(generateSalt(32)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('kdf.hashAuthHash / verifyAuthHash', () => {
  test('hash is deterministic for a fixed pepper (HMAC semantics)', () => {
    const a = hashAuthHash(sampleAuthHash);
    const b = hashAuthHash(sampleAuthHash);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('case-insensitive on the authHash input (hex is canonicalized)', () => {
    const lower = hashAuthHash(sampleAuthHash);
    const upper = hashAuthHash(sampleAuthHash.toUpperCase());
    expect(lower).toBe(upper);
  });

  test('round-trips verify for correct authHash', () => {
    const stored = hashAuthHash(sampleAuthHash);
    expect(verifyAuthHash(stored, sampleAuthHash)).toBe(true);
  });

  test('rejects a different authHash', () => {
    const stored = hashAuthHash(sampleAuthHash);
    const other =
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(verifyAuthHash(stored, other)).toBe(false);
  });

  test('rejects inputs that are not hex', () => {
    expect(() => hashAuthHash('not-hex-at-all')).toThrow(/hex/);
  });

  test('rejects empty inputs', () => {
    expect(() => hashAuthHash('')).toThrow(/non-empty/);
  });

  test('verify returns false for malformed stored hash without throwing', () => {
    expect(verifyAuthHash('!!!', sampleAuthHash)).toBe(false);
  });

  test('different peppers produce different hashes', () => {
    const first = hashAuthHash(sampleAuthHash);
    _resetPepperForTests();
    process.env.SYSNODE_AUTH_PEPPER = 'b'.repeat(64);
    const second = hashAuthHash(sampleAuthHash);
    expect(first).not.toBe(second);
  });

  test('throws in production when no pepper is configured', () => {
    _resetPepperForTests();
    const prev = process.env.SYSNODE_AUTH_PEPPER;
    delete process.env.SYSNODE_AUTH_PEPPER;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => hashAuthHash(sampleAuthHash)).toThrow(
        /SYSNODE_AUTH_PEPPER/
      );
    } finally {
      process.env.SYSNODE_AUTH_PEPPER = prev;
      process.env.NODE_ENV = 'test';
      _resetPepperForTests();
    }
  });

  test('throws a KdfConfigError (code: kdf_config) in production without pepper', () => {
    // Codex round-7 P1: routes rely on err.code === 'kdf_config' to
    // distinguish "you set things up wrong" from "user typed the wrong
    // password". The error type must be stable and recognisable, not a
    // generic Error.
    _resetPepperForTests();
    const prev = process.env.SYSNODE_AUTH_PEPPER;
    delete process.env.SYSNODE_AUTH_PEPPER;
    process.env.NODE_ENV = 'production';
    try {
      let caught;
      try {
        hashAuthHash(sampleAuthHash);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(KdfConfigError);
      expect(caught.code).toBe('kdf_config');
    } finally {
      process.env.SYSNODE_AUTH_PEPPER = prev;
      process.env.NODE_ENV = 'test';
      _resetPepperForTests();
    }
  });

  test('verifyAuthHash PROPAGATES config errors, does NOT swallow them to false', () => {
    // Before this fix, a missing pepper in production turned every login
    // into "invalid_credentials" — indistinguishable from a user who
    // typed their password wrong. That gave operators zero signal that
    // the deploy was broken. The new contract: config errors surface;
    // input-shape errors still fold into false for defense-in-depth.
    _resetPepperForTests();
    const prev = process.env.SYSNODE_AUTH_PEPPER;
    delete process.env.SYSNODE_AUTH_PEPPER;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => verifyAuthHash('a'.repeat(64), sampleAuthHash)).toThrow(
        KdfConfigError
      );
    } finally {
      process.env.SYSNODE_AUTH_PEPPER = prev;
      process.env.NODE_ENV = 'test';
      _resetPepperForTests();
    }
  });

  test('verifyAuthHash still folds input-shape errors into false (defense in depth)', () => {
    // Zod schemas at the route level already reject malformed client
    // input before we get here, so this branch is belt-and-braces —
    // but we keep it so a malformed DB row (unlikely) doesn't 500.
    const stored = hashAuthHash(sampleAuthHash);
    expect(verifyAuthHash(stored, 'not-hex-at-all')).toBe(false);
    expect(verifyAuthHash(stored, '')).toBe(false);
  });

  test('assertPepperConfigured passes when pepper is set, throws when not (prod)', () => {
    expect(() => assertPepperConfigured()).not.toThrow();

    _resetPepperForTests();
    const prev = process.env.SYSNODE_AUTH_PEPPER;
    delete process.env.SYSNODE_AUTH_PEPPER;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => assertPepperConfigured()).toThrow(KdfConfigError);
    } finally {
      process.env.SYSNODE_AUTH_PEPPER = prev;
      process.env.NODE_ENV = 'test';
      _resetPepperForTests();
    }
  });
});

describe('kdf.constantTimeEqualHex', () => {
  test('true for equal hex strings', () => {
    expect(constantTimeEqualHex('abcd1234', 'abcd1234')).toBe(true);
  });

  test('false for differing hex strings of equal length', () => {
    expect(constantTimeEqualHex('abcd1234', 'abcd1235')).toBe(false);
  });

  test('false for different lengths without throwing', () => {
    expect(constantTimeEqualHex('abcd', 'abcd00')).toBe(false);
  });

  test('tolerates case differences', () => {
    expect(constantTimeEqualHex('ABCD1234', 'abcd1234')).toBe(true);
  });
});
