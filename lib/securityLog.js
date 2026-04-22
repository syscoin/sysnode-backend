// Structured security-event logger.
//
// F5 mini-audit: the backend previously emitted security-relevant
// events via ad-hoc `console.error('[auth/...]', err)` calls. That is
// fine for local debugging but makes incident forensics on a
// production deployment (grep, filter-by-ip, join-by-userId, SIEM
// ingestion) painful. This module is a tiny wrapper over `console`
// that writes a single JSON line per event in production and a
// human-readable line in development, so operators can pipe stdout
// straight into a log-aggregator without parsing free-form prefixes.
//
// Design constraints:
//   1. No new dependencies. Winston / pino are overkill for ~20 sites;
//      node:console + JSON.stringify covers the need.
//   2. Never throw. A logger that can crash the request handler is
//      worse than no logger at all. Every path catches and silently
//      falls back to best-effort.
//   3. Never leak secrets. Callers MUST NOT pass raw credential
//      material (authHash, stored_auth, session tokens, vault blob,
//      CSRF token). As defense-in-depth we also redact keys whose
//      names look secret-adjacent (see REDACT_KEYS).
//   4. Accept an optional `req` to auto-capture request context
//      (method, path, ip, authenticated userId) without every caller
//      spelling it out.
//
// Public API:
//   securityLog.event(name, ctx)  // default level: 'warn'
//   securityLog.info(name, ctx)   // audit / success trace
//   securityLog.warn(name, ctx)   // notable potential-attack event
//   securityLog.error(name, ctx)  // actual server-side failure
//
// `ctx` shape (all fields optional):
//   {
//     req,             // Express request — method/path/ip/userId auto-extracted
//     error,           // Error instance — .message stringified, stack kept server-side only
//     ...extra         // any other scalar fields to attach to the event
//   }

const REDACT_KEYS = new Set([
  'password',
  'authHash',
  'oldAuthHash',
  'newAuthHash',
  'storedAuth',
  'stored_auth',
  'token',
  'sessionToken',
  'csrfToken',
  'blob',
  'secret',
  'apiKey',
  'privateKey',
]);

// Ordered severities. `event()` defaults to 'warn' because the most
// common call site is "something notable happened on an unauthenticated
// surface" — failed login, rate-limit trip, CSRF mismatch. True audit
// trails (successful login, successful proposal submit) should use
// `info()` explicitly.
const LEVEL_FN = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function reqContext(req) {
  if (!req || typeof req !== 'object') return null;
  const out = {};
  if (typeof req.method === 'string') out.method = req.method;
  // Prefer originalUrl (survives Express subrouter mounts) and strip
  // the query string — query params on auth endpoints may echo user
  // input the logger should not persist.
  const url =
    typeof req.originalUrl === 'string'
      ? req.originalUrl
      : typeof req.url === 'string'
        ? req.url
        : null;
  if (url) {
    const q = url.indexOf('?');
    out.path = q >= 0 ? url.slice(0, q) : url;
  }
  if (typeof req.ip === 'string' && req.ip.length > 0) out.ip = req.ip;
  // Authenticated userId is attached by sessionMw.requireAuth as
  // `req.user = { id, email, ... }`. Only id is meaningful here —
  // email is PII and already tied to the user record.
  if (req.user && req.user.id != null) out.userId = req.user.id;
  return out;
}

// Redact or pass through a scalar value. Objects get shallow cloned
// with sensitive keys replaced. Buffers and other non-plain objects
// collapse to string to keep the JSON output size-bounded. The
// `seen` WeakSet prevents infinite recursion on cyclic references
// (rare in application data, but cheap insurance against logger-
// induced DoS).
function sanitizeValue(value, seen) {
  if (value == null) return value;
  if (value instanceof Error) {
    // Only message reaches the output — stack is logged separately at
    // error level on the server side.
    return value.message || String(value);
  }
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}b]`;
  if (t === 'object') {
    const visited = seen || new WeakSet();
    if (visited.has(value)) return '[cycle]';
    visited.add(value);
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeValue(v, visited));
    }
    const out = {};
    for (const k of Object.keys(value)) {
      if (REDACT_KEYS.has(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = sanitizeValue(value[k], visited);
      }
    }
    return out;
  }
  // functions, symbols, etc. — drop.
  return undefined;
}

function buildRecord(level, event, ctx) {
  const safeCtx = ctx && typeof ctx === 'object' ? ctx : {};
  const { req, error, ...rest } = safeCtx;
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  const rc = reqContext(req);
  if (rc) Object.assign(record, rc);
  if (error) {
    if (error instanceof Error) {
      record.error = error.message || String(error);
    } else {
      record.error = sanitizeValue(error);
    }
  }
  for (const k of Object.keys(rest)) {
    if (rest[k] === undefined) continue;
    if (REDACT_KEYS.has(k)) {
      record[k] = '[redacted]';
    } else {
      const clean = sanitizeValue(rest[k]);
      if (clean !== undefined) record[k] = clean;
    }
  }
  return record;
}

function emit(level, event, ctx) {
  let record;
  try {
    record = buildRecord(level, event, ctx);
  } catch (_err) {
    // Never let the logger throw. Degrade to a one-liner so the
    // original caller's control flow is unaffected.
    record = {
      ts: new Date().toISOString(),
      level,
      event,
      log_error: 'buildRecord_failed',
    };
  }
  const fn = LEVEL_FN[level] || LEVEL_FN.warn;
  try {
    if (isProduction()) {
      fn(JSON.stringify(record));
    } else {
      const { level: _l, event: _e, ...rest } = record;
      fn(`[security:${level}] ${event}`, rest);
    }
  } catch (_err) {
    // Best-effort: if stringify blows up on an exotic input we already
    // can't represent, there is no further fallback worth trying.
  }
  return record;
}

module.exports = {
  event: (name, ctx) => emit('warn', name, ctx),
  info: (name, ctx) => emit('info', name, ctx),
  warn: (name, ctx) => emit('warn', name, ctx),
  error: (name, ctx) => emit('error', name, ctx),
  // Exported for direct unit testing. Not part of the public contract.
  _buildRecord: buildRecord,
  _reqContext: reqContext,
  _sanitizeValue: sanitizeValue,
  _REDACT_KEYS: REDACT_KEYS,
};
