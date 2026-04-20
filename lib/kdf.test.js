const {
  verifyAuthHash,
  hashAuthHash,
  generateSalt,
  constantTimeEqualHex,
} = require('./kdf');

describe('kdf', () => {
  describe('generateSalt', () => {
    test('returns 16 hex bytes (32 chars) by default', () => {
      const salt = generateSalt();
      expect(typeof salt).toBe('string');
      expect(salt).toMatch(/^[0-9a-f]{32}$/);
    });

    test('produces distinct salts across calls', () => {
      const a = generateSalt();
      const b = generateSalt();
      expect(a).not.toBe(b);
    });

    test('honors requested byte length', () => {
      const salt = generateSalt(32);
      expect(salt).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('hashAuthHash / verifyAuthHash', () => {
    const sampleAuthHash =
      'a4f8b3c1d9e7f2a5b1c6d8e4f7a9b2c5d1e8f4a7b3c9d5e1f6a2b8c4d7e3f5a9';

    test('hash and verify round-trip for the correct authHash', async () => {
      const stored = await hashAuthHash(sampleAuthHash);
      expect(typeof stored).toBe('string');
      expect(stored).toMatch(/^\$argon2id\$/);
      await expect(verifyAuthHash(stored, sampleAuthHash)).resolves.toBe(true);
    }, 20000);

    test('rejects a different authHash', async () => {
      const stored = await hashAuthHash(sampleAuthHash);
      const other =
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      await expect(verifyAuthHash(stored, other)).resolves.toBe(false);
    }, 20000);

    test('two hashes of the same authHash differ (random salt)', async () => {
      const a = await hashAuthHash(sampleAuthHash);
      const b = await hashAuthHash(sampleAuthHash);
      expect(a).not.toBe(b);
      await expect(verifyAuthHash(a, sampleAuthHash)).resolves.toBe(true);
      await expect(verifyAuthHash(b, sampleAuthHash)).resolves.toBe(true);
    }, 30000);

    test('rejects a malformed stored hash without throwing', async () => {
      await expect(verifyAuthHash('not-a-hash', sampleAuthHash)).resolves.toBe(
        false
      );
    });

    test('rejects empty inputs', async () => {
      await expect(hashAuthHash('')).rejects.toThrow();
    });
  });

  describe('constantTimeEqualHex', () => {
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
});
