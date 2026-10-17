'use strict';

const crypto = require('crypto');
const { parseReminderProposals } = require('./reminderProposals');

const CORE_BLOCK_SECONDS = 150;
const NETWORKS = Object.freeze({
  mainnet: {
    chain: 'main',
    genesis: '0000022642db0346b6e01c2a397471f4f12e65d4f4251ec96c1f85367a61a7ab',
  },
  testnet: {
    chain: 'test',
    genesis: '0000066e1a6b9cfeac8295dce0cc8d9170690a74bc4878cf8a0b412554f5c222',
  },
});
const METHODS = new Set([
  'getblockchaininfo',
  'getblockhash',
  'getgovernanceinfo',
  'gobject_list',
]);
const failure = (code) => Object.assign(new Error(code), { code });

// Private, read-only RPC adapter. No public route exposes arbitrary methods.
// Share the configured client's auth/cookie interceptors, but enforce one
// overall abort deadline (including a cookie retry) and a bounded response.
function createReminderRpc(client) {
  return async (method, params, signal) => {
    if (!METHODS.has(method)) throw failure('reminder_rpc_method_forbidden');
    const id = crypto.randomUUID();
    let response;
    try {
      response = await client.instance.post(
        client.url,
        { jsonrpc: '1.0', id, method, params },
        {
          signal,
          timeout: 10000,
          maxContentLength: 16 * 1024 * 1024,
          maxBodyLength: 1024,
          maxRedirects: 0,
        }
      );
    } catch {
      throw failure('reminder_rpc_unavailable');
    }
    const data = response && response.data;
    if (
      !data ||
      data.id !== id ||
      data.error ||
      !Object.hasOwn(data, 'result')
    ) {
      throw failure('reminder_rpc_invalid_response');
    }
    return data.result;
  };
}

function createReminderSource({
  rpcCall,
  network,
  now = Date.now,
  timeoutMs = 20000,
} = {}) {
  if (typeof rpcCall !== 'function') throw failure('reminder_rpc_required');
  const expected = NETWORKS[network];
  function validateInfo(info) {
    if (
      !expected ||
      !info ||
      info.chain !== expected.chain ||
      !Number.isSafeInteger(info.blocks) ||
      info.blocks < 0 ||
      !Number.isSafeInteger(info.headers) ||
      info.headers !== info.blocks ||
      info.initialblockdownload !== false ||
      !Number.isFinite(info.verificationprogress) ||
      info.verificationprogress < 0.999 ||
      !/^[0-9a-f]{64}$/.test(info.bestblockhash || '')
    ) {
      throw failure('reminder_chain_unavailable');
    }
  }

  async function getNextSuperblock() {
    if (!expected) throw failure('reminder_network_unconfigured');
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(failure('reminder_snapshot_timeout'));
      }, timeoutMs);
    });
    const load = async () => {
      const call = (method, params = []) => {
        if (controller.signal.aborted)
          throw failure('reminder_snapshot_timeout');
        return rpcCall(method, params, controller.signal);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await call('getblockchaininfo');
        validateInfo(before);
        const [genesis, governance, raw] = await Promise.all([
          call('getblockhash', [0]),
          call('getgovernanceinfo'),
          call('gobject_list'),
        ]);
        if (genesis !== expected.genesis)
          throw failure('reminder_network_mismatch');
        const after = await call('getblockchaininfo');
        validateInfo(after);
        if (
          before.bestblockhash !== after.bestblockhash ||
          before.blocks !== after.blocks
        )
          continue;
        const height = governance && governance.nextsuperblock;
        const maturityBlocks =
          governance && governance.superblockmaturitywindow;
        const cycle = governance && governance.superblockcycle;
        if (
          !Number.isSafeInteger(height) ||
          !Number.isSafeInteger(maturityBlocks) ||
          !Number.isSafeInteger(cycle) ||
          maturityBlocks <= 0 ||
          maturityBlocks > cycle ||
          cycle <= 0 ||
          height !== (Math.floor(after.blocks / cycle) + 1) * cycle
        ) {
          throw failure('reminder_governance_unavailable');
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
          throw failure('reminder_proposals_unavailable');
        const observedAt = now();
        return {
          height,
          currentHeight: after.blocks,
          maturityBlocks,
          observedAt,
          blockHash: after.bestblockhash,
          // Matches Core CreateSuperblockCandidate, not the dashboard's
          // empirical average and not the previous block's timestamp.
          epochSec:
            Math.floor(observedAt / 1000) +
            (height - after.blocks) * CORE_BLOCK_SECONDS,
          proposals: parseReminderProposals(raw),
        };
      }
      throw failure('reminder_tip_changed');
    };
    try {
      return await Promise.race([load(), timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return {
    getNextSuperblock,
    getActiveProposals: async (snapshot) => snapshot.proposals,
  };
}

module.exports = {
  createReminderSource,
  createReminderRpc,
  CORE_BLOCK_SECONDS,
  NETWORKS,
};
