const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { normalizeEmail } = require('../lib/email');
const securityLog = require('../lib/securityLog');

// Emit a structured security event every time a limiter trips so
// operators can grep `rate_limit.tripped` to correlate bursts with
// IPs / users. `bucket` identifies WHICH limiter fired (login,
// register, verify-email, vote) without depending on the freeform
// req path. We intentionally do NOT log the full key (it contains
// email for login bucket) — the reqContext already captures
// ip/userId which is the forensic minimum.
function trippedHandler(bucket) {
  return (req, res, _next, options) => {
    securityLog.warn('rate_limit.tripped', { req, bucket });
    res.status(options.statusCode).json(options.message);
  };
}

// Per-route limiters for authentication endpoints.
// In-memory store is fine for single-process; switch to a shared store (Redis
// etc.) if we move to multi-process in the future.
//
// Email-bucketed keys MUST use the same normalization as `users.verifyAuth`
// (`normalizeEmail`: NFKC + trim + lowercase). Otherwise an attacker can
// bypass the bucket by submitting canonical-equivalent variants (trailing
// whitespace, different Unicode normalization, mixed case) while still hitting
// the same account downstream.
//
// IP-bucketed keys MUST go through `ipKeyGenerator` rather than using raw
// `req.ip`. For IPv4 it's a no-op, but for IPv6 it masks down to the /56
// subnet so a single /64 (or smaller) allocation can't trivially rotate
// addresses to bypass the limit.

const MINUTE = 60 * 1000;

function ipBucket(req) {
  return ipKeyGenerator(req.ip || '');
}

function loginKey(req) {
  const raw = (req.body && req.body.email) || '';
  return `login|${ipBucket(req)}|${normalizeEmail(raw)}`;
}

function mfaLoginKey(req) {
  return `login-totp|${ipBucket(req)}`;
}

// Per-session bucket for authenticated password re-checks. This endpoint is
// a credential oracle only after an attacker already has a live session+CSRF
// pair; keying by session contains abuse to that stolen session instead of
// letting it burn the whole user's account budget. The IP fallback keeps the
// limiter safe if a future caller mounts it in the wrong order.
function authenticatedStepUpKey(req) {
  const sessionId =
    req.session && req.session.id != null ? String(req.session.id) : null;
  if (sessionId) return `step-up|s${sessionId}`;
  return `step-up|ip|${ipBucket(req)}`;
}

const verifyPasswordKey = authenticatedStepUpKey;

function registerKey(req) {
  return `register|${ipBucket(req)}`;
}

// /auth/verify-email is unauthenticated and consumes a 64-hex one-shot
// token against a pending_registrations row. Brute-forcing the token
// space is computationally infeasible (2^256) AND every attempt burns
// a `runAtomic` + two repo reads, so the real risk here is DoS from a
// flood of invalid-token requests, not credential attack. We bucket
// by the /56-masked IP (same as register) and set a generous cap:
// legitimate users click the link once; even slow SMTP + retry looks
// like a few requests per hour from any single network. A hundred
// per 15 minutes still trips WAY before a floor of "flood the
// transaction log" abuse becomes a problem. Separate key prefix so
// a register flood does NOT eat into a legit user's verify budget.
function verifyEmailKey(req) {
  return `verify-email|${ipBucket(req)}`;
}

// Per-user bucket for /gov/vote. IP alone is wrong here: a shared-IP
// office can legitimately vote from many accounts in one hour, and a
// user on a mobile IPv6 prefix can churn through addresses faster
// than the register bucket's /56 masking catches. We bucket by the
// authenticated user.id (set by sessionMw.requireAuth before this
// limiter runs) and fall back to IP for defense in depth — a
// pre-auth miss here should never happen in production, but the
// fallback keeps the limiter safe if someone mounts it without the
// auth middleware.
function voteKey(req) {
  const uid = req.user && req.user.id != null ? String(req.user.id) : null;
  if (uid) return `vote|u${uid}`;
  return `vote|ip|${ipBucket(req)}`;
}

// Per-user bucket for /gov/receipts/reconcile. This endpoint may issue
// gobject_getcurrentvotes RPCs, so it needs its own budget instead of
// sharing /gov/vote's relay budget.
function reconcileKey(req) {
  const uid = req.user && req.user.id != null ? String(req.user.id) : null;
  if (uid) return `reconcile|u${uid}`;
  return `reconcile|ip|${ipBucket(req)}`;
}

function loginLimiter() {
  return rateLimit({
    windowMs: 15 * MINUTE,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: loginKey,
    message: { error: 'too_many_attempts' },
    handler: trippedHandler('login'),
  });
}

function mfaLoginLimiter() {
  return rateLimit({
    windowMs: 15 * MINUTE,
    // Per-challenge OTP guessing is capped in the TOTP repository. This
    // limiter is an endpoint DoS guard, so it must not key on the
    // attacker-supplied challenge token.
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: mfaLoginKey,
    message: { error: 'too_many_attempts' },
    handler: trippedHandler('login-totp'),
  });
}

function authenticatedStepUpLimiter() {
  return rateLimit({
    windowMs: 15 * MINUTE,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: authenticatedStepUpKey,
    message: { error: 'too_many_attempts' },
    handler: trippedHandler('authenticated-step-up'),
  });
}

const verifyPasswordLimiter = authenticatedStepUpLimiter;

function registerLimiter() {
  return rateLimit({
    windowMs: 60 * MINUTE,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: registerKey,
    message: { error: 'too_many_registrations' },
    handler: trippedHandler('register'),
  });
}

// 100 attempts / 15 min / IP. See `verifyEmailKey` above for the
// rationale: this is a DoS bound, not a credential-attack bound.
// Using the same message code as the /login limiter so the SPA can
// surface a generic "too many attempts" without leaking which
// endpoint tripped.
function verifyEmailLimiter() {
  return rateLimit({
    windowMs: 15 * MINUTE,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: verifyEmailKey,
    message: { error: 'too_many_attempts' },
    handler: trippedHandler('verify-email'),
  });
}

// /gov/vote: 60 POSTs per hour per user. A proposal cycle has a few
// dozen active proposals; a user who votes on every proposal twice
// (e.g. changed their mind) still fits comfortably. Each request
// carries up to MAX_VOTE_ENTRIES entries, so the effective ceiling
// is ample without inviting abuse.
function voteLimiter() {
  return rateLimit({
    windowMs: 60 * MINUTE,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: voteKey,
    message: { error: 'too_many_vote_requests' },
    handler: trippedHandler('vote'),
  });
}

function reconcileLimiter() {
  return rateLimit({
    windowMs: 60 * MINUTE,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: reconcileKey,
    message: { error: 'too_many_reconcile_requests' },
    handler: trippedHandler('reconcile'),
  });
}

function disabled() {
  return (_req, _res, next) => next();
}

module.exports = {
  loginLimiter,
  mfaLoginLimiter,
  authenticatedStepUpLimiter,
  verifyPasswordLimiter,
  registerLimiter,
  verifyEmailLimiter,
  voteLimiter,
  reconcileLimiter,
  disabled,
  // Exported for direct unit testing.
  loginKey,
  mfaLoginKey,
  authenticatedStepUpKey,
  verifyPasswordKey,
  registerKey,
  verifyEmailKey,
  voteKey,
  reconcileKey,
};
