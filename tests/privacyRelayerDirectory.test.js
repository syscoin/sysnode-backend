'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { namehash } = require('ethers');
const { createPrivacyRelayerDirectory, createRelayerCheckpointStore, configuredPrivacyRelayerDirectory,
  SOURCE_ID, REFRESH_MS, JOB_MS, RANGE, MAX_CHUNKS } = require('../lib/privacyRelayerDirectory');
const { createPrivacyRelayerStatus } = require('../lib/privacyRelayerStatus');
const { POOLS } = require('../lib/privacyRegistry');
const { DEPLOYMENT_BLOCK, MAX_CANDIDATES } = require('../lib/privacyRelayerRegistry');
const owner = '0x1111111111111111111111111111111111111111';
const candidate = { ensName: 'relay.eth', ensHash: namehash('relay.eth'), registeredAddress: owner };
const hash = '0x' + 'aa'.repeat(32);
function setup({ saved, candidates = [candidate], end = DEPLOYMENT_BLOCK + 2, overrides = {} } = {}) {
  let clock = 1700000000000; let disk = saved; const timers = new Set();
  const header = { number: end, hash, timestamp: clock / 1000 };
  const store = { read: jest.fn(async () => disk), write: jest.fn(async (value) => { disk = structuredClone(value); }) };
  const guard = (ctx) => ctx?.beforeRequest?.();
  const rpc = {
    head: jest.fn(async (ctx) => { guard(ctx); return { ...header }; }),
    assertSource: jest.fn(async (_h, ctx) => { guard(ctx); }),
    assertBlock: jest.fn(async (_h, ctx) => { guard(ctx); }),
    block: jest.fn(async (number, ctx) => { guard(ctx); return { number, hash, timestamp: clock / 1000 }; }),
    events: jest.fn(async (_from, _to, ctx) => { guard(ctx); return candidates; }),
    resolve: jest.fn(async (c, _h, ctx) => { guard(ctx); return { ensName: c.ensName, ensHash: c.ensHash, owner, registryBalance: '123', endpoint: 'https://public.example' }; }),
    rewardRegistered: jest.fn(async (_owner, _reward, _h, ctx) => { guard(ctx); return true; }), ...overrides,
  };
  const inspect = jest.fn(async (_endpoint, ctx) => { guard(ctx); return { origin: 'https://public.example', rewardAccount: owner,
    supportedPools: ['eth-0.1'], serviceFeePercent: '0.3', reportedHealthy: true, queueLength: 0, version: '5.0.1', observedAt: clock }; });
  const directory = createPrivacyRelayerDirectory({ rpc, inspect, store, now: () => clock,
    setTimer: (fn, delay) => { const t = { fn, delay }; timers.add(t); return t; }, clearTimer: (t) => timers.delete(t) });
  return { directory, rpc, inspect, store, timers, header,
    advance: (ms) => { clock += ms; },
    tick: async () => { const timer = [...timers][0]; if (timer) { timers.delete(timer); clock += timer.delay; timer.fn(); await directory.idle(); } },
    get disk() { return disk; },
  };
}
async function ready(s) { await s.directory.read(); await s.directory.idle(); return s.directory.read(); }

test('directory defaults on with an RPC, remains idle until requested, and supports opt-out', async () => {
  const post = jest.spyOn(require('axios'), 'post');
  expect(configuredPrivacyRelayerDirectory({})).toBeNull();
  expect(configuredPrivacyRelayerDirectory({ PRIVACY_RELAYER_DIRECTORY_ENABLED: '', PRIVACY_INDEX_RPC_URL: '' })).toBeNull();
  expect(configuredPrivacyRelayerDirectory({ PRIVACY_RELAYER_DIRECTORY_ENABLED: 'false', PRIVACY_INDEX_RPC_URL: 'broken' })).toBeNull();
  expect(() => configuredPrivacyRelayerDirectory({ PRIVACY_RELAYER_DIRECTORY_ENABLED: 'true' })).toThrow('rpc_required');
  expect(() => configuredPrivacyRelayerDirectory({ PRIVACY_RELAYER_DIRECTORY_ENABLED: 'yes' })).toThrow('PRIVACY_RELAYER_DIRECTORY_ENABLED_invalid');
  expect(() => configuredPrivacyRelayerDirectory({ PRIVACY_INDEX_RPC_URL: 'http://localhost' })).toThrow('privacy_rpc_url_invalid');
  for (const flag of [undefined, '', 'true']) {
    const directory = configuredPrivacyRelayerDirectory({ PRIVACY_RELAYER_DIRECTORY_ENABLED: flag, PRIVACY_INDEX_RPC_URL: 'https://operator.example' });
    expect(directory).not.toBeNull();
    await directory.start();
    expect(post).not.toHaveBeenCalled();
    await directory.close();
  }
  post.mockRestore();
});
test('unused directory stays idle; first bulk read publishes only public anchored observations', async () => {
  const s = setup(); await s.directory.start(); expect(s.rpc.head).not.toHaveBeenCalled();
  expect((await s.directory.read()).status).toBe(202); await s.directory.idle();
  const res = await s.directory.read(); expect(res.status).toBe(200); expect(res.phase).toBe('ready');
  expect(res.body).toMatchObject({ version: 1, chainId: 1, asOfBlockNumber: s.header.number, asOfBlockHash: hash, unavailableEntries: 0,
    relayers: [{ owner, advertisedServiceFeePercent: '0.3', supportedPools: ['eth-0.1'], health: 'reported-healthy' }] });
  expect(s.rpc.resolve).toHaveBeenCalledWith(candidate, s.header, expect.objectContaining({ beforeRequest: expect.any(Function) }));
  expect(s.rpc.rewardRegistered).toHaveBeenCalledWith(owner, owner, s.header, expect.any(Object));
  expect(s.disk).toMatchObject({ version: 1, source: SOURCE_ID, scannedBlock: s.header.number });
  expect(JSON.stringify(s.disk)).not.toContain('endpoint'); expect(JSON.stringify(s.disk)).not.toContain('Fee');
  await s.directory.close(); expect(s.timers.size).toBe(0);
});
test('registered bare ENS hostname yields a selectable HTTPS relayer through guarded status inspection', async () => {
  const s = setup();
  s.rpc.resolve.mockResolvedValue({ ensName: candidate.ensName, ensHash: candidate.ensHash, owner,
    registryBalance: '123', endpoint: 'relay.example' });
  const request = jest.fn((options, callback) => {
    const req = new EventEmitter(); req.destroy = jest.fn();
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough(); res.statusCode = 200; res.headers = { 'content-type': 'application/json' };
      callback(res);
      res.end(JSON.stringify({ netId: 1, rewardAccount: owner,
        instances: { eth: { decimals: 18, instanceAddress: Object.fromEntries(POOLS.map((p) => [p.id.slice(4), p.address])) } },
        tornadoServiceFee: 0.3, health: { status: 'true' }, currentQueue: 0, version: '5.0.1' }));
    });
    return req;
  });
  const inspect = createPrivacyRelayerStatus({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request, now: () => 1700000000000 });
  s.inspect.mockImplementation(inspect);
  const res = await ready(s);
  expect(res.body.relayers[0]).toMatchObject({ endpoint: 'https://relay.example', health: 'reported-healthy',
    rewardAccount: owner, supportedPools: POOLS.map((p) => p.id) });
  expect(request.mock.calls[0][0]).toMatchObject({ protocol: 'https:', hostname: 'relay.example', port: 443, path: '/status', rejectUnauthorized: true });
  expect(s.rpc.rewardRegistered).toHaveBeenCalledWith(owner, owner, s.header, expect.any(Object));
  await s.directory.close();
});
test('deduplicates concurrent demand into one registry scan and one status request', async () => {
  const s = setup(); await Promise.all(Array.from({ length: 10 }, () => s.directory.read())); await s.directory.idle();
  expect(s.rpc.head).toHaveBeenCalledTimes(1); expect(s.inspect).toHaveBeenCalledTimes(1); await s.directory.close();
});
test('cold checkpoint never supplies a trusted directory before fresh validation', async () => {
  const saved = { version: 1, source: SOURCE_ID, scannedBlock: DEPLOYMENT_BLOCK + 2, scannedHash: hash, candidates: [candidate], relayers: [{ health: 'reported-healthy' }] };
  const s = setup({ saved, overrides: { head: jest.fn(async () => { throw new Error('offline'); }) } });
  await s.directory.start(); await s.directory.idle();
  expect((await s.directory.read()).status).toBe(503); expect(s.inspect).not.toHaveBeenCalled(); await s.directory.close();
});
test('invalid old source checkpoints rebuild from pinned deployment', async () => {
  const s = setup({ saved: { version: 1, source: 'old', scannedBlock: DEPLOYMENT_BLOCK + 2, scannedHash: hash, candidates: [candidate] } });
  await ready(s); expect(s.rpc.events.mock.calls[0][0]).toBe(DEPLOYMENT_BLOCK); await s.directory.close();
});
test('restored checkpoint with reorg starts a new canonical registry scan', async () => {
  const s = setup({ saved: { version: 1, source: SOURCE_ID, scannedBlock: DEPLOYMENT_BLOCK + 1, scannedHash: '0x' + 'bb'.repeat(32), candidates: [candidate] } });
  await ready(s); expect(s.rpc.events.mock.calls[0][0]).toBe(DEPLOYMENT_BLOCK); await s.directory.close();
});
test('current registration refusals remove old candidates rather than endorsing old endpoints', async () => {
  const s = setup({ overrides: { resolve: jest.fn(async () => null) } });
  const res = await ready(s); expect(res.body.relayers).toEqual([]); expect(s.inspect).not.toHaveBeenCalled(); await s.directory.close();
});
test('unavailable or mismatched reward status never supplies selectable advertised fees', async () => {
  const s = setup({ overrides: { rewardRegistered: jest.fn(async () => false) } });
  const res = await ready(s); expect(res.body.relayers[0]).toEqual({ ensName: candidate.ensName, ensHash: candidate.ensHash, owner, registryBalance: '123', health: 'unavailable' });
  expect(res.body.unavailableEntries).toBe(1); await s.directory.close();
  const offline = setup(); offline.inspect.mockRejectedValue(new Error('timeout'));
  const failed = await ready(offline); expect(failed.body.relayers[0].health).toBe('unavailable'); expect(failed.body.relayers[0].endpoint).toBeUndefined();
  await offline.directory.close();
});
test('periodic refresh retains old as-of snapshot with stale header on failure', async () => {
  const s = setup(); const old = await ready(s); s.advance(REFRESH_MS);
  s.rpc.head.mockRejectedValue(new Error('offline'));
  const refreshing = await s.directory.read(); expect(refreshing.body.asOfBlockNumber).toBe(old.body.asOfBlockNumber);
  await s.directory.idle(); const after = await s.directory.read(); expect(after.phase).toBe('stale'); expect(after.etag).toBe(old.etag);
  await s.directory.close();
});
test('source upgrade and anchor reorg discard an already-published directory', async () => {
  for (const message of ['privacy_relayer_source_changed', 'privacy_relayer_reorg']) {
    const s = setup(); await ready(s); s.advance(REFRESH_MS); s.rpc.assertSource.mockRejectedValue(new Error(message));
    await s.directory.read(); await s.directory.idle(); expect((await s.directory.read()).status).toBe(503); await s.directory.close();
  }
});
test('large backfill is bounded to sixteen chunks before yielding', async () => {
  const s = setup({ candidates: [], end: DEPLOYMENT_BLOCK + RANGE * (MAX_CHUNKS + 1) });
  await s.directory.read(); await s.directory.idle(); expect(s.rpc.events).toHaveBeenCalledTimes(MAX_CHUNKS); expect(s.inspect).not.toHaveBeenCalled();
  await s.tick(); expect((await s.directory.read()).status).toBe(200); await s.directory.close();
});
test('candidate capacity overflow is explicit and never silently truncates', async () => {
  const candidates = Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({ ensName: `relay${i}.eth`, ensHash: namehash(`relay${i}.eth`), registeredAddress: owner }));
  const s = setup({ candidates }); const res = await ready(s); expect(res.status).toBe(503); expect(s.inspect).not.toHaveBeenCalled(); await s.directory.close();
});
test('close during an awaited RPC prevents later requests and publication', async () => {
  const s = setup(); let finish; s.rpc.head.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await s.directory.read(); const closing = s.directory.close(); finish(s.header); await closing;
  expect(s.rpc.assertSource).toHaveBeenCalledTimes(1); // fake adapter calls the real beforeRequest fence before any transport.
  expect(s.rpc.events).not.toHaveBeenCalled(); expect(s.inspect).not.toHaveBeenCalled(); expect(s.timers.size).toBe(0);
  expect((await s.directory.read()).status).toBe(503);
});
test('deadline during a long RPC yields without launching the next transport', async () => {
  const s = setup(); s.rpc.head.mockImplementation(async (ctx) => { ctx.beforeRequest(); s.advance(JOB_MS); return s.header; });
  await s.directory.read(); await s.directory.idle(); expect(s.rpc.events).not.toHaveBeenCalled(); expect(s.inspect).not.toHaveBeenCalled();
  expect(s.timers.size).toBe(1); await s.directory.close();
});
test('checkpoint store checks checksum and only uses one fixed public filename', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relayer-checkpoint-'));
  try {
    const store = createRelayerCheckpointStore(dir); await store.write({ public: 'data' }); expect(await store.read()).toEqual({ public: 'data' });
    const file = path.join(dir, 'registry-checkpoint.json'); const value = JSON.parse(await fs.readFile(file, 'utf8')); value.value.public = 'changed';
    await fs.writeFile(file, JSON.stringify(value)); expect(await store.read()).toBeNull(); expect(await fs.readdir(dir)).toEqual(['registry-checkpoint.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('polling cannot bypass failure backoff or bounded continuation delay', async () => {
  const s = setup({ overrides: { head: jest.fn(async () => { throw new Error('offline'); }) } });
  await s.directory.read(); await s.directory.idle();
  await Promise.all(Array.from({ length: 10 }, () => s.directory.read()));
  expect(s.rpc.head).toHaveBeenCalledTimes(1);
  await s.tick(); expect(s.rpc.head).toHaveBeenCalledTimes(2); await s.directory.close();
  const backlog = setup({ candidates: [], end: DEPLOYMENT_BLOCK + RANGE * (MAX_CHUNKS + 1) });
  await backlog.directory.read(); await backlog.directory.idle();
  await Promise.all(Array.from({ length: 10 }, () => backlog.directory.read()));
  expect(backlog.rpc.events).toHaveBeenCalledTimes(MAX_CHUNKS); await backlog.directory.close();
});
test('provider range rejection shrinks subsequent public scans without skipping blocks', async () => {
  const s = setup({ candidates: [], end: DEPLOYMENT_BLOCK + RANGE });
  s.rpc.events.mockImplementation(async (from, to) => {
    if (to - from + 1 > RANGE / 2) throw new Error('privacy_relayer_rpc_rejected');
    return [];
  });
  await s.directory.read(); await s.directory.idle();
  expect(s.store.write).not.toHaveBeenCalled(); await s.tick();
  expect(s.rpc.events.mock.calls[1].slice(0, 2)).toEqual([DEPLOYMENT_BLOCK, DEPLOYMENT_BLOCK + RANGE / 2 - 1]);
  expect((await s.directory.read()).status).toBe(200); await s.directory.close();
});

test('checkpoint beyond current chain head resets without requesting the unavailable future block', async () => {
  const future = DEPLOYMENT_BLOCK + 100;
  const s = setup({ saved: { version: 1, source: SOURCE_ID, scannedBlock: future, scannedHash: hash, candidates: [candidate] } });
  const originalBlock = s.rpc.block.getMockImplementation();
  s.rpc.block.mockImplementation(async (number, context) => {
    if (number === future) throw new Error('privacy_relayer_missing_block');
    return originalBlock(number, context);
  });
  const res = await ready(s); expect(res.status).toBe(200);
  expect(s.rpc.events.mock.calls[0][0]).toBe(DEPLOYMENT_BLOCK);
  expect(s.rpc.block.mock.calls.some(([number]) => number === future)).toBe(false);
  await s.directory.close();
});

test('long catalogue assembly does not re-date an earlier endpoint status', async () => {
  const candidates = Array.from({ length: 72 }, (_, i) => ({ ensName: `relay${i}.eth`, ensHash: namehash(`relay${i}.eth`), registeredAddress: owner }));
  const s = setup({ candidates }); const inspect = s.inspect.getMockImplementation();
  s.inspect.mockImplementation(async (...args) => { const result = await inspect(...args); s.advance(5000); return result; });
  try {
    await s.directory.read(); await s.directory.idle();
    for (let i = 0; i < 8; i++) await s.tick();
    const res = await s.directory.read(); expect(res.status).toBe(200); expect(res.phase).toBe('stale');
    expect(res.body.observedAt - res.body.relayers[0].statusObservedAt).toBeGreaterThan(REFRESH_MS);
  } finally { await s.directory.close(); }
});
