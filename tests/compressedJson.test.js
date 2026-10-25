const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { z } = require('zod');

// Small bounded payloads reproduce GHSA-27r3-jxmh-p828. A subprocess keeps a
// regression to the vulnerable decompressor from crashing the Jest runner.
test.each(['production', 'standalone'])('%s parser survives compressed trailing bytes and rejects malformed gzip', (mode) => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'helpers/compressedJsonChild.cjs'), mode], {
    timeout: 10000, encoding: 'utf8', maxBuffer: 64 * 1024,
    env: { ...process.env, NODE_ENV: 'test', RECOVERY_ALERTS_ENABLED: 'false' },
  });
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(result.stderr || `Child exited with ${result.signal || result.status}`);
  expect(result.signal).toBeNull();
  expect(JSON.parse(result.stdout)).toEqual({ mode, statuses: [401, 401, 400, 401] });
});

test('oversized constrained arrays reject before validating their elements', () => {
  let visited = 0;
  const schema = z.array(z.custom(() => { visited++; return false; })).max(2);
  const result = schema.safeParse([1, 2, 3, 4]);
  expect(result.success).toBe(false);
  expect(result.error.issues[0].code).toBe('too_big');
  expect(visited).toBe(0);
});
