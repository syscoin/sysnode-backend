const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');

const { createUsersRepo } = require('./users');
const { createSessionStore } = require('./sessions');
const { createVerificationsRepo } = require('./verifications');
const {
  createPendingRegistrationsRepo,
} = require('./pendingRegistrations');
const { createVaultsRepo } = require('./vaults');
const { createVoteReceiptsRepo } = require('./voteReceipts');
const { createProposalDraftsRepo } = require('./proposalDrafts');
const { createProposalSubmissionsRepo } = require('./proposalSubmissions');
const { createProposalDispatcher } = require('./proposalDispatcher');
const { createSessionMiddleware } = require('../middleware/session');
const { createCsrfMiddleware } = require('../middleware/csrf');
const rateLimiters = require('../middleware/rateLimit');
const { createAuthRouter } = require('../routes/auth');
const { createVaultRouter } = require('../routes/vault');
const { createGovRouter } = require('../routes/gov');
const { createGovProposalsRouter } = require('../routes/govProposals');
const securityLog = require('./securityLog');

function parseBooleanEnv(value, name) {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name}_invalid`);
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function resolveSecureCookies(explicit) {
  if (typeof explicit === 'boolean') return explicit;
  const fromEnv = parseBooleanEnv(
    process.env.SYSNODE_SECURE_COOKIES,
    'SYSNODE_SECURE_COOKIES'
  );
  if (typeof fromEnv === 'boolean') return fromEnv;
  return isProduction();
}

function assertSecureCookieConfig(secureCookies) {
  if (isProduction() && secureCookies !== true) {
    throw new Error('secure_cookies_required_in_production');
  }
}

function normalizeHttpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch (_err) {
    return null;
  }
}

function normalizeProductionCorsOrigin(corsOrigin) {
  try {
    return new URL(corsOrigin).origin;
  } catch (_err) {
    return corsOrigin;
  }
}

function assertProductionAuthConfig({ secureCookies, corsOrigin, frontendUrl }) {
  assertSecureCookieConfig(secureCookies);
  if (!isProduction()) return;

  const frontendOrigin = normalizeHttpsOrigin(frontendUrl);
  const corsNormalizedOrigin = normalizeHttpsOrigin(corsOrigin);
  if (!frontendOrigin) {
    throw new Error('frontend_https_url_required_in_production');
  }
  if (!corsNormalizedOrigin || corsNormalizedOrigin !== frontendOrigin) {
    throw new Error('same_origin_cors_required_in_production');
  }
}

// Build the stateful services (repos + middlewares) around a DB handle.
// Pure-ish: no Express side effects yet, so the same object graph can be
// mounted onto either a dedicated test app (see `createApp`) or the legacy
// `server.js` alongside its unaffected public routes.
function buildServices({
  db,
  now = () => Date.now(),
  secureCookies,
} = {}) {
  if (!db) throw new Error('buildServices: db is required');
  const resolvedSecureCookies = resolveSecureCookies(secureCookies);
  assertSecureCookieConfig(resolvedSecureCookies);
  return {
    users: createUsersRepo(db, { now }),
    sessions: createSessionStore(db, { now }),
    verifications: createVerificationsRepo(db, { now }),
    pendingRegistrations: createPendingRegistrationsRepo(db, { now }),
    vaults: createVaultsRepo(db, { now }),
    voteReceipts: createVoteReceiptsRepo(db, { now }),
    proposalDrafts: createProposalDraftsRepo(db, { now }),
    proposalSubmissions: createProposalSubmissionsRepo(db, { now }),
    sessionMw: null, // finalized once we know `users`
    csrfMw: createCsrfMiddleware({ secureCookies: resolvedSecureCookies }),
    secureCookies: resolvedSecureCookies,
    // Shared atomic-write helper. Route handlers that touch multiple
    // repos (/verify-email = pendingRegistrations.redeem +
    // users.create; /change-password = users.updateAuthHash +
    // sessions.revokeAllForUser + sessions.issue) wrap the sequence in
    // `runAtomic(() => { ... })` so any thrown error rolls back every
    // prior write in the group. Uses better-sqlite3's `db.transaction`
    // (SAVEPOINT-backed, supports nesting). Body MUST be synchronous —
    // no awaits inside.
    runAtomic: (fn) => db.transaction(fn)(),
  };
}

function finalizeSessionMw(services) {
  services.sessionMw = createSessionMiddleware({
    sessions: services.sessions,
    users: services.users,
    secureCookies: services.secureCookies,
  });
  return services;
}

// Mount /auth and /vault onto an existing Express app with a pre-configured
// middleware chain (cors + json + cookieParser + session.parse). Caller is
// responsible for that chain.
function mountAuthAndVault(
  app,
  {
    services,
    mailer,
    baseUrl = process.env.BASE_URL || 'http://localhost:3001',
    frontendUrl = process.env.FRONTEND_URL ||
      process.env.CORS_ORIGIN ||
      'http://localhost:3000',
    disableRateLimit = process.env.NODE_ENV === 'test',
    scheduler,
    now = () => Date.now(),
    masternodesProvider,
    voteRaw,
    getCurrentVotes,
    invalidateCurrentVotes,
    // Optional: Syscoin RPC adapter for governance writes.
    // Expected shape (camelCase on purpose — see
    // lib/proposalDispatcher.js for the full rationale; callers
    // wrap @syscoin/syscoin-js's snake_case methods):
    //   getRawTransaction(txid, verbose?)  -> tx-json / throws
    //   gObjectSubmit(parentHash, rev, t, dataHex, txid) -> hash
    //   gObjectCheck(parentHash, rev, t, dataHex)       -> ok|detail
    // Only the subset actually consumed by each route/dispatcher is
    // used, so test wiring can mock sparsely.
    proposalRpc = null,
    // Optional: info about which chain this backend is pinned to, and
    // an (already-wired) Pali collateral-PSBT builder. Both flow
    // straight through to createGovProposalsRouter — see the big
    // doc-comment there. Leaving either null disables the "Pay with
    // Pali" path server-side (the /collateral/psbt route returns 503
    // and /network reports paliPathEnabled=false), so the FE cleanly
    // falls back to the manual CLI flow.
    governanceNetworkInfo = null,
    buildCollateralPsbt = null,
    // Optional: live guard that cross-checks SYSCOIN_NETWORK against
    // the actual RPC chain. See routes/govProposals.js for the
    // contract. Pass-through only.
    paliChainGuard = null,
  }
) {
  if (!services.sessionMw) finalizeSessionMw(services);
  const limiters = disableRateLimit
    ? {
        login: rateLimiters.disabled(),
        register: rateLimiters.disabled(),
        verifyEmail: rateLimiters.disabled(),
        vote: rateLimiters.disabled(),
        reconcile: rateLimiters.disabled(),
      }
    : {
        login: rateLimiters.loginLimiter(),
        register: rateLimiters.registerLimiter(),
        verifyEmail: rateLimiters.verifyEmailLimiter(),
        vote: rateLimiters.voteLimiter(),
        reconcile: rateLimiters.reconcileLimiter(),
      };

  app.use(
    '/auth',
    createAuthRouter({
      users: services.users,
      sessions: services.sessions,
      pendingRegistrations: services.pendingRegistrations,
      vaults: services.vaults,
      mailer,
      sessionMw: services.sessionMw,
      csrfMw: services.csrfMw,
      limiters,
      baseUrl,
      frontendUrl,
      scheduler,
      now,
      runAtomic: services.runAtomic,
    })
  );
  app.use(
    '/vault',
    createVaultRouter({
      vaults: services.vaults,
      sessionMw: services.sessionMw,
      csrfMw: services.csrfMw,
    })
  );

  // /gov is optional: only mount it when the caller has wired the
  // Syscoin RPC + masternode tracker. The legacy `server.js` path
  // always provides both; tests wire fakes or omit them entirely if
  // they only exercise /auth / /vault.
  if (typeof masternodesProvider === 'function' && typeof voteRaw === 'function') {
    app.use(
      '/gov',
      createGovRouter({
        masternodesProvider,
        voteRaw,
        sessionMw: services.sessionMw,
        csrfMw: services.csrfMw,
        receipts: services.voteReceipts,
        getCurrentVotes:
          typeof getCurrentVotes === 'function' ? getCurrentVotes : null,
        invalidateCurrentVotes:
          typeof invalidateCurrentVotes === 'function'
            ? invalidateCurrentVotes
            : null,
        voteLimiter: limiters.vote,
        reconcileLimiter: limiters.reconcile,
        nowMs: now,
      })
    );
  }

  // /gov/proposals is a separate, self-contained router. Unlike /gov
  // it does NOT depend on masternodesProvider or voteRaw; it only
  // needs the proposal repos (already in `services`) and — optionally
  // — a `proposalRpc` with gObjectCheck for the prepare-time
  // pre-flight. If no RPC is wired, the route degrades to "skip the
  // pre-flight" silently (see routes/govProposals.js). Mount it
  // unconditionally because users can still manage drafts offline.
  if (services.proposalDrafts && services.proposalSubmissions) {
    app.use(
      '/gov/proposals',
      createGovProposalsRouter({
        drafts: services.proposalDrafts,
        submissions: services.proposalSubmissions,
        sessionMw: services.sessionMw,
        csrfMw: services.csrfMw,
        rpc: proposalRpc,
        runAtomic: services.runAtomic,
        now,
        networkInfo: governanceNetworkInfo,
        buildCollateralPsbt,
        paliChainGuard,
      })
    );
  }

  // Last-chance error-handling middleware for /auth and /vault.
  //
  // Express 4 does not automatically route rejected async-handler
  // promises into error middleware, which is why the route handlers
  // themselves already catch + respond 500. This is belt-and-braces
  // for any future handler that forgets to wrap a throw, and for
  // upstream middleware (body-parser, etc.) that forwards errors via
  // next(err). We preserve well-known status codes from known errors
  // (e.g. body-parser PayloadTooLargeError → 413) and only default to
  // 500 for uncategorized throws. (Codex round-9 P1 defense.)
  // eslint-disable-next-line no-unused-vars
  app.use(['/auth', '/vault', '/gov'], (err, req, res, _next) => {
    if (res.headersSent) return;
    // Body-parser + a few other middlewares attach a `.status`/`.statusCode`
    // to errors that represent well-formed HTTP responses. Honor those so
    // we don't turn a 413 into a 500 here.
    const status = err && (err.status || err.statusCode);
    if (status && status >= 400 && status < 600) {
      if (status === 413) {
        securityLog.warn('http.payload_too_large', { req });
        return res.status(413).json({ error: 'payload_too_large' });
      }
      securityLog.warn('http.bad_request', {
        req,
        status,
        code: err.code,
        error: err.message,
      });
      return res.status(status).json({ error: err.code || 'bad_request' });
    }
    securityLog.error('http.uncaught_error', { req, error: err });
    res.status(500).json({ error: 'internal' });
  });
}

// Standalone app builder used by tests and by any deployment that wants
// auth+vault without the legacy public routes.
function createApp({
  db,
  mailer,
  now = () => Date.now(),
  secureCookies,
  corsOrigin = process.env.CORS_ORIGIN ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000',
  baseUrl = process.env.BASE_URL || 'http://localhost:3001',
  frontendUrl = process.env.FRONTEND_URL ||
    process.env.CORS_ORIGIN ||
    'http://localhost:3000',
  disableRateLimit = process.env.NODE_ENV === 'test',
  scheduler,
  masternodesProvider,
  voteRaw,
  getCurrentVotes,
  invalidateCurrentVotes,
  proposalRpc = null,
  // If true and a proposalRpc is wired, start the background
  // proposal dispatcher interval. Production: true. Tests: false
  // (they prefer to advance the dispatcher manually by calling
  // `tick()` so they can observe each transition deterministically).
  startProposalDispatcher = false,
  // Interval between dispatcher ticks when startProposalDispatcher
  // is true. Default 60s — slow enough to be polite to the RPC node
  // (n submissions * getRawTransaction per tick) but fast enough
  // that the 6-conf threshold is reached within ~1-2 blocks past
  // the real confirmation.
  proposalDispatcherIntervalMs = 60_000,
} = {}) {
  if (!db) throw new Error('appFactory: db is required');
  if (!mailer) throw new Error('appFactory: mailer is required');

  const resolvedSecureCookies = resolveSecureCookies(secureCookies);
  assertProductionAuthConfig({
    secureCookies: resolvedSecureCookies,
    corsOrigin,
    frontendUrl,
  });
  const effectiveCorsOrigin = normalizeProductionCorsOrigin(corsOrigin);

  const services = finalizeSessionMw(
    buildServices({ db, now, secureCookies: resolvedSecureCookies })
  );

  const app = express();
  app.use(helmet());
  app.use(cors({ origin: effectiveCorsOrigin, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(services.sessionMw.parse);

  mountAuthAndVault(app, {
    services,
    mailer,
    baseUrl,
    frontendUrl,
    disableRateLimit,
    scheduler,
    now,
    masternodesProvider,
    voteRaw,
    getCurrentVotes,
    invalidateCurrentVotes,
    proposalRpc,
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Optional: dispatcher lifecycle. We build the dispatcher even when
  // the interval is off so tests can drive it by calling `tick()`
  // directly via the returned handle. The onSubmitted / onFailed
  // hooks resolve the submission's user email and dispatch the
  // corresponding mailer method. A missing user record (ghost submission
  // after a hard account-delete) short-circuits without throwing —
  // these hooks are best-effort by design (dispatcher.js catches
  // everything).
  let dispatcher = null;
  let dispatcherTimer = null;
  // Codex PR8 round 8 P2: `stopProposalDispatcher` must prevent a
  // tick that is already *in flight* (i.e. awaiting
  // `dispatcher.tick()`) from re-arming the loop after it resolves.
  // clearTimeout() only cancels a *pending* timer — it can't abort
  // an async function that's already past the `await`. This flag
  // is checked right before scheduling the next setTimeout so a
  // late-arriving tick becomes a silent no-op instead of
  // resurrecting the polling loop (which would keep hitting
  // services and the RPC node on a process that's trying to shut
  // down cleanly, and leak the timer into post-teardown tests).
  let dispatcherStopped = false;
  if (proposalRpc && typeof proposalRpc.getRawTransaction === 'function') {
    async function mailOnStateChange(kind, submission) {
      // Lookup is read-only; users.findById returns null for a
      // deleted account, in which case we simply drop the email.
      let user;
      try {
        user = services.users.findById(submission.userId);
      } catch (_err) {
        return;
      }
      if (!user || !user.email) return;
      const common = {
        to: user.email,
        proposalName: submission.name,
        submissionId: submission.id,
      };
      if (kind === 'submitted') {
        await mailer.sendProposalSubmitted({
          ...common,
          governanceHash: submission.governanceHash,
          collateralTxid: submission.collateralTxid,
        });
      } else {
        await mailer.sendProposalFailed({
          ...common,
          failReason: submission.failReason,
          failDetail: submission.failDetail,
        });
      }
    }

    dispatcher = createProposalDispatcher({
      submissions: services.proposalSubmissions,
      rpc: proposalRpc,
      now,
      onSubmitted: ({ submission }) =>
        mailOnStateChange('submitted', submission),
      onFailed: ({ submission }) => mailOnStateChange('failed', submission),
    });

    if (startProposalDispatcher) {
      // Reset the stopped flag so re-wiring (e.g. in tests that
      // call mountAuthAndVault multiple times in the same process)
      // starts fresh.
      dispatcherStopped = false;
      // Stagger the first run a few seconds after boot so we don't
      // hammer the RPC node at the same instant as every other
      // scheduled task (reminder dispatcher, etc).
      const kickoff = setTimeout(() => {
        // eslint-disable-next-line no-inner-declarations
        async function fireAndSchedule() {
          // Codex PR8 round 8 P2: if stopProposalDispatcher() was
          // called after the previous setTimeout fired but before
          // this callback started running, the timer handle was
          // already consumed by Node and clearTimeout() was a
          // no-op. Bail out here so we don't hit services during
          // teardown.
          if (dispatcherStopped) return;
          try {
            await dispatcher.tick();
          } catch (err) {
            // Dispatcher swallows per-row errors internally; any
            // throw out here is an invariant violation worth logging.
            // eslint-disable-next-line no-console
            console.error('[proposalDispatcher] tick crashed', err);
          }
          // Re-check AFTER the await: stopProposalDispatcher may
          // have been called while the tick was in flight (common
          // in graceful-shutdown paths and in Jest teardown). If
          // it was, do NOT re-arm — otherwise the loop effectively
          // ignores the stop signal and keeps polling until
          // process exit.
          if (dispatcherStopped) return;
          dispatcherTimer = setTimeout(
            fireAndSchedule,
            proposalDispatcherIntervalMs
          );
        }
        fireAndSchedule();
      }, Math.min(5000, proposalDispatcherIntervalMs));
      dispatcherTimer = kickoff;
    }
  }

  function stopProposalDispatcher() {
    dispatcherStopped = true;
    if (dispatcherTimer) {
      clearTimeout(dispatcherTimer);
      dispatcherTimer = null;
    }
  }

  return {
    app,
    users: services.users,
    sessions: services.sessions,
    verifications: services.verifications,
    pendingRegistrations: services.pendingRegistrations,
    vaults: services.vaults,
    voteReceipts: services.voteReceipts,
    proposalDrafts: services.proposalDrafts,
    proposalSubmissions: services.proposalSubmissions,
    proposalDispatcher: dispatcher,
    stopProposalDispatcher,
    sessionMw: services.sessionMw,
    csrfMw: services.csrfMw,
    runAtomic: services.runAtomic,
  };
}

module.exports = {
  assertProductionAuthConfig,
  buildServices,
  finalizeSessionMw,
  mountAuthAndVault,
  normalizeProductionCorsOrigin,
  createApp,
};
