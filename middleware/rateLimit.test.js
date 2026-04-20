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

    test('includes IP so distinct IPs do not share the attacker bucket', () => {
      const a = loginKey(mk({ email: 'user@example.com' }, '1.2.3.4'));
      const b = loginKey(mk({ email: 'user@example.com' }, '5.6.7.8'));
      expect(a).not.toBe(b);
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
    test('is scoped per IP only', () => {
      const a = registerKey(mk({ email: 'a@b.com' }, '1.2.3.4'));
      const b = registerKey(mk({ email: 'c@d.com' }, '1.2.3.4'));
      expect(a).toBe(b);
      expect(a).toMatch(/^register\|1\.2\.3\.4$/);
    });
  });
});
