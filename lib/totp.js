const crypto = require('crypto');
const { deriveServerKey, hmacServerSecret } = require('./kdf');

const ISSUER = 'Sysnode';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

function mkErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function encryptSecret(secret) {
  const key = deriveServerKey('totp-secret-v1');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(secret), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function decryptSecret(envelope) {
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw mkErr('invalid_secret');
  const key = deriveServerKey('totp-secret-v1');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8'
  );
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(value) {
  const clean = String(value || '').toUpperCase().replace(/=+$/g, '');
  let bits = 0;
  let acc = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw mkErr('invalid_secret');
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function generateTotpCode(secret, timeMs = Date.now()) {
  const counter = Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function normalizeCode(code) {
  return String(code || '').replace(/\s+/g, '');
}

function constantTimeEqualText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function verifyTotp(secret, code, timeMs = Date.now()) {
  const token = normalizeCode(code);
  if (!/^[0-9]{6}$/.test(token)) return false;
  return [-1, 0, 1].some((offset) =>
    constantTimeEqualText(
      token,
      generateTotpCode(secret, timeMs + offset * TOTP_STEP_SECONDS * 1000)
    )
  );
}

function formatRecoveryCode(raw) {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code) {
  return hmacServerSecret(normalizeRecoveryCode(code), 'totp-recovery-v1');
}

function generateRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    formatRecoveryCode(crypto.randomBytes(6).toString('hex').toUpperCase())
  );
}

function mapRecoveryHashes(codes) {
  return JSON.stringify(codes.map(hashRecoveryCode));
}

function readRecoveryHashes(json) {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'hex').digest('hex');
}

function createTotpRepo(db, opts = {}) {
  const now = opts.now ?? (() => Date.now());

  const selectTotp = db.prepare(
    `SELECT user_id AS userId,
            secret_enc AS secretEnc,
            pending_secret_enc AS pendingSecretEnc,
            recovery_hashes AS recoveryHashes,
            enabled,
            created_at AS createdAt,
            updated_at AS updatedAt
       FROM user_totp
      WHERE user_id = ?`
  );
  const upsertPending = db.prepare(
    `INSERT INTO user_totp
       (user_id, secret_enc, pending_secret_enc, recovery_hashes, enabled, created_at, updated_at)
     VALUES (?, NULL, ?, '[]', 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       pending_secret_enc = excluded.pending_secret_enc,
       updated_at = excluded.updated_at`
  );
  const enable = db.prepare(
    `UPDATE user_totp
        SET secret_enc = pending_secret_enc,
            pending_secret_enc = NULL,
            recovery_hashes = ?,
            enabled = 1,
            updated_at = ?
      WHERE user_id = ?
        AND pending_secret_enc IS NOT NULL`
  );
  const disable = db.prepare(`DELETE FROM user_totp WHERE user_id = ?`);
  const updateRecoveryHashes = db.prepare(
    `UPDATE user_totp SET recovery_hashes = ?, updated_at = ? WHERE user_id = ?`
  );

  const insertChallenge = db.prepare(
    `INSERT INTO mfa_challenges
       (token_hash, user_id, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)`
  );
  const selectChallenge = db.prepare(
    `SELECT token_hash AS tokenHash,
            user_id AS userId,
            expires_at AS expiresAt,
            attempts
       FROM mfa_challenges
      WHERE token_hash = ?`
  );
  const bumpChallenge = db.prepare(
    `UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?`
  );
  const deleteChallenge = db.prepare(
    `DELETE FROM mfa_challenges WHERE token_hash = ?`
  );
  const deleteUserChallenges = db.prepare(
    `DELETE FROM mfa_challenges WHERE user_id = ?`
  );
  const deleteExpiredChallenges = db.prepare(
    `DELETE FROM mfa_challenges WHERE expires_at < ?`
  );

  function status(userId) {
    const row = selectTotp.get(userId);
    return {
      enabled: !!(row && row.enabled === 1 && row.secretEnc),
      pending: !!(row && row.pendingSecretEnc),
      recoveryCodesRemaining:
        row && row.recoveryHashes ? readRecoveryHashes(row.recoveryHashes).length : 0,
    };
  }

  function beginSetup(user) {
    if (!user || !Number.isInteger(user.id)) throw mkErr('invalid_user');
    const secret = generateSecret();
    const t = now();
    upsertPending.run(user.id, encryptSecret(secret), t, t);
    const account = user.email || `user-${user.id}`;
    const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(account)}`;
    const issuer = encodeURIComponent(ISSUER);
    return {
      secret,
      otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`,
    };
  }

  function enableSetup(userId, code) {
    const row = selectTotp.get(userId);
    if (!row || !row.pendingSecretEnc) throw mkErr('totp_setup_not_started');
    const secret = decryptSecret(row.pendingSecretEnc);
    if (!verifyTotp(secret, code)) throw mkErr('invalid_totp_code');
    const recoveryCodes = generateRecoveryCodes();
    const info = enable.run(mapRecoveryHashes(recoveryCodes), now(), userId);
    if (info.changes !== 1) throw mkErr('totp_setup_not_started');
    return { recoveryCodes };
  }

  function getEnabledSecret(userId) {
    const row = selectTotp.get(userId);
    if (!row || row.enabled !== 1 || !row.secretEnc) return null;
    return decryptSecret(row.secretEnc);
  }

  function createChallenge(userId) {
    deleteExpiredChallenges.run(now());
    deleteUserChallenges.run(userId);
    const token = crypto.randomBytes(32).toString('hex');
    insertChallenge.run(hashToken(token), userId, now() + CHALLENGE_TTL_MS, now());
    return {
      challengeToken: token,
      expiresAt: now() + CHALLENGE_TTL_MS,
    };
  }

  function consumeRecoveryCode(row, code) {
    const normalized = normalizeRecoveryCode(code);
    if (!/^[A-Z0-9]{12}$/.test(normalized)) return false;
    const hashes = readRecoveryHashes(row.recoveryHashes);
    const candidate = hashRecoveryCode(normalized);
    const index = hashes.findIndex((h) => h === candidate);
    if (index === -1) return false;
    hashes.splice(index, 1);
    updateRecoveryHashes.run(JSON.stringify(hashes), now(), row.userId);
    return true;
  }

  function hasRecoveryCode(row, code) {
    const normalized = normalizeRecoveryCode(code);
    if (!/^[A-Z0-9]{12}$/.test(normalized)) return false;
    const hashes = readRecoveryHashes(row.recoveryHashes);
    const candidate = hashRecoveryCode(normalized);
    return hashes.some((h) => h === candidate);
  }

  function consumeUserRecoveryCode(userId, code) {
    const row = selectTotp.get(userId);
    if (!row || row.enabled !== 1 || !row.secretEnc) return false;
    return consumeRecoveryCode(row, code);
  }

  function verifyChallenge({ challengeToken, code, recoveryCode }) {
    const tokenHash = hashToken(challengeToken);
    const challenge = selectChallenge.get(tokenHash);
    if (!challenge || challenge.expiresAt < now()) {
      if (challenge) deleteChallenge.run(tokenHash);
      throw mkErr('mfa_challenge_invalid');
    }
    if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      deleteChallenge.run(tokenHash);
      throw mkErr('mfa_challenge_invalid');
    }

    const row = selectTotp.get(challenge.userId);
    if (!row || row.enabled !== 1 || !row.secretEnc) {
      deleteChallenge.run(tokenHash);
      throw mkErr('mfa_challenge_invalid');
    }

    let ok = false;
    let recoveryCodeUsed = false;
    if (code) {
      ok = verifyTotp(decryptSecret(row.secretEnc), code);
    } else if (recoveryCode) {
      ok = hasRecoveryCode(row, recoveryCode);
      recoveryCodeUsed = ok;
    }

    if (!ok) {
      bumpChallenge.run(tokenHash);
      throw mkErr('invalid_totp_code');
    }
    deleteChallenge.run(tokenHash);
    return {
      userId: challenge.userId,
      recoveryCodeUsed,
      recoveryCode: recoveryCodeUsed ? recoveryCode : undefined,
    };
  }

  function verifyUserCode(userId, code) {
    const secret = getEnabledSecret(userId);
    if (!secret) throw mkErr('totp_not_enabled');
    if (!verifyTotp(secret, code)) throw mkErr('invalid_totp_code');
    return true;
  }

  function disableTotp(userId) {
    disable.run(userId);
  }

  return {
    status,
    beginSetup,
    enableSetup,
    getEnabledSecret,
    createChallenge,
    verifyChallenge,
    consumeUserRecoveryCode,
    verifyUserCode,
    disable: disableTotp,
  };
}

module.exports = {
  createTotpRepo,
  verifyTotp,
  generateTotpCode,
  normalizeRecoveryCode,
  hashRecoveryCode,
  CHALLENGE_TTL_MS,
};
