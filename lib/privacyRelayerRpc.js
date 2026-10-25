'use strict';

const axios = require('axios');
const { toQuantity, keccak256, ZeroAddress } = require('ethers');
const { quantity } = require('./privacyRpc');
const { word } = require('./privacyRegistry');
const { REGISTRY, IMPLEMENTATION, IMPLEMENTATION_CODE_HASH, IMPLEMENTATION_SLOT, ENS,
  ABI, candidate, address, urlNode } = require('./privacyRelayerRegistry');
const TOPIC = ABI.getEvent('RelayerRegistered').topicHash;
function createPrivacyRelayerRpc(rpcUrl, { post = axios.post, now = Date.now } = {}) {
  let url;
  try { url = new URL(rpcUrl); } catch (_) { throw new Error('privacy_rpc_url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('privacy_rpc_url_invalid');
  let id = 0;
  async function call(method, params, context = {}) {
    context.beforeRequest?.();
    const current = ++id;
    let res;
    try {
      res = await post(url.href, { jsonrpc: '2.0', id: current, method, params }, {
        timeout: 10000, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024, maxBodyLength: 16384,
        responseType: 'json', transitional: { silentJSONParsing: false }, headers: { 'Content-Type': 'application/json' },
      });
    } catch (_) { throw new Error('privacy_relayer_rpc_unavailable'); }
    if (res.status !== 200 || !res.data || res.data.jsonrpc !== '2.0' || res.data.id !== current ||
        !Object.hasOwn(res.data, 'result') && !Object.hasOwn(res.data, 'error')) throw new Error('privacy_relayer_rpc_invalid');
    if (Object.hasOwn(res.data, 'error')) throw new Error('privacy_relayer_rpc_rejected');
    return res.data.result;
  }
  async function block(tag, context) {
    const raw = await call('eth_getBlockByNumber', [typeof tag === 'number' ? toQuantity(tag) : tag, false], context);
    if (!raw) throw new Error('privacy_relayer_missing_block');
    const result = { number: quantity(raw.number), hash: word(raw.hash), timestamp: quantity(raw.timestamp) };
    if (typeof tag === 'number' && result.number !== tag) throw new Error('privacy_relayer_wrong_block');
    return result;
  }
  async function head(context) {
    if (quantity(await call('eth_chainId', [], context)) !== 1) throw new Error('privacy_relayer_wrong_chain');
    const h = await block('finalized', context);
    if (now() - h.timestamp * 1000 > 30 * 60 * 1000 || now() - h.timestamp * 1000 < -30000) throw new Error('privacy_relayer_stale_chain');
    return h;
  }
  async function assertBlock(header, context) {
    if ((await block(header.number, context)).hash !== header.hash) throw new Error('privacy_relayer_reorg');
  }
  async function assertSource(header, context) {
    const tag = toQuantity(header.number);
    const slot = word(await call('eth_getStorageAt', [REGISTRY, IMPLEMENTATION_SLOT, tag], context));
    if (slot !== '0x' + '0'.repeat(24) + IMPLEMENTATION.slice(2)) throw new Error('privacy_relayer_source_changed');
    const code = await call('eth_getCode', [IMPLEMENTATION, tag], context);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(code) || keccak256(code) !== IMPLEMENTATION_CODE_HASH) throw new Error('privacy_relayer_source_changed');
    await assertBlock(header, context);
  }
  async function view(to, name, args, header, context) {
    const data = await call('eth_call', [{ to, data: ABI.encodeFunctionData(name, args), gas: '0x7a120' }, toQuantity(header.number)], context);
    if (typeof data !== 'string' || data.length > 8194 || !/^0x(?:[0-9a-f]{2})*$/.test(data)) throw new Error('privacy_relayer_state_invalid');
    try { return ABI.decodeFunctionResult(name, data); } catch (_) { throw new Error('privacy_relayer_state_invalid'); }
  }
  async function events(from, to, context) {
    const rows = await call('eth_getLogs', [{ address: REGISTRY, fromBlock: toQuantity(from), toBlock: toQuantity(to), topics: [TOPIC] }], context);
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error('privacy_relayer_logs_invalid');
    const positions = new Set();
    return rows.map((row) => {
      if (!row || row.removed !== false || row.address !== REGISTRY || !Array.isArray(row.topics) ||
          row.topics.length !== 1 || row.topics[0] !== TOPIC || typeof row.data !== 'string' || row.data.length > 4098) throw new Error('privacy_relayer_logs_invalid');
      const blockNumber = quantity(row.blockNumber), txIndex = quantity(row.transactionIndex), logIndex = quantity(row.logIndex);
      if (blockNumber < from || blockNumber > to) throw new Error('privacy_relayer_logs_invalid');
      word(row.blockHash); word(row.transactionHash);
      const position = `${blockNumber}:${txIndex}:${logIndex}`;
      if (positions.has(position)) throw new Error('privacy_relayer_logs_invalid');
      positions.add(position);
      let decoded;
      try { decoded = ABI.parseLog(row).args; } catch (_) { throw new Error('privacy_relayer_logs_invalid'); }
      return { ...candidate({ ensName: decoded.ensName, ensHash: decoded.relayer, registeredAddress: decoded.relayerAddress }), blockNumber, txIndex, logIndex };
    }).sort((a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
  }
  async function resolve(value, header, context) {
    const c = candidate(value);
    const owner = address((await view(ENS, 'owner', [c.ensHash], header, context))[0]);
    if (owner === ZeroAddress) return null;
    const metadata = await view(REGISTRY, 'relayers', [owner], header, context);
    if (metadata.ensHash !== c.ensHash || !(await view(REGISTRY, 'isRelayerRegistered', [owner, owner], header, context))[0]) return null;
    // Match the original RelayerAggregator: use the registered parent's
    // resolver for the mainnet-tornado child node's URL text record.
    const resolver = address((await view(ENS, 'resolver', [c.ensHash], header, context))[0]);
    if (resolver === ZeroAddress) return null;
    const endpoint = (await view(resolver, 'text', [urlNode(c.ensHash), 'url'], header, context))[0];
    if (Buffer.byteLength(endpoint) > 2048) throw new Error('privacy_relayer_endpoint_invalid');
    // The current owner must still own this exact registered ENS node. A past
    // registration event or a sufficient historical stake alone is not admission.
    return { ensName: c.ensName, ensHash: c.ensHash, owner, registryBalance: metadata.balance.toString(), endpoint };
  }
  async function rewardRegistered(owner, reward, header, context) {
    return (await view(REGISTRY, 'isRelayerRegistered', [address(owner), address(reward)], header, context))[0];
  }
  return { head, block, assertBlock, assertSource, events, resolve, rewardRegistered };
}
module.exports = { createPrivacyRelayerRpc, TOPIC };
