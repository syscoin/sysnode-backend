'use strict';

const { createHash } = require('crypto');
const { performance } = require('perf_hooks');
const { getPool, MAX_LEAVES } = require('./privacyRegistry');
const { createPrivacyRpc } = require('./privacyRpc');
const { createPrivacyStore } = require('./privacyStore');

// One process-wide queue. Only a request can enqueue work; no boot-time RPC,
// timers, wallet records or account-specific queries are involved.
function createPrivacyIndex({ rpc, store = createPrivacyStore(), now = Date.now,
  chunkBlocks = 5000, maxChunks = 16, jobBudgetMs = 45000,
  refreshMs = 60000, retryMs = 30000, log = () => {} } = {}) {
  if (!rpc) throw new Error('privacy_rpc_required');
  const states = new Map();
  const queue = [];
  let running = null;
  async function stateFor(pool) {
    if (!states.has(pool.id)) {
      const state = { snapshot: null, encoded: null, etag: null, checkpoint: null,
        candidate: null, syncing: false, retryAt: 0, error: false };
      state.loaded = Promise.all([store.load(pool.id, 'snapshot'), store.load(pool.id, 'checkpoint')])
        .then(([snapshot, checkpoint]) => { state.candidate = snapshot; state.checkpoint = checkpoint; });
      states.set(pool.id, state);
    }
    const state = states.get(pool.id);
    await state.loaded;
    return state;
  }
  function publish(state, snapshot) {
    state.snapshot = snapshot;
    state.encoded = JSON.stringify(snapshot);
    state.etag = `"${createHash('sha256').update(state.encoded).digest('hex')}"`;
    state.candidate = null;
  }
  async function reset(pool, state) {
    state.snapshot = state.candidate = state.checkpoint = state.encoded = state.etag = null;
    await store.remove(pool.id, 'snapshot');
    await store.remove(pool.id, 'checkpoint');
  }
  async function verifySaved(pool, snapshot, head) {
    if (snapshot.asOfBlockNumber > head.number) throw new Error('privacy_reorg');
    const header = await rpc.block(snapshot.asOfBlockNumber);
    if (header.hash !== snapshot.asOfBlockHash) throw new Error('privacy_reorg');
    const observed = await rpc.state(pool, header);
    if (observed.nextIndex !== snapshot.leafCount || observed.root !== snapshot.root) throw new Error('privacy_reorg');
  }
  async function sync(pool, state) {
    const deadline = performance.now() + jobBudgetMs;
    try {
      const head = await rpc.head();
      if (head.number < pool.deploymentBlock) throw new Error('privacy_pool_not_deployed');
      // In-memory snapshots are also checked before extending. On restart the
      // saved snapshot is withheld until this independent canonical read passes.
      const saved = state.snapshot || state.candidate;
      if (saved) {
        await verifySaved(pool, saved, head);
        if (!state.snapshot) publish(state, saved);
      }
      let checkpoint = state.checkpoint;
      if (checkpoint && state.snapshot && checkpoint.targetBlock < state.snapshot.asOfBlockNumber) checkpoint = null;
      if (checkpoint) {
        if (checkpoint.targetBlock > head.number ||
            (await rpc.block(checkpoint.targetBlock)).hash !== checkpoint.targetHash ||
            (checkpoint.scannedBlock >= pool.deploymentBlock &&
             (await rpc.block(checkpoint.scannedBlock)).hash !== checkpoint.scannedHash)) throw new Error('privacy_reorg');
      } else if (state.snapshot && state.snapshot.asOfBlockNumber === head.number) {
        state.error = false;
        state.retryAt = now() + refreshMs;
        return;
      } else {
        checkpoint = {
          version: 1, poolAddress: pool.address,
          scannedBlock: state.snapshot?.asOfBlockNumber ?? pool.deploymentBlock - 1,
          scannedHash: state.snapshot?.asOfBlockHash ?? null,
          targetBlock: head.number, targetHash: head.hash,
          leaves: state.snapshot ? state.snapshot.leaves.slice() : [],
        };
      }
      state.checkpoint = checkpoint;
      const target = await rpc.block(checkpoint.targetBlock);
      if (target.hash !== checkpoint.targetHash) throw new Error('privacy_reorg');
      const expected = await rpc.state(pool, target);
      if (checkpoint.leaves.length > expected.nextIndex) throw new Error('privacy_index_gap');
      let blockSpan = Math.min(checkpoint.blockSpan || chunkBlocks, chunkBlocks);
      for (let chunk = 0; checkpoint.scannedBlock < target.number && chunk < maxChunks && performance.now() < deadline; chunk++) {
        const from = checkpoint.scannedBlock + 1;
        let to, boundary, rows;
        for (;;) {
          to = Math.min(target.number, from + blockSpan - 1);
          boundary = await rpc.block(to);
          try { rows = await rpc.deposits(pool, from, to); break; }
          catch (error) {
            // Read-only provider size/range limits can be retried on a smaller
            // public range. The job deadline and a one-block floor bound this.
            if (!['privacy_rpc_unavailable', 'privacy_rpc_rejected', 'privacy_logs_too_large'].includes(error.message) ||
                to === from || performance.now() >= deadline) throw error;
            blockSpan = Math.max(1, Math.floor((to - from + 1) / 2));
          }
        }
        // Validate the complete chunk before mutating its checkpoint.
        let next = checkpoint.leaves.length;
        let previous = null;
        for (const row of rows) {
          if (row.leafIndex !== next || next >= expected.nextIndex || next >= MAX_LEAVES ||
              (previous && row.blockNumber === previous.blockNumber && row.logIndex <= previous.logIndex) ||
              (row.blockNumber === boundary.number && row.blockHash !== boundary.hash)) throw new Error('privacy_index_gap');
          previous = row; next++;
        }
        await rpc.assertBlock(boundary);
        checkpoint.leaves.push(...rows.map((row) => row.leaf));
        checkpoint.scannedBlock = to;
        checkpoint.scannedHash = boundary.hash;
        checkpoint.blockSpan = blockSpan;
      }
      // A reorg during any read cannot publish a mixed-fork view.
      await rpc.assertBlock(target);
      if (checkpoint.scannedBlock === target.number) {
        if (checkpoint.leaves.length !== expected.nextIndex) throw new Error('privacy_index_gap');
        const snapshot = { version: 1, chainId: 1, poolAddress: pool.address,
          asOfBlockNumber: target.number, asOfBlockHash: target.hash,
          leafCount: checkpoint.leaves.length, root: expected.root, leaves: checkpoint.leaves };
        // The root comes from the pool at this exact block. Wallets must rebuild
        // MiMC independently before trusting these public RPC-provided leaves.
        await store.save(pool.id, 'snapshot', snapshot);
        publish(state, snapshot);
        state.checkpoint = null;
        await store.remove(pool.id, 'checkpoint');
        state.retryAt = now() + refreshMs;
      } else {
        await store.save(pool.id, 'checkpoint', checkpoint);
        state.retryAt = 0; // the next explicit poll may advance another bounded job
      }
      state.error = false;
    } catch (error) {
      if (error.message === 'privacy_reorg') await reset(pool, state);
      if (error.message === 'privacy_index_gap') {
        // Missing new logs invalidate only unfinished work. A previously
        // checked complete snapshot remains a useful, explicitly stale view.
        state.checkpoint = null;
        await store.remove(pool.id, 'checkpoint');
      }
      state.error = true;
      state.retryAt = now() + retryMs;
      log('privacy_sync_failed', { poolId: pool.id, code: /^privacy_[a-z_]+$/.test(error.message) ? error.message : 'privacy_index_unavailable' });
    }
  }
  function enqueue(pool, state) {
    if (state.syncing || now() < state.retryAt) return;
    state.syncing = true;
    queue.push({ pool, state });
    if (running) return;
    running = (async () => {
      while (queue.length) {
        const next = queue.shift();
        try { await sync(next.pool, next.state); }
        catch (_) { next.state.error = true; next.state.retryAt = now() + retryMs; }
        finally { next.state.syncing = false; }
      }
    })().finally(() => { running = null; });
  }
  async function read(id) {
    const pool = getPool(id);
    if (!pool) return { status: 404, body: { error: 'unknown_privacy_pool' } };
    let state;
    try { state = await stateFor(pool); }
    catch (_) { return { status: 503, body: { error: 'privacy_index_unavailable' } }; }
    enqueue(pool, state);
    if (state.snapshot) return { status: 200, body: state.snapshot, encoded: state.encoded, etag: state.etag,
      phase: state.error ? 'stale' : state.syncing ? 'refreshing' : 'ready' };
    if (state.error) return { status: 503, body: { error: 'privacy_index_unavailable' } };
    return { status: 202, body: { phase: 'syncing', scannedBlock: state.checkpoint?.scannedBlock ?? pool.deploymentBlock - 1,
      startBlock: pool.deploymentBlock, targetBlock: state.checkpoint?.targetBlock ?? pool.deploymentBlock - 1 } };
  }
  return { read, whenIdle: () => running || Promise.resolve() };
}

function configuredPrivacyIndex({ enabled = process.env.PRIVACY_INDEX_ENABLED,
  rpcUrl = process.env.PRIVACY_INDEX_RPC_URL, ...options } = {}) {
  if (enabled !== undefined && enabled !== '' && enabled !== 'true' && enabled !== 'false') throw new Error('PRIVACY_INDEX_ENABLED_invalid');
  if (enabled !== 'true') return null;
  if (!rpcUrl) throw new Error('PRIVACY_INDEX_RPC_URL_required');
  return createPrivacyIndex({ rpc: createPrivacyRpc(rpcUrl), ...options });
}

module.exports = { createPrivacyIndex, configuredPrivacyIndex };
