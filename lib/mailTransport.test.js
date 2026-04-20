const { selectMailTransport } = require('./mailTransport');

describe('selectMailTransport', () => {
  describe('without MAIL_TRANSPORT set', () => {
    test('returns "smtp" when SMTP_HOST is configured', () => {
      expect(
        selectMailTransport({ SMTP_HOST: 'smtp.example.com', NODE_ENV: 'production' })
      ).toBe('smtp');
    });

    test('returns "log" in dev/test when SMTP_HOST is missing', () => {
      expect(selectMailTransport({ NODE_ENV: 'development' })).toBe('log');
      expect(selectMailTransport({ NODE_ENV: 'test' })).toBe('log');
    });

    test('THROWS in production when SMTP_HOST is missing (Codex round-6 P1)', () => {
      // Operators must not be able to deploy to prod and have mail
      // silently go to stdout. They have to explicitly opt in via
      // MAIL_TRANSPORT=log to get that behaviour.
      expect(() => selectMailTransport({ NODE_ENV: 'production' })).toThrow(
        /refusing to start in production without SMTP_HOST/i
      );
    });

    test('THROWS in production when SMTP_HOST is whitespace-only', () => {
      expect(() =>
        selectMailTransport({ NODE_ENV: 'production', SMTP_HOST: '   ' })
      ).toThrow(/refusing to start in production/i);
    });
  });

  describe('with MAIL_TRANSPORT set', () => {
    test('explicit "smtp" is honored', () => {
      expect(
        selectMailTransport({
          MAIL_TRANSPORT: 'smtp',
          SMTP_HOST: 'smtp.example.com',
          NODE_ENV: 'production',
        })
      ).toBe('smtp');
    });

    test('explicit "log" allows opt-in to stdout delivery even in production', () => {
      // This is the operator escape hatch: dry-run deploys, staging
      // boxes without a relay, etc.
      expect(
        selectMailTransport({ MAIL_TRANSPORT: 'log', NODE_ENV: 'production' })
      ).toBe('log');
    });

    test('explicit "memory" works in dev but is rejected in production', () => {
      expect(
        selectMailTransport({ MAIL_TRANSPORT: 'memory', NODE_ENV: 'development' })
      ).toBe('memory');
      expect(() =>
        selectMailTransport({ MAIL_TRANSPORT: 'memory', NODE_ENV: 'production' })
      ).toThrow(/memory is not valid in production/i);
    });

    test('unknown transport value throws a clear error', () => {
      expect(() =>
        selectMailTransport({ MAIL_TRANSPORT: 'bogus' })
      ).toThrow(/not a valid transport/i);
    });

    test('case-insensitive matching', () => {
      expect(
        selectMailTransport({ MAIL_TRANSPORT: 'SMTP', SMTP_HOST: 'x' })
      ).toBe('smtp');
    });
  });
});
