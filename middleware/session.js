// Session-cookie middleware.
//
// Two cookies are issued on login:
//   - `sid`  : the opaque session token. HttpOnly, so JS cannot read it.
//   - `csrf` : a random CSRF token. NOT HttpOnly, so the SPA can mirror it
//              in the X-CSRF-Token header (double-submit pattern).
//
// Sliding expiry: `sessions.verify(token)` bumps the DB `expires_at` forward
// on every authenticated request. To actually deliver the sliding behavior
// the caller promised, we must also refresh the cookie expiries on the HTTP
// response, otherwise the browser drops the cookie at the original login
// expiry and the user is silently logged out mid-session. `parse` does that
// refresh and carries the csrf cookie along so its lifetime tracks the
// session it's paired with.

const SESSION_COOKIE = 'sid';
const CSRF_COOKIE = 'csrf';

function sessionCookieOpts(expiresAt, { secure }) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  };
}

function csrfCookieOpts(expiresAt, { secure }) {
  // Must remain readable to the SPA so it can mirror the value into the
  // X-CSRF-Token header, hence httpOnly: false.
  return {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  };
}

function createSessionMiddleware({ sessions, users, secureCookies }) {
  function attach(req) {
    const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    if (!token) return null;
    const session = sessions.verify(token);
    if (!session) return null;
    const user = users.findById(session.userId);
    if (!user) return null;
    req.session = session;
    req.user = user;
    req.sessionToken = token;
    return session;
  }

  return {
    parse(req, res, next) {
      try {
        const session = attach(req);
        if (session) {
          // Re-emit the sid cookie with the newly-extended expiry so the
          // browser's cookie lifetime stays in sync with the DB's sliding
          // window.
          res.cookie(
            SESSION_COOKIE,
            req.sessionToken,
            sessionCookieOpts(session.expiresAt, { secure: secureCookies })
          );
          // Keep the csrf cookie's lifetime pinned to the session it guards.
          // Preserve the existing value — rotating it here would invalidate
          // the SPA's in-memory token and break every subsequent PUT/POST
          // until the user reloaded.
          const csrfToken = req.cookies && req.cookies[CSRF_COOKIE];
          if (csrfToken) {
            res.cookie(
              CSRF_COOKIE,
              csrfToken,
              csrfCookieOpts(session.expiresAt, { secure: secureCookies })
            );
          }
        }
      } catch {
        // Never fail the request on session-parse errors; downstream
        // requireAuth will handle the 401 if needed.
      }
      next();
    },

    requireAuth(req, res, next) {
      if (!req.user) return res.status(401).json({ error: 'unauthorized' });
      if (!req.user.emailVerified) {
        return res.status(403).json({ error: 'email_not_verified' });
      }
      next();
    },

    optionalAuth(req, _res, next) {
      next();
    },

    setSessionCookie(res, token, expiresAt) {
      res.cookie(
        SESSION_COOKIE,
        token,
        sessionCookieOpts(expiresAt, { secure: secureCookies })
      );
    },

    clearSessionCookie(res) {
      res.clearCookie(SESSION_COOKIE, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'lax',
        path: '/',
      });
    },
  };
}

module.exports = {
  createSessionMiddleware,
  SESSION_COOKIE,
};
