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
  test('log transport resolves without throwing and records outbox', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const mailer = createMailer({ transport: 'log', from: 'a@b.com' });
      await mailer.sendVerification({ to: 'x@y.com', link: 'https://s/d' });
      expect(spy).toHaveBeenCalled();
      expect(mailer.outbox).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
