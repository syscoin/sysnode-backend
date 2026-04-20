const {
  loginKey,
  resendKey,
  registerKey,
} = require('./rateLimit');

function mk(body, ip = '1.2.3.4') {
  return { ip, body };
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

  describe('resendKey', () => {
    test('uses normalized email only (IP-independent)', () => {
      const a = resendKey(mk({ email: 'User@Example.com' }, '1.2.3.4'));
      const b = resendKey(mk({ email: 'user@example.com' }, '5.6.7.8'));
      expect(a).toBe(b);
      expect(a).toMatch(/^resend\|user@example\.com$/);
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
});
