'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createPrivacyIndex, configuredPrivacyIndex } = require('../lib/privacyIndex');
const { createPrivacyStore } = require('../lib/privacyStore');
const { POOLS } = require('../lib/privacyRegistry');

const pool = POOLS[0];
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
function fixture({ count = 3, blocks = 4 } = {}) {
  const start = pool.deploymentBlock;
  const state = { height: start + blocks - 1, fork: 0, fail: false, gap: false, extra: false, reads: 0, active: 0, peak: 0 };
  const header = (n) => ({ number: n, hash: word(n + state.fork * 100000000), parentHash: word(n - 1), timestamp: 1700000000 });
  const deposits = Array.from({ length: count }, (_, i) => ({ leaf: word(i + 1), leafIndex: i,
    blockNumber: start + i, blockHash: header(start + i).hash, txHash: word(i + 100), txIndex: 0, logIndex: i }));
  const rpc = {
    async head() { state.reads++; if (state.fail) throw new Error('privacy_rpc_unavailable'); return header(state.height); },
    async block(n) { if (state.fail) throw new Error('privacy_rpc_unavailable'); return header(n); },
    async assertBlock(h) { if (h.hash !== header(h.number).hash) throw new Error('privacy_reorg'); },
    async state(_pool, h) { return { nextIndex: deposits.filter((d) => d.blockNumber <= h.number).length, root: word(1234) }; },
    async deposits(_pool, from, to) {
      state.active++; state.peak = Math.max(state.peak, state.active);
      await new Promise((resolve) => setImmediate(resolve));
      state.active--;
      const rows = deposits.filter((d) => d.blockNumber >= from && d.blockNumber <= to);
      return state.gap ? rows.filter((d) => d.leafIndex !== 1) : rows;
    },
  };
  return { rpc, state, deposits, header };
}

describe('public privacy index lifecycle', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-index-test-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const setup = (dir, rpc, extra = {}) => createPrivacyIndex({ rpc, store: createPrivacyStore(dir), refreshMs: 0, retryMs: 0, ...extra });

  test('disabled config performs no RPC or file IO and opt-in validates configuration', () => {
    expect(configuredPrivacyIndex({ enabled: 'false', rpcUrl: 'broken' })).toBeNull();
    expect(() => configuredPrivacyIndex({ enabled: 'true', rpcUrl: '' })).toThrow('PRIVACY_INDEX_RPC_URL_required');
    expect(() => configuredPrivacyIndex({ enabled: 'yes' })).toThrow('PRIVACY_INDEX_ENABLED_invalid');
    expect(() => configuredPrivacyIndex({ enabled: 'true', rpcUrl: 'http://localhost' })).toThrow('privacy_rpc_url_invalid');
  });

  test('returns progress first and only publishes complete pinned snapshots', async () => {
    const f = fixture(); const index = setup(dir, f.rpc, { chunkBlocks: 1, maxChunks: 2 });
    expect(f.state.reads).toBe(0);
    expect((await index.read(pool.id)).status).toBe(202);
    await index.whenIdle();
    const progress = await index.read(pool.id);
    expect(progress.status).toBe(202);
    expect(progress.body.scannedBlock).toBe(pool.deploymentBlock + 1);
    await index.whenIdle();
    const ready = await index.read(pool.id); await index.whenIdle();
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ version: 1, chainId: 1, poolAddress: pool.address,
      asOfBlockNumber: f.state.height, asOfBlockHash: f.header(f.state.height).hash,
      leafCount: 3, root: word(1234), leaves: [word(1), word(2), word(3)] });
  });

  test('simultaneous polls share one job, and other pools cannot run RPC scans in parallel', async () => {
    const f = fixture({ count: 0 }); const index = setup(dir, f.rpc);
    await Promise.all(Array.from({ length: 20 }, () => index.read(pool.id)));
    await index.whenIdle();
    expect(f.state.reads).toBe(1); expect(f.state.peak).toBe(1);
    await Promise.all(POOLS.map((p) => index.read(p.id))); await index.whenIdle();
    expect(f.state.peak).toBe(1);
  });

  test('checkpoint survives restart; saved snapshot is withheld until revalidated', async () => {
    const f = fixture(); const index = setup(dir, f.rpc, { chunkBlocks: 1, maxChunks: 2 });
    await index.read(pool.id); await index.whenIdle();
    const resumed = setup(dir, f.rpc, { chunkBlocks: 1, maxChunks: 2 });
    expect((await resumed.read(pool.id)).status).toBe(202); await resumed.whenIdle();
    expect((await resumed.read(pool.id)).status).toBe(200); await resumed.whenIdle();
    const restarted = setup(dir, f.rpc);
    expect((await restarted.read(pool.id)).status).toBe(202); await restarted.whenIdle();
    expect((await restarted.read(pool.id)).status).toBe(200); await restarted.whenIdle();
  });

  test('provider range limits shrink the public scan range without losing progress', async () => {
    const f = fixture({ blocks: 16 });
    const original = f.rpc.deposits;
    f.rpc.deposits = jest.fn(async (p, from, to) => {
      if (to - from + 1 > 2) throw new Error('privacy_rpc_unavailable');
      return original(p, from, to);
    });
    const index = setup(dir, f.rpc, { maxChunks: 8 });
    await index.read(pool.id); await index.whenIdle();
    const ready = await index.read(pool.id); await index.whenIdle();
    expect(ready.status).toBe(200); expect(ready.body.leafCount).toBe(3);
    expect(f.rpc.deposits.mock.calls.length).toBeGreaterThan(8);
  });

  test('incomplete gaps are never served as a complete tree and resets are persistent', async () => {
    const f = fixture(); f.state.gap = true; const index = setup(dir, f.rpc);
    await index.read(pool.id); await index.whenIdle();
    expect((await index.read(pool.id)).status).toBe(503); await index.whenIdle();
    expect(await createPrivacyStore(dir).load(pool.id, 'checkpoint')).toBeNull();
    expect(await createPrivacyStore(dir).load(pool.id, 'snapshot')).toBeNull();
  });

  test('missing trailing deposit fails final count despite contiguous earlier indices', async () => {
    const f = fixture(); const original = f.rpc.deposits;
    f.rpc.deposits = async (...args) => (await original(...args)).filter((r) => r.leafIndex !== 2);
    const index = setup(dir, f.rpc); await index.read(pool.id); await index.whenIdle();
    expect((await index.read(pool.id)).status).toBe(503); await index.whenIdle();
  });

  test('refresh failure retains only the old complete snapshot with a stale marker', async () => {
    const f = fixture(); const index = setup(dir, f.rpc);
    await index.read(pool.id); await index.whenIdle();
    const previous = await index.read(pool.id); await index.whenIdle();
    f.state.fail = true; await index.read(pool.id); await index.whenIdle();
    const stale = await index.read(pool.id); await index.whenIdle();
    expect(stale.status).toBe(200); expect(stale.phase).toBe('stale');
    expect(stale.body).toEqual(previous.body); expect(stale.etag).toBe(previous.etag);
    const restarted = setup(dir, f.rpc);
    await restarted.read(pool.id); await restarted.whenIdle();
    expect((await restarted.read(pool.id)).status).toBe(503); await restarted.whenIdle();
  });

  test('a gap in refreshed logs retains the previous complete canonical snapshot', async () => {
    const f = fixture(); const index = setup(dir, f.rpc);
    await index.read(pool.id); await index.whenIdle();
    const old = await index.read(pool.id); await index.whenIdle();
    f.state.height += 2;
    f.deposits.push({ leaf: word(99), leafIndex: 3, blockNumber: f.state.height,
      blockHash: f.header(f.state.height).hash, txHash: word(999), txIndex: 0, logIndex: 0 });
    const original = f.rpc.deposits;
    f.rpc.deposits = async (...args) => (await original(...args)).filter((r) => r.leafIndex !== 3);
    await index.read(pool.id); await index.whenIdle();
    const stale = await index.read(pool.id); await index.whenIdle();
    expect(stale.status).toBe(200); expect(stale.phase).toBe('stale'); expect(stale.body).toEqual(old.body);
  });

  test('ready snapshot and checkpoints are discarded when their anchor reorgs', async () => {
    const f = fixture(); const index = setup(dir, f.rpc);
    await index.read(pool.id); await index.whenIdle();
    f.state.fork = 1; await index.read(pool.id); await index.whenIdle();
    expect(await createPrivacyStore(dir).load(pool.id, 'snapshot')).toBeNull();
    expect((await index.read(pool.id)).status).toBe(503); await index.whenIdle();
  });

  test('an in-flight target reorg cannot publish a mixed-fork snapshot', async () => {
    const f = fixture(); const original = f.rpc.deposits;
    f.rpc.deposits = async (...args) => { const rows = await original(...args); f.state.fork = 1; return rows; };
    const index = setup(dir, f.rpc); await index.read(pool.id); await index.whenIdle();
    expect(await createPrivacyStore(dir).load(pool.id, 'snapshot')).toBeNull();
  });

  test('corrupt cache is rebuilt and only allowlisted IDs can become file names', async () => {
    await fs.writeFile(path.join(dir, `${pool.id}.snapshot.json`), '{broken');
    const f = fixture(); const index = setup(dir, f.rpc);
    expect((await index.read('../../anything')).status).toBe(404);
    expect(f.state.reads).toBe(0);
    await index.read(pool.id); await index.whenIdle();
    expect((await index.read(pool.id)).status).toBe(200); await index.whenIdle();
    await expect(createPrivacyStore(dir).save('../escape', 'snapshot', {})).rejects.toThrow('privacy_unknown_pool');
  });

  test.each(['null', '{}', '[]', '{"sha256":0,"value":{}}', '{"sha256":"bad","value":{}}'])('malformed JSON envelope %s is discarded and rebuilt', async (body) => {
    await fs.writeFile(path.join(dir, `${pool.id}.snapshot.json`), body);
    const index = setup(dir, fixture().rpc);
    expect((await index.read(pool.id)).status).toBe(202); await index.whenIdle();
    expect((await index.read(pool.id)).status).toBe(200); await index.whenIdle();
  });

  test('a new finalized target does not replace a ready snapshot with partial refresh data', async () => {
    const f = fixture(); const index = setup(dir, f.rpc, { chunkBlocks: 1, maxChunks: 4 });
    await index.read(pool.id); await index.whenIdle();
    const old = await index.read(pool.id); await index.whenIdle();
    f.state.height += 10;
    await index.read(pool.id); await index.whenIdle();
    const stillReady = await index.read(pool.id); await index.whenIdle();
    expect(stillReady.status).toBe(200); expect(stillReady.body).toEqual(old.body);
  });
});
