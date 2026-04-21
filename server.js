const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

// Load services (timed background workers). These are pre-existing.
require('./services/sysMain');
require('./services/masternodeTracker');

// Legacy public routes (no cookies, no credentials; stats + governance list
// + masternode list etc. consumed by sysnode-info and third parties).
const mnStatsRoute = require('./routes/mnStats');
const masternodesRoute = require('./routes/masternodes');
const governanceRoute = require('./routes/governance');
const csvParserRoute = require('./routes/csvParser');
const mnListRoute = require('./routes/mnList');
const mnSearchRoute = require('./routes/mnSearch');

// New authenticated subsystem (auth + vault + gov).
const { openDatabase } = require('./lib/db');
const { createMailer } = require('./lib/mailer');
const { selectMailTransport } = require('./lib/mailTransport');
const { assertPepperConfigured } = require('./lib/kdf');
const {
  buildServices,
  finalizeSessionMw,
  mountAuthAndVault,
} = require('./lib/appFactory');
const dataStore = require('./data/dataStore');
const { client, rpcServices } = require('./services/rpcClient');
const { createCurrentVotesCache } = require('./lib/voteReceipts');

// Per-process cache for `gobject_getcurrentvotes`. Concurrent callers
// hitting GET /gov/receipts for the same proposal share one RPC; a
// successful response is memoized for the cache's default TTL (2
// minutes), aligned with the receipts freshness window so the two
// layers decay together.
//
// The RPC name on syscoin-js is resolved dynamically via the stub's
// `callee.name.toLowerCase()` trick — camelCase `gObject_getCurrentVotes`
// maps to snake_case `gobject_getcurrentvotes` at call time.
const currentVotesCache = createCurrentVotesCache({
  callRpc: (proposalHash) =>
    rpcServices(client.callRpc).gObject_getCurrentVotes(proposalHash).call(),
});

const app = express();

// Reverse-proxy awareness. When deployed behind nginx / a load balancer,
// Express's default `req.ip` is the proxy's socket address, which collapses
// every real client into a single rate-limit bucket. `TRUST_PROXY` is read
// verbatim by express.set: it accepts "true"/"false", an IP/CIDR list, or a
// hop count. Default is `loopback` for local dev; production deployments
// should set it to the actual proxy hop (e.g. "1" for single nginx in front).
const rawTrustProxy = process.env.TRUST_PROXY;
app.set(
  'trust proxy',
  rawTrustProxy === undefined
    ? 'loopback'
    : rawTrustProxy === 'true'
      ? true
      : rawTrustProxy === 'false'
        ? false
        : /^\d+$/.test(rawTrustProxy)
          ? Number(rawTrustProxy)
          : rawTrustProxy
);

// Security headers apply everywhere. helmet defaults are safe for JSON APIs.
app.use(helmet());
app.use(bodyParser.json({ limit: '256kb' }));
app.use(cookieParser());

// -----------------------------------------------------------------------------
// CORS: legacy public data routes keep `origin: *` so existing third-party
// consumers don't break. Auth, vault, and gov use credentialed CORS pinned
// to the SPA origin (browsers reject `*` with credentials). /gov is the
// authenticated voting surface; it carries cookies + the X-CSRF-Token
// header and MUST go through `authCors` or browsers will block the
// preflight.
//
// CRITICAL: the prefix match MUST be on a path boundary — i.e. "exactly
// `/gov`" or "starts with `/gov/`". A naive `startsWith('/gov')` also
// catches the legacy public endpoints `/govlist` and `/govbyhash`
// (routes/governance.js), which are historically served under
// `origin: '*'` and must keep working for third-party consumers that
// are not on the configured CORS_ORIGIN. Same argument applies to
// `/auth` / `/vault`, though today those prefixes have no legacy
// collisions; we enforce the boundary everywhere to stay safe as the
// legacy surface evolves.
// -----------------------------------------------------------------------------
const legacyCors = cors({ origin: '*', optionsSuccessStatus: 200 });
const authCors = cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
});
const { isCredentialedPath } = require('./lib/credentialedPaths');
app.use((req, res, next) => {
  if (isCredentialedPath(req.path)) {
    return authCors(req, res, next);
  }
  return legacyCors(req, res, next);
});

// -----------------------------------------------------------------------------
// Authenticated subsystem wiring (before legacy routers so /auth and /vault
// match first; legacy routers register their own specific paths and won't
// shadow these).
// -----------------------------------------------------------------------------
const dbPath = process.env.SYSNODE_DB_PATH || './data/sysnode.db';
const db = openDatabase(dbPath);

// Boot-time config sanity checks. These throw synchronously so a
// misconfigured deploy crashes on startup rather than silently turning
// every login into a 401 (Codex round-7 P1 on pepper) or dropping mail
// to stdout (Codex round-6 P1 on SMTP).
assertPepperConfigured();
const mailer = createMailer({
  transport: selectMailTransport(),
  from: process.env.MAIL_FROM || 'no-reply@syscoin.dev',
});
const services = finalizeSessionMw(buildServices({ db }));

// Session parsing must cover every route that reads `req.user`. /gov
// uses `requireAuth` in its router; without parse running here first
// `req.user` would always be undefined and every authenticated caller
// would see a 401.
app.use(['/auth', '/vault', '/gov'], services.sessionMw.parse);

mountAuthAndVault(app, {
  services,
  mailer,
  baseUrl: process.env.BASE_URL || 'http://localhost:3001',
  frontendUrl:
    process.env.FRONTEND_URL ||
    process.env.CORS_ORIGIN ||
    'http://localhost:3000',
  // Read the live tracker array fresh on every call rather than
  // snapshotting it here — the tracker REASSIGNS `masternodesArr`
  // every 10s (`data.masternodesArr = []`), so a captured reference
  // would go stale after the first refresh. `dataStore.masternodesArr`
  // is a property access and therefore always returns the current value.
  masternodesProvider: () => dataStore.masternodesArr,
  voteRaw: (collateralHash, collateralIndex, governanceHash, signal, outcome, time, voteSig) =>
    rpcServices(client.callRpc)
      .voteRaw(
        collateralHash,
        collateralIndex,
        governanceHash,
        signal,
        outcome,
        time,
        voteSig
      )
      .call(true),
  getCurrentVotes: (proposalHash) => currentVotesCache.get(proposalHash),
  invalidateCurrentVotes: (proposalHash) =>
    currentVotesCache.invalidate(proposalHash),
});

// -----------------------------------------------------------------------------
// Legacy public routes: mounted AFTER auth/vault to keep historical path
// registration exactly as it was before this PR.
// -----------------------------------------------------------------------------
app.use(mnStatsRoute);
app.use(masternodesRoute);
app.use(governanceRoute);
app.use(csvParserRoute);
app.use(mnListRoute);
app.use(mnSearchRoute);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Housekeeping: expire stale sessions + pending-registration tokens once
// per hour. pending_registrations is bounded by TTL (default 30m) so the
// sweep is mostly defensive — it caps table growth if the router is ever
// spammed faster than natural expiry + redeem-on-use can drain it.
setInterval(() => {
  try {
    services.sessions.cleanupExpired();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sessions.cleanup]', err && err.message);
  }
  try {
    services.pendingRegistrations.cleanupExpired();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pendingRegistrations.cleanup]', err && err.message);
  }
}, 60 * 60 * 1000).unref();

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Sysnode backend running on port ${PORT}`);
});
