const { normalizeEmail, isValidEmailSyntax } = require('./email');

describe('email.normalizeEmail', () => {
  test('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM  ')).toBe('foo@bar.com');
  });

  test('applies NFKC', () => {
    // compatibility-composable ligature that should normalize to "fi"
    expect(normalizeEmail('\u{FB01}oo@bar.com')).toBe('fioo@bar.com');
  });

  test('returns empty string for non-strings', () => {
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
    expect(normalizeEmail(42)).toBe('');
  });

  test('is idempotent', () => {
    const once = normalizeEmail('Foo@Bar.com');
    const twice = normalizeEmail(once);
    expect(twice).toBe(once);
  });
});

describe('email.isValidEmailSyntax', () => {
  test('accepts common formats', () => {
    expect(isValidEmailSyntax('a@b.co')).toBe(true);
    expect(isValidEmailSyntax('user+tag@sub.example.com')).toBe(true);
  });

  test('rejects obvious malformed inputs', () => {
    expect(isValidEmailSyntax('')).toBe(false);
    expect(isValidEmailSyntax('no-at-symbol')).toBe(false);
    expect(isValidEmailSyntax('two@@at.com')).toBe(false);
    expect(isValidEmailSyntax('space in@email.com')).toBe(false);
    expect(isValidEmailSyntax('@nouser.com')).toBe(false);
    expect(isValidEmailSyntax('nodot@test')).toBe(false);
  });

  test('accepts domains whose labels start with a digit (addresses syshub issue #1)', () => {
    expect(isValidEmailSyntax('user@1domain.com')).toBe(true);
    expect(isValidEmailSyntax('user@sub.1domain.com')).toBe(true);
  });
});
