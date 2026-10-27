'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createPrivacyRelayerRpc } = require('./privacyRelayerRpc');
const { createPrivacyRelayerStatus } = require('./privacyRelayerStatus');
const { SOURCE, DEPLOYMENT_BLOCK, MAX_CANDIDATES, candidate } = require('./privacyRelayerRegistry');
const { word } = require('./privacyRegistry');
const REFRESH_MS = 5 * 60 * 1000;
const RETRY_MS = 30000;
const JOB_MS = 45000;
const MAX_CHUNKS = 16;
const RANGE = 50000;
const MAX_FILE_BYTES = 256 * 1024;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SOURCE_ID = digest(SOURCE);

// Only the public registry scan is persisted. Endpoint observations and trust
// never survive process restart without new finalized on-chain verification.
function createRelayerCheckpointStore(directory) {
  const filename = path.join(directory, 'registry-checkpoint.json');
  return {
    async read() {
      try {
        const stat = await fs.stat(filename);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
        const envelope = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (envelope.sha256 !== digest(envelope.value)) return null;
        return envelope.value;
      } catch (_) { return null; }
    },
    async write(value) {
      const encoded = JSON.stringify({ sha256: digest(value), value });
      if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new Error('privacy_relayer_checkpoint_too_large');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = filename + '.' + randomBytes(8).toString('hex') + '.tmp';
      let file;
      try {
        file = await fs.open(temporary, 'wx', 0o600); await file.writeFile(encoded); await file.sync(); await file.close(); file = null;
        await fs.rename(temporary, filename);
        const dir = await fs.open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      } finally { if (file) await file.close(); await fs.rm(temporary, { force: true }); }
    },
  };
}
function validCheckpoint(value) {
  if (!value || value.version !== 1 || value.source !== SOURCE_ID || !Number.isSafeInteger(value.scannedBlock) ||
      value.scannedBlock < DEPLOYMENT_BLOCK || !Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES) return null;
  try {
    const seen = new Set();
    const candidates = value.candidates.map((v) => {
      const c = candidate(v);
      if (seen.has(c.ensHash)) throw new Error('duplicate');
      seen.add(c.ensHash); return c;
    });
    return { scannedBlock: value.scannedBlock, scannedHash: word(value.scannedHash), candidates };
  } catch (_) { return null; }
}
function createPrivacyRelayerDirectory({ rpc, inspect, store, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!rpc || !inspect || !store) throw new Error('privacy_relayer_dependencies_missing');
  let scan = { scannedBlock: DEPLOYMENT_BLOCK - 1, scannedHash: null, candidates: [] };
  let loaded = false, loading, active = false, closed = false, running, timer, stage, snapshot, failed = false;
  let nextRun = 0, range = RANGE;
  function schedule(delay) {
    if (closed || !active || timer) return;
    timer = setTimer(() => { timer = null; kick(); }, delay); timer?.unref?.();
  }
  async function load() {
    if (!loading) loading = (async () => { const saved = validCheckpoint(await store.read()); if (saved) { scan = saved; active = true; } loaded = true; })();
    await loading;
  }
  async function job() {
    const deadline = now() + JOB_MS;
    const beforeRequest = () => {
      if (closed) throw new Error('privacy_relayer_closed');
      if (now() >= deadline) throw new Error('privacy_relayer_job_deadline');
    };
    const context = { beforeRequest };
    if (!stage) {
      const header = await rpc.head(context);
      if (header.number < DEPLOYMENT_BLOCK) throw new Error('privacy_relayer_before_deployment');
      await rpc.assertSource(header, context);
      if (scan.scannedHash) {
        // A reset provider may not even have the saved height. Compare first,
        // so an unavailable future block cannot permanently strand recovery.
        const invalid = scan.scannedBlock > header.number ||
          (await rpc.block(scan.scannedBlock, context)).hash !== scan.scannedHash;
        if (invalid) {
          scan = { scannedBlock: DEPLOYMENT_BLOCK - 1, scannedHash: null, candidates: [] };
          snapshot = null;
        }
      }
      let chunks = 0;
      while (scan.scannedBlock < header.number && chunks++ < MAX_CHUNKS) {
        beforeRequest();
        const to = Math.min(header.number, scan.scannedBlock + range);
        let rows;
        try { rows = await rpc.events(scan.scannedBlock + 1, to, context); }
        catch (error) {
          if (['privacy_relayer_rpc_unavailable', 'privacy_relayer_rpc_rejected'].includes(error.message) && range > 1) range = Math.max(1, Math.floor(range / 2));
          throw error;
        }
        const candidates = new Map(scan.candidates.map((c) => [c.ensHash, c]));
        for (const row of rows) { const c = candidate(row); candidates.set(c.ensHash, c); }
        if (candidates.size > MAX_CANDIDATES) throw new Error('privacy_relayer_registry_capacity');
        const anchor = await rpc.block(to, context);
        await rpc.assertBlock(header, context);
        beforeRequest();
        const next = { scannedBlock: to, scannedHash: anchor.hash, candidates: [...candidates.values()] };
        await store.write({ version: 1, source: SOURCE_ID, ...next });
        scan = next;
      }
      if (scan.scannedBlock < header.number) { nextRun = now() + 1000; return; }
      stage = { header, index: 0, entries: [], unavailableEntries: 0 };
    }
    let processed = 0;
    while (stage.index < scan.candidates.length && processed++ < 8) {
      beforeRequest();
      const c = scan.candidates[stage.index];
      let entry;
      try {
        const current = await rpc.resolve(c, stage.header, context);
        if (current) {
          entry = { ensName: current.ensName, ensHash: current.ensHash, owner: current.owner,
            registryBalance: current.registryBalance, health: 'unavailable' };
          const status = await inspect(current.endpoint, context);
          if (await rpc.rewardRegistered(current.owner, status.rewardAccount, stage.header, context)) {
            const { origin, rewardAccount, supportedPools, serviceFeePercent, reportedHealthy, queueLength, version, observedAt } = status;
            entry = { ...entry, endpoint: origin, rewardAccount, supportedPools, advertisedServiceFeePercent: serviceFeePercent,
              health: reportedHealthy ? 'reported-healthy' : 'reported-unhealthy', advertisedQueueLength: queueLength,
              version, statusObservedAt: observedAt };
          } else stage.unavailableEntries++;
        }
      } catch (error) {
        // A bad or unreachable record is not an endorsement. If no current
        // registry identity was verified, omit it and report the incomplete count.
        if (closed || error.message === 'privacy_relayer_job_deadline') throw error;
        stage.unavailableEntries++;
      }
      beforeRequest();
      if (entry) stage.entries.push(entry);
      stage.index++;
    }
    if (stage.index < scan.candidates.length) { nextRun = now() + 1000; return; }
    if (now() - stage.header.timestamp * 1000 > 30 * 60 * 1000) { stage = null; throw new Error('privacy_relayer_stale_chain'); }
    await rpc.assertSource(stage.header, context);
    await rpc.assertBlock(stage.header, context);
    beforeRequest();
    const body = { version: 1, chainId: 1, source: SOURCE, asOfBlockNumber: stage.header.number,
      asOfBlockHash: stage.header.hash, asOfBlockTimestamp: stage.header.timestamp,
      observedAt: now(), candidateCount: scan.candidates.length, unavailableEntries: stage.unavailableEntries,
      relayers: stage.entries.sort((a, b) => a.ensName.localeCompare(b.ensName)) };
    const encoded = JSON.stringify(body);
    snapshot = { body, encoded, etag: '"' + createHash('sha256').update(encoded).digest('hex') + '"' };
    failed = false; stage = null; nextRun = now() + REFRESH_MS;
  }
  function kick() {
    if (closed || !active || running || !loaded) return;
    if (timer) { clearTimer(timer); timer = null; }
    running = job().catch((error) => {
      if (error.message === 'privacy_relayer_closed') return;
      if (error.message === 'privacy_relayer_job_deadline') nextRun = now() + 1000;
      else {
        failed = true; stage = null; nextRun = now() + RETRY_MS;
        if (['privacy_relayer_reorg', 'privacy_relayer_source_changed'].includes(error.message)) {
          snapshot = null; scan = { scannedBlock: DEPLOYMENT_BLOCK - 1, scannedHash: null, candidates: [] };
        }
      }
    }).finally(() => {
      running = null;
      schedule(Math.max(1000, nextRun - now()));
    });
  }
  async function read() {
    await load();
    if (closed) return { status: 503, body: { error: 'privacy_relayer_directory_closed' } };
    active = true;
    if (now() >= nextRun) kick();
    if (!snapshot) return { status: failed ? 503 : 202, body: { phase: failed ? 'unavailable' : 'syncing',
      scannedBlock: scan.scannedBlock, startBlock: DEPLOYMENT_BLOCK } };
    // A long catalogue scan does not make its earliest endpoint observations
    // fresh again when the final entry is published.
    const oldestStatus = snapshot.body.relayers.reduce((oldest, entry) =>
      entry.statusObservedAt === undefined ? oldest : Math.min(oldest, entry.statusObservedAt), snapshot.body.observedAt);
    const stale = failed || now() - oldestStatus >= REFRESH_MS ||
      now() - snapshot.body.asOfBlockTimestamp * 1000 > 30 * 60 * 1000;
    return { status: 200, ...snapshot, phase: stale ? 'stale' : running ? 'refreshing' : 'ready' };
  }
  async function close() { closed = true; if (timer) clearTimer(timer); timer = null; await loading; await running; }
  async function start() { await load(); if (active) kick(); }
  return { read, start, close, idle: async () => { await loading; await running; } };
}
function configuredPrivacyRelayerDirectory(env = process.env) {
  const enabled = env.PRIVACY_RELAYER_DIRECTORY_ENABLED;
  if (enabled !== undefined && enabled !== '' && enabled !== 'true' && enabled !== 'false') throw new Error('PRIVACY_RELAYER_DIRECTORY_ENABLED_invalid');
  if (enabled === 'false') return null;
  if (!env.PRIVACY_INDEX_RPC_URL) {
    if (enabled === 'true') throw new Error('privacy_relayer_rpc_required');
    return null;
  }
  const directory = createPrivacyRelayerDirectory({ rpc: createPrivacyRelayerRpc(env.PRIVACY_INDEX_RPC_URL),
    inspect: createPrivacyRelayerStatus(), store: createRelayerCheckpointStore(path.resolve('data/privacy-relayers')) });
  // Persisted public registry checkpoints resume; a never-used directory is idle.
  directory.start().catch(() => {});
  return directory;
}
module.exports = { createPrivacyRelayerDirectory, createRelayerCheckpointStore, configuredPrivacyRelayerDirectory,
  validCheckpoint, SOURCE_ID, REFRESH_MS, JOB_MS, RANGE, MAX_CHUNKS };
