const {
  createMailer,
  renderTemplate,
  _builtInTemplates,
} = require('./mailer');

describe('mailer.renderTemplate', () => {
  test('substitutes {{var}} placeholders', () => {
    const out = renderTemplate('hi {{name}}!', { name: 'Alice' });
    expect(out).toBe('hi Alice!');
  });

  test('leaves unknown placeholders empty', () => {
    const out = renderTemplate('{{a}}-{{b}}', { a: 'A' });
    expect(out).toBe('A-');
  });

  test('HTML-escapes substituted values by default', () => {
    const out = renderTemplate('<p>{{v}}</p>', { v: '<script>x</script>' });
    expect(out).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
  });

  test('raw: true disables escaping (used for URLs in href)', () => {
    const out = renderTemplate('<a href="{{url}}">x</a>', {
      url: 'https://x.com/?a=1&b=2',
    }, { raw: ['url'] });
    expect(out).toBe('<a href="https://x.com/?a=1&b=2">x</a>');
  });
});

describe('mailer.createMailer with memory transport', () => {
  test('sendVerification queues a message with the verification link', async () => {
    const mailer = createMailer({ transport: 'memory', from: 'no-reply@syscoin.dev' });
    await mailer.sendVerification({
      to: 'user@example.com',
      link: 'https://syscoin.dev/verify?token=abc',
    });
    expect(mailer.outbox).toHaveLength(1);
    const msg = mailer.outbox[0];
    expect(msg.to).toBe('user@example.com');
    expect(msg.from).toBe('no-reply@syscoin.dev');
    expect(msg.subject).toMatch(/verify/i);
    expect(msg.html).toContain('https://syscoin.dev/verify?token=abc');
    expect(msg.text).toContain('https://syscoin.dev/verify?token=abc');
  });

  test('sendVoteReminder produces a reminder with proposal context', async () => {
    const mailer = createMailer({ transport: 'memory', from: 'no-reply@syscoin.dev' });
    await mailer.sendVoteReminder({
      to: 'user@example.com',
      proposals: [
        {
          name: 'Fund Dev Team',
          hash: 'deadbeef'.repeat(8),
          deadlineText: 'in 3 days',
          voteUrl: 'https://syscoin.dev/governance#fund-dev-team',
          unvotedCount: 2,
        },
      ],
      bucket: '3d',
    });
    const msg = mailer.outbox[0];
    expect(msg.subject).toMatch(/3 days|reminder/i);
    expect(msg.html).toContain('Fund Dev Team');
    expect(msg.html).toContain('2 masternode');
    expect(msg.html).toContain('https://syscoin.dev/governance');
  });

  test('rejects sending when "to" is missing', async () => {
    const mailer = createMailer({ transport: 'memory' });
    await expect(mailer.sendVerification({ link: 'x' })).rejects.toThrow(/to/);
  });

  test('all built-in templates declared', () => {
    expect(Object.keys(_builtInTemplates).sort()).toEqual(
      ['passwordChanged', 'verification', 'voteReminder'].sort()
    );
  });
});

describe('mailer.createMailer transport=log', () => {
  test('log transport resolves without throwing and writes to stdout', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const mailer = createMailer({ transport: 'log', from: 'a@b.com' });
      await mailer.sendVerification({ to: 'x@y.com', link: 'https://s/d' });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('log transport does NOT accumulate mail in outbox (no memory leak)', async () => {
    // Codex P2: `outbox` is a test affordance meaningful only for the
    // memory transport. Log and smtp transports are long-running; holding
    // every email ever sent in a process-lifetime array is an unbounded
    // leak.
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const mailer = createMailer({ transport: 'log', from: 'a@b.com' });
    for (let i = 0; i < 50; i++) {
      await mailer.sendVerification({
        to: `user${i}@example.com`,
        link: `https://s/d/${i}`,
      });
    }
    expect(mailer.outbox).toEqual([]);
  });

});

describe('mailer.createMailer transport=smtp eager validation (Codex round-8 P1)', () => {
  // The previous implementation deferred SMTP_HOST validation until the
  // first send, so a production deploy with `transport: 'smtp'` and no
  // host started healthy, passed /health, accepted registrations, and
  // then silently failed every outbound email. The tests below pin the
  // fail-fast behaviour.

  test('throws at construction when SMTP_HOST is missing', () => {
    expect(() =>
      createMailer({
        transport: 'smtp',
        from: 'a@b.com',
        smtp: { host: '', port: 587 },
      })
    ).toThrow(/SMTP_HOST is required/i);
  });

  test('throws at construction when SMTP_HOST is whitespace-only', () => {
    expect(() =>
      createMailer({
        transport: 'smtp',
        from: 'a@b.com',
        smtp: { host: '   ', port: 587 },
      })
    ).toThrow(/SMTP_HOST is required/i);
  });

  test('throws at construction for an out-of-range SMTP_PORT', () => {
    expect(() =>
      createMailer({
        transport: 'smtp',
        from: 'a@b.com',
        smtp: { host: 'smtp.example.com', port: 70000 },
      })
    ).toThrow(/SMTP_PORT/i);
    expect(() =>
      createMailer({
        transport: 'smtp',
        from: 'a@b.com',
        smtp: { host: 'smtp.example.com', port: 0 },
      })
    ).toThrow(/SMTP_PORT/i);
  });

  test('throws at construction if only one of SMTP_USER / SMTP_PASS is set', () => {
    expect(() =>
      createMailer({
        transport: 'smtp',
        from: 'a@b.com',
        smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: '' },
      })
    ).toThrow(/SMTP_USER and SMTP_PASS must be set together/i);
    expect(() =>
      createMailer({
        transport: 'smtp',
        from: 'a@b.com',
        smtp: { host: 'smtp.example.com', port: 587, user: '', pass: 'p' },
      })
    ).toThrow(/SMTP_USER and SMTP_PASS must be set together/i);
  });

  test('constructs successfully with host + port + matched credentials', () => {
    // nodemailer.createTransport only validates the config shape — it
    // does NOT attempt a network connection until sendMail() runs —
    // so this succeeds without hitting the test machine's network.
    expect(() =>
      createMailer({
        transport: 'smtp',
        from: 'a@b.com',
        smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' },
      })
    ).not.toThrow();
  });

  test('rejects unknown transport names at construction', () => {
    expect(() =>
      createMailer({ transport: 'bogus', from: 'a@b.com' })
    ).toThrow(/unknown transport/i);
  });
});
