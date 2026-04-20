const rateLimit = require('express-rate-limit');

// Per-route limiters for authentication endpoints.
// In-memory store is fine for single-process; switch to a shared store (Redis
// etc.) if we move to multi-process in the future.

const MINUTE = 60 * 1000;

function loginLimiter() {
  return rateLimit({
    windowMs: 15 * MINUTE,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    // Key on ip + email so attackers can't grind one account by rotating IPs
    // from a single subnet, and so honest users on shared IPs can still try.
    keyGenerator: (req) => {
      const email = (req.body && req.body.email) || '';
      return `${req.ip}|${email.toLowerCase()}`;
    },
    message: { error: 'too_many_attempts' },
  });
}

function verifyEmailResendLimiter() {
  return rateLimit({
    windowMs: 60 * MINUTE,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const email = (req.body && req.body.email) || '';
      return `resend|${email.toLowerCase()}`;
    },
    message: { error: 'too_many_resends' },
  });
}

function registerLimiter() {
  return rateLimit({
    windowMs: 60 * MINUTE,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `register|${req.ip}`,
    message: { error: 'too_many_registrations' },
  });
}

// Disabled in tests so bursty Supertest runs don't trip the limiter.
function disabled() {
  return (_req, _res, next) => next();
}

module.exports = {
  loginLimiter,
  verifyEmailResendLimiter,
  registerLimiter,
  disabled,
};
