const { isCredentialedPath } = require('./credentialedPaths');

describe('isCredentialedPath', () => {
  test.each([
    ['/auth', true],
    ['/auth/login', true],
    ['/auth/register', true],
    ['/vault', true],
    ['/vault/get', true],
    ['/gov', true],
    ['/gov/mns/lookup', true],
    ['/gov/vote', true],
  ])('%s is credentialed', (path, expected) => {
    expect(isCredentialedPath(path)).toBe(expected);
  });

  // These are the legacy public endpoints that used to sit under
  // `origin: '*'`. A naive startsWith('/gov') match would wrongly
  // pull them into the credentialed bucket and break every third-
  // party consumer that isn't hosted on CORS_ORIGIN. These
  // assertions are the regression test for Codex P1 on server.js.
  test.each([
    ['/govlist', false],
    ['/govbyhash', false],
    ['/authenticate', false], // hypothetical future legacy path
    ['/vaultpublic', false], // hypothetical future legacy path
    ['/mnstats', false],
    ['/', false],
    ['/health', false],
  ])('%s is NOT credentialed (boundary check)', (path, expected) => {
    expect(isCredentialedPath(path)).toBe(expected);
  });

  test.each([
    [null, false],
    [undefined, false],
    ['', false],
    [42, false],
  ])('rejects %p (non-string / empty)', (input, expected) => {
    expect(isCredentialedPath(input)).toBe(expected);
  });
});
