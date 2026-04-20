const express = require('express');
const { z } = require('zod');
const { normalizeEmail, isValidEmailSyntax } = require('../lib/email');

// Shape of client-provided data. authHash is the 32-byte HKDF output in hex
// produced by the client from PBKDF2-SHA512(password, email, 600k). The server
// never sees the password.
const HEX_32 = /^[0-9a-fA-F]{64}$/;
const HEX_32_SCHEMA = z.string().regex(HEX_32, 'authHash must be 32 hex bytes');
const EMAIL_SCHEMA = z.string().min(3).max(254);

const RegisterSchema = z.object({
  email: EMAIL_SCHEMA,
  authHash: HEX_32_SCHEMA,
});

const LoginSchema = RegisterSchema;

const ChangePasswordSchema = z.object({
  oldAuthHash: HEX_32_SCHEMA,
  newAuthHash: HEX_32_SCHEMA,
});

const VerifySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

function badRequest(res, code, details) {
  return res
    .status(400)
    .json(details ? { error: code, details } : { error: code });
}

// Express 4 quirk: returned promises from `async` route handlers are NOT
// routed through the app's error middleware. A bare `throw` inside an
// async handler becomes an unhandled rejection and can crash the process.
//
// This wrapper forces every rejection onto `next(err)`, which then hits
// the last-chance error middleware mounted in `lib/appFactory.js`. It
// means individual handlers can let transient DB/SMTP errors bubble
// without wrapping every write in try/catch, while the wire response is
// still a controlled 500 instead of a connection hang.
// (Codex round-9 P1 — covers /verify-email, /login post-verify path,
// and /change-password post-verify writes.)
function asyncHandler(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

function createAuthRouter({
  users,
  sessions,
  pendingRegistrations,
  mailer,
  sessionMw,
  csrfMw,
  limiters,
  baseUrl,
  frontendUrl,
  scheduler,
  runAtomic,
}) {
  if (typeof runAtomic !== 'function') {
    throw new Error('createAuthRouter: runAtomic is required');
  }
  const router = express.Router();

  // The verification link must land on the frontend (which will POST the
  // token back to this router). Pointing at `baseUrl` — the backend's own
  // origin — would hit a route that only accepts POST, producing a dead link
  // when the user clicks from their mail client.
  const verifyBase = (frontendUrl || baseUrl).replace(/\/$/, '');

  // Background-job hook. Defaults to `setImmediate`, but tests inject a
  // synchronous runner so they can assert on the mailer outbox without
  // racing ticks.
  const schedule = scheduler || ((fn) => setImmediate(fn));

  function mailLink(token) {
    return `${verifyBase}/verify-email?token=${token}`;
  }

  // -------------------------------------------------------------------------
  // POST /auth/register
  //
  // Deferred credential binding (Codex P1 fix, round 4):
  //
  //   OLD flow: POST /register immediately wrote (email, HMAC(authHash)) into
  //   the users table with email_verified=0. An attacker could pre-register
  //   the victim's email with the attacker's own authHash and wait for the
  //   victim to click the verification link.
  //
  //   NEW flow: no user row is created at register time. Instead a
  //   pending_registrations row binds (email, stored_auth) to a freshly
  //   issued one-shot verification token. The user row is created — already
  //   verified — only when that specific token is redeemed on /verify-email.
  //   Multiple concurrent pending rows for the same email are harmless:
  //   each carries its own stored_auth snapshot, whichever is redeemed
  //   first "wins" and purgeForEmail wipes the rest.
  //
  // Timing / correctness split (Codex round-6 P1):
  //   The Round-4 rewrite moved ALL post-parse work into the background so
  //   that response timing carried no signal about account state. But
  //   putting the pending-row INSERT in the background too meant
  //   configuration failures (e.g. missing SYSNODE_AUTH_PEPPER in
  //   pendingRegistrations.issue) produced a silent 202 with nothing
  //   scheduled — users saw "check your email" forever.
  //
  //   We now split the work:
  //     • Synchronous path (must succeed, else 5xx):
  //         - parse + email-syntax validation,
  //         - check "is there already a verified owner?" (cheap lookup),
  //         - if no, issue the pending_registrations row (cheap insert).
  //       These steps either all succeed or they all fail loudly — no
  //       silent drop-on-floor.
  //     • Background path (best-effort):
  //         - SMTP send. Transient SMTP blips are isolated from the
  //           response, and the user can simply re-POST /register to get
  //           a fresh token + retry.
  //
  //   Timing cross-talk between "verified owner exists" and "new email"
  //   is bounded to one SQLite SELECT plus conditionally one INSERT —
  //   on the order of a few hundred microseconds, far below network
  //   jitter + TLS handshake variance. The substantive timing leak that
  //   motivated Round 4 (seconds-scale cost of Argon2 / SMTP in the
  //   critical path) is gone either way.
  // -------------------------------------------------------------------------
  router.post('/register', limiters.register, asyncHandler(async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(res, 'invalid_body', parsed.error.flatten());
    }
    const { email, authHash } = parsed.data;

    if (!isValidEmailSyntax(normalizeEmail(email))) {
      return badRequest(res, 'invalid_email');
    }

    let token = null;
    try {
      const existing = users.findByEmail(email);
      const alreadyVerified = !!(existing && existing.emailVerified);
      if (!alreadyVerified) {
        // Issue synchronously so config errors (missing pepper, bad DB
        // state) fail fast with 5xx rather than producing a silent 202
        // that never results in a deliverable link.
        token = pendingRegistrations.issue({ email, authHash });
      }
    } catch (err) {
      if (err.code === 'invalid_email') {
        return badRequest(res, 'invalid_email');
      }
      // eslint-disable-next-line no-console
      console.error('[auth/register] pending-issue failed', err);
      return res.status(500).json({ error: 'internal' });
    }

    if (token) {
      schedule(async () => {
        try {
          await mailer.sendVerification({
            to: email,
            link: mailLink(token),
          });
        } catch (err) {
          // SMTP is best-effort: if it fails, user retries /register
          // and a fresh pending row + send is issued. We don't retry
          // internally to keep this endpoint fast and predictable.
          // eslint-disable-next-line no-console
          console.error(
            '[auth/register] mailer.sendVerification failed',
            err && err.message
          );
        }
      });
    }

    return res.status(202).json({ status: 'verification_sent' });
  }));

  // -------------------------------------------------------------------------
  // POST /auth/verify-email
  //
  // Body: { token }. Redeems a pending_registrations row and creates the
  // user account already verified. If an account already exists for this
  // email (another pending for the same email verified first), we surface
  // 409 and purge remaining pendings so attacker-spawned tokens die.
  // -------------------------------------------------------------------------
  router.post('/verify-email', asyncHandler(async (req, res) => {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'invalid_token');

    // Atomic redemption + account write (Codex round-10 P1).
    //
    // The old flow called pendingRegistrations.redeem() unconditionally
    // up front, so any downstream DB failure (users.* throw, SQLite
    // error) burned the user's token forever — they couldn't retry with
    // their original link, and any other pending token for the same
    // email stayed live as a latent account-takeover vector.
    //
    // Wrapping redeem + all subsequent writes in a single transaction
    // means a throw at any step rolls back the redeem as well. The
    // token stays valid for a legitimate retry, and purgeForEmail
    // (which only fires on the success path) still wipes competing
    // pendings after the account is successfully created/promoted.
    //
    // The body MUST be synchronous — better-sqlite3 transactions can't
    // await. All repo calls here are synchronous prepared statements.
    let outcome;
    try {
      outcome = runAtomic(() => {
        const redeemed = pendingRegistrations.redeem(parsed.data.token);
        if (!redeemed) return { kind: 'invalid_or_expired_token' };

        const { email, storedAuth } = redeemed;

        // Three cases to handle (in order):
        //   (1) Users row exists and is already verified → 409.
        //   (2) Users row exists and is still unverified → promote in
        //       place (round-5 P1 defense against a regression that
        //       re-introduces unverified rows; migration 003 wipes any
        //       legacy ones at deploy).
        //   (3) No users row → insert verified from the snapshot. Can
        //       race another verify-email for the same email and lose
        //       on UNIQUE(email); re-check in the email_taken branch.
        const existing = users.findByEmail(email);
        if (existing && existing.emailVerified) {
          pendingRegistrations.purgeForEmail(email);
          return { kind: 'already_verified' };
        }
        if (existing && !existing.emailVerified) {
          const ok = users.promoteUnverifiedWithStoredAuth({
            id: existing.id,
            storedAuth,
          });
          pendingRegistrations.purgeForEmail(email);
          return { kind: ok ? 'verified' : 'already_verified' };
        }

        try {
          users.createVerifiedWithStoredAuth({ email, storedAuth });
        } catch (err) {
          if (err && err.code === 'email_taken') {
            const after = users.findByEmail(email);
            pendingRegistrations.purgeForEmail(email);
            if (after && after.emailVerified) {
              return { kind: 'already_verified' };
            }
            // Extremely unlikely (email_taken without a verified row).
            // Re-throw to roll back the transaction.
            throw err;
          }
          throw err;
        }
        pendingRegistrations.purgeForEmail(email);
        return { kind: 'verified' };
      });
    } catch (err) {
      if (err && err.code === 'invalid_email') {
        return badRequest(res, 'invalid_email');
      }
      // Any other throw rolled back the redeem — token is still live.
      // Let asyncHandler route to the central error middleware.
      throw err;
    }

    switch (outcome.kind) {
      case 'invalid_or_expired_token':
        return badRequest(res, 'invalid_or_expired_token');
      case 'already_verified':
        return res.status(409).json({ error: 'already_verified' });
      case 'verified':
        return res.json({ status: 'verified' });
      default:
        // Should be unreachable; defensive 500.
        // eslint-disable-next-line no-console
        console.error('[auth/verify-email] unknown outcome', outcome);
        return res.status(500).json({ error: 'internal' });
    }
  }));

  // -------------------------------------------------------------------------
  // POST /auth/login
  // -------------------------------------------------------------------------
  router.post('/login', limiters.login, asyncHandler(async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'invalid_body');
    let user;
    try {
      user = users.verifyAuth(parsed.data.email, parsed.data.authHash);
    } catch (err) {
      // Config errors (e.g. missing SYSNODE_AUTH_PEPPER) propagate out of
      // users.verifyAuth → kdf.verifyAuthHash. Surface as 503 so ops alerts
      // fire loudly instead of masquerading as a bad password. (Codex
      // round-7 P1.)
      if (err && err.code === 'kdf_config') {
        // eslint-disable-next-line no-console
        console.error('[auth/login] kdf config error', err.message);
        return res.status(503).json({ error: 'server_misconfigured' });
      }
      // Any other failure in verifyAuth (transient DB, etc.) is not a
      // credential mismatch. Let it bubble so asyncHandler routes it
      // through our central error middleware → 500. (Codex round-9 P1.)
      throw err;
    }
    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    if (!user.emailVerified) {
      return res.status(403).json({ error: 'email_not_verified' });
    }
    // sessions.issue / setSessionCookie / issueCookie may also throw on
    // transient DB failures. They ran unprotected before (Codex round-9
    // P1 "Guard login session creation"); asyncHandler now forwards any
    // rejection to the error middleware instead of producing an
    // unhandled promise rejection.
    const { token, expiresAt } = sessions.issue(user.id, {
      userAgent: req.get('user-agent') || null,
      ip: req.ip,
    });
    sessionMw.setSessionCookie(res, token, expiresAt);
    csrfMw.issueCookie(res, expiresAt);
    return res.json({
      user: { id: user.id, email: user.email },
      expiresAt,
    });
  }));

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------
  router.post('/logout', csrfMw.require, (req, res) => {
    if (req.sessionToken) sessions.revoke(req.sessionToken);
    sessionMw.clearSessionCookie(res);
    csrfMw.clearCookie(res);
    return res.json({ status: 'ok' });
  });

  // -------------------------------------------------------------------------
  // GET /auth/me
  // -------------------------------------------------------------------------
  router.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    return res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        emailVerified: req.user.emailVerified,
        notificationPrefs: req.user.notificationPrefs,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /auth/change-password
  // Client re-derives both old & new authHash from old/new passwords and
  // submits both. Server verifies old, rewrites stored_auth, invalidates
  // every session except this one (caller must re-login on other devices).
  // -------------------------------------------------------------------------
  router.post(
    '/change-password',
    sessionMw.requireAuth,
    csrfMw.require,
    asyncHandler(async (req, res) => {
      const parsed = ChangePasswordSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'invalid_body');
      let confirmed;
      try {
        confirmed = users.verifyAuth(
          req.user.email,
          parsed.data.oldAuthHash
        );
      } catch (err) {
        if (err && err.code === 'kdf_config') {
          // eslint-disable-next-line no-console
          console.error('[auth/change-password] kdf config error', err.message);
          return res.status(503).json({ error: 'server_misconfigured' });
        }
        // Non-config failures bubble through asyncHandler → error mw.
        // (Codex round-9 P1.)
        throw err;
      }
      if (!confirmed) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      // Atomic rotation of auth state (Codex round-10 P2).
      //
      // Without a transaction, the three writes here could leave the
      // account in torn states on mid-sequence failure:
      //   (a) updateAuthHash succeeds, revokeAllForUser fails → user's
      //       password rotated but old sessions on other devices are
      //       still live (silent auth bypass window).
      //   (b) both succeed, sessions.issue fails → every session
      //       revoked including the current one, user gets 500 but is
      //       silently signed out from everywhere.
      // Wrapping in a transaction rolls all three back on any throw,
      // so the only observable outcomes are "fully rotated" or "no
      // change". The client can retry safely.
      //
      // Side-effect note: setSessionCookie + csrfMw.issueCookie live
      // OUTSIDE the transaction (they only set response headers, no DB
      // writes). They must run after the transaction commits, using the
      // token/expiresAt produced inside.
      const { token, expiresAt } = runAtomic(() => {
        users.updateAuthHash(req.user.id, parsed.data.newAuthHash);
        sessions.revokeAllForUser(req.user.id);
        return sessions.issue(req.user.id, {
          userAgent: req.get('user-agent') || null,
          ip: req.ip,
        });
      });
      sessionMw.setSessionCookie(res, token, expiresAt);
      csrfMw.issueCookie(res, expiresAt);
      try {
        await mailer.sendPasswordChanged({
          to: req.user.email,
          when: Date.now(),
        });
      } catch (err) {
        // Password change itself succeeded; notification mail is
        // best-effort. Swallow and log.
        // eslint-disable-next-line no-console
        console.error('[auth/change-password] mail failed', err && err.message);
      }
      return res.json({ status: 'ok', expiresAt });
    })
  );

  return router;
}

module.exports = { createAuthRouter };
