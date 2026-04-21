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

// PR 7 — password change now rotates the vault wrap atomically.
//
// The client re-derives the new vaultKey from (newPassword, email,
// saltV), fetches the current vault blob + etag, re-wraps the inner
// Data Key under the new vaultKey (byte-identical payload), and
// submits the rewrapped blob here alongside the new authHash. The
// server performs the auth rotation AND the vault write inside a
// single DB transaction, so either both land or neither does. That
// closes the "stored_auth rewritten but vault still wrapped under the
// old key" lockout window the envelope.js comment warns about
// (see sysnode-info/src/lib/crypto/envelope.js:12–16).
//
// Clients without a vault row (registered but never imported keys)
// can omit the `vault` field. The handler detects that case and
// refuses password change if the user actually has an existing vault
// that was not rewrapped, rather than silently leaving them locked
// out.
const ChangePasswordSchema = z.object({
  oldAuthHash: HEX_32_SCHEMA,
  newAuthHash: HEX_32_SCHEMA,
  vault: z
    .object({
      blob: z.string().min(1),
      // If-Match equivalent. Echo the etag the client observed on its
      // most recent GET /vault. For first-write rotations (empty
      // vault), send '*' explicitly.
      ifMatch: z.string().min(1),
    })
    .optional(),
});

const VerifySchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

// PR 7 — account deletion (GDPR "right to erasure").
//
// Requires the user to re-prove possession of the current password
// (same `oldAuthHash` re-derivation the client already performs for
// /change-password). A hijacked session alone is NOT enough to nuke
// the account — the attacker would also need the password.
//
// Body is intentionally minimal (no confirmation tokens, email
// echoes, etc.): the UI handles the "are you sure" ceremony, the
// server's job is to validate credentials and erase durably.
const DeleteAccountSchema = z.object({
  oldAuthHash: HEX_32_SCHEMA,
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
  vaults,
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
  // `vaults` is optional in principle (some test harnesses mount auth
  // alone without a vault store), but /auth/change-password refuses to
  // serve when it is missing and the caller requests a vault-bearing
  // rotation. A plain auth-only rotation (no vault in the body AND no
  // vault row) still works without it.
  if (vaults && typeof vaults.put !== 'function') {
    throw new Error('createAuthRouter: vaults.put must be a function');
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

    // Normalize once up front. The rest of the handler (validation,
    // users lookup, pending issuance, AND the SMTP recipient) must use
    // the same canonical value. Previously the SMTP `to:` field was
    // passed the raw user input, so a form submission like
    // "  User@Example.COM  " would validate + persist as
    // "user@example.com" but be handed to nodemailer with surrounding
    // whitespace, which many SMTP servers reject at RCPT TO. Because
    // the send is best-effort / backgrounded, the API still returned
    // 202 and the user never got a link. (Codex round-12 P2.)
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmailSyntax(normalizedEmail)) {
      return badRequest(res, 'invalid_email');
    }

    let token = null;
    try {
      const existing = users.findByEmail(normalizedEmail);
      const alreadyVerified = !!(existing && existing.emailVerified);
      if (!alreadyVerified) {
        // Issue synchronously so config errors (missing pepper, bad DB
        // state) fail fast with 5xx rather than producing a silent 202
        // that never results in a deliverable link.
        token = pendingRegistrations.issue({
          email: normalizedEmail,
          authHash,
        });
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
            to: normalizedEmail,
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
      // saltV is delivered here (and on /auth/me) so the client has the
      // per-user vault salt in memory immediately after login, without a
      // second round-trip. It is not secret (anyone with a valid session
      // for this account can fetch it) and is required for the client's
      // HKDF(master, saltV) → vaultKey derivation that in turn wraps the
      // Data Key inside the encrypted vault blob. Delivered on login
      // rather than gated behind /vault so an empty-vault first-write
      // ("create vault") does not need to round-trip for salt material.
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        saltV: user.saltV,
      },
      expiresAt,
    });
  }));

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------
  router.post('/logout', csrfMw.require, (req, res) => {
    // Clear cookies UNCONDITIONALLY — even if sessions.revoke throws
    // on a transient DB failure (Codex round-11 P2). Otherwise a logout
    // that blew up on the server would leave `sid` and `csrf` in the
    // browser, making the user effectively still signed in. Worst-case
    // the stale session row remains in the DB until its cleanup sweep,
    // but the user is definitely signed out client-side.
    try {
      if (req.sessionToken) sessions.revoke(req.sessionToken);
    } catch (err) {
      // Log-and-continue — response is still 200 because from the
      // client's point of view logout succeeded (cookies are gone).
      // eslint-disable-next-line no-console
      console.error('[auth/logout] sessions.revoke failed', err && err.message);
    } finally {
      sessionMw.clearSessionCookie(res);
      csrfMw.clearCookie(res);
    }
    return res.json({ status: 'ok' });
  });

  // -------------------------------------------------------------------------
  // GET /auth/me
  // -------------------------------------------------------------------------
  router.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    return res.json({
      // See /auth/login for the saltV rationale; /auth/me is the
      // rehydration path (page reload) so it MUST return the same
      // fields as /auth/login — otherwise a rehydrated client would
      // silently lose saltV and be unable to unlock the vault until
      // it re-logs-in.
      user: {
        id: req.user.id,
        email: req.user.email,
        emailVerified: req.user.emailVerified,
        notificationPrefs: req.user.notificationPrefs,
        saltV: req.user.saltV,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /auth/prefs / PUT /auth/prefs
  //
  // Thin wrappers over notification_prefs. GET is redundant with the
  // `notificationPrefs` field on /auth/me but exists as a tight,
  // cacheable endpoint the UI can poll after a PUT without refetching
  // the full user record (which includes saltV and emailVerified).
  //
  // PUT is validated by the whitelist below. We explicitly do NOT
  // accept arbitrary JSON into notification_prefs — the column is
  // opaque to the DB schema, but letting the client write any shape
  // would make it a de-facto property bag that server code would
  // grow dependencies on. Every preference the UI can toggle must
  // first be added here.
  //
  // Whitelist today:
  //   voteReminders.enabled  (bool)  — opt-out of governance reminders
  //
  // Merging: PUT is a full-document overwrite of the whitelisted
  // namespaces, NOT a deep merge. If the client sends
  // { voteReminders: { enabled: false } } we write exactly that. The
  // client is responsible for echoing any other namespaces it wants
  // to preserve (today none exist, so it's a non-issue). We document
  // this explicitly so a future pref added here doesn't silently get
  // wiped by an older client.
  const PrefsSchema = z
    .object({
      voteReminders: z
        .object({
          enabled: z.boolean(),
        })
        .strict()
        .optional(),
    })
    .strict();

  router.get('/prefs', sessionMw.requireAuth, (req, res) => {
    return res.json({ notificationPrefs: req.user.notificationPrefs || {} });
  });

  router.put(
    '/prefs',
    sessionMw.requireAuth,
    csrfMw.require,
    (req, res) => {
      const parsed = PrefsSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'invalid_body');
      // Persist exactly the whitelisted shape.
      users.updateNotificationPrefs(req.user.id, parsed.data);
      // Echo back the stored value so the caller can update local
      // state without a follow-up GET.
      return res.json({ notificationPrefs: parsed.data });
    }
  );

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

      // Decide whether this request is a vault-bearing rotation or a
      // plain auth rotation. The contract is:
      //
      //   - If the user currently has a vault row, the client MUST
      //     rewrap and submit it alongside. Omitting the vault would
      //     leave the user with a new password whose derived vaultKey
      //     cannot open the still-old-wrapped blob → permanent
      //     lockout. We refuse with 409 so the client can re-fetch,
      //     rewrap, and retry instead of soft-failing.
      //
      //   - If the user has no vault row, the client MAY omit `vault`
      //     entirely (plain auth rotation). If the client still sends
      //     a vault in this state, we pass it through as a first-write
      //     (ifMatch='*' from the client side is expected).
      //
      // The vault-presence check lives INSIDE the runAtomic() block
      // below (not here). Why: in a multi-worker deployment, a second
      // request could create this user's first vault row between a
      // pre-transaction SELECT and the COMMIT of the auth rotation,
      // at which point this handler would have already decided "no
      // vault — plain rotation" and would commit a new authHash that
      // cannot open the vault the peer just wrote. Holding the check
      // inside the same transaction as updateAuthHash collapses that
      // window to zero (better-sqlite3 serializes writes in-process;
      // across processes, SQLite's write lock serializes the commit).
      // Codex round-2 P2.

      // Atomic rotation of auth state + (optional) vault wrap.
      //
      // Writes performed inside the transaction, any of which throwing
      // rolls back the whole thing so the only observable outcomes are
      // "fully rotated" or "no change":
      //
      //   1. vault presence check      (409 if vault exists but client
      //                                 omitted the rewrap)
      //   2. users.updateAuthHash      (new password authHash)
      //   3. vaults.put (if provided)  (rewrapped blob under new vaultKey)
      //   4. sessions.revokeAllForUser (kicks other devices)
      //   5. sessions.issue            (fresh session for this device)
      //
      // Order note: we rewrap the vault BEFORE rotating the authHash
      // so that if the vault.put throws (etag_mismatch, blob_too_large),
      // the auth is never touched. Concretely that means a stale
      // client — "I thought my old vault etag was X" — surfaces as a
      // 412 without their password being changed under them.
      //
      // Side-effect note: setSessionCookie + csrfMw.issueCookie live
      // OUTSIDE the transaction (they only set response headers, no DB
      // writes). They must run after the transaction commits, using
      // the token/expiresAt produced inside.
      let token, expiresAt, newVaultEtag;
      try {
        ({ token, expiresAt, newVaultEtag } = runAtomic(() => {
          // In-transaction vault-presence check. Throws a tagged
          // error that the outer catch translates to 409; the throw
          // rolls back the transaction before any state is written.
          const existingVault =
            vaults && typeof vaults.get === 'function'
              ? vaults.get(req.user.id)
              : null;
          if (existingVault && !parsed.data.vault) {
            const err = new Error('vault_rewrap_required');
            err.code = 'vault_rewrap_required';
            throw err;
          }

          let resultEtag = null;
          if (parsed.data.vault) {
            // put() throws on etag_mismatch / etag_required /
            // invalid_blob / blob_too_large — all of which roll back
            // the transaction here before we touch auth state. Caught
            // below and translated into HTTP status codes.
            const putOut = vaults.put(req.user.id, {
              blob: parsed.data.vault.blob,
              ifMatch: parsed.data.vault.ifMatch,
            });
            resultEtag = putOut && putOut.etag;
          }
          users.updateAuthHash(req.user.id, parsed.data.newAuthHash);
          sessions.revokeAllForUser(req.user.id);
          const s = sessions.issue(req.user.id, {
            userAgent: req.get('user-agent') || null,
            ip: req.ip,
          });
          return { ...s, newVaultEtag: resultEtag };
        }));
      } catch (err) {
        // Map vault errors back to the same HTTP shape the /vault
        // route uses, so clients can reuse their existing handlers.
        if (err && err.code === 'vault_rewrap_required') {
          return res.status(409).json({ error: 'vault_rewrap_required' });
        }
        if (err && err.code === 'etag_mismatch') {
          return res.status(412).json({ error: 'precondition_failed' });
        }
        if (err && err.code === 'etag_required') {
          return res.status(428).json({ error: 'if_match_required' });
        }
        if (err && err.code === 'blob_too_large') {
          return res.status(413).json({ error: 'blob_too_large' });
        }
        if (err && err.code === 'invalid_blob') {
          return res.status(400).json({ error: 'invalid_blob' });
        }
        throw err;
      }
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
      // Include `newVaultEtag` ONLY when the caller submitted a vault
      // (otherwise it's null and omitting it from the response keeps
      // the auth-only rotation response identical to the legacy shape).
      const body = { status: 'ok', expiresAt };
      if (newVaultEtag) body.newVaultEtag = newVaultEtag;
      return res.json(body);
    })
  );

  // -------------------------------------------------------------------------
  // DELETE /auth/account
  //
  // GDPR "right to erasure" endpoint. Permanently removes the user's
  // account and every row dependent on it. The caller must:
  //
  //   - be authenticated on a valid session (sessionMw.requireAuth)
  //   - pass the CSRF token (csrfMw.require)
  //   - re-prove the current password (oldAuthHash in the body)
  //
  // The password re-proof is the important bit: without it, a stolen
  // session cookie alone could be used to irrecoverably delete an
  // account. With it, the attacker would also need the password, at
  // which point they could already change it or drain the vault — so
  // the re-proof raises the bar to match the sensitivity of the
  // operation.
  //
  // Deletion is atomic:
  //
  //   1. pendingRegistrations.purgeForEmail (not cascaded — keyed by
  //      email, not user_id; leftover tokens would let the account be
  //      silently re-registered by whoever still holds the magic link).
  //   2. users.deleteById, which cascades via FK ON DELETE to
  //      sessions, vaults, email_verifications, tracked_masternodes,
  //      vote_reminder_log, vote_receipts. The cascade semantics are
  //      documented in db/migrations/001_init.sql.
  //
  // Response: 204 No Content (nothing useful to echo back — the row
  // no longer exists). The session cookie and CSRF cookie are
  // cleared on the response so the client lands on an anonymous
  // state immediately.
  //
  // We do NOT send a "your account was deleted" email. The request
  // is user-initiated and acknowledged by the UI; sending an email
  // to a now-nonexistent user's former address risks overreach for
  // a user who explicitly asked us to stop storing their data.
  router.delete(
    '/account',
    sessionMw.requireAuth,
    csrfMw.require,
    asyncHandler(async (req, res) => {
      const parsed = DeleteAccountSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, 'invalid_body');

      let confirmed;
      try {
        confirmed = users.verifyAuth(req.user.email, parsed.data.oldAuthHash);
      } catch (err) {
        if (err && err.code === 'kdf_config') {
          // eslint-disable-next-line no-console
          console.error(
            '[auth/delete-account] kdf config error',
            err.message
          );
          return res.status(503).json({ error: 'server_misconfigured' });
        }
        throw err;
      }
      if (!confirmed) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }

      const userId = req.user.id;
      const userEmail = req.user.email;
      runAtomic(() => {
        if (
          pendingRegistrations &&
          typeof pendingRegistrations.purgeForEmail === 'function'
        ) {
          pendingRegistrations.purgeForEmail(userEmail);
        }
        const changed = users.deleteById(userId);
        if (changed === 0) {
          // Extremely unlikely — requireAuth just resolved this user
          // milliseconds ago. Concurrent delete (second tab?) races
          // converge to the same "already gone" outcome, which we
          // treat as success.
        }
      });

      // Clear cookies unconditionally — the DB transaction succeeded,
      // so the user is definitely gone; any remaining `sid` / `csrf`
      // on the client would point at a cascaded-away sessions row and
      // confuse the next request.
      sessionMw.clearSessionCookie(res);
      csrfMw.clearCookie(res);
      return res.status(204).end();
    })
  );

  return router;
}

module.exports = { createAuthRouter };
