'use strict';

const express = require('express');
const request = require('supertest');
const { createPrivacyRouter, PRIVACY_PREFIX } = require('../routes/privacy');
const { POOLS } = require('../lib/privacyRegistry');
const { buildTestApp } = require('./helpers/buildTestApp');
const endpoint = `${PRIVACY_PREFIX}/pools/eth-0.1/snapshot`;
function app(index, limiter = (_req, _res, next) => next()) {
  const a = express(); a.use(express.json()); a.use(PRIVACY_PREFIX, createPrivacyRouter({ index, limiter })); return a;
}
test('anonymous progress and disabled responses are JSON without cookies', async () => {
  expect((await request(app()).get(endpoint)).body).toEqual({ error: 'privacy_index_disabled' });
  const res = await request(app({ read: async () => ({ status: 202, body: { phase: 'syncing', scannedBlock: 1, startBlock: 2, targetBlock: 3 } }) })).get(endpoint).set('Origin', 'chrome-extension://pali');
  expect(res.status).toBe(202); expect(res.headers['access-control-allow-origin']).toBe('*');
  expect(res.headers['set-cookie']).toBeUndefined(); expect(res.headers['access-control-allow-credentials']).toBeUndefined();
});
test.each(['?note=secret', '?leafIndex=1', '?rpcUrl=https://attacker.example'])('rejects extra request data %s before index invocation', async (query) => {
  const read = jest.fn(); expect((await request(app({ read })).get(endpoint + query)).status).toBe(400); expect(read).not.toHaveBeenCalled();
});
test('unknown pool, write methods and arbitrary paths cannot reach indexing', async () => {
  const read = jest.fn(); const a = app({ read });
  expect((await request(a).get(endpoint.replace('eth-0.1', '0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc'))).status).toBe(404);
  expect((await request(a).post(endpoint).send({ note: 'secret' })).status).toBe(405);
  expect((await request(a).get(PRIVACY_PREFIX + '/anything')).status).toBe(404);
  expect((await request(a).get(endpoint).send({ note: 'secret' })).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
test('ETag revalidation preserves freshness marker and unchanged anchored body', async () => {
  const body = { version: 1, chainId: 1, poolAddress: POOLS[0].address, asOfBlockNumber: 123, asOfBlockHash: 'hash', leafCount: 0, root: 'root', leaves: [] };
  const index = { read: async () => ({ status: 200, body, encoded: JSON.stringify(body), etag: '"snapshot"', phase: 'stale' }) };
  const res = await request(app(index)).get(endpoint).set('If-None-Match', '"snapshot"');
  expect(res.status).toBe(304); expect(res.headers['x-privacy-index-state']).toBe('stale');
  expect(res.headers['cache-control']).toContain('must-revalidate'); expect(res.headers['etag']).toBe('"snapshot"');
});
test('standalone app wires public CORS before auth and exposes no session', async () => {
  const read = jest.fn(async () => ({ status: 202, body: { phase: 'syncing' } }));
  const ctx = buildTestApp({ privacyIndex: { read } });
  try {
    const res = await request(ctx.app).get(endpoint).set('Origin', 'https://unrelated.example');
    expect(res.status).toBe(202); expect(res.headers['access-control-allow-origin']).toBe('*'); expect(res.headers['set-cookie']).toBeUndefined();
    expect(read).toHaveBeenCalledWith('eth-0.1');
  } finally { ctx.db.close(); }
});
