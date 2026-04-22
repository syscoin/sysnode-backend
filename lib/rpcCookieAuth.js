'use strict';

// rpcCookieAuth — cookie-file credential provider for Syscoin Core RPC.
// ---------------------------------------------------------------------
// Syscoin Core (like bitcoind) auto-generates a one-line file at
// `<datadir>/.cookie` on startup when no `rpcauth`/`rpcuser` is
// configured. Its contents are `__cookie__:<random>` and it is
// rewritten on every Core restart, so the credentials rotate and any
// long-running client must be prepared to re-read the file mid-session.
//
// This module is a minimal, testable provider. It is deliberately
// passive: `current()` returns the most recent parsed credentials with
// a short TTL cache (avoids an fs syscall on every RPC call under
// load); `forceReload()` drops the cache so the next `current()` hits
// the disk. The consumer (services/rpcClient.js) is responsible for
// deciding WHEN to force-reload — today that's on a 401 response from
// Core, which is the signature of a post-restart token rotation.
//
// Failure modes we surface clearly (each with a distinct message):
//   - ENOENT: path does not exist. Most common operator mistake:
//     syscoind isn't running yet, or the datadir is different from
//     expected.
//   - EACCES/EPERM: file exists but our process can't read it. Fix is
//     either running under the same user as syscoind, or relaxing the
//     cookie perms (see `-rpccookieperms` in Core).
//   - Malformed content (no ':' separator or empty line): file was
//     truncated, or the path points at something that isn't a Core
//     cookie. We refuse to emit bogus credentials in this case.
//
// We intentionally do NOT watch the file for changes. Core only
// rewrites it on restart, and our 401-retry path in rpcClient
// reloads on demand — a long-lived fs watcher would add complexity
// and platform caveats (macOS FSEvents, NFS, Docker bind mounts)
// without making us any more correct.

const fs = require('fs');

const DEFAULT_CACHE_MS = 2000;

function parseCookieLine(raw, sourcePath) {
  if (typeof raw !== 'string') {
    throw new Error(
      `rpc cookie at ${sourcePath} is not a string (got ${typeof raw})`
    );
  }
  const trimmed = raw.replace(/\r?\n.*$/s, '').trim();
  if (!trimmed) {
    throw new Error(`rpc cookie at ${sourcePath} is empty`);
  }
  const colon = trimmed.indexOf(':');
  if (colon < 1 || colon === trimmed.length - 1) {
    throw new Error(
      `rpc cookie at ${sourcePath} is malformed (expected "user:password" on a single line)`
    );
  }
  return {
    username: trimmed.slice(0, colon),
    password: trimmed.slice(colon + 1),
  };
}

function createCookieProvider({
  path,
  cacheMs = DEFAULT_CACHE_MS,
  now = () => Date.now(),
  readFileSync = fs.readFileSync,
} = {}) {
  if (!path || typeof path !== 'string') {
    throw new Error('createCookieProvider: path is required');
  }
  let cached = null;
  let cachedAt = 0;

  function read() {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      // Preserve the underlying errno code on a new Error so callers
      // can branch (e.g. "retry later if ENOENT, fail hard if EACCES")
      // without reaching through to the raw fs error and depending on
      // Node's wording staying stable.
      const code = err && err.code;
      const wrapped = new Error(
        `failed to read rpc cookie at ${path}: ${err.message}`
      );
      if (code) wrapped.code = code;
      wrapped.cause = err;
      throw wrapped;
    }
    return parseCookieLine(raw, path);
  }

  function current() {
    if (cached && now() - cachedAt < cacheMs) return cached;
    const fresh = read();
    cached = fresh;
    cachedAt = now();
    return cached;
  }

  function forceReload() {
    cached = null;
    cachedAt = 0;
  }

  function isCached() {
    return cached !== null;
  }

  return {
    current,
    forceReload,
    isCached,
    get path() {
      return path;
    },
  };
}

module.exports = {
  createCookieProvider,
  // Exported only for tests — do not import from outside the library.
  _internal: { parseCookieLine, DEFAULT_CACHE_MS },
};
