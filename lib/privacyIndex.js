'use strict';

const { createHash } = require('crypto');
const { performance } = require('perf_hooks');
const { getPool, MAX_LEAVES, fieldWord } = require('./privacyRegistry');
const { createPrivacyRpc } = require('./privacyRpc');
const { createPrivacyStore } = require('./privacyStore');

// One process-wide queue. A public request activates a pool durably; only those
// pools resume after restart and receive subsequent bounded background refresh.
function createPrivacyIndex({ rpc, store = createPrivacyStore(), now = Date.now,
  chunkBlocks = 5000, maxChunks = 16, jobBudgetMs = 45000,
  refreshMs = 60000, retryMs = 30000, continueMs = 1000,
  autoStart = true, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  log = () => {} } = {}) {
  if (!rpc) throw new Error('privacy_rpc_required');
  for (const [value, cap] of [[chunkBlocks, 5000], [maxChunks, 16], [jobBudgetMs, 45000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new Error('privacy_invalid_work_limit');
  }
  const states = new Map();
  const active = new Set();
  const queue = [];
  let running = null;
  let startup = Promise.resolve();
  let timer = null;
  let started = false;
  let closed = false;
  let restoreFailed = false;
  async function stateFor(pool) {
    if (!states.has(pool.id)) {
      const state = { snapshot: null, encoded: null, etag: null, checkpoint: null,
        candidate: null, syncing: false, retryAt: 0, error: false };
      state.loaded = Promise.all([store.load(pool.id, 'snapshot'), store.load(pool.id, 'checkpoint')])
        .then(([snapshot, checkpoint]) => { state.candidate = snapshot; state.checkpoint = checkpoint; })
        .catch((error) => { states.delete(pool.id); throw error; });
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
  async function verifySaved(pool, snapshot, head, jobRpc) {
    if (snapshot.asOfBlockNumber > head.number) throw new Error('privacy_reorg');
    const header = await jobRpc.block(snapshot.asOfBlockNumber);
    if (header.hash !== snapshot.asOfBlockHash) throw new Error('privacy_reorg');
    const observed = await jobRpc.state(pool, header);
    if (observed.nextIndex !== snapshot.leafCount || observed.root !== snapshot.root) throw new Error('privacy_reorg');
  }
  async function sync(pool, state) {
    const deadline = performance.now() + jobBudgetMs;
    const beforeRequest = () => {
      if (closed) throw new Error('privacy_index_closed');
      if (performance.now() >= deadline) throw new Error('privacy_budget_exhausted');
    };
    const jobRpc = Object.fromEntries(['head', 'block', 'state', 'events', 'assertBlock'].map((name) => [name, (...args) => {
      beforeRequest();
      return rpc[name](...args, { beforeRequest });
    }]));
    try {
      const head = await jobRpc.head();
      if (head.number < pool.deploymentBlock) throw new Error('privacy_pool_not_deployed');
      // In-memory snapshots are also checked before extending. On restart the
      // saved snapshot is withheld until this independent canonical read passes.
      const saved = state.snapshot || state.candidate;
      if (saved) {
        await verifySaved(pool, saved, head, jobRpc);
        if (!state.snapshot) publish(state, saved);
      }
      let checkpoint = state.checkpoint;
      if (checkpoint && state.snapshot && checkpoint.targetBlock < state.snapshot.asOfBlockNumber) checkpoint = null;
      if (checkpoint) {
        if (checkpoint.targetBlock > head.number ||
            (await jobRpc.block(checkpoint.targetBlock)).hash !== checkpoint.targetHash ||
            (checkpoint.scannedBlock >= pool.deploymentBlock &&
             (await jobRpc.block(checkpoint.scannedBlock)).hash !== checkpoint.scannedHash)) throw new Error('privacy_reorg');
      } else if (state.snapshot && state.snapshot.asOfBlockNumber === head.number) {
        state.error = false;
        state.retryAt = now() + refreshMs;
        return;
      } else {
        checkpoint = {
          version: 2, poolAddress: pool.address,
          scannedBlock: state.snapshot?.asOfBlockNumber ?? pool.deploymentBlock - 1,
          scannedHash: state.snapshot?.asOfBlockHash ?? null,
          targetBlock: head.number, targetHash: head.hash,
          leaves: state.snapshot ? state.snapshot.leaves.slice() : [],
          withdrawnNullifiers: state.snapshot ? state.snapshot.withdrawnNullifiers.slice() : [],
        };
      }
      state.checkpoint = checkpoint;
      const target = await jobRpc.block(checkpoint.targetBlock);
      if (target.hash !== checkpoint.targetHash) throw new Error('privacy_reorg');
      const expected = await jobRpc.state(pool, target);
      if (checkpoint.leaves.length > expected.nextIndex) throw new Error('privacy_index_gap');
      const leafSet = new Set(checkpoint.leaves);
      const withdrawnSet = new Set(checkpoint.withdrawnNullifiers);
      let blockSpan = Math.min(checkpoint.blockSpan || state.blockSpan || chunkBlocks, chunkBlocks);
      let sparseChunks = 0;
      for (let chunk = 0; !closed && checkpoint.scannedBlock < target.number && chunk < maxChunks && performance.now() < deadline; chunk++) {
        const from = checkpoint.scannedBlock + 1;
        let to, boundary, rows;
        for (;;) {
          to = Math.min(target.number, from + blockSpan - 1);
          boundary = await jobRpc.block(to);
          try { rows = await jobRpc.events(pool, from, to); break; }
          catch (error) {
            // Read-only provider size/range limits can be retried on a smaller
            // public range. The job deadline and a one-block floor bound this.
            if (!['privacy_rpc_unavailable', 'privacy_rpc_rejected', 'privacy_logs_too_large'].includes(error.message) ||
                to === from || performance.now() >= deadline) throw error;
            blockSpan = Math.max(1, Math.floor((to - from + 1) / 2));
            sparseChunks = 0;
          }
        }
        // Validate the complete chunk before mutating its checkpoint.
        let next = checkpoint.leaves.length;
        let previous = null;
        const leaves = [], nullifiers = [];
        for (const row of rows) {
          if (row.blockNumber < from || row.blockNumber > to ||
              (previous && (row.blockNumber < previous.blockNumber ||
                (row.blockNumber === previous.blockNumber && (row.logIndex <= previous.logIndex ||
                  row.txIndex < previous.txIndex || row.blockHash !== previous.blockHash ||
                  (row.txIndex === previous.txIndex && row.txHash !== previous.txHash))))) ||
              (row.blockNumber === boundary.number && row.blockHash !== boundary.hash)) throw new Error('privacy_index_gap');
          if (row.kind === 'deposit') {
            fieldWord(row.leaf);
            if (row.leafIndex !== next || next >= expected.nextIndex || next >= MAX_LEAVES || leafSet.has(row.leaf)) throw new Error('privacy_index_gap');
            leafSet.add(row.leaf); leaves.push(row.leaf); next++;
          } else if (row.kind === 'withdrawal') {
            fieldWord(row.nullifierHash);
            if (withdrawnSet.has(row.nullifierHash) || withdrawnSet.size >= next) throw new Error('privacy_index_gap');
            withdrawnSet.add(row.nullifierHash); nullifiers.push(row.nullifierHash);
          } else throw new Error('privacy_index_gap');
          previous = row;
        }
        await jobRpc.assertBlock(boundary);
        checkpoint.leaves.push(...leaves);
        checkpoint.withdrawnNullifiers.push(...nullifiers);
        checkpoint.scannedBlock = to;
        checkpoint.scannedHash = boundary.hash;
        sparseChunks = rows.length <= 128 && to - from + 1 === blockSpan ? sparseChunks + 1 : 0;
        if (sparseChunks >= 3) { blockSpan = Math.min(chunkBlocks, blockSpan * 2); sparseChunks = 0; }
        checkpoint.blockSpan = state.blockSpan = blockSpan;
      }
      // A reorg during any read cannot publish a mixed-fork view.
      await jobRpc.assertBlock(target);
      if (checkpoint.scannedBlock === target.number) {
        if (checkpoint.leaves.length !== expected.nextIndex) throw new Error('privacy_index_gap');
        const snapshot = { version: 1, chainId: 1, poolAddress: pool.address,
          asOfBlockNumber: target.number, asOfBlockHash: target.hash,
          leafCount: checkpoint.leaves.length, root: expected.root, leaves: checkpoint.leaves,
          withdrawnNullifiers: checkpoint.withdrawnNullifiers };
        // The root comes from the pool at this exact block. Wallets must rebuild
        // MiMC independently before trusting these public RPC-provided leaves.
        // That root does NOT authenticate completeness of the withdrawal feed.
        await store.save(pool.id, 'snapshot', snapshot);
        publish(state, snapshot);
        state.checkpoint = null;
        await store.remove(pool.id, 'checkpoint');
        state.retryAt = now() + refreshMs;
      } else {
        await store.save(pool.id, 'checkpoint', checkpoint);
        state.retryAt = now() + continueMs;
      }
      state.error = false;
    } catch (error) {
      if (['privacy_budget_exhausted', 'privacy_index_closed'].includes(error.message)) {
        if (state.checkpoint) await store.save(pool.id, 'checkpoint', state.checkpoint);
        state.retryAt = now() + continueMs;
        return;
      }
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
    if (closed || state.syncing || now() < state.retryAt) return;
    state.syncing = true;
    queue.push({ pool, state });
    if (running) return;
    running = (async () => {
      while (!closed && queue.length) {
        const next = queue.shift();
        try { await sync(next.pool, next.state); }
        catch (_) { next.state.error = true; next.state.retryAt = now() + retryMs; }
        finally { next.state.syncing = false; }
      }
    })().finally(() => { running = null; scheduleNext(); });
  }
  async function activate(pool, state) {
    if (!state.activation) state.activation = store.activate(pool.id).then(() => { active.add(pool.id); })
      .catch((error) => { state.activation = null; throw error; });
    await state.activation;
  }
  function scheduleNext() {
    if (timer) { clearTimeoutImpl(timer); timer = null; }
    if (!started || closed || running || (!active.size && !restoreFailed)) return;
    const wait = restoreFailed ? retryMs : Math.min(...[...active].map((id) => Math.max(0, (states.get(id)?.retryAt || 0) - now())));
    timer = setTimeoutImpl(() => { timer = null; return tick(); }, Math.max(1, wait));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  async function restore() {
    for (const id of await store.listActive()) {
      const pool = getPool(id);
      if (!pool || closed) continue;
      const state = await stateFor(pool);
      await activate(pool, state);
      enqueue(pool, state);
    }
    restoreFailed = false;
  }
  async function tick() {
    if (closed) return;
    try {
      if (restoreFailed) await restore();
      for (const id of active) enqueue(getPool(id), await stateFor(getPool(id)));
    } catch (_) { restoreFailed = true; log('privacy_resume_failed', { code: 'privacy_storage_unavailable' }); }
    finally { scheduleNext(); }
  }
  function start() {
    if (started || closed) return startup;
    started = true;
    startup = restore().catch(() => { restoreFailed = true; log('privacy_resume_failed', { code: 'privacy_storage_unavailable' }); })
      .finally(scheduleNext);
    return startup;
  }
  async function read(id) {
    if (closed) return { status: 503, body: { error: 'privacy_index_closed' } };
    const pool = getPool(id);
    if (!pool) return { status: 404, body: { error: 'unknown_privacy_pool' } };
    let state;
    try { await startup; state = await stateFor(pool); await activate(pool, state); }
    catch (_) { return { status: 503, body: { error: 'privacy_index_unavailable' } }; }
    enqueue(pool, state);
    if (state.snapshot) return { status: 200, body: state.snapshot, encoded: state.encoded, etag: state.etag,
      phase: state.error ? 'stale' : state.syncing ? 'refreshing' : 'ready' };
    if (state.error) return { status: 503, body: { error: 'privacy_index_unavailable' } };
    return { status: 202, body: { phase: 'syncing', scannedBlock: state.checkpoint?.scannedBlock ?? pool.deploymentBlock - 1,
      startBlock: pool.deploymentBlock, targetBlock: state.checkpoint?.targetBlock ?? pool.deploymentBlock - 1 } };
  }
  async function whenIdle() { await startup; while (running) await running; }
  async function close() {
    closed = true;
    if (timer) { clearTimeoutImpl(timer); timer = null; }
    for (const item of queue.splice(0)) item.state.syncing = false;
    await whenIdle();
  }
  if (autoStart) start();
  return { read, whenIdle, start, tick, close };
}

function configuredPrivacyIndex({ enabled = process.env.PRIVACY_INDEX_ENABLED,
  rpcUrl = process.env.PRIVACY_INDEX_RPC_URL, ...options } = {}) {
  if (enabled !== undefined && enabled !== '' && enabled !== 'true' && enabled !== 'false') throw new Error('PRIVACY_INDEX_ENABLED_invalid');
  if (enabled === 'false') return null;
  if (!rpcUrl) {
    if (enabled === 'true') throw new Error('PRIVACY_INDEX_RPC_URL_required');
    return null;
  }
  return createPrivacyIndex({ rpc: createPrivacyRpc(rpcUrl), ...options });
}

module.exports = { createPrivacyIndex, configuredPrivacyIndex };
