const crypto = require('crypto');

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
  function timingEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  return {
    require(req, res, next) {
      const m = req.method.toUpperCase();
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
      const cookieToken = req.cookies && req.cookies[CSRF_COOKIE];
      const headerToken = req.get('X-CSRF-Token');
      if (!cookieToken || !headerToken) {
        return res.status(403).json({ error: 'csrf_missing' });
      }
      if (!timingEqual(cookieToken, headerToken)) {
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
