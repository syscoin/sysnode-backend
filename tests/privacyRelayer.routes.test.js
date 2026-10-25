'use strict';

const express = require('express');
const request = require('supertest');
const { createPrivacyRouter, PRIVACY_PREFIXES } = require('../routes/privacy');
const { buildTestApp } = require('./helpers/buildTestApp');
const next = (_req, _res, proceed) => proceed();
function app(relayers, index) {
  const a = express(); a.use(PRIVACY_PREFIXES, createPrivacyRouter({ index, relayers, limiter: next })); return a;
}
test.each(PRIVACY_PREFIXES)('bulk directory is anonymous and parameter-free at %s', async (prefix) => {
  const read = jest.fn(async () => ({ status: 202, body: { phase: 'syncing' } }));
  const a = app({ read }); const url = prefix + '/relayers';
  const res = await request(a).get(url).set('Origin', 'chrome-extension://pali');
  expect(res.status).toBe(202); expect(read).toHaveBeenCalledTimes(1);
  expect(res.headers['access-control-allow-origin']).toBe('*'); expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  expect(res.headers['set-cookie']).toBeUndefined();
  for (const suffix of ['?note=secret', '?address=0x123', '?url=https://private.example', '?pool=eth-1']) {
    expect((await request(a).get(url + suffix)).status).toBe(400);
  }
  expect((await request(a).get(url).send({ note: 'secret' })).status).toBe(400);
  expect((await request(a).post(url).send({ url: 'https://private.example' })).status).toBe(405);
  expect(read).toHaveBeenCalledTimes(1);
});
test('disabled directory does not require or enable the pool index', async () => {
  const a = app(); expect((await request(a).get('/api/privacy/v1/relayers')).body).toEqual({ error: 'privacy_relayer_directory_disabled' });
  expect((await request(a).get('/api/privacy/v1/pools/eth-1/snapshot')).body).toEqual({ error: 'privacy_index_disabled' });
});
test.each(PRIVACY_PREFIXES)('existing pool snapshot route works under preserved or stripped proxy prefix %s', async (prefix) => {
  const read = jest.fn(async () => ({ status: 202, body: { phase: 'syncing' } }));
  expect((await request(app(null, { read })).get(prefix + '/pools/eth-1/snapshot')).status).toBe(202);
  expect(read).toHaveBeenCalledWith('eth-1');
  const unknown = await request(app()).get(prefix + '/status'); expect(unknown.status).toBe(404); expect(unknown.body.error).toBe('unknown_privacy_route');
});
test('directory ETag carries stale observation marker; errors do not leak internal text', async () => {
  const read = jest.fn(async () => ({ status: 200, encoded: '{"relayers":[]}', etag: '"r1"', phase: 'stale' }));
  const a = app({ read });
  const res = await request(a).get('/api/privacy/v1/relayers').set('If-None-Match', '"r1"');
  expect(res.status).toBe(304); expect(res.headers['x-privacy-index-state']).toBe('stale'); expect(res.headers['cache-control']).toContain('must-revalidate');
  read.mockRejectedValue(new Error('secret rpc url'));
  expect((await request(a).get('/api/privacy/v1/relayers')).body).toEqual({ error: 'privacy_relayer_directory_unavailable' });
});
test('production app factory wires stripped public prefix before credentialed middleware', async () => {
  const read = jest.fn(async () => ({ status: 202, body: { phase: 'syncing' } }));
  const ctx = buildTestApp({ privacyRelayers: { read } });
  try {
    const res = await request(ctx.app).get('/privacy/v1/relayers').set('Origin', 'https://unrelated.example');
    expect(res.status).toBe(202); expect(res.headers['access-control-allow-origin']).toBe('*'); expect(res.headers['set-cookie']).toBeUndefined();
    expect(ctx.privacyRelayers).toEqual({ read });
  } finally { ctx.db.close(); }
});
