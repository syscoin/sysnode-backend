'use strict';

const http = require('http');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  createReminderRpc,
  createReminderSource,
  NETWORKS,
} = require('./reminderSource');
const NOW = 1800000000000;
const HASH = 'a'.repeat(64);
const OBJECT = 'b'.repeat(64);
const info = (overrides = {}) => ({
  chain: 'main',
  blocks: 10000,
  headers: 10000,
  initialblockdownload: false,
  verificationprogress: 1,
  bestblockhash: HASH,
  ...overrides,
});
const gov = (overrides = {}) => ({
  nextsuperblock: 17520,
  superblockcycle: 17520,
  superblockmaturitywindow: 1728,
  ...overrides,
});
const proposal = {
  Hash: 'c'.repeat(64),
  ObjectType: 1,
  fCachedValid: true,
  fCachedDelete: false,
  fBlockchainValidity: true,
  DataString: JSON.stringify({
    start_epoch: NOW / 1000 - 10,
    end_epoch: NOW / 1000 + 2000000,
  }),
};

function fixture(overrides = {}, options = {}) {
  const answers = {
    getblockchaininfo: info(),
    getblockhash: NETWORKS.mainnet.genesis,
    getgovernanceinfo: gov(),
    gobject_list: { [OBJECT]: proposal },
    ...overrides,
  };
  const rpcCall = jest.fn(async (method) =>
    typeof answers[method] === 'function' ? answers[method]() : answers[method]
  );
  return {
    rpcCall,
    source: createReminderSource({
      rpcCall,
      network: 'mainnet',
      now: () => NOW,
      ...options,
    }),
  };
}

test('fresh production source uses Core object IDs and fixed block spacing, without market/cache reads', async () => {
  const { source, rpcCall } = fixture();
  const snapshot = await source.getNextSuperblock();
  expect(snapshot).toMatchObject({
    height: 17520,
    currentHeight: 10000,
    maturityBlocks: 1728,
    epochSec: NOW / 1000 + 7520 * 150,
    observedAt: NOW,
    proposals: [expect.objectContaining({ hash: OBJECT })],
  });
  expect(await source.getActiveProposals(snapshot)).toEqual(snapshot.proposals);
  expect(rpcCall.mock.calls.map(([m]) => m)).toEqual([
    'getblockchaininfo',
    'getblockhash',
    'getgovernanceinfo',
    'gobject_list',
    'getblockchaininfo',
  ]);
  const production = fs.readFileSync(
    path.join(__dirname, '..', 'server.js'),
    'utf8'
  );
  expect(production).toContain(
    'getNextSuperblock: reminderSource.getNextSuperblock'
  );
  expect(production).toContain(
    'getActiveProposals: reminderSource.getActiveProposals'
  );
  expect(production).not.toContain('height: Number(dataStore.nextSuperBlock)');
});

test.each([
  { chain: 'test' },
  { initialblockdownload: true },
  { headers: 10001 },
  { verificationprogress: 0.5 },
  { bestblockhash: '' },
  { blocks: '10000' },
])(
  'unsynced, malformed or wrong-network Core fails closed: %p',
  async (override) => {
    await expect(
      fixture({ getblockchaininfo: info(override) }).source.getNextSuperblock()
    ).rejects.toThrow('reminder_chain_unavailable');
  }
);
test('same chain label but wrong genesis fails closed', async () => {
  await expect(
    fixture({ getblockhash: '0'.repeat(64) }).source.getNextSuperblock()
  ).rejects.toThrow('reminder_network_mismatch');
});
test('unknown configured network never sends RPC requests', async () => {
  const { source, rpcCall } = fixture({}, { network: 'regtest' });
  await expect(source.getNextSuperblock()).rejects.toThrow(
    'reminder_network_unconfigured'
  );
  expect(rpcCall).not.toHaveBeenCalled();
});
test.each([
  { nextsuperblock: 9999 },
  { nextsuperblock: 17521 },
  { superblockcycle: 0 },
  { superblockmaturitywindow: 0 },
  { superblockmaturitywindow: 18000 },
  { superblockmaturitywindow: '1728' },
])('malformed governance parameters fail closed: %p', async (override) => {
  await expect(
    fixture({ getgovernanceinfo: gov(override) }).source.getNextSuperblock()
  ).rejects.toThrow('reminder_governance_unavailable');
});
test('tip movement retries the entire snapshot once and never mixes proposals across tips', async () => {
  let calls = 0;
  const { source, rpcCall } = fixture({
    getblockchaininfo: () =>
      info({ bestblockhash: ++calls === 1 ? HASH : 'd'.repeat(64) }),
  });
  expect((await source.getNextSuperblock()).blockHash).toBe('d'.repeat(64));
  expect(rpcCall.mock.calls.filter(([m]) => m === 'gobject_list')).toHaveLength(
    2
  );
});
test('continual tip movement is bounded to two complete attempts', async () => {
  let calls = 0;
  const { source, rpcCall } = fixture({
    getblockchaininfo: () =>
      info({ bestblockhash: String(++calls).repeat(64) }),
  });
  await expect(source.getNextSuperblock()).rejects.toThrow(
    'reminder_tip_changed'
  );
  expect(rpcCall.mock.calls.filter(([m]) => m === 'gobject_list')).toHaveLength(
    2
  );
});
test('a hung RPC has an overall deadline and abort signal, without an accumulating tick', async () => {
  let signal;
  const source = createReminderSource({
    network: 'mainnet',
    timeoutMs: 20,
    rpcCall: (_m, _p, value) => {
      signal = value;
      return new Promise(() => {});
    },
  });
  await expect(source.getNextSuperblock()).rejects.toThrow(
    'reminder_snapshot_timeout'
  );
  expect(signal.aborted).toBe(true);
});

test('real HTTP RPC aborts; auth stays on configured client and only read methods are accepted', async () => {
  let request;
  const server = http.createServer((req) => {
    request = req;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const client = {
    instance: axios.create({
      auth: { username: 'fixture', password: 'synthetic' },
    }),
    url: 'http://127.0.0.1:' + server.address().port,
  };
  const rpc = createReminderRpc(client);
  try {
    await expect(
      rpc('sendrawtransaction', [], controller.signal)
    ).rejects.toThrow('reminder_rpc_method_forbidden');
    const result = rpc('getblockchaininfo', [], controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await expect(result).rejects.toThrow('reminder_rpc_unavailable');
    expect(request.headers.authorization).toMatch(/^Basic /);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('RPC validates response ID, rejects upstream errors and caps response size', async () => {
  const post = jest.fn(async (_url, body) => ({
    data: { id: body.id, result: 17520 },
  }));
  const rpc = createReminderRpc({
    instance: { post },
    url: 'http://fixture.test',
  });
  expect(await rpc('getgovernanceinfo', [])).toBe(17520);
  expect(post.mock.calls[0][2]).toMatchObject({
    maxContentLength: 16777216,
    maxRedirects: 0,
    timeout: 10000,
  });
  post.mockResolvedValue({ data: { id: 'wrong', result: {} } });
  await expect(rpc('getgovernanceinfo', [])).rejects.toThrow(
    'reminder_rpc_invalid_response'
  );
});
