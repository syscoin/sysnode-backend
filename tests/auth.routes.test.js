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
