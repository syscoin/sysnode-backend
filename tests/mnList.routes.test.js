// Regression test for routes/mnlist.js error-shape hardening.
//
// Previously /mnlist returned `{ error: err.message }` on RPC failure,
// which can leak internal hostnames/ports/stack-adjacent detail (e.g.
// "ECONNREFUSED 127.0.0.1:8370"). The hardened handler now mirrors
// routes/governance.js (`govlist.rpc_failed`):
//
//   - Logs the full error server-side via lib/securityLog.
//   - Returns an opaque `{ error: 'internal' }` 500 to the client.
//
// Pin both halves of that contract.

jest.mock('../services/rpcClient', () => {
  const fakeCall = jest.fn();
  return {
    client: { callRpc: jest.fn() },
    rpcServices: () => ({
      masternode_list: () => ({ call: fakeCall }),
    }),
    __fakeCall: fakeCall,
  };
});

jest.mock('../lib/securityLog', () => ({
  event: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

const rpcClientMock = require('../services/rpcClient');
const securityLogMock = require('../lib/securityLog');
const mnListRoute = require('../routes/mnlist');

function buildApp() {
  const app = express();
  app.use(mnListRoute);
  return app;
}

describe('GET /mnlist', () => {
  beforeEach(() => {
    rpcClientMock.__fakeCall.mockReset();
    securityLogMock.event.mockReset();
  });

  test('200 returns the RPC payload verbatim on success', async () => {
    const payload = { 'aaaa-0': { address: '127.0.0.1', status: 'ENABLED' } };
    rpcClientMock.__fakeCall.mockResolvedValueOnce(payload);

    const res = await request(buildApp()).get('/mnlist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(securityLogMock.event).not.toHaveBeenCalled();
  });

  test('500 returns opaque {error:"internal"} on RPC failure (no message leak)', async () => {
    rpcClientMock.__fakeCall.mockRejectedValueOnce(
      new Error('ECONNREFUSED 127.0.0.1:8370')
    );

    const res = await request(buildApp()).get('/mnlist');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    // The leaky message must NOT appear in the response body.
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
  });

  test('logs RPC failures server-side with full message detail', async () => {
    rpcClientMock.__fakeCall.mockRejectedValueOnce(
      new Error('ECONNREFUSED 127.0.0.1:8370')
    );

    await request(buildApp()).get('/mnlist');
    expect(securityLogMock.event).toHaveBeenCalledTimes(1);
    const [eventName, meta] = securityLogMock.event.mock.calls[0];
    expect(eventName).toBe('mnList.rpc_failed');
    expect(meta).toMatchObject({
      message: 'ECONNREFUSED 127.0.0.1:8370',
    });
    expect(meta.req).toBeDefined();
  });
});
