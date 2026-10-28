'use strict';

const expressRequest = require('supertest');
const { HOST, portFrom, createPrivacyApp } = require('../privacy-server');

const extension = `chrome-extension://${'a'.repeat(32)}`;
const pool = '/api/privacy/v1/pools/eth-0.1/snapshot';
let listener, index, relayers;

beforeEach(async () => {
  index = { read: jest.fn(async () => ({ status: 202, body: { phase: 'syncing' } })) };
  relayers = { read: jest.fn(async () => ({ status: 202, body: { phase: 'syncing' } })) };
  const app = createPrivacyApp({ index, relayers });
  listener = await new Promise((resolve) => { const s = app.listen(0, HOST, () => resolve(s)); });
});
afterEach(async () => { await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())); });

test('binds IPv4 loopback and serves existing public endpoints to extension origins', async () => {
  expect(listener.address().address).toBe('127.0.0.1');
  const api = expressRequest(listener);
  const result = await api.get(pool).set('Origin', extension);
  expect(result.status).toBe(202);
  expect(result.headers['access-control-allow-origin']).toBe('*');
  expect(result.headers['set-cookie']).toBeUndefined();
  expect(index.read).toHaveBeenCalledWith('eth-0.1');
  expect((await api.get('/privacy/v1/relayers').set('Origin', extension)).status).toBe(202);
  expect(relayers.read).toHaveBeenCalledTimes(1);
  expect((await api.get('/health')).body).toEqual({ ok: true });
  // Chromium MV3 service-worker fetches may omit Origin and send site=none.
  expect((await api.get('/privacy/v1/relayers').set('Sec-Fetch-Site', 'none')).status).toBe(202);
});

test('rejects untrusted Host and web Origin before activating index work', async () => {
  const api = expressRequest(listener);
  const port = listener.address().port;
  for (const host of [`attacker.example:${port}`, `localhost.attacker.example:${port}`, `localhost@attacker.example:${port}`, `127.0.0.1:${port + 1}`]) {
    expect((await api.get(pool).set('Host', host)).status).toBe(403);
  }
  for (const origin of ['https://attacker.example', 'http://localhost.attacker.example', 'null', `${extension}.attacker.example`]) {
    expect((await api.get(pool).set('Origin', origin)).status).toBe(403);
  }
  expect((await api.get(pool).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
  expect(index.read).not.toHaveBeenCalled();
});

test('retains privacy router query, body, write and unknown-pool guards', async () => {
  const api = expressRequest(listener);
  expect((await api.get(`${pool}?note=secret`).set('Origin', extension)).status).toBe(400);
  expect((await api.get(pool).send({ note: 'secret' })).status).toBe(400);
  expect((await api.post(pool).send({ note: 'secret' })).status).toBe(405);
  expect((await api.get('/api/privacy/v1/pools/arbitrary/snapshot')).status).toBe(404);
  expect(index.read).not.toHaveBeenCalled();
});

test('uses a bounded explicit port', () => {
  expect(portFrom()).toBe(3477);
  expect(portFrom('9876')).toBe(9876);
  for (const value of ['0', '-1', '65536', '1.5', '3477x']) expect(() => portFrom(value)).toThrow();
});
