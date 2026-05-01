const express = require('express');
const request = require('supertest');

jest.mock('../services/rpcClient', () => ({
  client: { callRpc: jest.fn() },
  rpcServices: jest.fn(),
}));

jest.mock('../lib/securityLog', () => ({
  event: jest.fn(),
}));

const { rpcServices } = require('../services/rpcClient');
const securityLog = require('../lib/securityLog');
const governanceRoute = require('../routes/governance');

function buildApp() {
  const app = express();
  app.use(governanceRoute);
  return app;
}

function mockGObjectList(value) {
  rpcServices.mockReturnValue({
    gObject_list: () => ({
      call: jest.fn().mockResolvedValue(value),
    }),
  });
}

describe('POST /govlist', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('skips malformed DataString entries without failing the whole feed', async () => {
    mockGObjectList({
      valid: {
        Hash: 'valid-hash',
        CollateralHash: 'collateral',
        ObjectType: 1,
        CreationTime: 123,
        AbsoluteYesCount: 9,
        YesCount: 10,
        NoCount: 1,
        AbstainCount: 0,
        fBlockchainValidity: true,
        IsValidReason: '',
        fCachedValid: true,
        fCachedFunding: true,
        fCachedDelete: false,
        fCachedEndorsed: false,
        DataString: JSON.stringify({ name: 'valid proposal' }),
      },
      malformed: {
        Hash: 'bad-hash',
        AbsoluteYesCount: 99,
        DataString: '{not json',
      },
    });

    const res = await request(buildApp()).post('/govlist').send({});

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      Key: 'valid',
      Hash: 'valid-hash',
      name: 'valid proposal',
    });
    expect(securityLog.event).toHaveBeenCalledWith(
      'govlist.malformed_data_string',
      expect.objectContaining({
        key: 'malformed',
        hash: 'bad-hash',
      })
    );
  });

  test('still returns a generic 500 when the RPC call itself fails', async () => {
    rpcServices.mockReturnValue({
      gObject_list: () => ({
        call: jest.fn().mockRejectedValue(new Error('rpc down')),
      }),
    });

    const res = await request(buildApp()).post('/govlist').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(securityLog.event).toHaveBeenCalledWith(
      'govlist.rpc_failed',
      expect.objectContaining({ message: 'rpc down' })
    );
  });
});
