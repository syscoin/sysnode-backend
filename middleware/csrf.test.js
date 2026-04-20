const { createCsrfMiddleware } = require('./csrf');

// Minimal test double for an Express response.
function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    cookies: [],
    cleared: [],
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    cookie(name, value, opts) {
      this.cookies.push({ name, value, opts });
    },
    clearCookie(name, opts) {
      this.cleared.push({ name, opts });
    },
  };
  return res;
}

function mockReq({ method = 'POST', cookieToken, header } = {}) {
  return {
    method,
    cookies: cookieToken ? { csrf: cookieToken } : {},
    get(name) {
      if (name === 'X-CSRF-Token') return header;
      return undefined;
    },
  };
}

describe('csrf middleware', () => {
  const mw = createCsrfMiddleware({ secureCookies: false });

  test('exempts GET/HEAD/OPTIONS without touching cookies/headers', () => {
    let called = 0;
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      mw.require(mockReq({ method }), mockRes(), () => (called += 1));
    }
    expect(called).toBe(3);
  });

  test('403 csrf_missing when either side absent', () => {
    const res1 = mockRes();
    mw.require(mockReq({}), res1, () => {});
    expect(res1.statusCode).toBe(403);
    expect(res1.body).toEqual({ error: 'csrf_missing' });

    const res2 = mockRes();
    mw.require(
      mockReq({ cookieToken: 'a'.repeat(64) }),
      res2,
      () => {}
    );
    expect(res2.statusCode).toBe(403);
  });

  test('403 csrf_mismatch when tokens differ', () => {
    const res = mockRes();
    let nextCalled = false;
    mw.require(
      mockReq({ cookieToken: 'a'.repeat(64), header: 'b'.repeat(64) }),
      res,
      () => (nextCalled = true)
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'csrf_mismatch' });
    expect(nextCalled).toBe(false);
  });

  test('calls next() on equal tokens', () => {
    const res = mockRes();
    let nextCalled = false;
    mw.require(
      mockReq({ cookieToken: 'a'.repeat(64), header: 'a'.repeat(64) }),
      res,
      () => (nextCalled = true)
    );
    expect(nextCalled).toBe(true);
  });

  // Codex round-11 P1: malicious/accidental multibyte header must not
  // throw inside crypto.timingSafeEqual. Pre-fix, comparing a 64-ASCII
  // cookie against a 64-char header containing any non-ASCII codepoint
  // (UTF-16 length === UTF-8 byte length only for ASCII) raised
  // RangeError because the resulting Buffers had different byte lengths,
  // converting a 403 into a 500.
  test('multibyte X-CSRF-Token header returns 403, not 500', () => {
    const cookie = 'a'.repeat(64);
    // 64 UTF-16 code units but 68 UTF-8 bytes because "é" encodes as 2
    // bytes. This was the exact crash path pre-fix.
    const header = 'é'.repeat(32) + 'a'.repeat(32);
    expect(header.length).toBe(64);
    expect(Buffer.byteLength(header, 'utf8')).not.toBe(64);

    const res = mockRes();
    expect(() => {
      mw.require(
        mockReq({ cookieToken: cookie, header }),
        res,
        () => {
          throw new Error('next() should not be called on mismatch');
        }
      );
    }).not.toThrow();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'csrf_mismatch' });
  });

  test('non-string inputs short-circuit to false (via csrf_missing or csrf_mismatch)', () => {
    // typeof check prevents Buffer.from(undefined) crashing.
    const res = mockRes();
    mw.require(
      { method: 'POST', cookies: { csrf: 'x'.repeat(64) }, get: () => 123 },
      res,
      () => {}
    );
    // Numeric header → csrf_missing or csrf_mismatch; either way, 403
    // (never 500). We assert on that envelope.
    expect(res.statusCode).toBe(403);
    expect(['csrf_missing', 'csrf_mismatch']).toContain(res.body.error);
  });
});
