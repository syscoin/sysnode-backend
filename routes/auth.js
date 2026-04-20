const express = require('express');
const { z } = require('zod');

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

const ResendSchema = z.object({
  email: EMAIL_SCHEMA,
});

function badRequest(res, code, details) {
  return res
    .status(400)
    .json(details ? { error: code, details } : { error: code });
}

function createAuthRouter({
  users,
  sessions,
  verifications,
  mailer,
  sessionMw,
  csrfMw,
  limiters,
  baseUrl,
}) {
  const router = express.Router();

  async function sendVerificationEmail(user) {
    const token = verifications.issue(user.id);
    const link = `${baseUrl.replace(/\/$/, '')}/auth/verify-email?token=${token}`;
    try {
      await mailer.sendVerification({ to: user.email, link });
    } catch (err) {
      // Don't block registration on transient mail errors; surface the symptom
      // in logs and let the user retry via /auth/resend-verification.
      // eslint-disable-next-line no-console
      console.error('[auth] verification mail failed', err && err.message);
    }
  }

  // -------------------------------------------------------------------------
  // POST /auth/register
  // -------------------------------------------------------------------------
  router.post('/register', limiters.register, async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'invalid_body', parsed.error.flatten());

    try {
      const user = users.create({
        email: parsed.data.email,
        authHash: parsed.data.authHash,
      });
      await sendVerificationEmail(user);
      // Respond 202: registered, pending email verification. Never reveal
      // whether the email was already taken (that check happens in `create`
      // which throws `email_taken`; see catch below).
      return res.status(202).json({ status: 'verification_sent' });
    } catch (err) {
      if (err.code === 'invalid_email') return badRequest(res, 'invalid_email');
      if (err.code === 'email_taken') {
        // Return 202 anyway to avoid email enumeration. Don't re-send the
        // verification link here either (that's what /auth/resend is for).
        return res.status(202).json({ status: 'verification_sent' });
      }
      // eslint-disable-next-line no-console
      console.error('[auth/register]', err);
      return res.status(500).json({ error: 'internal' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /auth/resend-verification
  // -------------------------------------------------------------------------
  router.post('/resend-verification', limiters.resend, async (req, res) => {
    const parsed = ResendSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'invalid_body');
    const user = users.findByEmail(parsed.data.email);
    if (user && !user.emailVerified) {
      await sendVerificationEmail(user);
    }
    // Always 202 — no enumeration.
    return res.status(202).json({ status: 'verification_sent' });
  });

  // -------------------------------------------------------------------------
  // POST /auth/verify-email
  // Body: { token }. Accepts POST so the magic-link click triggers a CSRF-safe
  // form/script on the SPA rather than a naked GET (which would be logged in
  // referrer chains).
  // -------------------------------------------------------------------------
  router.post('/verify-email', async (req, res) => {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, 'invalid_token');
    const result = verifications.redeem(parsed.data.token);
    if (!result) return badRequest(res, 'invalid_or_expired_token');
    users.markEmailVerified(result.userId);
    verifications.clearForUser(result.userId);
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
