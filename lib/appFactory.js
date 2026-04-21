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
const { createSessionMiddleware } = require('../middleware/session');
const { createCsrfMiddleware } = require('../middleware/csrf');
const rateLimiters = require('../middleware/rateLimit');
const { createAuthRouter } = require('../routes/auth');
const { createVaultRouter } = require('../routes/vault');
const { createGovRouter } = require('../routes/gov');

// Build the stateful services (repos + middlewares) around a DB handle.
// Pure-ish: no Express side effects yet, so the same object graph can be
// mounted onto either a dedicated test app (see `createApp`) or the legacy
// `server.js` alongside its unaffected public routes.
function buildServices({
  db,
  now = () => Date.now(),
  secureCookies = process.env.NODE_ENV === 'production',
} = {}) {
  if (!db) throw new Error('buildServices: db is required');
  return {
    users: createUsersRepo(db, { now }),
    sessions: createSessionStore(db, { now }),
    verifications: createVerificationsRepo(db, { now }),
    pendingRegistrations: createPendingRegistrationsRepo(db, { now }),
    vaults: createVaultsRepo(db, { now }),
    sessionMw: null, // finalized once we know `users`
    csrfMw: createCsrfMiddleware({ secureCookies }),
    secureCookies,
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
  }
) {
  if (!services.sessionMw) finalizeSessionMw(services);
  const limiters = disableRateLimit
    ? {
        login: rateLimiters.disabled(),
        register: rateLimiters.disabled(),
        vote: rateLimiters.disabled(),
      }
    : {
        login: rateLimiters.loginLimiter(),
        register: rateLimiters.registerLimiter(),
        vote: rateLimiters.voteLimiter(),
      };

  app.use(
    '/auth',
    createAuthRouter({
      users: services.users,
      sessions: services.sessions,
      pendingRegistrations: services.pendingRegistrations,
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
        voteLimiter: limiters.vote,
        nowMs: now,
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
        // eslint-disable-next-line no-console
        console.warn(`[${req.method} ${req.originalUrl}] payload too large`);
        return res.status(413).json({ error: 'payload_too_large' });
      }
      // eslint-disable-next-line no-console
      console.warn(`[${req.method} ${req.originalUrl}] ${status}`, err.message);
      return res.status(status).json({ error: err.code || 'bad_request' });
    }
    // eslint-disable-next-line no-console
    console.error(`[${req.method} ${req.originalUrl}] uncaught error`, err);
    res.status(500).json({ error: 'internal' });
  });
}

// Standalone app builder used by tests and by any deployment that wants
// auth+vault without the legacy public routes.
function createApp({
  db,
  mailer,
  now = () => Date.now(),
  secureCookies = process.env.NODE_ENV === 'production',
  corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000',
  baseUrl = process.env.BASE_URL || 'http://localhost:3001',
  frontendUrl = process.env.FRONTEND_URL ||
    process.env.CORS_ORIGIN ||
    'http://localhost:3000',
  disableRateLimit = process.env.NODE_ENV === 'test',
  scheduler,
  masternodesProvider,
  voteRaw,
} = {}) {
  if (!db) throw new Error('appFactory: db is required');
  if (!mailer) throw new Error('appFactory: mailer is required');

  const services = finalizeSessionMw(buildServices({ db, now, secureCookies }));

  const app = express();
  app.use(helmet());
  app.use(cors({ origin: corsOrigin, credentials: true }));
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
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return {
    app,
    users: services.users,
    sessions: services.sessions,
    verifications: services.verifications,
    pendingRegistrations: services.pendingRegistrations,
    vaults: services.vaults,
    sessionMw: services.sessionMw,
    csrfMw: services.csrfMw,
    runAtomic: services.runAtomic,
  };
}

module.exports = {
  buildServices,
  finalizeSessionMw,
  mountAuthAndVault,
  createApp,
};
