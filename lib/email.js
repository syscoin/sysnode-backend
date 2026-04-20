// Email handling shared by auth routes and the client KDF contract.
// The client MUST normalize with the same rules (trim + lowercase + NFKC) when
// deriving `master` via PBKDF2 because email is the PBKDF2 salt. Any divergence
// breaks login across devices.

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').trim().toLowerCase();
}

// Intentionally permissive RFC-ish syntax check. We explicitly allow domain
// labels that start with a digit (syshub issue #1 rejected these).
// We do NOT try to be a full RFC 5322 parser; the magic-link verification
// confirms deliverability for real.
function isValidEmailSyntax(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 254) return false;
  const atIdx = value.indexOf('@');
  if (atIdx < 1 || atIdx !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, atIdx);
  const domain = value.slice(atIdx + 1);
  if (local.length === 0 || local.length > 64) return false;
  if (/\s/.test(value)) return false;
  if (domain.length === 0 || domain.indexOf('.') === -1) return false;
  // Domain labels: alphanum + hyphen, cannot start/end with hyphen; digits OK.
  const labels = domain.split('.');
  if (labels.some((l) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(l))) {
    return false;
  }
  // Local part: allow common safe chars. Not exhaustive but rejects the
  // obvious bad shapes the tests cover.
  if (!/^[A-Za-z0-9._%+\-]+$/.test(local)) return false;
  return true;
}

module.exports = {
  normalizeEmail,
  isValidEmailSyntax,
};
