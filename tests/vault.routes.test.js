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

async function loggedInAgent(ctx) {
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
  return { agent, csrf };
}

describe('vault routes', () => {
  let ctx;

  beforeEach(() => {
    ctx = buildTestApp();
  });

  afterEach(() => {
    ctx.db.close();
  });

  test('GET /vault is 401 when not authenticated', async () => {
    const res = await request(ctx.app).get('/vault');
    expect(res.status).toBe(401);
  });

  test('GET /vault returns empty on fresh account', async () => {
    const { agent } = await loggedInAgent(ctx);
    const res = await agent.get('/vault');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ empty: true });
  });

  test('PUT /vault requires CSRF header', async () => {
    const { agent } = await loggedInAgent(ctx);
    const res = await agent.put('/vault').send({ blob: 'ciphertext-1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_missing');
  });

  test('first PUT /vault creates row, returns saltV + etag', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const res = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: 'ciphertext-1' });
    expect(res.status).toBe(200);
    expect(res.body.saltV).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers.etag).toBe(res.body.etag);
  });

  test('subsequent PUT requires matching If-Match', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    const first = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: 'A' });
    const originalEtag = first.body.etag;

    const missing = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .send({ blob: 'B' });
    expect(missing.status).toBe(428);
    expect(missing.body.error).toBe('if_match_required');

    const wrong = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', 'deadbeef')
      .send({ blob: 'B' });
    expect(wrong.status).toBe(412);

    const good = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', originalEtag)
      .send({ blob: 'B' });
    expect(good.status).toBe(200);
    expect(good.body.saltV).toBe(first.body.saltV);
  });

  test('GET /vault returns full blob for authenticated user', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: 'ciphertext-2' });

    const res = await agent.get('/vault');
    expect(res.status).toBe(200);
    expect(res.body.blob).toBe('ciphertext-2');
    expect(res.body.saltV).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.etag).toMatch(/^[0-9a-f]{64}$/);
  });

  test('PUT with If-Match: * is rejected with 412 once a vault exists', async () => {
    // Matches lib/vaults.test.js: wildcard must only work for first write.
    const { agent, csrf } = await loggedInAgent(ctx);
    await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: 'initial' });

    const wildcard = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: 'attempted-clobber' });
    expect(wildcard.status).toBe(412);
    expect(wildcard.body.error).toBe('precondition_failed');

    const read = await agent.get('/vault');
    expect(read.body.blob).toBe('initial');
  });

  test('oversized blob returns 413', async () => {
    const { agent, csrf } = await loggedInAgent(ctx);
    // express.json() limit is 256kb; send something right below that so the
    // body parser accepts it but our vault limit rejects it.
    const big = 'x'.repeat(260 * 1024);
    const res = await agent
      .put('/vault')
      .set('X-CSRF-Token', csrf)
      .set('If-Match', '*')
      .send({ blob: big });
    // Body parser may reject at 413 with its own envelope, or vaults repo
    // rejects at 413. Either way, the wire code must be 413.
    expect(res.status).toBe(413);
  });

  test('vault is per-user isolated', async () => {
    const { agent: a, csrf: ca } = await loggedInAgent(ctx);
    await a
      .put('/vault')
      .set('X-CSRF-Token', ca)
      .set('If-Match', '*')
      .send({ blob: 'alice-secret' });

    // Register a second user; re-use context
    const b = request.agent(ctx.app);
    await b
      .post('/auth/register')
      .send({ email: 'bob@example.com', authHash: SAMPLE_AUTH });
    const bobToken = ctx.mailer.outbox
      .find((m) => m.to === 'bob@example.com')
      .html.match(/token=([0-9a-f]{64})/)[1];
    await b.post('/auth/verify-email').send({ token: bobToken });
    await b
      .post('/auth/login')
      .send({ email: 'bob@example.com', authHash: SAMPLE_AUTH });

    const bobVault = await b.get('/vault');
    expect(bobVault.status).toBe(200);
    expect(bobVault.body).toEqual({ empty: true });
  });
});
