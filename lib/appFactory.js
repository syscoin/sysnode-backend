const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');

const { createUsersRepo } = require('./users');
const { createSessionStore } = require('./sessions');
const { createVerificationsRepo } = require('./verifications');
const { createVaultsRepo } = require('./vaults');
const { createSessionMiddleware } = require('../middleware/session');
const { createCsrfMiddleware } = require('../middleware/csrf');
const rateLimiters = require('../middleware/rateLimit');
const { createAuthRouter } = require('../routes/auth');
const { createVaultRouter } = require('../routes/vault');

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
    vaults: createVaultsRepo(db, { now }),
    sessionMw: null, // finalized once we know `users`
    csrfMw: createCsrfMiddleware({ secureCookies }),
    secureCookies,
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
    disableRateLimit = process.env.NODE_ENV === 'test',
    now = () => Date.now(),
  }
) {
  if (!services.sessionMw) finalizeSessionMw(services);
  const limiters = disableRateLimit
    ? {
        login: rateLimiters.disabled(),
        register: rateLimiters.disabled(),
        resend: rateLimiters.disabled(),
      }
    : {
        login: rateLimiters.loginLimiter(),
        register: rateLimiters.registerLimiter(),
        resend: rateLimiters.verifyEmailResendLimiter(),
      };

  app.use(
    '/auth',
    createAuthRouter({
      users: services.users,
      sessions: services.sessions,
      verifications: services.verifications,
      mailer,
      sessionMw: services.sessionMw,
      csrfMw: services.csrfMw,
      limiters,
      baseUrl,
      now,
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
  disableRateLimit = process.env.NODE_ENV === 'test',
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
    disableRateLimit,
    now,
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return {
    app,
    users: services.users,
    sessions: services.sessions,
    verifications: services.verifications,
    vaults: services.vaults,
    sessionMw: services.sessionMw,
    csrfMw: services.csrfMw,
  };
}

module.exports = {
  buildServices,
  finalizeSessionMw,
  mountAuthAndVault,
  createApp,
};
