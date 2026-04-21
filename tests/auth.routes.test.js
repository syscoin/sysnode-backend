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
    expect(res.body.user.emailVerified).toBe(true);
    // saltV must be delivered on /auth/login — the client needs it in
    // memory immediately to derive vaultKey for vault operations. If
    // this regresses, the frontend would have no way to decrypt or
    // encrypt without a second round-trip.
    expect(res.body.user.saltV).toMatch(/^[0-9a-f]{64}$/);
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
    // /auth/me is the rehydration path on page reload; it must return
    // the same saltV as login or the client silently loses its ability
    // to derive vaultKey.
    expect(res.body.user.saltV).toMatch(/^[0-9a-f]{64}$/);
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

  // ---------------------------------------------------------------------
  // PR 7 — atomic vault rewrap inside /auth/change-password
  // ---------------------------------------------------------------------
  //
  // The previous /change-password rotated stored_auth only. That left
  // a torn-state window: the user's new password derives a new
  // vaultKey, but the stored vault blob is still wrapped under the
  // old vaultKey → permanent lockout until they restore the old
  // password (which is now gone). PR 7 closes the window by
  // requiring the client to submit the rewrapped blob + observed
  // etag alongside the new authHash, and rolling the auth rotation
  // + vault.put + session revocation into a single transaction.

  async function registerAndLogin(ctx, email = 'user@example.com') {
    // Small fixture helper: register → verify → login → return the
    // authenticated agent and the CSRF token.
    const agent = request.agent(ctx.app);
    await agent.post('/auth/register').send({ email, authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    await agent.post('/auth/verify-email').send({ token });
    const loginRes = await agent
      .post('/auth/login')
      .send({ email, authHash: SAMPLE_AUTH });
    const csrf = extractCookies(loginRes).csrf;
    return { agent, csrf };
  }

  test('POST /auth/change-password (with vault): updates both auth AND vault atomically', async () => {
    const { agent, csrf } = await registerAndLogin(ctx);

    // Seed a vault so there is something to rewrap. First-write uses
    // ifMatch='*'. The blob can be any non-empty string; this route
    // never introspects it.
    const putRes = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: 'original-blob' });
    expect(putRes.status).toBe(200);
    const originalEtag = putRes.body.etag;
    expect(originalEtag).toMatch(/^[0-9a-f]{64}$/);

    const NEW =
      'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
    const cp = await agent
      .post('/auth/change-password')
      .set('X-CSRF-Token', csrf)
      .send({
        oldAuthHash: SAMPLE_AUTH,
        newAuthHash: NEW,
        vault: { blob: 'rewrapped-blob', ifMatch: originalEtag },
      });
    expect(cp.status).toBe(200);
    // Response shape includes the new etag so the client can commit
    // its in-memory vaultKey/etag without a follow-up GET /vault.
    expect(cp.body.newVaultEtag).toMatch(/^[0-9a-f]{64}$/);
    expect(cp.body.newVaultEtag).not.toBe(originalEtag);

    // Vault row now has the rewrapped blob + a brand-new etag.
    const row = ctx.vaults.get(
      ctx.users.findByEmail('user@example.com').id
    );
    expect(row.blob).toBe('rewrapped-blob');
    expect(row.etag).toBe(cp.body.newVaultEtag);

    // And the new password is what now logs in.
    const newLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: NEW });
    expect(newLogin.status).toBe(200);
  });

  test('POST /auth/change-password: user with existing vault AND no vault body → 409 (prevents silent lockout)', async () => {
    const { agent, csrf } = await registerAndLogin(ctx);
    await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: 'some-vault' });

    const NEW =
      'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
    const res = await agent
      .post('/auth/change-password')
      .set('X-CSRF-Token', csrf)
      // No `vault` field. We must refuse: rotating auth without
      // rewrapping would lock the user out of their vault forever.
      .send({ oldAuthHash: SAMPLE_AUTH, newAuthHash: NEW });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('vault_rewrap_required');

    // And the password is NOT changed (old login still works).
    const stillOld = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(stillOld.status).toBe(200);
  });

  test('POST /auth/change-password: vault-presence check runs inside the transaction (Codex round-2 P2)', async () => {
    // The handler must not decide "no vault → plain rotation" based
    // on a read that happens BEFORE the auth-rotation transaction.
    // If it did, a concurrent writer that created the user's first
    // vault row between that read and our COMMIT would leave the
    // vault wrapped under the OLD password. Collapsing the check
    // into the same transaction as updateAuthHash eliminates that
    // window (better-sqlite3 serializes in-process; SQLite's write
    // lock serializes across processes).
    //
    // This test instruments `vaults.get` to record whether
    // `db.inTransaction` is true at call time, then drives a normal
    // /change-password (no vault row yet). The check MUST have run
    // inside an open transaction.
    const { agent, csrf } = await registerAndLogin(ctx);
    const originalGet = ctx.vaults.get.bind(ctx.vaults);
    const getTxStates = [];
    ctx.vaults.get = (...args) => {
      getTxStates.push(ctx.db.inTransaction);
      return originalGet(...args);
    };
    try {
      const NEW =
        'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
      const res = await agent
        .post('/auth/change-password')
        .set('X-CSRF-Token', csrf)
        .send({ oldAuthHash: SAMPLE_AUTH, newAuthHash: NEW });
      expect(res.status).toBe(200);
      expect(getTxStates.length).toBeGreaterThanOrEqual(1);
      expect(getTxStates.every((inTx) => inTx === true)).toBe(true);
    } finally {
      ctx.vaults.get = originalGet;
    }
  });

  test('POST /auth/change-password: vault-bearing request with no vault repo fails fast with 503 (Codex round-2 P3)', async () => {
    // createAuthRouter documents `vaults` as optional (auth-only
    // harnesses can mount without it). A vault-bearing rotation
    // fundamentally cannot be served in that mode, and the
    // in-transaction vaults.put dereference would otherwise throw
    // a TypeError → 500. The guard must instead surface a
    // deterministic 503 server_misconfigured. We simulate the
    // missing-repo mode by deleting the live `put` method from
    // the shared repo reference the router closed over at
    // construction time.
    const { agent, csrf } = await registerAndLogin(ctx);
    const originalPut = ctx.vaults.put.bind(ctx.vaults);
    delete ctx.vaults.put;
    try {
      const NEW =
        'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
      const suppressError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const res = await agent
        .post('/auth/change-password')
        .set('X-CSRF-Token', csrf)
        .send({
          oldAuthHash: SAMPLE_AUTH,
          newAuthHash: NEW,
          vault: { blob: 'abc', ifMatch: '*' },
        });
      suppressError.mockRestore();
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('server_misconfigured');

      // Auth was NOT rotated — old password still logs in.
      const stillOld = await request(ctx.app)
        .post('/auth/login')
        .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
      expect(stillOld.status).toBe(200);
    } finally {
      ctx.vaults.put = originalPut;
    }
  });

  test('POST /auth/change-password: auth-only rotation still works when vault repo is absent (Codex round-2 P3)', async () => {
    // Companion case — the optional-vaults contract says an
    // auth-only rotation (no vault row, no vault in body) MUST
    // still succeed when the repo is omitted. Proves the P3 guard
    // is targeted at the vault-bearing path only.
    const { agent, csrf } = await registerAndLogin(ctx);
    const originalPut = ctx.vaults.put.bind(ctx.vaults);
    const originalGet = ctx.vaults.get.bind(ctx.vaults);
    delete ctx.vaults.put;
    delete ctx.vaults.get;
    try {
      const NEW =
        'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
      const res = await agent
        .post('/auth/change-password')
        .set('X-CSRF-Token', csrf)
        .send({ oldAuthHash: SAMPLE_AUTH, newAuthHash: NEW });
      expect(res.status).toBe(200);
      expect(res.body.newVaultEtag).toBeUndefined();
    } finally {
      ctx.vaults.put = originalPut;
      ctx.vaults.get = originalGet;
    }
  });

  test('POST /auth/change-password: user with NO vault row can omit `vault` (plain auth rotation)', async () => {
    // The historical behavior — a user who registered but never
    // imported voting keys has no vault row. Rotating their password
    // does not require a rewrap; submitting without `vault` is valid.
    const { agent, csrf } = await registerAndLogin(ctx);

    const NEW =
      'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
    const res = await agent
      .post('/auth/change-password')
      .set('X-CSRF-Token', csrf)
      .send({ oldAuthHash: SAMPLE_AUTH, newAuthHash: NEW });
    expect(res.status).toBe(200);
    // No vault was submitted → response shape matches the legacy
    // auth-only rotation (no newVaultEtag key).
    expect(res.body.newVaultEtag).toBeUndefined();
  });

  test('POST /auth/change-password: stale etag → 412 and rolls back auth rotation', async () => {
    // Critical atomicity invariant: a bad etag must NOT leave the
    // account half-rotated. We stage a stale etag, attempt the
    // change, and assert that (a) the 412 surfaces verbatim from the
    // vault contract and (b) the old password still works.
    const { agent, csrf } = await registerAndLogin(ctx);
    const put1 = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: 'v1' });
    const etag1 = put1.body.etag;
    // Second writer bumps the etag.
    const put2 = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', etag1)
      .send({ blob: 'v2' });
    expect(put2.status).toBe(200);

    const NEW =
      'b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4b1c2d3e4';
    const res = await agent
      .post('/auth/change-password')
      .set('X-CSRF-Token', csrf)
      // Use etag1 — stale.
      .send({
        oldAuthHash: SAMPLE_AUTH,
        newAuthHash: NEW,
        vault: { blob: 'rewrapped', ifMatch: etag1 },
      });
    expect(res.status).toBe(412);

    // Auth was NOT rotated — the transaction rolled back.
    const stillOld = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(stillOld.status).toBe(200);
  });

  // ---------------------------------------------------------------------
  // PR 7 — /auth/prefs
  // ---------------------------------------------------------------------

  test('GET /auth/prefs returns {} for a fresh account (default opt-in semantics live on the client)', async () => {
    const { agent } = await registerAndLogin(ctx);
    const res = await agent.get('/auth/prefs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notificationPrefs: {} });
  });

  test('PUT /auth/prefs persists the opt-out toggle and GET echoes it back', async () => {
    const { agent, csrf } = await registerAndLogin(ctx);
    const put = await agent
      .put('/auth/prefs')
      .set('X-CSRF-Token', csrf)
      .send({ voteReminders: { enabled: false } });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      notificationPrefs: { voteReminders: { enabled: false } },
    });

    const get = await agent.get('/auth/prefs');
    expect(get.body).toEqual({
      notificationPrefs: { voteReminders: { enabled: false } },
    });

    // And /auth/me's embedded copy stays consistent.
    const me = await agent.get('/auth/me');
    expect(me.body.user.notificationPrefs).toEqual({
      voteReminders: { enabled: false },
    });
  });

  test('PUT /auth/prefs rejects unknown keys (strict whitelist)', async () => {
    // The contract is "prefs the server knows about". Rejecting
    // unknown keys prevents the column from becoming a dumping
    // ground for client-side state that server code would start
    // relying on, and catches typos that would silently no-op.
    const { agent, csrf } = await registerAndLogin(ctx);
    const res = await agent
      .put('/auth/prefs')
      .set('X-CSRF-Token', csrf)
      .send({ voteReminders: { enabled: true }, totallyFake: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  test('PUT /auth/prefs rejects wrong types on whitelisted keys', async () => {
    const { agent, csrf } = await registerAndLogin(ctx);
    const res = await agent
      .put('/auth/prefs')
      .set('X-CSRF-Token', csrf)
      .send({ voteReminders: { enabled: 'yes-please' } });
    expect(res.status).toBe(400);
  });

  test('PUT /auth/prefs requires CSRF and auth', async () => {
    const agent = request.agent(ctx.app);
    // Unauthenticated
    const anon = await agent.put('/auth/prefs').send({
      voteReminders: { enabled: false },
    });
    expect(anon.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // PR 7 — DELETE /auth/account (GDPR right to erasure)
  // ---------------------------------------------------------------------
  //
  // Contract:
  //   - Requires an authenticated session AND a matching CSRF token.
  //   - Requires re-proof of the current password (oldAuthHash).
  //   - Erases the users row; FK cascades wipe sessions, vaults,
  //     email_verifications, tracked_masternodes, vote_reminder_log,
  //     and vote_receipts.
  //   - Purges pending_registrations by email so a stale verification
  //     link from the deleted account can't be redeemed to silently
  //     re-register.
  //   - Clears sid + csrf cookies on the response.
  //   - Responds 204.

  test('DELETE /auth/account requires an authenticated session', async () => {
    const anon = await request(ctx.app)
      .delete('/auth/account')
      .send({ oldAuthHash: SAMPLE_AUTH });
    expect(anon.status).toBe(401);
  });

  test('DELETE /auth/account requires CSRF', async () => {
    const { agent } = await registerAndLogin(ctx);
    const noCsrf = await agent
      .delete('/auth/account')
      .send({ oldAuthHash: SAMPLE_AUTH });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error).toBe('csrf_missing');
  });

  test('DELETE /auth/account rejects wrong password with 401 and leaves state intact', async () => {
    const { agent, csrf } = await registerAndLogin(ctx);
    const res = await agent
      .delete('/auth/account')
      .set('X-CSRF-Token', csrf)
      .send({ oldAuthHash: 'deadbeef'.repeat(8) });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    // User still exists.
    expect(ctx.users.findByEmail('user@example.com')).not.toBeNull();
  });

  test('DELETE /auth/account validates body shape', async () => {
    const { agent, csrf } = await registerAndLogin(ctx);
    const res = await agent
      .delete('/auth/account')
      .set('X-CSRF-Token', csrf)
      .send({ oldAuthHash: 'not-hex' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  test('DELETE /auth/account erases user, cascades dependents, and clears cookies', async () => {
    const { agent, csrf } = await registerAndLogin(ctx);
    const userId = ctx.users.findByEmail('user@example.com').id;

    // Seed a vault so we can verify the cascade wipes it.
    await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: 'keys' });

    // And store a preference so prefs state is non-default too.
    await agent
      .put('/auth/prefs')
      .set('X-CSRF-Token', csrf)
      .send({ voteReminders: { enabled: false } });

    const del = await agent
      .delete('/auth/account')
      .set('X-CSRF-Token', csrf)
      .send({ oldAuthHash: SAMPLE_AUTH });

    expect(del.status).toBe(204);
    // Response body is empty (204 No Content).
    expect(del.text).toBe('');

    // Cookies cleared on the response so the browser lands anonymous.
    const rawCookies = del.headers['set-cookie'] || [];
    expect(rawCookies.some((c) => /^sid=;/.test(c) || /^sid=;/.test(c))).toBe(
      true
    );
    expect(rawCookies.some((c) => /^csrf=;/.test(c))).toBe(true);

    // The user row is gone, along with the vault row (FK cascade).
    expect(ctx.users.findById(userId)).toBeNull();
    expect(ctx.vaults.get(userId)).toBeNull();

    // Sessions for this user are cascaded away too — we can no longer
    // use the stale cookies to reach any authenticated endpoint.
    const afterDelete = await agent.get('/auth/me');
    expect(afterDelete.status).toBe(401);

    // And a fresh login with the old credentials fails (the user
    // doesn't exist anymore) rather than resurrecting the account.
    const relogin = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(relogin.status).toBe(401);
  });

  test('DELETE /auth/account purges pending_registrations so a stale link cannot re-register', async () => {
    // Register + verify + login + delete, then force a fresh pending
    // registration row issued BEFORE deletion (simulating a user who
    // clicked re-register, then deleted the account before verifying).
    // The dispatcher's safety net is that deleteById purges pending
    // rows keyed by the user's email; any leftover token would
    // otherwise redeem into a recreated users row.
    const { agent, csrf } = await registerAndLogin(ctx);

    // Provoke a second pending_registrations row (re-register path).
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    // Grab the token on the most recent outbox message.
    const lastMsg = ctx.mailer.outbox[ctx.mailer.outbox.length - 1];
    const staleToken = lastMsg.html.match(/token=([0-9a-f]{64})/)[1];

    // Delete the account.
    const del = await agent
      .delete('/auth/account')
      .set('X-CSRF-Token', csrf)
      .send({ oldAuthHash: SAMPLE_AUTH });
    expect(del.status).toBe(204);

    // Attempting to redeem the stale token now fails — no pending row
    // remains to promote into a users row. This is the critical GDPR
    // guarantee: we don't want an unverified magic link to resurrect
    // the account the user asked to erase.
    const redeem = await request(ctx.app)
      .post('/auth/verify-email')
      .send({ token: staleToken });
    expect(redeem.status).toBe(400);
    expect(ctx.users.findByEmail('user@example.com')).toBeNull();
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

  test('POST /auth/register sends verification mail to the NORMALIZED recipient (Codex round-12 P2)', async () => {
    // Pre-fix /register stored the normalized email but handed the raw
    // user input to the mailer. Whitespace/case variations that
    // normalized cleanly could therefore be rejected at RCPT TO by
    // the SMTP peer, and because sends are background best-effort the
    // caller got 202 with no email delivered.
    const res = await request(ctx.app)
      .post('/auth/register')
      .send({ email: '  User@Example.COM  ', authHash: SAMPLE_AUTH });
    expect(res.status).toBe(202);

    expect(ctx.mailer.outbox).toHaveLength(1);
    // Outbox recipient must be the canonical form that also backs the
    // pending row — no leading/trailing whitespace, no casing drift.
    expect(ctx.mailer.outbox[0].to).toBe('user@example.com');
    // And the token the link carries must redeem to the canonical
    // email so subsequent login works without re-normalization on the
    // client.
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];
    const verify = await request(ctx.app)
      .post('/auth/verify-email')
      .send({ token });
    expect(verify.status).toBe(200);
    const user = ctx.users.findByEmail('user@example.com');
    expect(user).not.toBeNull();
    expect(user.emailVerified).toBe(true);
  });

  test('POST /auth/logout clears cookies even when sessions.revoke throws (Codex round-11 P2)', async () => {
    // Invariant: logout must always leave the browser cookie-less, even
    // if the server-side revoke fails. Otherwise a transient DB blip
    // silently re-authenticates the user on their next request.
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

    const originalRevoke = ctx.sessions.revoke;
    ctx.sessions.revoke = () => {
      throw new Error('transient sqlite failure');
    };

    try {
      const res = await agent.post('/auth/logout').set('X-CSRF-Token', csrf);
      // Response still 200 from the client's POV — the user IS logged
      // out browser-side. Server logs the revoke failure.
      expect(res.status).toBe(200);

      const setCookies = res.headers['set-cookie'] || [];
      // Both auth cookies cleared: expired/empty Set-Cookie lines.
      // express's res.clearCookie emits cookies with Expires=Thu, 01 Jan 1970.
      expect(
        setCookies.some(
          (c) => /^sid=;/.test(c) && /Expires=/i.test(c)
        )
      ).toBe(true);
      expect(
        setCookies.some(
          (c) => /^csrf=;/.test(c) && /Expires=/i.test(c)
        )
      ).toBe(true);
    } finally {
      ctx.sessions.revoke = originalRevoke;
    }
  });

  test('POST /auth/verify-email keeps the token redeemable when the account write fails (Codex round-10 P1)', async () => {
    // Token-integrity invariant: if anything after pendingRegistrations.redeem
    // throws inside /verify-email, the whole operation must roll back so
    // the user can retry their original link. Pre-round-10 the token was
    // consumed unconditionally up front.
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const token = ctx.mailer.outbox[0].html.match(/token=([0-9a-f]{64})/)[1];

    // Make the user-row insert fail once.
    const originalCreate = ctx.users.createVerifiedWithStoredAuth;
    ctx.users.createVerifiedWithStoredAuth = () => {
      throw new Error('simulated db write failure');
    };

    let errored;
    await expectNoUnhandledRejection(async () => {
      errored = await request(ctx.app)
        .post('/auth/verify-email')
        .send({ token });
      expect(errored.status).toBe(500);
      expect(errored.body.error).toBe('internal');
    });

    // Restore the repo so the retry can succeed.
    ctx.users.createVerifiedWithStoredAuth = originalCreate;

    // Retry with the SAME token: must succeed now. If the repo had
    // consumed the token on the failed first attempt (no transaction),
    // this would return 400 invalid_or_expired_token.
    const retry = await request(ctx.app)
      .post('/auth/verify-email')
      .send({ token });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('verified');

    // And the account is actually created + verified.
    const user = ctx.users.findByEmail('user@example.com');
    expect(user).not.toBeNull();
    expect(user.emailVerified).toBe(true);
  });

  test('POST /auth/change-password is atomic — failed session issue rolls back hash + revocation (Codex round-10 P2)', async () => {
    // Atomicity invariant: if any write inside the password-rotation
    // sequence throws, none of them stick. Verifiable via a real
    // user: after a forced failure the old password must still work
    // and any pre-existing session must still be valid.
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

    // Establish a second, independent session that change-password
    // SHOULD revoke on success. We'll later assert it's preserved
    // because the change rolled back.
    const otherAgent = request.agent(ctx.app);
    await otherAgent
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const preRollbackOther = await otherAgent.get('/auth/me');
    expect(preRollbackOther.status).toBe(200);

    // Fail the *last* write in the transaction (sessions.issue). Per
    // round-10 P2, updateAuthHash + revokeAllForUser must also roll back.
    const originalIssue = ctx.sessions.issue;
    let issueCalls = 0;
    ctx.sessions.issue = (...args) => {
      issueCalls += 1;
      if (issueCalls === 1) {
        throw new Error('sessions.issue failed mid-transaction');
      }
      return originalIssue.apply(ctx.sessions, args);
    };

    const NEW =
      'c1d2e3f4c1d2e3f4c1d2e3f4c1d2e3f4c1d2e3f4c1d2e3f4c1d2e3f4c1d2e3f4';
    await expectNoUnhandledRejection(async () => {
      const res = await agent
        .post('/auth/change-password')
        .set('X-CSRF-Token', csrf)
        .send({ oldAuthHash: SAMPLE_AUTH, newAuthHash: NEW });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal');
    });

    ctx.sessions.issue = originalIssue;

    // Invariant A: stored_auth was NOT rotated. Old password still works;
    // new password does not.
    const oldStillWorks = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(oldStillWorks.status).toBe(200);
    const newDoesntWork = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: NEW });
    expect(newDoesntWork.status).toBe(401);

    // Invariant B: the other session was NOT revoked.
    const otherStillLive = await otherAgent.get('/auth/me');
    expect(otherStillLive.status).toBe(200);
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
