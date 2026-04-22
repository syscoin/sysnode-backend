'use strict';

const { SyscoinRpcClient, rpcServices } = require('@syscoin/syscoin-js');
const { createCookieProvider } = require('../lib/rpcCookieAuth');

// Syscoin Core RPC client.
// ------------------------
// Two authentication modes are supported, with cookie taking precedence:
//
//   1. Cookie file (preferred, default for same-host deployments):
//      `SYSCOIN_RPC_COOKIE_PATH` → absolute path to `<datadir>/.cookie`.
//      Core auto-generates this on startup and rewrites it on every
//      restart. We re-read on demand via a 401-driven retry so a Core
//      restart that rotates the token doesn't surface as an error to
//      callers of this client.
//
//   2. Static username/password (fallback for remote-host setups or
//      environments where `rpcauth` is already configured in
//      syscoin.conf): `SYSCOIN_RPC_USER` + `SYSCOIN_RPC_PASS`.
//
// If both are set, cookie wins and we log a one-line warning so the
// operator knows the env creds are being ignored. If neither is set
// we fail fast in production (RPC calls would all 401 anyway) but
// stay noisy-but-non-fatal in dev so contributors can boot features
// that don't touch Core.

function warn(msg) {
  // eslint-disable-next-line no-console
  console.warn(msg);
}

function resolveAuthMode() {
  const cookiePath = (process.env.SYSCOIN_RPC_COOKIE_PATH || '').trim();
  const username = process.env.SYSCOIN_RPC_USER;
  const password = process.env.SYSCOIN_RPC_PASS;
  const haveStatic = !!(username && password);
  const isProd = process.env.NODE_ENV === 'production';

  if (cookiePath) {
    if (haveStatic) {
      warn(
        '[rpcClient] SYSCOIN_RPC_COOKIE_PATH is set; ignoring SYSCOIN_RPC_USER/PASS.'
      );
    }
    return { mode: 'cookie', cookiePath };
  }

  if (!haveStatic) {
    const msg =
      '[rpcClient] No RPC credentials configured. Set SYSCOIN_RPC_COOKIE_PATH ' +
      '(preferred, same-host) or SYSCOIN_RPC_USER + SYSCOIN_RPC_PASS.';
    if (isProd) throw new Error(msg);
    warn(msg);
    return { mode: 'none' };
  }
  return { mode: 'static', username, password };
}

// Build the axios-backed SyscoinRpcClient with either the static
// creds baked in (static mode) or empty creds that we overwrite per
// request through an interceptor (cookie mode). This keeps us on the
// upstream lib without forking it.
function buildClient(authResolution) {
  const config = {
    host: process.env.SYSCOIN_RPC_HOST || 'localhost',
    rpcPort: Number(process.env.SYSCOIN_RPC_PORT) || 8370,
    username: authResolution.mode === 'static' ? authResolution.username : '',
    password: authResolution.mode === 'static' ? authResolution.password : '',
    logLevel: process.env.SYSCOIN_RPC_LOG_LEVEL || 'error',
  };
  return new SyscoinRpcClient(config);
}

function installCookieInterceptors(client, provider) {
  // Request: inject the current cookie creds on every call. Axios's
  // per-request `auth` overrides the default `auth` captured by the
  // SyscoinRpcClient constructor.
  client.instance.interceptors.request.use(function attachCookieAuth(cfg) {
    cfg.auth = provider.current();
    return cfg;
  });

  // Response: on a 401, the cookie almost certainly rotated (Core
  // restart). Force a fresh read and replay the request exactly once.
  // The `_cookieRetried` sentinel on the config prevents an infinite
  // loop if Core is genuinely misauthorised against the new cookie.
  client.instance.interceptors.response.use(
    function identity(res) {
      return res;
    },
    async function maybeRetryAfter401(err) {
      const cfg = err && err.config;
      const status = err && err.response && err.response.status;
      if (!cfg || status !== 401 || cfg._cookieRetried) {
        return Promise.reject(err);
      }
      cfg._cookieRetried = true;
      provider.forceReload();
      try {
        cfg.auth = provider.current();
      } catch (reloadErr) {
        // Cookie file vanished or became unreadable between requests.
        // Surface the reload error so the operator sees the root
        // cause, not the 401 that triggered the reload.
        return Promise.reject(reloadErr);
      }
      return client.instance.request(cfg);
    }
  );
}

const authResolution = resolveAuthMode();

let cookieProvider = null;
if (authResolution.mode === 'cookie') {
  cookieProvider = createCookieProvider({ path: authResolution.cookiePath });
  // Prime the cache at boot so operators get an actionable error at
  // startup instead of on the first RPC call minutes later.
  try {
    cookieProvider.current();
  } catch (err) {
    const msg = `[rpcClient] could not read SYSCOIN_RPC_COOKIE_PATH (${authResolution.cookiePath}): ${err.message}`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    }
    warn(msg);
  }
}

const client = buildClient(authResolution);

if (cookieProvider) {
  installCookieInterceptors(client, cookieProvider);
}

module.exports = {
  client,
  rpcServices,
  // Exported for tests and health endpoints. `null` when we are NOT
  // in cookie mode. Do not rely on this outside the backend itself.
  _cookieProvider: cookieProvider,
  _internal: {
    resolveAuthMode,
    installCookieInterceptors,
  },
};
