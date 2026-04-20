const request = require('supertest');
const { buildTestApp } = require('./helpers/buildTestApp');

const SAMPLE_AUTH =
  'a4f8b3c1d9e7f2a5b1c6d8e4f7a9b2c5d1e8f4a7b3c9d5e1f6a2b8c4d7e3f5a9';

function extractCookies(res) {
  const raw = res.headers['set-cookie'] || [];
  const map = {};
  for (const c of raw) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    map[k] = v;
  }
  return map;
}

describe('auth routes', () => {
  let ctx;

  beforeEach(() => {
    ctx = buildTestApp();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('POST /auth/register sends a verification email and returns 202', async () => {
    const res = await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(res.status).toBe(202);
    expect(ctx.mailer.outbox).toHaveLength(1);
    expect(ctx.mailer.outbox[0].to).toBe('user@example.com');
    expect(ctx.mailer.outbox[0].html).toMatch(/verify-email\?token=/);
  });

  test('verification link targets the frontend URL, not the backend endpoint', async () => {
    // Codex P1: the backend only exposes POST /auth/verify-email. Email
    // clients click-through triggers a GET, so the link must land on the
    // SPA which performs the POST. Asserts the link is rooted at the
    // configured frontendUrl (http://app.test.local in buildTestApp).
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const html = ctx.mailer.outbox[0].html;
    expect(html).toMatch(
      /http:\/\/app\.test\.local\/verify-email\?token=[0-9a-f]{64}/
    );
    expect(html).not.toMatch(/http:\/\/api\.test\.local/);
    expect(html).not.toMatch(/\/auth\/verify-email/);
  });

  test('POST /auth/register rejects invalid email shape', async () => {
    const res = await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'not-an-email', authHash: SAMPLE_AUTH });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_email');
  });

  test('POST /auth/register returns 202 for duplicate (unverified) emails with no enumeration signal', async () => {
    // Under deferred binding we happily issue a fresh pending row +
    // email each /register for an unverified email (so clicking the
    // latest link always works). The non-enumeration guarantee is that
    // the HTTP response — status, body shape, latency — is
    // indistinguishable from the first-time case. See the separate
    // "already verified" test below for the silent branch.
    const a = await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const b = await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
  });

  test('POST /auth/verify-email flips emailVerified; token is single-use', async () => {
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const link = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];

    const first = await request(ctx.app)
      .post('/auth/verify-email')
      .send({ token: link });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('verified');

    const second = await request(ctx.app)
      .post('/auth/verify-email')
      .send({ token: link });
    expect(second.status).toBe(400);
  });

  test('POST /auth/login fails before email is verified (no user row exists pre-verification)', async () => {
    // Deferred credential binding: /register writes to pending_registrations,
    // NOT the users table, so login before clicking the verification link
    // can't match any account and returns invalid_credentials (401). The
    // email_not_verified (403) path is reserved for the legacy case where
    // an unverified user row somehow exists (still covered by the users
    // repo directly).
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const res = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  test('POST /auth/login after verify issues sid + csrf cookies and returns user', async () => {
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await request(ctx.app).post('/auth/verify-email').send({ token });

    const res = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('user@example.com');
    const cookies = extractCookies(res);
    expect(cookies.sid).toMatch(/^[0-9a-f]{64}$/);
    expect(cookies.csrf).toMatch(/^[0-9a-f]{64}$/);
  });

  test('POST /auth/login rejects wrong authHash', async () => {
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await request(ctx.app).post('/auth/verify-email').send({ token });

    const res = await request(ctx.app)
      .post('/auth/login')
      .send({
        email: 'user@example.com',
        authHash: 'deadbeef'.repeat(8),
      });
    expect(res.status).toBe(401);
  });

  test('authenticated requests refresh sid + csrf cookie expiries (sliding window)', async () => {
    // Codex P2: sessions.verify() extends expires_at in the DB on each
    // request, but earlier the sid cookie was only set at login time, so
    // the browser dropped it at the original expiry and the user was
    // silently logged out mid-session. Every authenticated request must
    // now emit fresh Set-Cookie headers with the new expiry.
    const agent = require('supertest').agent(ctx.app);
    await agent
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await agent.post('/auth/verify-email').send({ token });
    const loginRes = await agent
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const originalCsrf = extractCookies(loginRes).csrf;

    const me = await agent.get('/auth/me');
    expect(me.status).toBe(200);
    const refreshed = me.headers['set-cookie'] || [];
    const sidCookie = refreshed.find((c) => c.startsWith('sid='));
    const csrfCookie = refreshed.find((c) => c.startsWith('csrf='));
    expect(sidCookie).toBeDefined();
    expect(csrfCookie).toBeDefined();
    // Both carry an Expires attribute (sliding window, not a session
    // cookie that dies on browser close).
    expect(sidCookie).toMatch(/Expires=/i);
    expect(csrfCookie).toMatch(/Expires=/i);
    // CSRF token VALUE must be preserved so the SPA's in-memory mirror
    // keeps working; only the expiry moves.
    const csrfMap = extractCookies(me);
    expect(csrfMap.csrf).toBe(originalCsrf);
  });

  test('unauthenticated requests do NOT emit a sid cookie refresh', async () => {
    const res = await request(ctx.app).get('/auth/me');
    expect(res.status).toBe(401);
    const setCookies = res.headers['set-cookie'] || [];
    expect(setCookies.some((c) => c.startsWith('sid='))).toBe(false);
  });

  test('GET /auth/me returns user when authenticated', async () => {
    const agent = request.agent(ctx.app);
    await agent
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await agent.post('/auth/verify-email').send({ token });
    await agent
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });

    const res = await agent.get('/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('user@example.com');
    expect(res.body.user.emailVerified).toBe(true);
  });

  test('GET /auth/me is 401 when not authenticated', async () => {
    const res = await request(ctx.app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  test('POST /auth/logout requires CSRF header + cookie match', async () => {
    const agent = request.agent(ctx.app);
    await agent
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await agent.post('/auth/verify-email').send({ token });
    const loginRes = await agent
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const csrf = extractCookies(loginRes).csrf;

    const missing = await agent.post('/auth/logout');
    expect(missing.status).toBe(403);
    expect(missing.body.error).toBe('csrf_missing');

    const good = await agent.post('/auth/logout').set('X-CSRF-Token', csrf);
    expect(good.status).toBe(200);

    const after = await agent.get('/auth/me');
    expect(after.status).toBe(401);
  });

  test('POST /auth/change-password rotates hash and invalidates other sessions', async () => {
    const agent = request.agent(ctx.app);
    await agent
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await agent.post('/auth/verify-email').send({ token });
    const loginRes = await agent
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const csrf = extractCookies(loginRes).csrf;

    const NEW =
      'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
    const cp = await agent
      .post('/auth/change-password')
      .set('X-CSRF-Token', csrf)
      .send({ oldAuthHash: SAMPLE_AUTH, newAuthHash: NEW });
    expect(cp.status).toBe(200);

    // Old authHash no longer valid.
    const oldLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(oldLogin.status).toBe(401);

    // New authHash works from a clean agent.
    const newLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: NEW });
    expect(newLogin.status).toBe(200);

    // And the password-changed email went out.
    expect(
      ctx.mailer.outbox.some((m) => /password was changed/i.test(m.subject))
    ).toBe(true);
  });

  test('POST /auth/change-password rejects wrong oldAuthHash', async () => {
    const agent = request.agent(ctx.app);
    await agent
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await agent.post('/auth/verify-email').send({ token });
    const loginRes = await agent
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const csrf = extractCookies(loginRes).csrf;

    const res = await agent
      .post('/auth/change-password')
      .set('X-CSRF-Token', csrf)
      .send({
        oldAuthHash: 'deadbeef'.repeat(8),
        newAuthHash: SAMPLE_AUTH,
      });
    expect(res.status).toBe(401);
  });

  test('POST /auth/resend-verification no longer exists — /register is the idempotent resend path', async () => {
    // Codex P2: the old /resend-verification endpoint branched on "does a
    // user row exist?" and thereby leaked account existence via response
    // timing. We removed it entirely. A client that needs a fresh link
    // just re-POSTs /register with the same credentials; the server
    // responds 202 in constant time whether the account is new,
    // pending, or already verified.
    const res = await request(ctx.app)
      .post('/auth/resend-verification')
      .send({ email: 'user@example.com' });
    expect(res.status).toBe(404);
  });

  test('/register acts as the resend path for unverified emails', async () => {
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(ctx.mailer.outbox).toHaveLength(1);
    const again = await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(again.status).toBe(202);
    // A second pending row was issued with its own token, so a second
    // email fires. The previously-issued token is still valid (until
    // purge-on-verify wipes it), but in practice each send gives the user
    // a fresh working link.
    expect(ctx.mailer.outbox).toHaveLength(2);
  });

  test('/register is silent (no email sent) when the account is already verified', async () => {
    // Deferred binding: once an email is verified, /register must NOT send
    // another verification email to the real account owner, to avoid
    // confusion and to close off a notification-spam vector. The request
    // still returns 202 to preserve timing indistinguishability.
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await request(ctx.app).post('/auth/verify-email').send({ token });
    const outboxBefore = ctx.mailer.outbox.length;

    const res = await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(res.status).toBe(202);
    expect(ctx.mailer.outbox.length).toBe(outboxBefore);
  });

  // -----------------------------------------------------------------------
  // Codex round-9 P1 coverage: async-handler rejections must not produce
  // unhandled promise rejections; every post-parse throw from a repo or
  // middleware must bubble to a controlled 500 response via asyncHandler
  // + the app-level error middleware.
  //
  // Covers the three handlers Codex specifically flagged:
  //   • /verify-email (the whole body ran with no try/catch)
  //   • /login post-verifyAuth (sessions.issue / cookie writes)
  //   • /change-password post-verifyAuth (updateAuthHash, revoke, issue)
  // -----------------------------------------------------------------------
  async function expectNoUnhandledRejection(run) {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await run();
      // Give any deferred microtask a chance to fire.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      errSpy.mockRestore();
    }
  }

  test('POST /auth/login returns 500 when users.verifyAuth throws unexpectedly (Codex round-9 P1)', async () => {
    const original = ctx.users.verifyAuth;
    ctx.users.verifyAuth = () => {
      throw new Error('db connection lost');
    };
    try {
      await expectNoUnhandledRejection(async () => {
        const res = await request(ctx.app)
          .post('/auth/login')
          .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('internal');
      });
    } finally {
      ctx.users.verifyAuth = original;
    }
  });

  test('POST /auth/login returns 500 when sessions.issue throws after successful verifyAuth (Codex round-9 P1)', async () => {
    // Set up a real verified account so verifyAuth succeeds.
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await request(ctx.app).post('/auth/verify-email').send({ token });

    const original = ctx.sessions.issue;
    ctx.sessions.issue = () => {
      throw new Error('sessions table write failed');
    };
    try {
      await expectNoUnhandledRejection(async () => {
        const res = await request(ctx.app)
          .post('/auth/login')
          .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('internal');
      });
    } finally {
      ctx.sessions.issue = original;
    }
  });

  test('POST /auth/verify-email returns 500 when the pending-registrations repo throws (Codex round-9 P1)', async () => {
    const original = ctx.pendingRegistrations.redeem;
    ctx.pendingRegistrations.redeem = () => {
      throw new Error('redeem exploded');
    };
    try {
      await expectNoUnhandledRejection(async () => {
        const res = await request(ctx.app)
          .post('/auth/verify-email')
          .send({ token: 'a'.repeat(64) });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('internal');
      });
    } finally {
      ctx.pendingRegistrations.redeem = original;
    }
  });

  test('POST /auth/change-password returns 500 when updateAuthHash throws post-verifyAuth (Codex round-9 P1)', async () => {
    // Full happy-path auth first.
    const agent = request.agent(ctx.app);
    await agent
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await agent.post('/auth/verify-email').send({ token });
    const loginRes = await agent
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const csrf = extractCookies(loginRes).csrf;

    const original = ctx.users.updateAuthHash;
    ctx.users.updateAuthHash = () => {
      throw new Error('updateAuthHash failed');
    };
    const NEW =
      'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
    try {
      await expectNoUnhandledRejection(async () => {
        const res = await agent
          .post('/auth/change-password')
          .set('X-CSRF-Token', csrf)
          .send({ oldAuthHash: SAMPLE_AUTH, newAuthHash: NEW });
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('internal');
      });
    } finally {
      ctx.users.updateAuthHash = original;
    }
  });

  test('POST /auth/login returns 503 server_misconfigured when the KDF pepper is missing (Codex round-7 P1)', async () => {
    // Happy-path setup: register + verify a real account using the
    // correctly-configured pepper.
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await request(ctx.app).post('/auth/verify-email').send({ token });

    // Now simulate ops losing/unsetting the pepper: drop the env var,
    // bounce the pepper cache, and flip to production mode so
    // loadPepper refuses the dev fallback.
    const { _resetPepperForTests } = require('../lib/kdf');
    const originalPepper = process.env.SYSNODE_AUTH_PEPPER;
    delete process.env.SYSNODE_AUTH_PEPPER;
    process.env.NODE_ENV = 'production';
    _resetPepperForTests();

    try {
      const res = await request(ctx.app)
        .post('/auth/login')
        .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
      // Critical assertion: NOT 401. The response must clearly flag
      // server misconfiguration so alerting catches it.
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('server_misconfigured');
    } finally {
      process.env.SYSNODE_AUTH_PEPPER = originalPepper;
      process.env.NODE_ENV = 'test';
      _resetPepperForTests();
    }
  });

  test('POST /auth/register fails fast (5xx) when pending-row issuance throws (Codex round-6 P1)', async () => {
    // Simulate a configuration failure (e.g. missing pepper) by making
    // pendingRegistrations.issue throw. The response must NOT be 202 —
    // users shouldn't be told "check your email" when the server
    // couldn't actually schedule a link.
    const broken = {
      issue: () => {
        throw new Error('pending issue blew up');
      },
      redeem: ctx.pendingRegistrations.redeem,
      purgeForEmail: ctx.pendingRegistrations.purgeForEmail,
      cleanupExpired: ctx.pendingRegistrations.cleanupExpired,
    };
    // Swap in the broken stub via the same appFactory services object.
    ctx.pendingRegistrations.issue = broken.issue;

    const res = await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'ops-broken@example.com', authHash: SAMPLE_AUTH });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal');
    expect(ctx.mailer.outbox).toHaveLength(0);
  });

  test('POST /auth/register still returns 202 when SMTP send fails (background best-effort)', async () => {
    // SMTP is intentionally best-effort: a flaky relay shouldn't break
    // /register. The pending row is already persisted synchronously, so
    // the user can retry /register to get another mail attempt.
    const originalSend = ctx.mailer.sendVerification;
    ctx.mailer.sendVerification = async () => {
      throw new Error('smtp down');
    };
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(ctx.app)
        .post('/auth/register')
        .send({ email: 'flaky@example.com', authHash: SAMPLE_AUTH });
      expect(res.status).toBe(202);
      expect(err).toHaveBeenCalled();
      const pendingRow = ctx.db
        .prepare(
          'SELECT COUNT(*) AS c FROM pending_registrations WHERE email_normalized = ?'
        )
        .get('flaky@example.com');
      expect(pendingRow.c).toBe(1);
    } finally {
      err.mockRestore();
      ctx.mailer.sendVerification = originalSend;
    }
  });

  test('verify-email rotates a legacy unverified users row in place (Codex round-5 P1)', async () => {
    // Migration 003 wipes pre-existing email_verified=0 rows at deploy,
    // but the code must also handle the case defensively (e.g. a future
    // regression re-introduces one, or a race around migration time).
    //
    // Here we directly insert a legacy unverified row with SOME stored
    // auth (could be attacker's, victim's, doesn't matter — the
    // pre-deferred flow never proved ownership). Then we drive a
    // normal /register → click link flow and confirm:
    //   - verify-email succeeds with 200 verified,
    //   - the row's stored_auth is rotated to the one submitted via
    //     the just-redeemed pending,
    //   - login works with the NEW authHash, not the legacy one.
    const LEGACY_AUTH =
      'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
    ctx.users.create({ email: 'legacy@example.com', authHash: LEGACY_AUTH });
    // sanity: the legacy row is unverified and bound to LEGACY_AUTH.
    expect(ctx.users.findByEmail('legacy@example.com').emailVerified).toBe(false);

    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'legacy@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    const verify = await request(ctx.app)
      .post('/auth/verify-email')
      .send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('verified');

    const row = ctx.users.findByEmail('legacy@example.com');
    expect(row.emailVerified).toBe(true);

    const goodLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'legacy@example.com', authHash: SAMPLE_AUTH });
    expect(goodLogin.status).toBe(200);

    const legacyLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'legacy@example.com', authHash: LEGACY_AUTH });
    expect(legacyLogin.status).toBe(401);
  });

  test('deferred binding: attacker-issued token cannot bind to a later victim account', async () => {
    // The core threat that motivated moving to pending_registrations.
    // 1. Attacker pre-registers with victim@example.com + attacker's authHash.
    // 2. Victim later registers the same email with their own authHash.
    // 3. Victim clicks the link in the email they just received.
    // 4. The account must end up bound to the VICTIM's authHash, and the
    //    attacker's pre-issued token must become dead on verify.
    const ATTACKER = 'deadbeef'.repeat(8);
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: ATTACKER });
    const attackerToken = ctx.mailer.outbox[0].html.match(
      /token=([0-9a-f]{64})/
    )[1];

    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const victimToken = ctx.mailer.outbox[1].html.match(
      /token=([0-9a-f]{64})/
    )[1];
    expect(victimToken).not.toBe(attackerToken);

    const verify = await request(ctx.app)
      .post('/auth/verify-email')
      .send({ token: victimToken });
    expect(verify.status).toBe(200);

    // Victim can log in with their own authHash.
    const goodLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(goodLogin.status).toBe(200);

    // Attacker's authHash no longer works.
    const badLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: ATTACKER });
    expect(badLogin.status).toBe(401);

    // And the attacker's token is dead (purged by purgeForEmail on verify).
    const attackerRedeem = await request(ctx.app)
      .post('/auth/verify-email')
      .send({ token: attackerToken });
    expect(attackerRedeem.status).toBe(400);
  });
});
