'use strict';

const crypto = require('crypto');

const HASH = /^[0-9a-f]{64}$/;
function failure(code, status = 422) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
function strictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) throw failure('invalid_request');
}
function nodeIdentity(network, proTxHash) {
  if (!['mainnet', 'testnet', 'regtest'].includes(network) || !HASH.test(proTxHash || '')) {
    throw failure('invalid_node_identity');
  }
  return { network, proTxHash };
}
function createSentryRepository(db, { now = Date.now } = {}) {
  // Only public node identifiers, exact transaction bytes and operation status
  // are stored here. Operator/owner/voting secrets never enter this service.
  db.exec(`CREATE TABLE IF NOT EXISTS sentry_watches (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    network TEXT NOT NULL, protx_hash TEXT NOT NULL, label TEXT NOT NULL,
    PRIMARY KEY (user_id, network, protx_hash));
    CREATE TABLE IF NOT EXISTS sentry_operations (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    network TEXT NOT NULL, protx_hash TEXT NOT NULL, prepared TEXT NOT NULL,
    status TEXT NOT NULL, signed_hex TEXT, txid TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, error_code TEXT);`);
  const read = (id, userId) => {
    const row = db.prepare('SELECT * FROM sentry_operations WHERE id=? AND user_id=?').get(id, userId);
    if (!row) return null;
    const prepared = JSON.parse(row.prepared);
    // A registration creates its node identity; collateral identifies only
    // the input being reserved. There is no ProTx hash before submission.
    return { ...row, prepared, protx_hash: prepared.request.operation === 'register' ? row.txid : row.protx_hash };
  };
  return {
    watch(userId, { network, proTxHash, label = '', preserveExisting = false }) {
      nodeIdentity(network, proTxHash);
      if (typeof label !== 'string' || label.length > 80) throw failure('invalid_label');
      if (typeof preserveExisting !== 'boolean') throw failure('invalid_request');
      // Batch imports must not overwrite a label saved by another tab while
      // their on-chain validation was in flight. Decide at the SQLite write,
      // not with a stale preflight read. Ordinary single-node edits keep the
      // existing upsert behavior unless the caller explicitly opts in.
      const conflict = preserveExisting ? 'DO NOTHING' : 'DO UPDATE SET label=excluded.label';
      db.prepare(`INSERT INTO sentry_watches VALUES (?,?,?,?) ON CONFLICT (user_id,network,protx_hash) ${conflict}`)
        .run(userId, network, proTxHash, label);
    },
    watches: (userId) => db.prepare('SELECT network, protx_hash AS proTxHash, label FROM sentry_watches WHERE user_id=? ORDER BY label,protx_hash').all(userId),
    unwatch: (userId, network, proTxHash) => db.prepare('DELETE FROM sentry_watches WHERE user_id=? AND network=? AND protx_hash=?').run(userId, network, proTxHash),
    create(userId, network, proTxHash, prepared) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO sentry_operations (id,user_id,network,protx_hash,prepared,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, userId, network, proTxHash, JSON.stringify(prepared), 'prepared', now(), now());
      return read(id, userId);
    },
    read,
    list: (userId) => db.prepare("SELECT id,network,CASE WHEN json_extract(prepared, '$.request.operation')='register' THEN txid ELSE protx_hash END AS proTxHash,status,txid,json_extract(prepared, '$.request.operation') AS operation,created_at AS createdAt,error_code AS errorCode FROM sentry_operations WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(userId),
    claim(id, userId, signedHex, txid) {
      const changed = db.prepare("UPDATE sentry_operations SET status='submitting',signed_hex=?,txid=?,protx_hash=CASE WHEN json_extract(prepared, '$.request.operation')='register' THEN ? ELSE protx_hash END,updated_at=? WHERE id=? AND user_id=? AND status='prepared'")
        .run(signedHex, txid, txid, now(), id, userId).changes;
      return changed === 1;
    },
    claimRetry(id, userId, updatedAt) {
      return db.prepare("UPDATE sentry_operations SET status='submitting',updated_at=? WHERE id=? AND user_id=? AND updated_at=? AND status IN ('submission_unknown','submitted','submitting','confirmed','state_changed')")
        .run(now(), id, userId, updatedAt).changes === 1;
    },
    status(id, userId, status, errorCode = null) {
      db.prepare('UPDATE sentry_operations SET status=?,error_code=?,updated_at=? WHERE id=? AND user_id=?')
        .run(status, errorCode, now(), id, userId);
    },
  };
}

function createSentryManagement({ repository, adapter, now = Date.now }) {
  const configured = () => {
    if (!adapter) throw failure('sentry_not_configured', 503);
    return adapter;
  };
  return {
    capabilities: async () => configured().capabilities(),
    context: async (network, proTxHash, collateral) => {
      nodeIdentity(network, proTxHash || collateral?.txid);
      return configured().context(network, proTxHash, collateral);
    },
    votingContext: async (query) => {
      strictObject(query, ['network', 'proposalHash', 'proTxHashes']);
      if (typeof query.proposalHash !== 'string') throw failure('invalid_node_identity');
      nodeIdentity(query.network, query.proposalHash);
      if (/^0+$/.test(query.proposalHash)) throw failure('invalid_node_identity');
      if (typeof query.proTxHashes !== 'string' || query.proTxHashes.length > 20 * 65) throw failure('invalid_voting_nodes');
      const hashes = query.proTxHashes.split(',');
      if (!hashes.length || hashes.length > 20 || new Set(hashes).size !== hashes.length) throw failure('invalid_voting_nodes');
      hashes.forEach((hash) => {
        nodeIdentity(query.network, hash);
        if (/^0+$/.test(hash)) throw failure('invalid_node_identity');
      });
      return configured().votingContext(query.network, query.proposalHash, hashes);
    },
    watches: (userId) => repository.watches(userId),
    async watch(userId, body) {
      strictObject(body, ['network', 'proTxHash', 'label', 'preserveExisting']);
      if (body.preserveExisting !== undefined && typeof body.preserveExisting !== 'boolean') throw failure('invalid_request');
      const { network, proTxHash } = nodeIdentity(body.network, body.proTxHash);
      await configured().context(network, proTxHash);
      repository.watch(userId, body);
      return repository.watches(userId);
    },
    unwatch(userId, network, proTxHash) {
      nodeIdentity(network, proTxHash);
      repository.unwatch(userId, network, proTxHash);
    },
    async prepare(userId, body) {
      strictObject(body, ['operation', 'network', 'proTxHash', 'collateralOutpoint', 'changes', 'xpub', 'changeAddress', 'feeRate']);
      const operation = body.operation || 'updateService';
      const allowed = {
        updateService: ['nevmAddress', 'service', 'operatorPayoutAddress'],
        register: ['service', 'ownerAddress', 'votingAddress', 'operatorPublicKey', 'pqOwnerPublicKey', 'pqVotingPublicKey', 'operatorRewardBasisPoints', 'payoutAddress'],
        updateRegistrar: ['operatorPublicKey', 'votingAddress', 'payoutAddress', 'pqOwnerPublicKey', 'pqVotingPublicKey'],
        revoke: ['reason'],
        registerOperator: ['operatorPublicKey', 'childKeyCommitment', 'keyVersion'],
        rotateOperator: ['operatorPublicKey', 'childKeyCommitment', 'keyVersion'],
      };
      if (!allowed[operation]) throw failure('operation_not_supported');
      const { network, proTxHash } = nodeIdentity(body.network, operation === 'register' ? body.collateralOutpoint?.txid : body.proTxHash);
      if (operation === 'register') {
        strictObject(body.collateralOutpoint, ['txid', 'vout']);
        if (!Number.isSafeInteger(body.collateralOutpoint.vout) || body.collateralOutpoint.vout < 0 || body.collateralOutpoint.vout > 0xffffffff) throw failure('invalid_collateral');
      }
      strictObject(body.changes, allowed[operation]);
      if (!Object.keys(body.changes).length) throw failure('no_changes');
      // Omission preserves NEVM. Empty string is an explicit removal only.
      if (Object.hasOwn(body.changes, 'nevmAddress') && body.changes.nevmAddress !== '' &&
          !/^0x[0-9a-fA-F]{40}$/.test(body.changes.nevmAddress)) throw failure('invalid_nevm_address');
      if (/^0x0{40}$/i.test(body.changes.nevmAddress || '')) throw failure('invalid_nevm_address');
      if (Object.hasOwn(body.changes, 'operatorRewardBasisPoints') &&
          (!Number.isSafeInteger(body.changes.operatorRewardBasisPoints) || body.changes.operatorRewardBasisPoints < 0 || body.changes.operatorRewardBasisPoints > 10000)) throw failure('invalid_operator_reward');
      if (Object.hasOwn(body.changes, 'reason') && ![0, 1, 2, 3].includes(body.changes.reason)) throw failure('invalid_revocation_reason');
      if (Object.hasOwn(body.changes, 'keyVersion') && (!Number.isSafeInteger(body.changes.keyVersion) || body.changes.keyVersion < 1 || body.changes.keyVersion > 0xffffffff)) throw failure('invalid_key_version');
      const prepared = await configured().prepare({ ...body, operation });
      return repository.create(userId, network, proTxHash, { ...prepared, preparedAt: now() });
    },
    operations: (userId) => repository.list(userId),
    async authorize(userId, id, body) {
      strictObject(body, ['authorization']);
      strictObject(body.authorization, ['version', 'operation', 'transactionHex', 'operatorPublicKey', 'authorizationHash', 'signedAuthorization', 'complete']);
      const row = repository.read(id, userId);
      if (!row) throw failure('operation_not_found', 404);
      if (row.status !== 'prepared') throw failure('operation_already_submitted', 409);
      if (now() - row.created_at > 15 * 60_000) throw failure('operation_expired', 409);
      return configured().authorize(row, body.authorization);
    },
    async submit(userId, id, body) {
      strictObject(body, ['signedPsbt']);
      const row = repository.read(id, userId);
      if (!row) throw failure('operation_not_found', 404);
      if (row.status !== 'prepared') return { id: row.id, status: row.status, txid: row.txid };
      if (now() - row.created_at > 15 * 60_000) throw failure('operation_expired', 409);
      // Verify exact prepared inputs/outputs, operator signature and current
      // chain state before occupying the durable one-publication journal.
      const verified = await configured().validateSigned(row, body.signedPsbt);
      if (!repository.claim(id, userId, verified.transactionHex, verified.txid)) {
        const occupied = repository.read(id, userId);
        return { id, status: occupied.status, txid: occupied.txid };
      }
      try {
        const txid = await configured().broadcast(verified.transactionHex);
        if (txid !== verified.txid) throw failure('broadcast_identity_mismatch', 502);
        repository.status(id, userId, 'submitted');
      } catch (_) {
        // Timeout does not mean rejection. Never auto-rebuild or auto-resend.
        repository.status(id, userId, 'submission_unknown', 'broadcast_unconfirmed');
      }
      const result = repository.read(id, userId);
      return { id, status: result.status, txid: result.txid };
    },
    async retry(userId, id, body) {
      strictObject(body, []);
      const row = repository.read(id, userId);
      if (!row) throw failure('operation_not_found', 404);
      if (!row.signed_hex || !row.txid) throw failure('operation_not_submitted', 409);
      const observation = await configured().readback(row);
      if (observation.confirmed || observation.known) {
        const status = observation.confirmed
          ? (observation.matches || row.status === 'confirmed' ? 'confirmed' : 'state_changed')
          : 'submitted';
        repository.status(id, userId, status);
        return { id, status, txid: row.txid };
      }
      if (now() - row.updated_at < 30_000) throw failure('retry_not_ready', 429);
      // Stored bytes were fully authorized before the first attempt. Core
      // must still accept those exact bytes now; never rebuild or re-sign.
      await configured().validateStored(row);
      if (!repository.claimRetry(id, userId, row.updated_at)) {
        const current = repository.read(id, userId);
        return { id, status: current.status, txid: current.txid };
      }
      try {
        if (await configured().broadcast(row.signed_hex) !== row.txid) throw failure('broadcast_identity_mismatch', 502);
        repository.status(id, userId, 'submitted');
      } catch (_) {
        repository.status(id, userId, 'submission_unknown', 'broadcast_unconfirmed');
      }
      const current = repository.read(id, userId);
      return { id, status: current.status, txid: current.txid };
    },
    async reconcile(userId, id) {
      const row = repository.read(id, userId);
      if (!row) throw failure('operation_not_found', 404);
      if (row.txid) {
        const observation = await configured().readback(row);
        // A later legitimate update can change the current registration. Once
        // this transaction's effect was confirmed, that does not make its
        // historical success a failure; loss of its confirmation still does.
        if (observation.confirmed && (observation.matches || row.status === 'confirmed')) repository.status(id, userId, 'confirmed');
        else if (observation.confirmed && !observation.matches) repository.status(id, userId, 'state_changed', 'confirmed_state_differs');
        else if (row.status === 'confirmed' || row.status === 'state_changed') repository.status(id, userId, 'submission_unknown', 'confirmation_no_longer_observed');
      }
      const current = repository.read(id, userId);
      return { id, network: current.network, proTxHash: current.protx_hash, operation: current.prepared.request.operation, status: current.status, txid: current.txid, prepared: current.prepared, errorCode: current.error_code };
    },
  };
}
module.exports = { createSentryRepository, createSentryManagement, failure, nodeIdentity, strictObject };
