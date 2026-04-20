const rateLimit = require('express-rate-limit');
const { normalizeEmail } = require('../lib/email');

// Per-route limiters for authentication endpoints.
// In-memory store is fine for single-process; switch to a shared store (Redis
// etc.) if we move to multi-process in the future.
//
// Email-bucketed keys MUST use the same normalization as `users.verifyAuth`
// (`normalizeEmail`: NFKC + trim + lowercase). Otherwise an attacker can
// bypass the bucket by submitting canonical-equivalent variants (trailing
// whitespace, different Unicode normalization, mixed case) while still hitting
// the same account downstream.

const MINUTE = 60 * 1000;

function loginKey(req) {
  const raw = (req.body && req.body.email) || '';
  return `login|${req.ip}|${normalizeEmail(raw)}`;
}

function resendKey(req) {
  const raw = (req.body && req.body.email) || '';
  return `resend|${normalizeEmail(raw)}`;
}

function registerKey(req) {
  return `register|${req.ip}`;
}

function loginLimiter() {
  return rateLimit({
    windowMs: 15 * MINUTE,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: loginKey,
    message: { error: 'too_many_attempts' },
  });
}

function verifyEmailResendLimiter() {
  return rateLimit({
    windowMs: 60 * MINUTE,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: resendKey,
    message: { error: 'too_many_resends' },
  });
}

function registerLimiter() {
  return rateLimit({
    windowMs: 60 * MINUTE,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: registerKey,
    message: { error: 'too_many_registrations' },
  });
}

function disabled() {
  return (_req, _res, next) => next();
}

module.exports = {
  loginLimiter,
  verifyEmailResendLimiter,
  registerLimiter,
  disabled,
  // Exported for direct unit testing.
  loginKey,
  resendKey,
  registerKey,
};
