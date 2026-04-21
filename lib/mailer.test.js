const {
  createMailer,
  renderTemplate,
  buildFooter,
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

  test('sendVoteReminder (days_before) produces a generic heads-up body', async () => {
    // publicBaseUrl is the FRONTEND origin (sysnode.info in prod). All
    // CTAs in the reminder body must point there, NOT at the backend
    // API host. Supply a distinctive test value so the assertions fail
    // loudly if the mailer ever regresses to hard-coded syscoin.dev.
    const mailer = createMailer({
      transport: 'memory',
      from: 'no-reply@syscoin.dev',
      publicBaseUrl: 'https://sysnode.info',
    });
    await mailer.sendVoteReminder({
      to: 'user@example.com',
      bucket: 'days_before',
      proposalCount: 3,
      deadlineText: 'in 3 days',
    });
    const msg = mailer.outbox[0];
    // Subject is bucket-aware; the 'days_before' subject is the calm
    // heads-up copy, not the urgent one.
    expect(msg.subject).toMatch(/closing soon/i);
    expect(msg.subject).not.toMatch(/24 hours/i);
    // Body must surface the count and deadline text, and the canonical
    // governance CTA pointing at the FRONTEND origin. We deliberately
    // do NOT leak per-proposal names or per-MN unvoted counts (PR 7 is
    // generic-only).
    expect(msg.html).toMatch(/3 active proposals/i);
    expect(msg.html).toContain('in 3 days');
    expect(msg.html).toContain('https://sysnode.info/governance');
    expect(msg.html).toContain('https://sysnode.info/account');
    // Backend host must NEVER appear as a CTA target — those are JSON
    // endpoints, not human pages. This regression-guards a real PR 7
    // bug where syscoin.dev was hard-coded in the template.
    expect(msg.html).not.toContain('syscoin.dev/governance');
    expect(msg.text).toMatch(/3 active proposals/i);
    expect(msg.text).toContain('in 3 days');
    expect(msg.text).toContain('https://sysnode.info/governance');
    expect(msg.text).not.toContain('syscoin.dev/governance');
  });

  test('sendVoteReminder (final_24h) is explicitly urgent and omits per-MN detail', async () => {
    const mailer = createMailer({
      transport: 'memory',
      from: 'no-reply@syscoin.dev',
      publicBaseUrl: 'https://sysnode.info',
    });
    await mailer.sendVoteReminder({
      to: 'user@example.com',
      bucket: 'final_24h',
      proposalCount: 1,
      deadlineText: 'in 18 hours',
    });
    const msg = mailer.outbox[0];
    expect(msg.subject).toMatch(/24 hours/i);
    // Urgent bucket uses a stronger lead and renders the urgent banner.
    expect(msg.html).toMatch(/less than 24 hours/i);
    expect(msg.html).toMatch(/urgent/i);
    // Singular agreement on a 1-proposal cycle.
    expect(msg.html).toMatch(/1 active proposal\b/);
    expect(msg.text).toMatch(/1 active proposal\b/);
  });

  test('sendVoteReminder strips a trailing slash from publicBaseUrl', async () => {
    // Operators often set FRONTEND_URL=https://sysnode.info/ (with a
    // trailing slash). We normalize to avoid `https://sysnode.info//governance`.
    const mailer = createMailer({
      transport: 'memory',
      from: 'no-reply@syscoin.dev',
      publicBaseUrl: 'https://sysnode.info/',
    });
    await mailer.sendVoteReminder({
      to: 'user@example.com',
      bucket: 'days_before',
      proposalCount: 2,
      deadlineText: 'in 2 days',
    });
    const msg = mailer.outbox[0];
    expect(msg.html).toContain('https://sysnode.info/governance');
    expect(msg.html).not.toContain('sysnode.info//');
    expect(msg.text).toContain('https://sysnode.info/governance');
    expect(msg.text).not.toContain('sysnode.info//');
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

// ---------------------------------------------------------------------------
// Compliance footer
// ---------------------------------------------------------------------------
//
// Every outbound email must carry a footer that explains WHY the recipient
// is getting it, identifies the sender, and — for opt-in notifications —
// offers a management/opt-out path. These tests pin that contract in
// place so a future template addition can't slip by without a footer.
describe('mailer.buildFooter', () => {
  test('vote_reminder footer names the recipient, explains the opt-in, and links to /account', () => {
    const { text, html } = buildFooter({
      kind: 'vote_reminder',
      to: 'alice@example.com',
      accountUrl: 'https://sysnode.info/account',
    });
    expect(text).toContain('alice@example.com');
    expect(text).toMatch(/you enabled vote\s*reminders/i);
    expect(text).toContain('https://sysnode.info/account');
    expect(text).toMatch(/automated notification, please do not reply/i);

    expect(html).toContain('alice@example.com');
    expect(html).toMatch(/enabled vote\s*\n?\s*reminders/i);
    expect(html).toContain('href="https://sysnode.info/account"');
    expect(html).toMatch(/update your notification preferences/i);
    expect(html).toMatch(/automated notification, please do not reply/i);
  });

  test('account_security footer states it is transactional and cannot be disabled', () => {
    const { text, html } = buildFooter({
      kind: 'account_security',
      to: 'bob@example.com',
      accountUrl: 'https://sysnode.info/account',
    });
    expect(text).toContain('bob@example.com');
    expect(text).toMatch(/security-sensitive/i);
    expect(text).toMatch(/cannot be disabled/i);
    expect(text).toContain('https://sysnode.info/account');

    expect(html).toContain('bob@example.com');
    expect(html).toMatch(/cannot be disabled/i);
    expect(html).toContain('href="https://sysnode.info/account"');
  });

  test('account_security footer omits the review link when no accountUrl is provided', () => {
    // We should never break the footer if a future caller happens to
    // forget the accountUrl — surfacing an <a href=""> would ship a
    // literal "review your account" that navigates to the recipient's
    // own domain, which is worse than silently hiding the link.
    const { text, html } = buildFooter({
      kind: 'account_security',
      to: 'bob@example.com',
    });
    expect(text).not.toMatch(/review your account/i);
    expect(html).not.toMatch(/review your account/i);
    expect(html).not.toContain('href=""');
  });

  test('account_verification footer explains how the address was used and the safe-ignore path', () => {
    const { text, html } = buildFooter({
      kind: 'account_verification',
      to: 'new@example.com',
    });
    expect(text).toContain('new@example.com');
    expect(text).toMatch(/someone requested a Syscoin/i);
    // The phrase wraps across text-mode line breaks, so be tolerant of
    // whitespace (space OR newline) between words.
    expect(text).toMatch(/safely\s+ignore\s+this\s+message/i);
    expect(html).toMatch(/safely\s+ignore\s+this\s+message/i);
  });

  test('HTML-escapes the recipient to neutralize spoofed angle brackets', () => {
    // If a recipient address ever contains HTML-meaningful chars (e.g.
    // via an operator editing the outbound envelope), the footer must
    // escape them rather than let them break the email body's markup.
    const { html } = buildFooter({
      kind: 'vote_reminder',
      to: '<script>x</script>@evil.example',
      accountUrl: 'https://sysnode.info/account',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('unknown kind throws — prevents a new template from shipping without a footer', () => {
    expect(() =>
      buildFooter({ kind: 'marketing_blast', to: 'x@y' })
    ).toThrow(/unknown kind/i);
  });
});

describe('mailer compliance footer on every sent message', () => {
  test('sendVerification body carries the account_verification footer', async () => {
    const mailer = createMailer({
      transport: 'memory',
      from: 'no-reply@syscoin.dev',
      publicBaseUrl: 'https://sysnode.info',
    });
    await mailer.sendVerification({
      to: 'alice@example.com',
      link: 'https://sysnode.info/verify?token=abc',
    });
    const msg = mailer.outbox[0];
    expect(msg.text).toContain('alice@example.com');
    expect(msg.text).toMatch(/someone requested a Syscoin/i);
    expect(msg.html).toContain('alice@example.com');
    expect(msg.html).toMatch(/automated notification, please do not reply/i);
    // Verification specifically must NOT pre-link to /account — the user
    // has no login yet; leading them to a sign-in page before verifying
    // is a worse UX than a clean "ignore this email" footer.
    expect(msg.html).not.toContain('href="https://sysnode.info/account"');
  });

  test('sendPasswordChanged body carries the account_security footer with review link', async () => {
    const mailer = createMailer({
      transport: 'memory',
      from: 'no-reply@syscoin.dev',
      publicBaseUrl: 'https://sysnode.info',
    });
    await mailer.sendPasswordChanged({
      to: 'alice@example.com',
      when: '2026-01-01T00:00:00.000Z',
    });
    const msg = mailer.outbox[0];
    expect(msg.text).toMatch(/security-sensitive/i);
    expect(msg.text).toMatch(/cannot be disabled/i);
    expect(msg.text).toContain('https://sysnode.info/account');
    expect(msg.html).toContain('href="https://sysnode.info/account"');
    expect(msg.html).toMatch(/automated notification, please do not reply/i);
  });

  test('sendVoteReminder body carries the vote_reminder footer with manage link', async () => {
    const mailer = createMailer({
      transport: 'memory',
      from: 'no-reply@syscoin.dev',
      publicBaseUrl: 'https://sysnode.info',
    });
    await mailer.sendVoteReminder({
      to: 'alice@example.com',
      bucket: 'days_before',
      proposalCount: 2,
      deadlineText: 'in 2 days',
    });
    const msg = mailer.outbox[0];
    expect(msg.text).toContain('alice@example.com');
    expect(msg.text).toMatch(/you enabled vote\s*reminders/i);
    expect(msg.text).toContain('https://sysnode.info/account');
    expect(msg.html).toContain('alice@example.com');
    expect(msg.html).toMatch(/update your notification preferences/i);
    expect(msg.html).toContain('href="https://sysnode.info/account"');
    expect(msg.html).toMatch(/automated notification, please do not reply/i);
  });

  test('every built-in template declares a footerKind', () => {
    // Contract pin: future templates MUST declare footerKind, otherwise
    // buildMessage throws at call-time. This test catches regressions at
    // "git blame"-time rather than deploy-time.
    for (const [name, tpl] of Object.entries(_builtInTemplates)) {
      expect(tpl.footerKind).toMatch(
        /^(account_verification|account_security|vote_reminder)$/
      );
      // And the template-name → footer-kind alignment is not accidental.
      if (name === 'verification') {
        expect(tpl.footerKind).toBe('account_verification');
      } else if (name === 'passwordChanged') {
        expect(tpl.footerKind).toBe('account_security');
      } else if (name === 'voteReminder') {
        expect(tpl.footerKind).toBe('vote_reminder');
      }
    }
  });
});
