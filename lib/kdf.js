const crypto = require('crypto');

// Server-side wrapper over the client-derived `authHash`.
//
// Threat model:
// - The client performs WebCrypto PBKDF2-SHA512(password, email, 600_000, 32B) =
//   master, then HKDF-SHA256(master, "sysnode-auth-v1", 32B) = authHash, and
//   sends only authHash (hex) to the server.
// - authHash is a 256-bit HKDF output with full entropy; it cannot be
//   brute-forced directly. The meaningful work factor lives in the client's
//   600k PBKDF2 step.
//
// Why a server wrap at all:
// - Without one, a DB leak = instant impersonation for every user.
// - With a deterministic keyed hash (HMAC-SHA256 using a server-held pepper),
//   a DB-only leak leaves the attacker unable to impersonate even if the
//   `authHash` values were somehow leaked via a side channel at the client.
//
// Why not argon2id here:
// - The 600k PBKDF2 already pays the work cost against password guessing.
//   Argon2id would add ~350 ms and ~19 MiB RAM per login for no meaningful
//   gain against a DB dump (authHash is 256-bit).
//
// The pepper (HMAC key) lives in env `SYSNODE_AUTH_PEPPER` as hex. In dev we
// auto-generate an ephemeral pepper and warn so tests are self-contained;
// production deployments must set a persistent value (rotating the pepper
// invalidates all existing logins).

const PEPPER_ENV = 'SYSNODE_AUTH_PEPPER';
let cachedPepper = null;

// Distinguished error type for pepper/config failures. verifyAuthHash
// MUST let this propagate (unlike input-shape errors, which fold into
// "mismatch" returning false). If we swallowed it, a misconfigured
// production deploy — e.g. SYSNODE_AUTH_PEPPER missing — would turn
// every login into a silent 401 and look like mass credential
// corruption rather than an ops issue. (Codex round-7 P1.)
class KdfConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KdfConfigError';
    this.code = 'kdf_config';
  }
}

function loadPepper() {
  if (cachedPepper) return cachedPepper;
  const envVal = process.env[PEPPER_ENV];
  if (envVal && /^[0-9a-fA-F]{64,}$/.test(envVal)) {
    cachedPepper = Buffer.from(envVal, 'hex');
    return cachedPepper;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new KdfConfigError(
      `${PEPPER_ENV} must be set to at least 32 hex bytes in production`
    );
  }
  // Dev/test fallback: ephemeral pepper. Not a security hole because there is
  // no persistent DB in dev by default; if there is, rotating pepper just
  // forces re-login.
  cachedPepper = crypto.randomBytes(32);
  if (process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.warn(
      `[kdf] ${PEPPER_ENV} not set; using ephemeral dev pepper. ` +
        'Existing auth rows will not verify after restart.'
    );
  }
  return cachedPepper;
}

// Test-only hook to reset the cache.
function _resetPepperForTests() {
  cachedPepper = null;
}

function generateSalt(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashAuthHash(authHash) {
  if (typeof authHash !== 'string' || authHash.length === 0) {
    throw new Error('authHash must be a non-empty string');
  }
  if (!/^[0-9a-fA-F]+$/.test(authHash)) {
    throw new Error('authHash must be hex');
  }
  const pepper = loadPepper();
  return crypto
    .createHmac('sha256', pepper)
    .update(authHash.toLowerCase(), 'utf8')
    .digest('hex');
}

function verifyAuthHash(storedHash, providedAuthHash) {
  if (
    typeof storedHash !== 'string' ||
    typeof providedAuthHash !== 'string' ||
    storedHash.length === 0 ||
    providedAuthHash.length === 0
  ) {
    return false;
  }
  let candidate;
  try {
    candidate = hashAuthHash(providedAuthHash);
  } catch (err) {
    // Config errors (missing pepper, etc.) MUST propagate: they mean
    // the server cannot verify anyone's credentials and we want callers
    // to surface that as a 5xx. Input-shape errors fold into "not a
    // match" so a malformed client payload still fails closed as a
    // 401 rather than crashing the process. (Codex round-7 P1.)
    if (err && err.code === 'kdf_config') throw err;
    return false;
  }
  return constantTimeEqualHex(storedHash, candidate);
}

// Eager validation hook for startup — callers can invoke this once at
// boot so misconfigured deploys fail at process start rather than on
// the first authenticated request.
function assertPepperConfigured() {
  loadPepper();
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  if (aLower.length !== bLower.length) return false;
  const ab = Buffer.from(aLower);
  const bb = Buffer.from(bLower);
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = {
  generateSalt,
  hashAuthHash,
  verifyAuthHash,
  constantTimeEqualHex,
  assertPepperConfigured,
  KdfConfigError,
  _resetPepperForTests,
};
