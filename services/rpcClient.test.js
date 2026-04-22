'use strict';

// Unit tests for the cookie-auth wiring in services/rpcClient.js.
// ----------------------------------------------------------------
// We verify two behaviours:
//   1. `resolveAuthMode` picks the right mode from env vars, with
//      cookie taking precedence and the right fail-fast/dev-warn
//      split when nothing is configured.
//   2. `installCookieInterceptors` injects fresh credentials per
//      request and replays exactly once on a 401 with the rotated
//      cookie.
//
// The real SyscoinRpcClient is construction-time-heavy (it builds an
// axios instance and services), so to keep this file decoupled we
// build a minimal stand-in that exposes the same `instance` shape —
// just `interceptors.request`/`interceptors.response` and a
// `request()` method. That's the surface the real interceptors touch.

const { _internal } = require('./rpcClient');

function buildFakeClient() {
  const requestInterceptors = [];
  const responseInterceptors = [];
  const calls = [];

  function addInterceptor(list, fulfilled, rejected) {
    list.push({ fulfilled, rejected });
  }

  async function runRequest(config) {
    let cfg = { ...config };
    for (const ic of requestInterceptors) {
      cfg = await ic.fulfilled(cfg);
    }
    // Record a shallow snapshot. The real axios adapter would
    // have already serialised the config into a network request
    // by this point, so per-call state (auth token, _cookieRetried)
    // is frozen. Without the snapshot, the replay's request
    // interceptor would overwrite auth on the very same object
    // we stored for call 1.
    calls.push({ ...cfg, auth: cfg.auth ? { ...cfg.auth } : undefined });
    // The test installs a scripted response stack on the fake
    // client so each `request()` call resolves/rejects as scripted.
    const scriptItem = runRequest._script.shift();
    let result;
    if (!scriptItem) {
      result = Promise.reject(new Error('fake client: no more scripted responses'));
    } else if (scriptItem.reject) {
      const err = scriptItem.reject;
      err.config = cfg;
      result = Promise.reject(err);
    } else {
      result = Promise.resolve(scriptItem.resolve);
    }
    // Run response interceptors in order (there's only one in
    // practice, but we loop for generality).
    for (const ic of responseInterceptors) {
      result = result.then(ic.fulfilled, ic.rejected);
    }
    return result;
  }
  runRequest._script = [];

  return {
    instance: {
      interceptors: {
        request: {
          use: (f, r) => addInterceptor(requestInterceptors, f, r),
        },
        response: {
          use: (f, r) => addInterceptor(responseInterceptors, f, r),
        },
      },
      request: runRequest,
    },
    _calls: calls,
    _script: runRequest._script,
  };
}

describe('resolveAuthMode', () => {
  const { resolveAuthMode } = _internal;
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  function setEnv(next) {
    // Start from a clean baseline — clear all three relevant vars
    // before applying overrides, so a prior test's value doesn't
    // leak through `process.env` inheritance.
    delete process.env.SYSCOIN_RPC_COOKIE_PATH;
    delete process.env.SYSCOIN_RPC_USER;
    delete process.env.SYSCOIN_RPC_PASS;
    delete process.env.NODE_ENV;
    Object.assign(process.env, next);
  }

  test('cookie path alone -> cookie mode', () => {
    setEnv({ SYSCOIN_RPC_COOKIE_PATH: '/tmp/.cookie' });
    expect(resolveAuthMode()).toEqual({
      mode: 'cookie',
      cookiePath: '/tmp/.cookie',
    });
  });

  test('trims whitespace on cookie path', () => {
    setEnv({ SYSCOIN_RPC_COOKIE_PATH: '  /tmp/.cookie \n' });
    expect(resolveAuthMode().cookiePath).toBe('/tmp/.cookie');
  });

  test('cookie path + static creds -> cookie wins, warns', () => {
    setEnv({
      SYSCOIN_RPC_COOKIE_PATH: '/tmp/.cookie',
      SYSCOIN_RPC_USER: 'u',
      SYSCOIN_RPC_PASS: 'p',
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveAuthMode().mode).toBe('cookie');
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/ignoring SYSCOIN_RPC_USER\/PASS/)
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('static creds alone -> static mode', () => {
    setEnv({ SYSCOIN_RPC_USER: 'u', SYSCOIN_RPC_PASS: 'p' });
    expect(resolveAuthMode()).toEqual({
      mode: 'static',
      username: 'u',
      password: 'p',
    });
  });

  test('partial static (user only) -> treated as missing', () => {
    setEnv({ SYSCOIN_RPC_USER: 'u' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveAuthMode()).toEqual({ mode: 'none' });
    } finally {
      warn.mockRestore();
    }
  });

  test('nothing configured in production -> throws', () => {
    setEnv({ NODE_ENV: 'production' });
    expect(() => resolveAuthMode()).toThrow(/No RPC credentials configured/);
  });

  test('nothing configured in dev -> warns and returns none', () => {
    setEnv({ NODE_ENV: 'development' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveAuthMode()).toEqual({ mode: 'none' });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('installCookieInterceptors', () => {
  const { installCookieInterceptors } = _internal;

  function makeProvider(tokens) {
    // Each call to current() returns the head of `tokens`; calling
    // forceReload() advances so the NEXT current() returns the
    // next token. This models a Core restart rotating the cookie.
    let idx = 0;
    return {
      current: () => ({ username: '__cookie__', password: tokens[idx] }),
      forceReload: () => {
        idx = Math.min(idx + 1, tokens.length - 1);
      },
      _peekIdx: () => idx,
    };
  }

  test('request interceptor injects current creds on every call', async () => {
    const client = buildFakeClient();
    const provider = makeProvider(['token-a']);
    installCookieInterceptors(client, provider);

    client._script.push({ resolve: { status: 200 } });
    await client.instance.request({ url: '/', method: 'post' });
    expect(client._calls[0].auth).toEqual({
      username: '__cookie__',
      password: 'token-a',
    });
  });

  test('401 triggers forceReload + single replay with rotated creds', async () => {
    const client = buildFakeClient();
    const provider = makeProvider(['stale', 'fresh']);
    installCookieInterceptors(client, provider);

    // First call -> 401 (simulating a post-rotation cookie mismatch).
    // Second call (the replay) -> 200.
    const unauthorized = Object.assign(new Error('Unauthorized'), {
      response: { status: 401 },
    });
    client._script.push({ reject: unauthorized });
    client._script.push({ resolve: { status: 200, data: { ok: true } } });

    const res = await client.instance.request({ url: '/', method: 'post' });
    expect(res).toEqual({ status: 200, data: { ok: true } });

    // Two fake-axios calls total (the 401 + the replay).
    expect(client._calls).toHaveLength(2);
    // Call 1 used the stale token; call 2 used the fresh one.
    expect(client._calls[0].auth.password).toBe('stale');
    expect(client._calls[1].auth.password).toBe('fresh');
    // The sentinel flag guards against further retries.
    expect(client._calls[1]._cookieRetried).toBe(true);
  });

  test('401 on the replay is surfaced (no infinite retry)', async () => {
    const client = buildFakeClient();
    const provider = makeProvider(['a', 'b']);
    installCookieInterceptors(client, provider);

    const unauthorized = () =>
      Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    client._script.push({ reject: unauthorized() });
    client._script.push({ reject: unauthorized() });

    await expect(
      client.instance.request({ url: '/', method: 'post' })
    ).rejects.toThrow(/Unauthorized/);

    // Exactly one replay attempt past the original -> 2 total.
    expect(client._calls).toHaveLength(2);
  });

  test('non-401 errors are not retried', async () => {
    const client = buildFakeClient();
    const provider = makeProvider(['a']);
    installCookieInterceptors(client, provider);

    const boom = Object.assign(new Error('server is on fire'), {
      response: { status: 500 },
    });
    client._script.push({ reject: boom });

    await expect(
      client.instance.request({ url: '/', method: 'post' })
    ).rejects.toThrow(/server is on fire/);
    expect(client._calls).toHaveLength(1);
  });

  test('reload failure after a 401 surfaces the reload error, not the 401', async () => {
    const client = buildFakeClient();
    // Provider whose forceReload succeeds but subsequent current()
    // throws (simulates the cookie file vanishing between a
    // successful pre-flight and the 401-driven reload).
    let primed = true;
    const provider = {
      current: () => {
        if (primed) return { username: '__cookie__', password: 'stale' };
        throw Object.assign(new Error('cookie gone'), { code: 'ENOENT' });
      },
      forceReload: () => {
        primed = false;
      },
    };
    installCookieInterceptors(client, provider);

    const unauthorized = Object.assign(new Error('Unauthorized'), {
      response: { status: 401 },
    });
    client._script.push({ reject: unauthorized });

    await expect(
      client.instance.request({ url: '/', method: 'post' })
    ).rejects.toThrow(/cookie gone/);
  });
});
