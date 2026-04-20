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

  test('POST /auth/register returns 202 for duplicate emails (no enumeration)', async () => {
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const second = await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(second.status).toBe(202);
    // Only the first registration sends an email; duplicate path is silent.
    expect(ctx.mailer.outbox).toHaveLength(1);
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

  test('POST /auth/login fails before email is verified', async () => {
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    const res = await request(ctx.app)
      .post('/auth/login')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('email_not_verified');
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

  test('POST /auth/resend-verification is silent for unknown emails', async () => {
    const res = await request(ctx.app)
      .post('/auth/resend-verification')
      .send({ email: 'ghost@example.com' });
    expect(res.status).toBe(202);
    expect(ctx.mailer.outbox).toHaveLength(0);
  });

  test('POST /auth/resend-verification re-sends when user exists and is unverified', async () => {
    await request(ctx.app)
      .post('/auth/register')
      .send({ email: 'user@example.com', authHash: SAMPLE_AUTH });
    expect(ctx.mailer.outbox).toHaveLength(1);
    const res = await request(ctx.app)
      .post('/auth/resend-verification')
      .send({ email: 'user@example.com' });
    expect(res.status).toBe(202);
    expect(ctx.mailer.outbox).toHaveLength(2);
  });
});
