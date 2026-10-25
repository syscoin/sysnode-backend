'use strict';

// Isolate the process-crash regression from Jest. Only an ephemeral loopback
// server, an in-memory database and the real auth router are used.
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { gzipSync, deflateSync } = require('node:zlib');
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { openDatabase } = require('../../lib/db');
const { createMailer } = require('../../lib/mailer');
const { buildServices, mountAuthAndVault, createApp } = require('../../lib/appFactory');

process.env.NODE_ENV = 'test';
process.env.SYSNODE_AUTH_PEPPER = 'a'.repeat(64);
const db = openDatabase(':memory:');
const mailer = createMailer({ transport: 'memory', from: 'test@example.com' });
const mode = process.argv[2];
let app;
if (mode === 'production') {
  app = express();
  // server.js's production parser, followed by its actual auth route wiring.
  app.use(bodyParser.json({ limit: '256kb' }));
  app.use(cookieParser());
  mountAuthAndVault(app, { services: buildServices({ db, secureCookies: false }), mailer, disableRateLimit: true });
} else if (mode === 'standalone') {
  app = createApp({ db, mailer, secureCookies: false, disableRateLimit: true }).app;
} else {
  throw new Error('unknown_test_mode');
}

// The deflate frame must finish before trailing request bytes arrive. This
// schedules the final write from the real parser's completion callback, as in
// the upstream GHSA regression, without intercepting uncaught exceptions.
let afterParse = null;
const parserLayer = app._router.stack.find((layer) => layer.name === 'jsonParser');
assert(parserLayer, 'real JSON parser is mounted');
const parser = parserLayer.handle;
parserLayer.handle = (req, res, next) => parser(req, res, (error) => {
  if (afterParse) { const finish = afterParse; afterParse = null; finish(); }
  next(error);
});
// Suppress Express's default stderr stack; preserve the middleware status.
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: 'invalid_body' }));

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  async function send({ encoding, first, trailing, path = '/auth/login', method = 'POST' }) {
    return new Promise((resolve, reject) => {
      const size = first ? first.length + (trailing?.length || 0) : 0;
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path, method, agent: false, headers: first ? {
          'Content-Type': 'application/json', 'Content-Encoding': encoding,
          'Content-Length': size,
        } : {} }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('compressed_request_timeout')));
      if (trailing) {
        afterParse = () => req.end(trailing);
        req.write(first);
      } else req.end(first);
    });
  }
  try {
    const loginBody = JSON.stringify({ email: 'nobody@example.com', authHash: '0'.repeat(64) });
    const deflate = await send({ encoding: 'deflate',
      first: Buffer.concat([deflateSync(loginBody), Buffer.from([0])]), trailing: Buffer.alloc(1024) });
    assert.equal(deflate.status, 401); // Parsed credentials reached the real auth route.
    const gzip = await send({ encoding: 'gzip',
      first: Buffer.concat([gzipSync(loginBody), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]) });
    assert.equal(gzip.status, 401);
    const malformed = await send({ encoding: 'gzip', first: Buffer.from([0x01, 0x02, 0x03]) });
    assert.equal(malformed.status, 400);
    // Late decompressor errors must not crash or poison the next request.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const followup = await send({ method: 'GET', path: '/auth/me' });
    assert.equal(followup.status, 401);
    process.stdout.write(JSON.stringify({ mode, statuses: [deflate.status, gzip.status, malformed.status, followup.status] }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
