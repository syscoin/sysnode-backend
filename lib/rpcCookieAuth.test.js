'use strict';

const { createCookieProvider, _internal } = require('./rpcCookieAuth');

const COOKIE_PATH = '/var/fake/.cookie';

function makeReadFile(responses) {
  // responses is an array of either strings (success) or Error
  // instances (failure) to return on each successive call. Calls
  // past the end of the array throw an assertion error, so forgetting
  // to stub the next read is loud rather than silent.
  let i = 0;
  const calls = [];
  const fn = (path, enc) => {
    calls.push({ path, enc });
    if (i >= responses.length) {
      throw new Error(
        `readFileSync called more times than stubbed (${i + 1} > ${responses.length})`
      );
    }
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

describe('parseCookieLine', () => {
  const { parseCookieLine } = _internal;

  test('parses the canonical Core cookie format', () => {
    expect(parseCookieLine('__cookie__:abcdef123456', COOKIE_PATH)).toEqual({
      username: '__cookie__',
      password: 'abcdef123456',
    });
  });

  test('strips a trailing newline (unix)', () => {
    expect(
      parseCookieLine('__cookie__:abc\n', COOKIE_PATH)
    ).toEqual({ username: '__cookie__', password: 'abc' });
  });

  test('strips a trailing CRLF (windows-ish)', () => {
    expect(
      parseCookieLine('__cookie__:abc\r\n', COOKIE_PATH)
    ).toEqual({ username: '__cookie__', password: 'abc' });
  });

  test('rejects an empty file', () => {
    expect(() => parseCookieLine('', COOKIE_PATH)).toThrow(/is empty/);
  });

  test('rejects whitespace-only content', () => {
    expect(() => parseCookieLine('   \n\t  ', COOKIE_PATH)).toThrow(/is empty/);
  });

  test('rejects missing colon', () => {
    expect(() => parseCookieLine('notacookie', COOKIE_PATH)).toThrow(
      /malformed/
    );
  });

  test('rejects leading colon (empty username)', () => {
    expect(() => parseCookieLine(':password', COOKIE_PATH)).toThrow(/malformed/);
  });

  test('rejects trailing colon (empty password)', () => {
    expect(() => parseCookieLine('__cookie__:', COOKIE_PATH)).toThrow(
      /malformed/
    );
  });

  test('accepts passwords containing colons', () => {
    // Core's actual cookie is `__cookie__:<hex>` with no colons in
    // the token, but we still split on the FIRST colon so any
    // future format with colons in the secret keeps working.
    expect(
      parseCookieLine('__cookie__:ab:cd:ef', COOKIE_PATH)
    ).toEqual({ username: '__cookie__', password: 'ab:cd:ef' });
  });
});

describe('createCookieProvider', () => {
  test('throws if path is missing', () => {
    expect(() => createCookieProvider({})).toThrow(/path is required/);
    expect(() => createCookieProvider({ path: '' })).toThrow(/path is required/);
  });

  test('current() reads and parses the file on first call', () => {
    const read = makeReadFile(['__cookie__:deadbeef']);
    const p = createCookieProvider({
      path: COOKIE_PATH,
      readFileSync: read,
      now: () => 0,
    });
    expect(p.current()).toEqual({ username: '__cookie__', password: 'deadbeef' });
    expect(read.calls).toHaveLength(1);
    expect(read.calls[0]).toEqual({ path: COOKIE_PATH, enc: 'utf8' });
  });

  test('current() caches for cacheMs then re-reads', () => {
    // Return two different tokens so we can tell cache-hit from
    // cache-miss by password value, not just call count.
    const read = makeReadFile([
      '__cookie__:first',
      '__cookie__:second',
    ]);
    let t = 1_000;
    const p = createCookieProvider({
      path: COOKIE_PATH,
      readFileSync: read,
      now: () => t,
      cacheMs: 100,
    });
    expect(p.current().password).toBe('first');
    t += 50; // within cache window
    expect(p.current().password).toBe('first');
    expect(read.calls).toHaveLength(1);
    t += 100; // past cache window
    expect(p.current().password).toBe('second');
    expect(read.calls).toHaveLength(2);
  });

  test('forceReload() drops the cache even within cacheMs', () => {
    const read = makeReadFile([
      '__cookie__:first',
      '__cookie__:rotated',
    ]);
    let t = 0;
    const p = createCookieProvider({
      path: COOKIE_PATH,
      readFileSync: read,
      now: () => t,
      cacheMs: 60_000,
    });
    expect(p.current().password).toBe('first');
    t += 1;
    expect(p.isCached()).toBe(true);
    p.forceReload();
    expect(p.isCached()).toBe(false);
    expect(p.current().password).toBe('rotated');
    expect(read.calls).toHaveLength(2);
  });

  test('ENOENT is re-thrown with path context and code preserved', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const read = makeReadFile([err]);
    const p = createCookieProvider({
      path: COOKIE_PATH,
      readFileSync: read,
      now: () => 0,
    });
    try {
      p.current();
      throw new Error('expected current() to throw');
    } catch (e) {
      expect(e.message).toMatch(/failed to read rpc cookie/);
      expect(e.message).toMatch(COOKIE_PATH);
      expect(e.code).toBe('ENOENT');
      expect(e.cause).toBe(err);
    }
  });

  test('EACCES is re-thrown with code preserved', () => {
    const err = Object.assign(new Error('perm denied'), { code: 'EACCES' });
    const read = makeReadFile([err]);
    const p = createCookieProvider({
      path: COOKIE_PATH,
      readFileSync: read,
      now: () => 0,
    });
    try {
      p.current();
      throw new Error('expected current() to throw');
    } catch (e) {
      expect(e.message).toMatch(/failed to read rpc cookie/);
      expect(e.code).toBe('EACCES');
      expect(e.cause).toBe(err);
    }
  });

  test('read errors do not poison the cache', () => {
    // First read fails; second read should hit disk, not the cache,
    // and succeed.
    const err = Object.assign(new Error('transient'), { code: 'EBUSY' });
    const read = makeReadFile([err, '__cookie__:afterwards']);
    const p = createCookieProvider({
      path: COOKIE_PATH,
      readFileSync: read,
      now: () => 0,
    });
    expect(() => p.current()).toThrow();
    expect(p.isCached()).toBe(false);
    expect(p.current().password).toBe('afterwards');
  });

  test('malformed content does not poison the cache', () => {
    const read = makeReadFile(['garbage-no-colon', '__cookie__:ok']);
    const p = createCookieProvider({
      path: COOKIE_PATH,
      readFileSync: read,
      now: () => 0,
    });
    expect(() => p.current()).toThrow(/malformed/);
    expect(p.isCached()).toBe(false);
    expect(p.current().password).toBe('ok');
  });
});
