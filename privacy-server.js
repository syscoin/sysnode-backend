'use strict';

// A local-only public-data service. It does not load server.js, the Syscoin
// RPC client, the database, or any of the masternode/governance workers.
const express = require('express');
const { configuredPrivacyIndex } = require('./lib/privacyIndex');
const { configuredPrivacyRelayerDirectory } = require('./lib/privacyRelayerDirectory');
const { PRIVACY_PREFIXES, createPrivacyRouter } = require('./routes/privacy');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3477;

function portFrom(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('PRIVACY_PORT must be a port between 1 and 65535');
  }
  return Number(value);
}

function localHost(value, port) {
  return typeof value === 'string' &&
    new RegExp(`^(?:localhost|127\\.0\\.0\\.1):${port}$`, 'i').test(value);
}

function allowedOrigin(value) {
  if (!value) return true; // Native local clients, including curl.
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(value) ||
      /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.origin === value;
  } catch (_) { return false; }
}

function createPrivacyApp({ index, relayers }) {
  const app = express();
  // Host checks prevent a DNS name pointing at loopback from acting as this
  // service; origin checks keep ordinary remote web pages from reading it.
  app.use((req, res, next) => {
    if (!localHost(req.headers.host, req.socket.localPort) || !allowedOrigin(req.headers.origin) ||
        (!req.headers.origin && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none')) {
      return res.status(403).json({ error: 'local_privacy_request_rejected' });
    }
    next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(PRIVACY_PREFIXES, createPrivacyRouter({ index, relayers }));
  return app;
}

async function main(env = process.env) {
  const port = portFrom(env.PRIVACY_PORT);
  let index, relayers;
  try {
    index = configuredPrivacyIndex({ enabled: env.PRIVACY_INDEX_ENABLED, rpcUrl: env.PRIVACY_INDEX_RPC_URL });
    relayers = configuredPrivacyRelayerDirectory(env);
    if (!index && !relayers) throw new Error('Configure PRIVACY_INDEX_RPC_URL and enable at least one privacy service');
    const app = createPrivacyApp({ index, relayers });
    const server = await new Promise((resolve, reject) => {
      const listener = app.listen(port, HOST, () => resolve(listener));
      listener.once('error', reject);
    });
    let closing;
    const close = () => {
      if (!closing) closing = Promise.all([
        new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
        ...[index, relayers].filter(Boolean).map((service) => service.close()),
      ]);
      return closing;
    };
    return { server, close };
  } catch (error) {
    await Promise.allSettled([index, relayers].filter(Boolean).map((service) => service.close()));
    throw error;
  }
}

if (require.main === module) {
  main().then(({ server, close }) => {
    console.log(`Local privacy API listening on http://${HOST}:${server.address().port}`);
    const stop = () => close().catch(() => { console.error('Privacy API shutdown failed'); process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch((error) => {
    // Never print RPC URLs or provider errors, which may contain API keys.
    console.error(error.message === 'Configure PRIVACY_INDEX_RPC_URL and enable at least one privacy service'
      ? error.message : 'Unable to start privacy API; check configuration and port');
    process.exitCode = 1;
  });
}

module.exports = { HOST, DEFAULT_PORT, portFrom, localHost, allowedOrigin, createPrivacyApp, main };
