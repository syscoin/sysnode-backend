'use strict';

const axios = require('axios');
const { Interface, toQuantity } = require('ethers');
const { MAX_LEAVES, word, fieldWord } = require('./privacyRegistry');

const ABI = new Interface([
  'event Deposit(bytes32 indexed commitment,uint32 leafIndex,uint256 timestamp)',
  'function levels() view returns (uint32)',
  'function denomination() view returns (uint256)',
  'function nextIndex() view returns (uint32)',
  'function getLastRoot() view returns (bytes32)',
]);
const DEPOSIT_TOPIC = ABI.getEvent('Deposit').topicHash;
const MAX_RPC_BYTES = 4 * 1024 * 1024;

function quantity(value) {
  if (typeof value !== 'string' || value.length > 16 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new Error('privacy_invalid_quantity');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n)) throw new Error('privacy_invalid_quantity');
  return n;
}

function createPrivacyRpc(rpcUrl, { post = axios.post, now = Date.now } = {}) {
  let url;
  try { url = new URL(rpcUrl); } catch (_) { throw new Error('privacy_rpc_url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('privacy_rpc_url_invalid');
  let id = 0;
  async function call(method, params) {
    const current = ++id;
    let response;
    try {
      response = await post(url.href, { jsonrpc: '2.0', id: current, method, params }, {
        timeout: 10000, maxRedirects: 0, maxContentLength: MAX_RPC_BYTES,
        maxBodyLength: 16384, responseType: 'json',
        transitional: { silentJSONParsing: false },
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (_) { throw new Error('privacy_rpc_unavailable'); }
    const body = response.data;
    if (response.status !== 200 || !body || body.jsonrpc !== '2.0' || body.id !== current) throw new Error('privacy_rpc_invalid_response');
    if (Object.hasOwn(body, 'error')) throw new Error('privacy_rpc_rejected');
    if (!Object.hasOwn(body, 'result')) throw new Error('privacy_rpc_invalid_response');
    return body.result;
  }
  async function block(tag) {
    const value = await call('eth_getBlockByNumber', [typeof tag === 'number' ? toQuantity(tag) : tag, false]);
    if (!value || typeof value !== 'object') throw new Error('privacy_missing_block');
    const result = { number: quantity(value.number), hash: word(value.hash), parentHash: word(value.parentHash), timestamp: quantity(value.timestamp) };
    if (typeof tag === 'number' && result.number !== tag) throw new Error('privacy_wrong_block');
    return result;
  }
  async function assertBlock(header) {
    if ((await block(header.number)).hash !== header.hash) throw new Error('privacy_reorg');
  }
  async function head() {
    if (quantity(await call('eth_chainId', [])) !== 1) throw new Error('privacy_wrong_chain');
    // Never silently substitute latest/safe for finalized.
    const result = await block('finalized');
    const age = now() - result.timestamp * 1000;
    if (age < -30000 || age > 30 * 60 * 1000) throw new Error('privacy_stale_chain');
    return result;
  }
  async function state(pool, header) {
    const tag = toQuantity(header.number);
    const code = await call('eth_getCode', [pool.address, tag]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(code)) throw new Error('privacy_missing_pool');
    async function view(name) {
      const result = await call('eth_call', [{ to: pool.address, data: ABI.encodeFunctionData(name), gas: '0x186a0' }, tag]);
      word(result);
      try { return ABI.decodeFunctionResult(name, result)[0]; } catch (_) { throw new Error('privacy_invalid_pool_state'); }
    }
    const levels = await view('levels');
    const denomination = await view('denomination');
    const nextIndex = Number(await view('nextIndex'));
    const root = fieldWord(await view('getLastRoot'));
    if (levels !== 20n || denomination !== BigInt(pool.denomination) ||
        !Number.isSafeInteger(nextIndex) || nextIndex < 0 || nextIndex > MAX_LEAVES) throw new Error('privacy_pool_mismatch');
    await assertBlock(header);
    return { nextIndex, root };
  }
  async function deposits(pool, from, to) {
    const rows = await call('eth_getLogs', [{ address: pool.address, fromBlock: toQuantity(from), toBlock: toQuantity(to), topics: [DEPOSIT_TOPIC] }]);
    if (!Array.isArray(rows)) throw new Error('privacy_invalid_logs');
    if (rows.length > 10000) throw new Error('privacy_logs_too_large');
    return rows.map((row) => {
      if (!row || row.removed !== false || row.address !== pool.address ||
          !Array.isArray(row.topics) || row.topics.length !== 2 || row.topics[0] !== DEPOSIT_TOPIC ||
          typeof row.data !== 'string' || !/^0x[0-9a-f]{128}$/.test(row.data)) throw new Error('privacy_invalid_log');
      fieldWord(row.topics[1]);
      const blockNumber = quantity(row.blockNumber);
      if (blockNumber < from || blockNumber > to) throw new Error('privacy_invalid_log');
      let parsed;
      try { parsed = ABI.parseLog(row); } catch (_) { throw new Error('privacy_invalid_log'); }
      const leafIndex = Number(parsed.args.leafIndex);
      if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= MAX_LEAVES) throw new Error('privacy_invalid_log');
      return { leaf: fieldWord(parsed.args.commitment), leafIndex, blockNumber,
        blockHash: word(row.blockHash), txHash: word(row.transactionHash),
        txIndex: quantity(row.transactionIndex), logIndex: quantity(row.logIndex) };
    }).sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
  }
  return { head, block, assertBlock, state, deposits };
}

module.exports = { createPrivacyRpc, ABI, DEPOSIT_TOPIC, quantity, MAX_RPC_BYTES };
