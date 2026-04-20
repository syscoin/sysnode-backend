const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');

const { createUsersRepo } = require('./users');
const { createSessionStore } = require('./sessions');
const { createVerificationsRepo } = require('./verifications');
const { createSessionMiddleware } = require('../middleware/session');
const { createCsrfMiddleware } = require('../middleware/csrf');
const rateLimiters = require('../middleware/rateLimit');
const { createAuthRouter } = require('../routes/auth');

// Factory that builds the full app (or just the auth subtree) around a
// supplied DB handle and mailer. Tests pass in-memory DB + memory mailer;
// production wires real SQLite + SMTP.

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

  const users = createUsersRepo(db, { now });
  const sessions = createSessionStore(db, { now });
  const verifications = createVerificationsRepo(db, { now });
  const sessionMw = createSessionMiddleware({
    sessions,
    users,
    secureCookies,
  });
  const csrfMw = createCsrfMiddleware({ secureCookies });

  const app = express();
  app.use(helmet());
  app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(sessionMw.parse);

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
      users,
      sessions,
      verifications,
      mailer,
      sessionMw,
      csrfMw,
      limiters,
      baseUrl,
      now,
    })
  );

  app.get('/health', (_req, res) => res.json({ ok: true }));

  return { app, users, sessions, verifications, sessionMw, csrfMw };
}

module.exports = { createApp };
