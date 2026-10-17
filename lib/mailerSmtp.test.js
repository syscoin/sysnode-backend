const net = require('net');
const { createMailer } = require('./mailer');

test('the installed CommonJS mailer authenticates and delivers one verification recipient over SMTP', async () => {
  const commands = [];
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 localhost test SMTP\r\n');
    let pending = '';
    let data = null;
    socket.on('data', (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 2);
        if (data !== null) {
          if (line === '.') {
            messages.push(data.join('\r\n'));
            data = null;
            socket.write('250 2.0.0 accepted\r\n');
          } else data.push(line);
          continue;
        }
        commands.push(line);
        if (line.startsWith('EHLO ')) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH PLAIN ')) socket.write('235 2.7.0 authenticated\r\n');
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 2.1.0 accepted\r\n');
        else if (line === 'DATA') { data = []; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 2.0.0 goodbye\r\n');
        else socket.write('500 unexpected test command\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const mailer = createMailer({
      transport: 'smtp',
      from: 'Sysnode <no-reply@example.com>',
      smtp: { host: '127.0.0.1', port: server.address().port, user: 'test-user', pass: 'test-password' },
    });
    await mailer.sendVerification({ to: 'user+tag@example.com', link: 'https://sysnode.info/verify-email?token=abc' });
    const auth = commands.find((line) => line.startsWith('AUTH PLAIN '));
    expect(Buffer.from(auth.slice('AUTH PLAIN '.length), 'base64').toString()).toBe('\0test-user\0test-password');
    expect(commands.filter((line) => line.startsWith('MAIL FROM:'))).toEqual(['MAIL FROM:<no-reply@example.com>']);
    expect(commands.filter((line) => line.startsWith('RCPT TO:'))).toEqual(['RCPT TO:<user+tag@example.com>']);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^To: user\+tag@example.com$/m);
    const decoded = messages[0].replace(/=\r\n/g, '').replace(/=([A-F\d]{2})/g,
      (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    expect(decoded).toContain('https://sysnode.info/verify-email?token=abc');
    expect(mailer.outbox).toEqual([]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}, 10_000);
