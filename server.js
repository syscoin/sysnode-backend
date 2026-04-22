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
const { createReminderLog } = require('./lib/reminderLog');
const { createReminderDispatcher } = require('./lib/reminderDispatcher');
const { createProposalDispatcher } = require('./lib/proposalDispatcher');
const { createProposalRpc } = require('./lib/proposalRpc');
const {
  buildCollateralPsbt,
  createDefaultSyscoinClient,
} = require('./lib/proposalPsbt');
const { createPaliChainGuard } = require('./lib/paliChainGuard');

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
// The frontend (e.g. https://sysnode.info) is the origin we link to in
// outgoing emails. The backend API lives on a different origin
// (https://syscoin.dev today) and only serves JSON, so links must be
// built against FRONTEND_URL. This value is shared between appFactory
// (for the email-verification link) and the mailer itself (for vote-
// reminder CTAs) — compute it once here.
const PUBLIC_BASE_URL =
  process.env.FRONTEND_URL ||
  process.env.CORS_ORIGIN ||
  'http://localhost:3000';
const mailer = createMailer({
  transport: selectMailTransport(),
  from: process.env.MAIL_FROM || 'no-reply@syscoin.dev',
  publicBaseUrl: PUBLIC_BASE_URL,
});
const services = finalizeSessionMw(buildServices({ db }));

// Session parsing must cover every route that reads `req.user`. /gov
// uses `requireAuth` in its router; without parse running here first
// `req.user` would always be undefined and every authenticated caller
// would see a 401.
app.use(['/auth', '/vault', '/gov'], services.sessionMw.parse);

// Proposal RPC adapter.
//
// The governance-proposals code (dispatcher + prepare pre-flight)
// speaks a camelCase surface on purpose — see
// lib/proposalDispatcher.js for the full rationale.
// @syscoin/syscoin-js exposes snake_case methods (`gObject_submit`,
// `gObject_check`, `getRawTransaction`) that return a "stub" you
// `.call()` to actually fire. The wrapping lives in
// `lib/proposalRpc.js` so it can be unit-tested directly; without
// that extraction a regression in the argument shape sent to
// syscoin-js / syscoind (e.g. stringified revision/time) would only
// surface in integration.
const proposalRpc = createProposalRpc(() => rpcServices(client.callRpc));

// "Pay with Pali" wiring.
//
// Both `SYSCOIN_NETWORK` and `SYSCOIN_BLOCKBOOK_URL` must be set for
// the /collateral/psbt route to function. We pre-wire the syscoinjs
// client at boot so every request reuses one SyscoinJSLib instance
// (it's stateless across requests — it only holds a Blockbook URL
// and a bitcoinjs network object). When either env var is missing we
// leave `paliPsbtBuilder` null; the gov-proposals router then
// returns 503 from that route and reports `paliPathEnabled: false`
// from GET /network, so the FE hides the button cleanly.
//
// NOTE: the chain declared here via SYSCOIN_NETWORK is ONLY trusted
// after it's been cross-checked against the actual RPC node's
// `getblockchaininfo.chain`. That cross-check lives in
// `paliChainGuard` below (constructed right after this block); the
// router refuses /collateral/psbt until the guard reports ready, so
// an operator misconfiguration (e.g. SYSCOIN_NETWORK=mainnet but
// SYSCOIN_RPC_* pointing at a testnet node) cannot cause users to
// burn 150 SYS on the wrong chain.
const PALI_NETWORK_KEY = (() => {
  const raw = String(process.env.SYSCOIN_NETWORK || '').trim().toLowerCase();
  if (raw === 'mainnet') return 'mainnet';
  if (raw === 'testnet') return 'testnet';
  return null;
})();
const PALI_BLOCKBOOK_URL =
  typeof process.env.SYSCOIN_BLOCKBOOK_URL === 'string'
    ? process.env.SYSCOIN_BLOCKBOOK_URL.trim()
    : '';

let paliSyscoinClient = null;
let paliPsbtBuilder = null;
let paliNetworkInfo = null;
if (PALI_NETWORK_KEY && PALI_BLOCKBOOK_URL) {
  try {
    paliSyscoinClient = createDefaultSyscoinClient({
      blockbookURL: PALI_BLOCKBOOK_URL,
      networkKey: PALI_NETWORK_KEY,
    });
    paliPsbtBuilder = paliSyscoinClient
      ? (args) =>
          buildCollateralPsbt({ ...args, syscoinClient: paliSyscoinClient })
      : null;
    paliNetworkInfo = {
      // `chain` mirrors the string Core returns from getblockchaininfo
      // so /network readers can compare against a value they've seen
      // elsewhere. slip44 is the BIP-44 coin type (57 for mainnet SYS,
      // 1 for any testnet per BIP-44), which Pali's chainId response
      // can be cross-checked against.
      chain: PALI_NETWORK_KEY === 'mainnet' ? 'main' : 'test',
      slip44: PALI_NETWORK_KEY === 'mainnet' ? 57 : 1,
      networkKey: PALI_NETWORK_KEY,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[pali] failed to wire Pali PSBT builder; path stays disabled',
      err && err.message
    );
    paliSyscoinClient = null;
    paliPsbtBuilder = null;
    paliNetworkInfo = null;
  }
} else if (PALI_NETWORK_KEY || PALI_BLOCKBOOK_URL) {
  // Half-configured: loud warning so the operator notices on boot.
  // eslint-disable-next-line no-console
  console.warn(
    '[pali] SYSCOIN_NETWORK and SYSCOIN_BLOCKBOOK_URL must both be set;' +
      ' Pali collateral path disabled until both are present.'
  );
}

// Chain-verification guard (Codex PR10 P1).
//
// Even with both env vars set correctly, the RPC node behind them
// could be on a different chain (common mistake: repointed
// SYSCOIN_RPC_HOST without flipping SYSCOIN_NETWORK). If we trust
// the env blindly, the PSBT builder would happily burn 150 SYS on
// the env-declared chain while the dispatcher watches the RPC
// chain — funds gone, submission eternally stuck in
// `awaiting_collateral` until timeout. The guard probes
// getblockchaininfo.chain once the RPC is reachable and disables
// the Pali path on mismatch. We still publish /network with
// paliPathEnabled=false + paliPathReason so the FE can explain why
// the button is grey.
const paliChainGuard = paliNetworkInfo
  ? createPaliChainGuard({
      declaredChain: paliNetworkInfo.chain,
      fetchActualChain: async () => {
        const info = await rpcServices(client.callRpc)
          .getBlockchainInfo()
          .call();
        return info && info.chain;
      },
      log: (level, event, meta) => {
        // eslint-disable-next-line no-console
        console[level === 'error' ? 'error' : 'log'](
          `[pali-guard] ${level} ${event}`,
          meta || ''
        );
      },
    })
  : null;
if (paliChainGuard) {
  paliChainGuard.start();
}

mountAuthAndVault(app, {
  services,
  mailer,
  baseUrl: process.env.BASE_URL || 'http://localhost:3001',
  frontendUrl: PUBLIC_BASE_URL,
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
  proposalRpc,
  governanceNetworkInfo: paliNetworkInfo,
  buildCollateralPsbt: paliPsbtBuilder,
  paliChainGuard,
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

// Governance reminder dispatcher (PR 7).
//
// Fires hourly. The dispatcher itself decides whether any email is
// owed on a given tick by comparing the current time to the earliest
// proposal deadline. Users who have voted in the current cycle are
// skipped by the dispatcher's internal gating; users who have opted
// out of reminders in notification_prefs are never considered.
//
// We intentionally source active proposals from `gObject_list` RPC
// on each tick rather than reading a cached view: the tick cadence
// is hourly and the RPC is cheap, so adding a cache layer only
// inflates the code surface. If reminders ever graduate to sub-hour
// cadence, wrap this with a short-lived memo.
//
// Mailer is the same instance wired into /auth above (line ~121);
// createMailer is idempotent in the 'log' / 'memory' transports and
// fine to share for 'smtp' since nodemailer pools internally. We
// deliberately reuse rather than re-create to avoid a double-pooled
// SMTP connection for what is semantically one mail pipeline.
const reminderLog = createReminderLog(db);
const reminderDispatcher = createReminderDispatcher({
  users: services.users,
  voteReceipts: services.voteReceipts,
  reminderLog,
  mailer,
  // Shape: [{ hash, endEpoch }]. gObject_list returns a map keyed by
  // gov-object hash, with `DataString` containing the per-proposal
  // JSON that has end_epoch (unix seconds). We project here rather
  // than inside the dispatcher because the RPC shape is a
  // server-side concern (the dispatcher contract is the normalized
  // shape).
  getActiveProposals: async () => {
    const raw = await rpcServices(client.callRpc).gObject_list().call();
    const out = [];
    for (const key of Object.keys(raw)) {
      const entry = raw[key];
      let data;
      try {
        data = JSON.parse(entry.DataString);
      } catch {
        continue;
      }
      const endEpoch = Number(data && data.end_epoch);
      if (!Number.isFinite(endEpoch) || endEpoch <= 0) continue;
      out.push({ hash: entry.Hash, endEpoch });
    }
    return out;
  },
  log: (level, event, meta) => {
    // eslint-disable-next-line no-console
    console.log(`[reminder] ${level} ${event}`, meta || '');
  },
});

// First tick 5 minutes after boot (lets the RPC warm up), then hourly.
// We `unref()` both so the dispatcher never keeps the event loop alive
// on its own — if the HTTP server shuts down, the process exits.
setTimeout(() => {
  reminderDispatcher.tick().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[reminder] initial tick failed', err && err.message);
  });
  setInterval(() => {
    reminderDispatcher.tick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[reminder] tick failed', err && err.message);
    });
  }, 60 * 60 * 1000).unref();
}, 5 * 60 * 1000).unref();

// -----------------------------------------------------------------------------
// Proposal dispatcher (PR 8).
//
// Walks `awaiting_collateral` submissions: bumps confirmation counts
// from getRawTransaction, fires gObject_submit once >= 6 confs, and
// transitions rows to `submitted` or `failed`. The mailer hooks
// resolve the submission's user and send the corresponding template.
//
// Same cadence philosophy as the reminder dispatcher: first tick a
// few minutes after boot (lets the RPC warm up) and then once a
// minute — fast enough that the 6-conf threshold is observed within
// about a block of real confirmation, slow enough to be polite to
// the RPC node (N rows → N getRawTransaction calls per tick). The
// timer is .unref()'d so it never keeps the process alive on its own.
// -----------------------------------------------------------------------------
const proposalDispatcher = createProposalDispatcher({
  submissions: services.proposalSubmissions,
  rpc: proposalRpc,
  onSubmitted: async ({ submission }) => {
    const user = services.users.findById(submission.userId);
    if (!user || !user.email) return;
    await mailer.sendProposalSubmitted({
      to: user.email,
      proposalName: submission.name,
      governanceHash: submission.governanceHash,
      collateralTxid: submission.collateralTxid,
      submissionId: submission.id,
    });
  },
  onFailed: async ({ submission }) => {
    const user = services.users.findById(submission.userId);
    if (!user || !user.email) return;
    await mailer.sendProposalFailed({
      to: user.email,
      proposalName: submission.name,
      failReason: submission.failReason,
      failDetail: submission.failDetail,
      submissionId: submission.id,
    });
  },
  log: (level, event, meta) => {
    // eslint-disable-next-line no-console
    console.log(`[proposal] ${level} ${event}`, meta || '');
  },
});

// Codex PR8 round 9 P2: self-scheduling dispatcher loop.
//
// The previous implementation used `setInterval(..., 60s)` which
// fires on a fixed cadence regardless of how long the last tick is
// still running. Under slow RPC or a large `awaiting_collateral`
// backlog, a single tick can easily exceed the interval — two
// workers then start processing the same rows concurrently, which
// at best doubles the `getRawTransaction` / `gObjectSubmit` load on
// the RPC node (and any shared rate limiter) and at worst races on
// state transitions that the CAS guards in proposalSubmissions.js
// would otherwise collapse cleanly. Serialize with a
// self-scheduling `setTimeout` that re-arms only AFTER the previous
// `tick()` resolves (matching the appFactory.js pattern).
const PROPOSAL_DISPATCHER_INTERVAL_MS = 60 * 1000;
const PROPOSAL_DISPATCHER_KICKOFF_MS = 5 * 60 * 1000;

async function proposalDispatcherLoop() {
  try {
    await proposalDispatcher.tick();
  } catch (err) {
    // Dispatcher swallows per-row errors internally; any throw out
    // here is an invariant violation worth logging but not fatal.
    // eslint-disable-next-line no-console
    console.error('[proposal] tick failed', err && err.message);
  }
  setTimeout(proposalDispatcherLoop, PROPOSAL_DISPATCHER_INTERVAL_MS).unref();
}

setTimeout(() => {
  proposalDispatcherLoop();
}, PROPOSAL_DISPATCHER_KICKOFF_MS).unref();

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Sysnode backend running on port ${PORT}`);
});
