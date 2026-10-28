'use strict';

const axios = require('axios');
const { Interface, toQuantity } = require('ethers');
const { MAX_LEAVES, word, fieldWord } = require('./privacyRegistry');
const { privacyRpcUrl } = require('./privacyRpcUrl');

const ABI = new Interface([
  'event Deposit(bytes32 indexed commitment,uint32 leafIndex,uint256 timestamp)',
  'event Withdrawal(address to,bytes32 nullifierHash,address indexed relayer,uint256 fee)',
  'function levels() view returns (uint32)',
  'function denomination() view returns (uint256)',
  'function nextIndex() view returns (uint32)',
  'function getLastRoot() view returns (bytes32)',
]);
const DEPOSIT_TOPIC = ABI.getEvent('Deposit').topicHash;
const WITHDRAWAL_TOPIC = ABI.getEvent('Withdrawal').topicHash;
const MAX_RPC_BYTES = 4 * 1024 * 1024;

function quantity(value) {
  if (typeof value !== 'string' || value.length > 16 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new Error('privacy_invalid_quantity');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n)) throw new Error('privacy_invalid_quantity');
  return n;
}

function createPrivacyRpc(rpcUrl, { post = axios.post, now = Date.now } = {}) {
  const { url, localHttp } = privacyRpcUrl(rpcUrl);
  let id = 0;
  async function call(method, params, { beforeRequest } = {}) {
    // A logical read such as state() uses several HTTP requests. Check the
    // caller's close/deadline fence before every one, not just at method entry.
    if (beforeRequest) beforeRequest();
    const current = ++id;
    let response;
    try {
      response = await post(url.href, { jsonrpc: '2.0', id: current, method, params }, {
        timeout: 10000, maxRedirects: 0, maxContentLength: MAX_RPC_BYTES,
        maxBodyLength: 16384, responseType: 'json',
        transitional: { silentJSONParsing: false },
        headers: { 'Content-Type': 'application/json' }, ...(localHttp ? { proxy: false } : {}),
      });
    } catch (_) { throw new Error('privacy_rpc_unavailable'); }
    const body = response.data;
    if (response.status !== 200 || !body || body.jsonrpc !== '2.0' || body.id !== current) throw new Error('privacy_rpc_invalid_response');
    if (Object.hasOwn(body, 'error')) throw new Error('privacy_rpc_rejected');
    if (!Object.hasOwn(body, 'result')) throw new Error('privacy_rpc_invalid_response');
    return body.result;
  }
  async function block(tag, context) {
    const value = await call('eth_getBlockByNumber', [typeof tag === 'number' ? toQuantity(tag) : tag, false], context);
    if (!value || typeof value !== 'object') throw new Error('privacy_missing_block');
    const result = { number: quantity(value.number), hash: word(value.hash), parentHash: word(value.parentHash), timestamp: quantity(value.timestamp) };
    if (typeof tag === 'number' && result.number !== tag) throw new Error('privacy_wrong_block');
    return result;
  }
  async function assertBlock(header, context) {
    if ((await block(header.number, context)).hash !== header.hash) throw new Error('privacy_reorg');
  }
  async function head(context) {
    if (quantity(await call('eth_chainId', [], context)) !== 1) throw new Error('privacy_wrong_chain');
    // Never silently substitute latest/safe for finalized.
    const result = await block('finalized', context);
    const age = now() - result.timestamp * 1000;
    if (age < -30000 || age > 30 * 60 * 1000) throw new Error('privacy_stale_chain');
    return result;
  }
  async function state(pool, header, context) {
    const tag = toQuantity(header.number);
    const code = await call('eth_getCode', [pool.address, tag], context);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(code)) throw new Error('privacy_missing_pool');
    async function view(name) {
      const result = await call('eth_call', [{ to: pool.address, data: ABI.encodeFunctionData(name), gas: '0x186a0' }, tag], context);
      word(result);
      try { return ABI.decodeFunctionResult(name, result)[0]; } catch (_) { throw new Error('privacy_invalid_pool_state'); }
    }
    const levels = await view('levels');
    const denomination = await view('denomination');
    const nextIndex = Number(await view('nextIndex'));
    const root = fieldWord(await view('getLastRoot'));
    if (levels !== 20n || denomination !== BigInt(pool.denomination) ||
        !Number.isSafeInteger(nextIndex) || nextIndex < 0 || nextIndex > MAX_LEAVES) throw new Error('privacy_pool_mismatch');
    await assertBlock(header, context);
    return { nextIndex, root };
  }
  async function events(pool, from, to, context) {
    const rows = await call('eth_getLogs', [{ address: pool.address, fromBlock: toQuantity(from), toBlock: toQuantity(to), topics: [[DEPOSIT_TOPIC, WITHDRAWAL_TOPIC]] }], context);
    if (!Array.isArray(rows)) throw new Error('privacy_invalid_logs');
    if (rows.length > 10000) throw new Error('privacy_logs_too_large');
    return rows.map((row) => {
      if (!row || row.removed !== false || row.address !== pool.address ||
          !Array.isArray(row.topics) || row.topics.length !== 2 ||
          ![DEPOSIT_TOPIC, WITHDRAWAL_TOPIC].includes(row.topics[0]) ||
          typeof row.data !== 'string' || !/^0x[0-9a-f]+$/.test(row.data) ||
          row.data.length !== (row.topics[0] === DEPOSIT_TOPIC ? 130 : 194)) throw new Error('privacy_invalid_log');
      word(row.topics[1]);
      if (row.topics[0] === WITHDRAWAL_TOPIC &&
          (BigInt(row.topics[1]) >= (1n << 160n) || !/^0x0{24}/.test(row.data))) throw new Error('privacy_invalid_log');
      const blockNumber = quantity(row.blockNumber);
      if (blockNumber < from || blockNumber > to) throw new Error('privacy_invalid_log');
      let parsed;
      try { parsed = ABI.parseLog(row); } catch (_) { throw new Error('privacy_invalid_log'); }
      const position = { blockNumber,
        blockHash: word(row.blockHash), txHash: word(row.transactionHash),
        txIndex: quantity(row.transactionIndex), logIndex: quantity(row.logIndex) };
      if (parsed.name === 'Deposit') {
        const leafIndex = Number(parsed.args.leafIndex);
        if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= MAX_LEAVES) throw new Error('privacy_invalid_log');
        return { ...position, kind: 'deposit', leaf: fieldWord(parsed.args.commitment), leafIndex };
      }
      if (parsed.args.fee > BigInt(pool.denomination)) throw new Error('privacy_invalid_log');
      return { ...position, kind: 'withdrawal', nullifierHash: fieldWord(parsed.args.nullifierHash) };
    }).sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
  }
  return { head, block, assertBlock, state, events };
}

module.exports = { createPrivacyRpc, ABI, DEPOSIT_TOPIC, WITHDRAWAL_TOPIC, quantity, MAX_RPC_BYTES };
