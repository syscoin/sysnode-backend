// Session-cookie middleware.
//
// Two cookies are issued on login:
//   - `sid`     : the opaque session token. HttpOnly, so JS cannot read it.
//   - `csrf`    : a random CSRF token. NOT HttpOnly, so the SPA can mirror it
//                 in the X-CSRF-Token header (double-submit pattern).
//
// The CSRF middleware lives separately (middleware/csrf.js); this file only
// manages session identity.

const SESSION_COOKIE = 'sid';

function buildCookieOpts(expiresAt, { secure }) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  };
}

function createSessionMiddleware({ sessions, users, secureCookies }) {
  function attach(req) {
    const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    if (!token) return;
    const session = sessions.verify(token);
    if (!session) return;
    const user = users.findById(session.userId);
    if (!user) return;
    req.session = session;
    req.user = user;
    req.sessionToken = token;
  }

  return {
    parse(req, _res, next) {
      try {
        attach(req);
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

    // Allows endpoints that behave differently for signed-in users but
    // don't require it (e.g. governance list with vote-enabled actions).
    optionalAuth(req, _res, next) {
      next();
    },

    setSessionCookie(res, token, expiresAt) {
      res.cookie(
        SESSION_COOKIE,
        token,
        buildCookieOpts(expiresAt, { secure: secureCookies })
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
