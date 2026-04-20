const crypto = require('crypto');
const argon2 = require('argon2');

// Server-side wrapper over the client-derived `authHash`.
//
// Threat model: the client performs PBKDF2-SHA512(password, email, 600k, 32B) =
// master, then HKDF-SHA256(master, "sysnode-auth-v1", 32B) = authHash, and sends
// only authHash to the server. We still wrap that with argon2id at rest so a DB
// dump does not give an attacker an offline target with cheap verification.
// Parameters follow OWASP 2024 guidance for interactive auth (1 iter, 19 MiB,
// 2 parallelism). They can be tuned via env without breaking stored hashes
// because argon2 encoding is self-describing.
const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: Number(process.env.ARGON_MEMORY_KIB) || 19 * 1024,
  timeCost: Number(process.env.ARGON_ITERATIONS) || 2,
  parallelism: Number(process.env.ARGON_PARALLELISM) || 1,
};

function generateSalt(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

async function hashAuthHash(authHash) {
  if (typeof authHash !== 'string' || authHash.length === 0) {
    throw new Error('authHash must be a non-empty string');
  }
  return argon2.hash(authHash, ARGON_OPTIONS);
}

async function verifyAuthHash(storedHash, providedAuthHash) {
  if (
    typeof storedHash !== 'string' ||
    typeof providedAuthHash !== 'string' ||
    storedHash.length === 0 ||
    providedAuthHash.length === 0
  ) {
    return false;
  }
  try {
    return await argon2.verify(storedHash, providedAuthHash);
  } catch {
    return false;
  }
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
};
