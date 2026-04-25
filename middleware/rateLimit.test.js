const {
  loginKey,
  mfaLoginKey,
  verifyPasswordKey,
  registerKey,
  reconcileKey,
  voteKey,
} = require('./rateLimit');

function mk(body, ip = '1.2.3.4', user) {
  const req = { ip, body };
  if (user) req.user = user;
  return req;
}

describe('rate-limit key generators', () => {
  describe('loginKey', () => {
    test('canonicalizes case, whitespace, and Unicode so equivalent emails share a bucket', () => {
      const a = loginKey(mk({ email: 'User@Example.com' }));
      const b = loginKey(mk({ email: '  user@example.com  ' }));
      const c = loginKey(mk({ email: '\u{FB01}oo@example.com' })); // "fi" ligature
      const d = loginKey(mk({ email: 'fioo@example.com' }));
      expect(a).toBe(b);
      expect(c).toBe(d);
    });

    test('distinct IPv4 addresses produce distinct keys', () => {
      const a = loginKey(mk({ email: 'user@example.com' }, '1.2.3.4'));
      const b = loginKey(mk({ email: 'user@example.com' }, '5.6.7.8'));
      expect(a).not.toBe(b);
    });

    test('IPv6 addresses in the same /56 subnet share a bucket (via ipKeyGenerator)', () => {
      // An attacker rotating addresses inside a single IPv6 allocation MUST
      // not be able to evade the 5-attempt login bucket. ipKeyGenerator
      // masks IPv6 to /56, so two addresses that only differ in the host
      // portion map to the same key.
      const a = loginKey(
        mk({ email: 'user@example.com' }, '2001:db8:1234:5678:9abc:def0:1234:5678')
      );
      const b = loginKey(
        mk({ email: 'user@example.com' }, '2001:db8:1234:56ff:ffff:ffff:ffff:ffff')
      );
      expect(a).toBe(b);
    });

    test('handles missing/empty body gracefully', () => {
      expect(loginKey({ ip: '1.2.3.4' })).toMatch(/^login\|1\.2\.3\.4\|$/);
      expect(loginKey({ ip: '1.2.3.4', body: {} })).toMatch(
        /^login\|1\.2\.3\.4\|$/
      );
    });
  });

  describe('mfaLoginKey', () => {
    test('ignores challenge token so invalid-token floods cannot rotate buckets', () => {
      const a = mfaLoginKey(
        mk({ challengeToken: 'a'.repeat(64) }, '1.2.3.4')
      );
      const b = mfaLoginKey(
        mk({ challengeToken: 'b'.repeat(64) }, '1.2.3.4')
      );
      expect(a).toBe(b);
      expect(a).toBe('login-totp|1.2.3.4');
    });

    test('distinct IPs produce distinct MFA endpoint buckets', () => {
      const a = mfaLoginKey(mk({ challengeToken: 'c'.repeat(64) }, '1.2.3.4'));
      const b = mfaLoginKey(mk({ challengeToken: 'c'.repeat(64) }, '5.6.7.8'));
      expect(a).not.toBe(b);
    });
  });

  describe('verifyPasswordKey', () => {
    function mkSession(body, ip, session) {
      return { ...mk(body, ip, { id: 42 }), session };
    }

    test('buckets by authenticated session.id when present', () => {
      const a = verifyPasswordKey(mkSession({}, '1.2.3.4', { id: 100 }));
      const b = verifyPasswordKey(mkSession({}, '9.9.9.9', { id: 100 }));
      expect(a).toBe(b);
      expect(a).toBe('verify-password|s100');
    });

    test('two sessions for the same user get distinct password-check buckets', () => {
      const a = verifyPasswordKey(mkSession({}, '1.2.3.4', { id: 100 }));
      const b = verifyPasswordKey(mkSession({}, '1.2.3.4', { id: 200 }));
      expect(a).not.toBe(b);
    });

    test('falls back to IP bucket when the user is missing', () => {
      const a = verifyPasswordKey(mk({}, '1.2.3.4'));
      expect(a).toBe('verify-password|ip|1.2.3.4');
    });
  });

  describe('registerKey', () => {
    test('is scoped per IPv4 only', () => {
      const a = registerKey(mk({ email: 'a@b.com' }, '1.2.3.4'));
      const b = registerKey(mk({ email: 'c@d.com' }, '1.2.3.4'));
      expect(a).toBe(b);
      expect(a).toMatch(/^register\|1\.2\.3\.4$/);
    });

    test('collapses an IPv6 /56 into a single bucket', () => {
      const a = registerKey(mk({}, '2001:db8:1234:5600::1'));
      const b = registerKey(mk({}, '2001:db8:1234:56ff::1'));
      expect(a).toBe(b);
    });
  });

  describe('voteKey', () => {
    test('buckets by authenticated user.id when present', () => {
      const a = voteKey(mk({}, '1.2.3.4', { id: 42 }));
      const b = voteKey(mk({}, '9.9.9.9', { id: 42 }));
      expect(a).toBe(b);
      expect(a).toBe('vote|u42');
    });

    test('two distinct users on the same IP get distinct buckets', () => {
      const a = voteKey(mk({}, '1.2.3.4', { id: 1 }));
      const b = voteKey(mk({}, '1.2.3.4', { id: 2 }));
      expect(a).not.toBe(b);
    });

    test('falls back to IP bucket when the user is missing (defense in depth)', () => {
      const a = voteKey(mk({}, '1.2.3.4'));
      expect(a).toMatch(/^vote\|ip\|1\.2\.3\.4$/);
    });
  });

  describe('reconcileKey', () => {
    test('buckets by authenticated user.id when present', () => {
      const a = reconcileKey(mk({}, '1.2.3.4', { id: 42 }));
      const b = reconcileKey(mk({}, '9.9.9.9', { id: 42 }));
      expect(a).toBe(b);
      expect(a).toBe('reconcile|u42');
    });

    test('falls back to IP bucket when the user is missing', () => {
      const a = reconcileKey(mk({}, '1.2.3.4'));
      expect(a).toMatch(/^reconcile\|ip\|1\.2\.3\.4$/);
    });
  });
});
