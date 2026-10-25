'use strict';

// Original Tornado Classic ETH instances. Pinned upstream registry:
// tornadocash/tornado-cli@378ddf8b8b92a4924037d7b64a94dbfd5a7dd6e8/config.js
const POOLS = Object.freeze([
  { id: 'eth-0.1', address: '0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc', denomination: '100000000000000000', deploymentBlock: 9116966 },
  { id: 'eth-1', address: '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936', denomination: '1000000000000000000', deploymentBlock: 9117609 },
  { id: 'eth-10', address: '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', denomination: '10000000000000000000', deploymentBlock: 9117720 },
  { id: 'eth-100', address: '0xa160cdab225685da1d56aa342ad8841c3b53f291', denomination: '100000000000000000000', deploymentBlock: 9161895 },
].map(Object.freeze));
const MAX_LEAVES = 2 ** 20;
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function getPool(id) {
  return POOLS.find((pool) => pool.id === id);
}

function word(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error('privacy_invalid_word');
  return value;
}

function fieldWord(value) {
  word(value);
  if (BigInt(value) >= FIELD_SIZE) throw new Error('privacy_invalid_field');
  return value;
}

module.exports = { POOLS, MAX_LEAVES, FIELD_SIZE, getPool, word, fieldWord };
