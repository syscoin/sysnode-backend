const { createMailer } = require('./mailer');
test('recovery mail escapes labels, uses fixed subjects, exact UTC deadlines and trusted review link', async () => {
  const mailer = createMailer({
    transport: 'memory',
    publicBaseUrl: 'https://sysnode.info',
  });
  await mailer.sendRecoveryAlert({
    to: 'owner@example.com',
    kind: 'scheduled',
    account: '0x' + '11'.repeat(20),
    label: '<script>alert(1)</script>',
    chainName: 'zkTanenbaum',
    operationId: '0x' + '22'.repeat(32),
    operation: { executable_at: 1800000000, expires_at: 1800604800 },
    messageId: '<test@sysnode.info>',
  });
  const mail = mailer.outbox[0];
  expect(mail.html).not.toContain('<script>');
  expect(mail.html).toContain('&lt;script&gt;');
  expect(mail.html).toContain(
    'href="https://sysnode.info/account#recovery-alerts"'
  );
  expect(mail.text).toContain(new Date(1800000000000).toISOString());
  expect(mail.text).toContain('best effort');
  expect(mail.text).toContain('observed chain state, not a finality guarantee');
  expect(mail.text).toContain('A chain reorganization can change it');
  expect(mail.messageId).toBe('<test@sysnode.info>');
});
