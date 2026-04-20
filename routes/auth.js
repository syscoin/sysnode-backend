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
}) {
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

  async function issueAndMail({ email, authHash }) {
    try {
      const token = pendingRegistrations.issue({ email, authHash });
      await mailer.sendVerification({ to: email, link: mailLink(token) });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] issueAndMail failed', err && err.message);
    }
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
  // Timing:
  //   The response MUST NOT vary by whether a verified user already exists
  //   for this email. We therefore always schedule the actual mail send in
  //   the background and return 202 synchronously. Attackers see constant
  //   response latency whether the email belongs to an existing account or
  //   is brand new.
  // -------------------------------------------------------------------------
  router.post('/register', limiters.register, async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(res, 'invalid_body', parsed.error.flatten());
    }
    const { email, authHash } = parsed.data;

    // Reject syntactically invalid emails synchronously. This path is
    // safe to surface (non-timing-sensitive): whether "foo" parses as an
    // email is a pure function of the submitted string, so it cannot leak
    // account existence. The existence check — "does a verified user
    // already own this email?" — is what we still do asynchronously
    // below to keep response timing constant.
    if (!isValidEmailSyntax(normalizeEmail(email))) {
      return badRequest(res, 'invalid_email');
    }

    schedule(async () => {
      try {
        const existing = users.findByEmail(email);
        if (existing && existing.emailVerified) {
          // Account already exists and is verified; don't spam the owner
          // with a bogus "confirm your email" message. Silent no-op.
          return;
        }
        await issueAndMail({ email, authHash });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[auth/register.bg]', err && err.message);
      }
    });

    return res.status(202).json({ status: 'verification_sent' });
  });

  // -------------------------------------------------------------------------
  // POST /auth/verify-email
  //
  // Body: { token }. Redeems a pending_registrations row and creates the
  // user account already verified. If an account already exists for this
  // email (another pending for the same email verified first), we surface
  // 409 and purge remaining pendings so attacker-spawned tokens die.
  // -------------------------------------------------------------------------
  router.post('/verify-email', async (req, res) => {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'invalid_token');

    const redeemed = pendingRegistrations.redeem(parsed.data.token);
    if (!redeemed) return badRequest(res, 'invalid_or_expired_token');

    const { email, storedAuth } = redeemed;

    // Three cases to handle (in order):
    //   (1) Users row exists and is already verified → 409 already_verified.
    //   (2) Users row exists and is still unverified → promote it in
    //       place, rebinding stored_auth to the just-redeemed pending
    //       (Codex round-5 P1: migration 003 clears these at deploy,
    //        but we also defend in code against any future regression
    //        that might leak an unverified row back into the table).
    //   (3) No users row → create verified from the redeemed snapshot.
    //       Insert can still race against a concurrent verify-email for
    //       the same email and lose on the UNIQUE(email) constraint; we
    //       re-check and fall back to cases (1)/(2).
    const existing = users.findByEmail(email);
    if (existing && existing.emailVerified) {
      pendingRegistrations.purgeForEmail(email);
      return res.status(409).json({ error: 'already_verified' });
    }
    if (existing && !existing.emailVerified) {
      const ok = users.promoteUnverifiedWithStoredAuth({
        id: existing.id,
        storedAuth,
      });
      if (!ok) {
        // Race: row was concurrently flipped to verified. Treat as already
        // verified to match case (1) above.
        pendingRegistrations.purgeForEmail(email);
        return res.status(409).json({ error: 'already_verified' });
      }
      pendingRegistrations.purgeForEmail(email);
      return res.json({ status: 'verified' });
    }

    try {
      users.createVerifiedWithStoredAuth({ email, storedAuth });
    } catch (err) {
      if (err.code === 'email_taken') {
        // Lost the UNIQUE(email) race to a concurrent verify-email on a
        // different pending for the same address. Reload; the other
        // redeem created a verified row, so fold into the already_verified
        // response.
        const after = users.findByEmail(email);
        pendingRegistrations.purgeForEmail(email);
        if (after && after.emailVerified) {
          return res.status(409).json({ error: 'already_verified' });
        }
        // Extremely unlikely: email_taken without a verified row. Fail
        // loud rather than silently drop the verify request.
        // eslint-disable-next-line no-console
        console.error('[auth/verify-email] email_taken without verified row');
        return res.status(500).json({ error: 'internal' });
      }
      if (err.code === 'invalid_email') return badRequest(res, 'invalid_email');
      // eslint-disable-next-line no-console
      console.error('[auth/verify-email]', err);
      return res.status(500).json({ error: 'internal' });
    }

    pendingRegistrations.purgeForEmail(email);
    return res.json({ status: 'verified' });
  });

  // -------------------------------------------------------------------------
  // POST /auth/login
  // -------------------------------------------------------------------------
  router.post('/login', limiters.login, async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'invalid_body');
    const user = users.verifyAuth(parsed.data.email, parsed.data.authHash);
    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    if (!user.emailVerified) {
      return res.status(403).json({ error: 'email_not_verified' });
    }
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
  });

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
    async (req, res) => {
      const parsed = ChangePasswordSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'invalid_body');
      const confirmed = users.verifyAuth(
        req.user.email,
        parsed.data.oldAuthHash
      );
      if (!confirmed) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      users.updateAuthHash(req.user.id, parsed.data.newAuthHash);
      sessions.revokeAllForUser(req.user.id);
      // Re-issue a fresh session for the current request.
      const { token, expiresAt } = sessions.issue(req.user.id, {
        userAgent: req.get('user-agent') || null,
        ip: req.ip,
      });
      sessionMw.setSessionCookie(res, token, expiresAt);
      csrfMw.issueCookie(res, expiresAt);
      try {
        await mailer.sendPasswordChanged({
          to: req.user.email,
          when: Date.now(),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[auth/change-password] mail failed', err && err.message);
      }
      return res.json({ status: 'ok', expiresAt });
    }
  );

  return router;
}

module.exports = { createAuthRouter };
