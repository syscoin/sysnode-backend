const crypto = require('crypto');
const securityLog = require('../lib/securityLog');

// Double-submit CSRF.
//
// On login we set a `csrf` cookie (not HttpOnly) with a random 32-byte token.
// The SPA reads it via `document.cookie` (or a helper) and mirrors it as the
// `X-CSRF-Token` header on every state-changing request. SameSite=Lax on the
// session cookie already blocks cross-site top-level POSTs, but the header
// requirement defeats same-site attacks via embedded forms in the SPA itself.
//
// GET/HEAD/OPTIONS are exempt (they must be idempotent).

const CSRF_COOKIE = 'csrf';

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function buildCookieOpts(expiresAt, { secure }) {
  return {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  };
}

function createCsrfMiddleware({ secureCookies }) {
  // Constant-time comparison of two CSRF tokens.
  //
  // The previous implementation guarded `crypto.timingSafeEqual` with a
  // String#length check, then passed the strings through `Buffer.from(x)`
  // for the compare. String#length is UTF-16 code-unit count; Buffer.from
  // default-encodes UTF-8. For any non-ASCII header value with the same
  // UTF-16 length as the cookie, the two resulting buffers differ in
  // BYTE length and `timingSafeEqual` throws RangeError. Because this
  // ran inside csrfMw.require, it was reachable on every CSRF-protected
  // route (logout, change-password, vault writes) and turned a normal
  // CSRF mismatch into a 500. (Codex round-11 P1.)
  //
  // Fix: encode both sides to utf-8 bytes explicitly, bail cleanly if
  // the byte lengths differ. Our issued tokens are always 64 hex ASCII
  // chars, so any honest client hits the fast equality branch; hostile
  // headers return false instead of throwing.
  function timingEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  }

  return {
    require(req, res, next) {
      const m = req.method.toUpperCase();
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
      const cookieToken = req.cookies && req.cookies[CSRF_COOKIE];
      const headerToken = req.get('X-CSRF-Token');
      if (!cookieToken || !headerToken) {
        // F5: structured security event — operators can grep for
        // csrf.* to spot abuse patterns. `reason` distinguishes the
        // "client forgot the header" benign case from a same-site
        // attack without logging the tokens themselves.
        securityLog.warn('csrf.missing', {
          req,
          reason: !cookieToken ? 'no_cookie' : 'no_header',
        });
        return res.status(403).json({ error: 'csrf_missing' });
      }
      if (!timingEqual(cookieToken, headerToken)) {
        securityLog.warn('csrf.mismatch', { req });
        return res.status(403).json({ error: 'csrf_mismatch' });
      }
      next();
    },

    issueCookie(res, expiresAt) {
      const token = newToken();
      res.cookie(
        CSRF_COOKIE,
        token,
        buildCookieOpts(expiresAt, { secure: secureCookies })
      );
      return token;
    },

    clearCookie(res) {
      res.clearCookie(CSRF_COOKIE, {
        httpOnly: false,
        secure: secureCookies,
        sameSite: 'lax',
        path: '/',
      });
    },
  };
}

module.exports = { createCsrfMiddleware, CSRF_COOKIE };
