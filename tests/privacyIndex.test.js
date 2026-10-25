'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyIndex, configuredPrivacyIndex } = require('../lib/privacyIndex');
const { createPrivacyStore } = require('../lib/privacyStore');
const { POOLS } = require('../lib/privacyRegistry');
const { createPrivacyRpc, ABI } = require('../lib/privacyRpc');

const pool = POOLS[0];
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
function fixture({ count = 3, blocks = 4 } = {}) {
  const start = pool.deploymentBlock;
  const state = { height: start + blocks - 1, fork: 0, fail: false, gap: false, extra: false, reads: 0, active: 0, peak: 0 };
  const header = (n) => ({ number: n, hash: word(n + state.fork * 100000000), parentHash: word(n - 1), timestamp: 1700000000 });
  const deposits = Array.from({ length: count }, (_, i) => ({ kind: 'deposit', leaf: word(i + 1), leafIndex: i,
    blockNumber: start + i, blockHash: header(start + i).hash, txHash: word(i + 100), txIndex: 0, logIndex: i }));
  const withdrawals = [];
  const rpc = {
    async head() { state.reads++; if (state.fail) throw new Error('privacy_rpc_unavailable'); return header(state.height); },
    async block(n) { if (state.fail) throw new Error('privacy_rpc_unavailable'); return header(n); },
    async assertBlock(h) { if (h.hash !== header(h.number).hash) throw new Error('privacy_reorg'); },
    async state(_pool, h) { return { nextIndex: deposits.filter((d) => d.blockNumber <= h.number).length, root: word(1234) }; },
    async events(_pool, from, to) {
      state.active++; state.peak = Math.max(state.peak, state.active);
      await new Promise((resolve) => setImmediate(resolve));
      state.active--;
      const rows = [...deposits, ...withdrawals].filter((d) => d.blockNumber >= from && d.blockNumber <= to).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
      return state.gap ? rows.filter((d) => d.leafIndex !== 1) : rows;
    },
  };
  return { rpc, state, deposits, withdrawals, header };
}

describe('public privacy index lifecycle', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-index-test-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const setup = (dir, rpc, extra = {}) => createPrivacyIndex({ rpc, store: createPrivacyStore(dir), autoStart: false, refreshMs: 0, retryMs: 0, continueMs: 0, ...extra });

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
      leafCount: 3, root: word(1234), leaves: [word(1), word(2), word(3)], withdrawnNullifiers: [] });
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
    const original = f.rpc.events;
    f.rpc.events = jest.fn(async (p, from, to) => {
      if (to - from + 1 > 2) throw new Error('privacy_rpc_unavailable');
      return original(p, from, to);
    });
    const index = setup(dir, f.rpc, { maxChunks: 8 });
    await index.read(pool.id); await index.whenIdle();
    const ready = await index.read(pool.id); await index.whenIdle();
    expect(ready.status).toBe(200); expect(ready.body.leafCount).toBe(3);
    expect(f.rpc.events.mock.calls.length).toBeGreaterThan(8);
  });

  test('incomplete gaps are never served as a complete tree and resets are persistent', async () => {
    const f = fixture(); f.state.gap = true; const index = setup(dir, f.rpc);
    await index.read(pool.id); await index.whenIdle();
    expect((await index.read(pool.id)).status).toBe(503); await index.whenIdle();
    expect(await createPrivacyStore(dir).load(pool.id, 'checkpoint')).toBeNull();
    expect(await createPrivacyStore(dir).load(pool.id, 'snapshot')).toBeNull();
  });

  test('missing trailing deposit fails final count despite contiguous earlier indices', async () => {
    const f = fixture(); const original = f.rpc.events;
    f.rpc.events = async (...args) => (await original(...args)).filter((r) => r.leafIndex !== 2);
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
    f.deposits.push({ kind: 'deposit', leaf: word(99), leafIndex: 3, blockNumber: f.state.height,
      blockHash: f.header(f.state.height).hash, txHash: word(999), txIndex: 0, logIndex: 0 });
    const original = f.rpc.events;
    f.rpc.events = async (...args) => (await original(...args)).filter((r) => r.leafIndex !== 3);
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
    const f = fixture(); const original = f.rpc.events;
    f.rpc.events = async (...args) => { const rows = await original(...args); f.state.fork = 1; return rows; };
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

  test('withdrawals are published with deposits at the same pinned block', async () => {
    const f = fixture();
    f.withdrawals.push({ kind: 'withdrawal', nullifierHash: word(88), blockNumber: f.state.height,
      blockHash: f.header(f.state.height).hash, txHash: word(188), txIndex: 1, logIndex: 8 });
    const index = setup(dir, f.rpc, { chunkBlocks: 1 });
    await index.read(pool.id); await index.whenIdle();
    const ready = await index.read(pool.id); await index.whenIdle();
    expect(ready.body.withdrawnNullifiers).toEqual([word(88)]);
    expect(ready.body.asOfBlockNumber).toBe(f.state.height);
  });

  test('duplicate withdrawal nullifiers across ranges cannot publish a snapshot', async () => {
    const f = fixture();
    for (const n of [pool.deploymentBlock + 1, pool.deploymentBlock + 2]) {
      f.withdrawals.push({ kind: 'withdrawal', nullifierHash: word(88), blockNumber: n,
        blockHash: f.header(n).hash, txHash: word(n), txIndex: 1, logIndex: 8 });
    }
    const index = setup(dir, f.rpc, { chunkBlocks: 1 });
    await index.read(pool.id); await index.whenIdle();
    expect((await index.read(pool.id)).status).toBe(503); await index.whenIdle();
    expect(await createPrivacyStore(dir).load(pool.id, 'snapshot')).toBeNull();
  });

  test('old deposit-only snapshots and checkpoints require a full rebuild', async () => {
    const old = { version: 1, chainId: 1, poolAddress: pool.address, asOfBlockNumber: pool.deploymentBlock + 3,
      asOfBlockHash: word(pool.deploymentBlock + 3), leafCount: 3, root: word(1234), leaves: [word(1), word(2), word(3)] };
    const oldCheckpoint = { version: 1, poolAddress: pool.address, scannedBlock: old.asOfBlockNumber,
      scannedHash: old.asOfBlockHash, targetBlock: old.asOfBlockNumber, targetHash: old.asOfBlockHash, leaves: old.leaves };
    for (const [kind, value] of [['snapshot', old], ['checkpoint', oldCheckpoint]]) {
      await fs.writeFile(path.join(dir, `${pool.id}.${kind}.json`), JSON.stringify({ value,
        sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') }));
    }
    const f = fixture();
    f.withdrawals.push({ kind: 'withdrawal', nullifierHash: word(88), blockNumber: f.state.height,
      blockHash: f.header(f.state.height).hash, txHash: word(188), txIndex: 1, logIndex: 8 });
    const index = setup(dir, f.rpc);
    expect((await index.read(pool.id)).status).toBe(202); await index.whenIdle();
    expect((await index.read(pool.id)).body.withdrawnNullifiers).toEqual([word(88)]); await index.whenIdle();
  });

  test('adaptive ranges grow back after sparse successful full ranges', async () => {
    const f = fixture({ count: 0, blocks: 30 });
    const original = f.rpc.events;
    let calls = 0;
    f.rpc.events = jest.fn(async (p, from, to) => {
      if (++calls === 1) throw new Error('privacy_rpc_rejected');
      return original(p, from, to);
    });
    const index = setup(dir, f.rpc, { chunkBlocks: 8 });
    await index.read(pool.id); await index.whenIdle();
    const spans = f.rpc.events.mock.calls.map(([, from, to]) => to - from + 1);
    expect(spans.slice(0, 5)).toEqual([8, 4, 4, 4, 8]);
  });

  function scheduler() {
    let now = 0;
    const timers = new Set();
    return { timers, now: () => now,
      setTimeoutImpl: (fn, delay) => { const t = { fn, at: now + delay, unref: jest.fn() }; timers.add(t); return t; },
      clearTimeoutImpl: (t) => timers.delete(t),
      advance: async (ms) => { now += ms; const due = [...timers].filter((t) => t.at <= now); for (const t of due) { timers.delete(t); await t.fn(); } },
    };
  }

  test('unused pools stay idle; first request enables durable periodic refresh and close stops it', async () => {
    const f = fixture(); const s = scheduler();
    const index = setup(dir, f.rpc, { ...s, autoStart: true, refreshMs: 50, continueMs: 10 });
    await index.whenIdle(); expect(f.state.reads).toBe(0); expect(s.timers.size).toBe(0);
    await index.read(pool.id); await index.whenIdle();
    expect([...s.timers][0].unref).toHaveBeenCalled();
    f.state.height++;
    f.withdrawals.push({ kind: 'withdrawal', nullifierHash: word(77), blockNumber: f.state.height,
      blockHash: f.header(f.state.height).hash, txHash: word(177), txIndex: 1, logIndex: 8 });
    await s.advance(50); await index.whenIdle();
    expect((await index.read(pool.id)).body.withdrawnNullifiers).toEqual([word(77)]);
    expect(f.state.reads).toBe(2);
    await index.close(); expect(s.timers.size).toBe(0);
    await s.advance(500); expect(f.state.reads).toBe(2);
    expect((await index.read(pool.id)).status).toBe(503);
  });

  test('restart resumes incomplete activated pools without another user request', async () => {
    const f = fixture();
    const first = setup(dir, f.rpc, { chunkBlocks: 1, maxChunks: 1 });
    await first.read(pool.id); await first.whenIdle(); await first.close();
    const s = scheduler();
    const resumed = setup(dir, f.rpc, { ...s, autoStart: true, chunkBlocks: 1, maxChunks: 1, continueMs: 10, refreshMs: 100 });
    await resumed.whenIdle();
    expect(f.state.reads).toBe(2);
    await s.advance(10); await resumed.whenIdle();
    await s.advance(10); await resumed.whenIdle();
    expect((await resumed.read(pool.id)).status).toBe(200);
    expect(await createPrivacyStore(dir).listActive()).toEqual([pool.id]);
    await resumed.close();
  });

  test('close during an in-flight read does not start another RPC or rearm a timer', async () => {
    const f = fixture(); const s = scheduler();
    let release;
    const original = f.rpc.head;
    f.rpc.head = jest.fn(async () => { await new Promise((resolve) => { release = resolve; }); return original(); });
    f.rpc.block = jest.fn(f.rpc.block);
    const index = setup(dir, f.rpc, { ...s, autoStart: true });
    await index.read(pool.id);
    const closing = index.close();
    release(); await closing;
    expect(f.rpc.block).not.toHaveBeenCalled();
    expect(s.timers.size).toBe(0);
  });

  test('the job deadline also bounds metadata reads before a scan begins', async () => {
    const f = fixture();
    f.rpc.head = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return f.header(f.state.height); };
    f.rpc.block = jest.fn(f.rpc.block);
    const index = setup(dir, f.rpc, { jobBudgetMs: 1 });
    await index.read(pool.id); await index.whenIdle();
    expect(f.rpc.block).not.toHaveBeenCalled();
    expect(await createPrivacyStore(dir).load(pool.id, 'snapshot')).toBeNull();
    await index.close();
  });

  function adapterFixture({ pauseCode = true } = {}) {
    let releaseCode, enteredCode;
    const codeEntered = new Promise((resolve) => { enteredCode = resolve; });
    const codeReleased = new Promise((resolve) => { releaseCode = resolve; });
    const calls = [];
    const post = async (_url, payload) => {
      calls.push(payload.method);
      let result;
      if (payload.method === 'eth_chainId') result = '0x1';
      else if (payload.method === 'eth_getBlockByNumber') {
        const n = payload.params[0] === 'finalized' ? pool.deploymentBlock + 3 : Number(BigInt(payload.params[0]));
        result = { number: `0x${n.toString(16)}`, hash: word(n), parentHash: word(n - 1), timestamp: '0x6553f100' };
      } else if (payload.method === 'eth_getCode') {
        enteredCode();
        if (pauseCode) await codeReleased;
        result = '0x6000';
      } else if (payload.method === 'eth_call') {
        const fn = ABI.parseTransaction(payload.params[0]).name;
        result = ABI.encodeFunctionResult(fn, [{ levels: 20, denomination: pool.denomination, nextIndex: 0, getLastRoot: word(1234) }[fn]]);
      } else if (payload.method === 'eth_getLogs') result = [];
      else throw new Error('unexpected_fixture_rpc');
      return { status: 200, data: { jsonrpc: '2.0', id: payload.id, result } };
    };
    return { rpc: createPrivacyRpc('https://archive.example', { post, now: () => 1700000000000 }),
      calls, codeEntered, releaseCode };
  }

  test('close fences nested actual-adapter requests after an in-flight eth_getCode', async () => {
    const f = adapterFixture(); const index = setup(dir, f.rpc);
    await index.read(pool.id); await f.codeEntered;
    const before = [...f.calls];
    const closing = index.close();
    f.releaseCode(); await closing;
    expect(before.at(-1)).toBe('eth_getCode');
    expect(f.calls).toEqual(before);
    expect(f.calls).not.toContain('eth_call');
    expect(await createPrivacyStore(dir).load(pool.id, 'snapshot')).toBeNull();
  });

  test('deadline fences nested actual-adapter requests after an in-flight eth_getCode', async () => {
    const f = adapterFixture(); const index = setup(dir, f.rpc, { jobBudgetMs: 200 });
    await index.read(pool.id); await f.codeEntered;
    const before = [...f.calls];
    await new Promise((resolve) => setTimeout(resolve, 225));
    f.releaseCode(); await index.whenIdle();
    expect(f.calls).toEqual(before);
    expect(f.calls).not.toContain('eth_call');
    expect(await createPrivacyStore(dir).load(pool.id, 'snapshot')).toBeNull();
    await index.close();
  });

  test('healthy actual-adapter control still reads pool state and publishes the snapshot', async () => {
    const f = adapterFixture({ pauseCode: false }); const index = setup(dir, f.rpc, { refreshMs: 60000 });
    await index.read(pool.id); await index.whenIdle();
    const ready = await index.read(pool.id); await index.whenIdle();
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ leafCount: 0, withdrawnNullifiers: [] });
    expect(f.calls.filter((method) => method === 'eth_call')).toHaveLength(4);
    expect(f.calls).toContain('eth_getLogs');
    await index.close();
  });
});
