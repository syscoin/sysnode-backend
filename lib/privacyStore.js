'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const { getPool, MAX_LEAVES, word, fieldWord } = require('./privacyRegistry');
const MAX_FILE_BYTES = 160 * 1024 * 1024;

function validateNullifiers(values, leafCount) {
  if (!Array.isArray(values) || values.length > leafCount || new Set(values).size !== values.length) throw new Error('privacy_invalid_nullifiers');
  values.forEach(fieldWord);
}

function validateSnapshot(value, pool) {
  if (!value || value.version !== 1 || value.chainId !== 1 || value.poolAddress !== pool.address ||
      !Number.isSafeInteger(value.asOfBlockNumber) || value.asOfBlockNumber < pool.deploymentBlock ||
      !Array.isArray(value.leaves) || value.leaves.length > MAX_LEAVES || value.leafCount !== value.leaves.length) throw new Error('privacy_invalid_snapshot');
  word(value.asOfBlockHash); fieldWord(value.root); value.leaves.forEach(fieldWord);
  if (new Set(value.leaves).size !== value.leaves.length) throw new Error('privacy_invalid_snapshot');
  validateNullifiers(value.withdrawnNullifiers, value.leafCount);
  // Return a strict public projection, never expose file bookkeeping.
  return { version: 1, chainId: 1, poolAddress: pool.address, asOfBlockNumber: value.asOfBlockNumber,
    asOfBlockHash: value.asOfBlockHash, leafCount: value.leaves.length, root: value.root, leaves: value.leaves,
    withdrawnNullifiers: value.withdrawnNullifiers };
}
function validateCheckpoint(value, pool) {
  if (!value || value.version !== 2 || value.poolAddress !== pool.address ||
      !Number.isSafeInteger(value.scannedBlock) || value.scannedBlock < pool.deploymentBlock - 1 ||
      !Number.isSafeInteger(value.targetBlock) || value.targetBlock < value.scannedBlock ||
      !Array.isArray(value.leaves) || value.leaves.length > MAX_LEAVES) throw new Error('privacy_invalid_checkpoint');
  if (value.scannedBlock >= pool.deploymentBlock) word(value.scannedHash);
  word(value.targetHash);
  if (value.blockSpan !== undefined && (!Number.isSafeInteger(value.blockSpan) || value.blockSpan < 1 || value.blockSpan > 5000)) throw new Error('privacy_invalid_checkpoint');
  if (value.scannedBlock === pool.deploymentBlock - 1 && value.leaves.length) throw new Error('privacy_invalid_checkpoint');
  value.leaves.forEach(fieldWord);
  if (new Set(value.leaves).size !== value.leaves.length) throw new Error('privacy_invalid_checkpoint');
  validateNullifiers(value.withdrawnNullifiers, value.leaves.length);
  return value;
}

function createPrivacyStore(directory = path.resolve('data/privacy-index')) {
  function file(id, kind) {
    if (!getPool(id) || !['snapshot', 'checkpoint', 'active'].includes(kind)) throw new Error('privacy_unknown_pool');
    return path.join(directory, `${id}.${kind}.json`);
  }
  async function load(id, kind) {
    try {
      const name = file(id, kind);
      if ((await fs.stat(name)).size > MAX_FILE_BYTES) throw new Error('privacy_file_too_large');
      const envelope = JSON.parse(await fs.readFile(name, 'utf8'));
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
          typeof envelope.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.sha256) ||
          !envelope.value || typeof envelope.value !== 'object' || Array.isArray(envelope.value)) throw new Error('privacy_file_envelope');
      const data = JSON.stringify(envelope.value);
      if (envelope.sha256 !== createHash('sha256').update(data).digest('hex')) throw new Error('privacy_file_checksum');
      if (kind === 'active') {
        if (envelope.value.version !== 1 || envelope.value.poolId !== id) throw new Error('privacy_invalid_active_pool');
        return envelope.value;
      }
      return kind === 'snapshot' ? validateSnapshot(envelope.value, getPool(id)) : validateCheckpoint(envelope.value, getPool(id));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      // Rebuildable public cache: corrupted state is never exposed or trusted.
      if (error instanceof SyntaxError || error.message.startsWith('privacy_')) return null;
      throw new Error('privacy_storage_unavailable');
    }
  }
  async function save(id, kind, value) {
    const target = file(id, kind);
    if (kind === 'snapshot') validateSnapshot(value, getPool(id));
    else if (kind === 'checkpoint') validateCheckpoint(value, getPool(id));
    else if (value.version !== 1 || value.poolId !== id) throw new Error('privacy_invalid_active_pool');
    const data = JSON.stringify(value);
    const encoded = JSON.stringify({ sha256: createHash('sha256').update(data).digest('hex'), value });
    if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new Error('privacy_file_too_large');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temp, target);
      const directoryHandle = await fs.open(directory, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally {
      if (handle) await handle.close();
      await fs.unlink(temp).catch(() => {});
    }
  }
  async function remove(id, kind) {
    try { await fs.unlink(file(id, kind)); } catch (error) { if (error.code !== 'ENOENT') throw new Error('privacy_storage_unavailable'); }
  }
  async function listActive() {
    let names;
    try { names = await fs.readdir(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new Error('privacy_storage_unavailable'); }
    // Old files identify previously requested pools even when their deposit-only
    // payload now requires a rebuild. An unrelated filename activates nothing.
    return [...new Set(names.flatMap((name) => {
      const match = /^(eth-(?:0\.1|1|10|100))\.(?:active|snapshot|checkpoint)\.json$/.exec(name);
      return match && getPool(match[1]) ? [match[1]] : [];
    }))];
  }
  return { load, save, remove, listActive,
    activate: (id) => save(id, 'active', { version: 1, poolId: id }) };
}

module.exports = { createPrivacyStore, validateSnapshot, validateCheckpoint, MAX_FILE_BYTES };
