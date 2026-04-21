// Credentialed-CORS path selector used by server.js.
//
// Separated into its own module (and its own test file) so the
// boundary semantics — "exactly /prefix OR starts with /prefix/" —
// can be verified in isolation from Express/middleware wiring.
//
// Why the boundary matters:
//
// Legacy public routes (`routes/governance.js` et al.) register
// paths like `/govlist`, `/govbyhash` that are served to third-party
// consumers under `origin: '*'`. The new authenticated governance
// surface registers `/gov/...` and MUST be served under the
// credentialed `origin: <SPA>, credentials: true` CORS profile or
// browsers reject the preflight.
//
// A naive `path.startsWith('/gov')` catches BOTH buckets: it would
// route legacy `/govlist` through the credentialed profile, which
// sends `Access-Control-Allow-Origin: <SPA>` and therefore 403s
// every other origin. That's a regression against every third-party
// integration that's ever polled the public governance list.
//
// The path-boundary match below is the only correct prefix test
// when you have sibling routes that differ only in the trailing
// characters of the prefix itself. (Express's own `app.use('/gov',
// ...)` applies the same boundary rule under the hood.)

const CREDENTIALED_PREFIXES = Object.freeze(['/auth', '/vault', '/gov']);

function isCredentialedPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  return CREDENTIALED_PREFIXES.some(
    (p) => path === p || path.startsWith(p + '/')
  );
}

module.exports = { CREDENTIALED_PREFIXES, isCredentialedPath };
