const axios = require('axios');
const {
  AbiCoder,
  Interface,
  keccak256,
  getAddress,
  hashMessage,
  toQuantity,
  zeroPadValue,
} = require('ethers');

const MODULE_ABI = new Interface([
  'function config(address) view returns ((uint32 delay,uint32 expiration,uint64 threshold,bool installed))',
  'function policyEpoch(address) view returns (uint256)',
  'event RecoveryScheduled(address indexed account,bytes32 indexed operationId,uint48 executableAt)',
  'event RecoveryCanceled(address indexed account,bytes32 indexed operationId)',
  'event RecoveryExecuted(address indexed account,bytes32 indexed operationId)',
]);
const ACCOUNT_ABI = new Interface([
  'function isValidSignature(bytes32,bytes) view returns (bytes4)',
  'function isModuleInstalled(uint256,address,bytes) view returns (bool)',
]);
const coder = AbiCoder.defaultAbiCoder();
const ZERO_HASH = '0x' + '00'.repeat(32);
const EVENT_TOPICS = [
  'RecoveryScheduled',
  'RecoveryCanceled',
  'RecoveryExecuted',
].map((name) => MODULE_ABI.getEvent(name).topicHash);
const MAX_BLOCK_AGE_MS = 120000;

function number(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value))
    throw new Error('invalid_rpc_quantity');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error('invalid_rpc_quantity');
  return n;
}
function word(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value))
    throw new Error('invalid_rpc_word');
  return value.toLowerCase();
}
function slot(type, key, base) {
  return keccak256(coder.encode([type, 'uint256'], [key, base]));
}
function scheduleWord(value) {
  const raw = BigInt(word(value));
  const scheduledAt = Number(raw & ((1n << 48n) - 1n));
  const executed = Number((raw >> 48n) & 255n);
  const canceled = Number((raw >> 56n) & 255n);
  if (executed > 1 || canceled > 1 || raw >> 64n !== 0n)
    throw new Error('unsupported_recovery_layout');
  return { scheduledAt, executed: executed === 1, canceled: canceled === 1 };
}

// No caller-controlled URL enters this adapter. The registry is maintained in
// source and each read verifies chain ID and the exact immutable module runtime.
function createRecoveryRpc(chain, { request, now = Date.now } = {}) {
  const maxBlockAgeMs = chain.maxBlockAgeMs ?? MAX_BLOCK_AGE_MS;
  if (!Number.isSafeInteger(maxBlockAgeMs) || maxBlockAgeMs <= 0)
    throw new Error('invalid_recovery_block_age');
  if (!Number.isSafeInteger(chain.confirmations) || chain.confirmations < 0)
    throw new Error('invalid_recovery_confirmations');
  let id = 0;
  const call =
    request ||
    (async (method, params) => {
      const current = ++id;
      const response = await axios.post(
        chain.rpcUrl,
        { jsonrpc: '2.0', id: current, method, params },
        {
          timeout: 10000,
          maxRedirects: 0,
          maxContentLength: 2 * 1024 * 1024,
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const body = response.data;
      if (
        !body ||
        body.jsonrpc !== '2.0' ||
        body.id !== current ||
        body.error ||
        !Object.hasOwn(body, 'result')
      )
        throw new Error('recovery_rpc_error');
      return body.result;
    });
  const getBlock = async (n) => {
    const b = await call('eth_getBlockByNumber', [
      typeof n === 'string' ? n : toQuantity(n),
      false,
    ]);
    if (!b) throw new Error('missing_rpc_block');
    return {
      number: number(b.number),
      hash: word(b.hash),
      timestamp: number(b.timestamp),
    };
  };
  const assertBlock = async (block) => {
    const after = await getBlock(block.number);
    if (after.hash !== block.hash) throw new Error('recovery_reorg');
  };
  const attest = async (block) => {
    if (number(await call('eth_chainId', [])) !== chain.chainId)
      throw new Error('recovery_wrong_chain');
    const code = await call('eth_getCode', [
      chain.recoveryModule,
      toQuantity(block.number),
    ]);
    if (
      typeof code !== 'string' ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(code) ||
      keccak256(code) !== chain.runtimeHash
    )
      throw new Error('recovery_module_mismatch');
  };
  const view = async (target, iface, fn, args, block) =>
    iface.decodeFunctionResult(
      fn,
      await call('eth_call', [
        {
          to: target,
          data: iface.encodeFunctionData(fn, args),
          gas: '0x1312d00',
        },
        toQuantity(block.number),
      ])
    );
  async function head() {
    const latest = await getBlock('latest');
    const assertFresh = (header) => {
      const age = now() - header.timestamp * 1000;
      if (age < -30000 || age > maxBlockAgeMs)
        throw new Error('recovery_chain_stale');
    };
    assertFresh(latest);
    const block = await getBlock(
      Math.max(0, latest.number - chain.confirmations)
    );
    // A fresh tip can follow a long halt. The selected state must also meet
    // this chain's finite freshness policy. Zero confirmations means the
    // latest canonical observation; hash fences do not make it finalized.
    assertFresh(block);
    await attest(block);
    await assertBlock(block);
    return block;
  }
  async function snapshot(account, operationIds = [], block) {
    block = block || (await head());
    await attest(block);
    const tag = toQuantity(block.number);
    const accountCode = await call('eth_getCode', [account, tag]);
    if (accountCode === '0x') {
      await assertBlock(block);
      throw new Error('recovery_not_installed');
    }
    if (
      typeof accountCode !== 'string' ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(accountCode)
    )
      throw new Error('invalid_account_code');
    const [configResult, installedResult, epochResult, activeResult] =
      await Promise.all([
        view(chain.recoveryModule, MODULE_ABI, 'config', [account], block),
        view(
          account,
          ACCOUNT_ABI,
          'isModuleInstalled',
          [2, chain.recoveryModule, '0x'],
          block
        ),
        view(chain.recoveryModule, MODULE_ABI, 'policyEpoch', [account], block),
        call('eth_getStorageAt', [
          chain.recoveryModule,
          slot('address', account, 3),
          tag,
        ]),
      ]);
    const config = configResult[0];
    const installed = installedResult[0];
    const epoch = epochResult[0].toString();
    // Solidity layout is pinned by the runtime attestation above. _activeRecovery
    // is mapping(address=>bytes32) at slot 3; _schedules is mapping(bytes32=>
    // RecoverySchedule) at slot 4. No archive-history guess about policy epochs
    // is necessary, even for uninstall/reinstall in the very same block.
    const activeOperationId = word(activeResult);
    const ids = [
      ...new Set(
        [...operationIds, activeOperationId].filter((v) => v !== ZERO_HASH)
      ),
    ];
    const schedules = {};
    if (ids.length > 1000) throw new Error('recovery_log_capacity');
    for (let offset = 0; offset < ids.length; offset += 4) {
      await Promise.all(
        ids.slice(offset, offset + 4).map(async (op) => {
          schedules[word(op)] = scheduleWord(
            await call('eth_getStorageAt', [
              chain.recoveryModule,
              slot('bytes32', op, 4),
              tag,
            ])
          );
        })
      );
    }
    await assertBlock(block);
    return {
      block,
      installed: Boolean(installed && config.installed),
      delay: Number(config.delay),
      expiration: Number(config.expiration),
      epoch,
      activeOperationId,
      schedules,
    };
  }
  async function verifySignature(account, message, signature, block) {
    block = block || (await head());
    const code = await call('eth_getCode', [account, toQuantity(block.number)]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code))
      return false;
    const result = await view(
      account,
      ACCOUNT_ABI,
      'isValidSignature',
      [hashMessage(message), signature],
      block
    );
    await assertBlock(block);
    return result[0] === '0x1626ba7e';
  }
  async function logs(account, from, to) {
    const rows = await call('eth_getLogs', [
      {
        address: chain.recoveryModule,
        fromBlock: toQuantity(from),
        toBlock: toQuantity(to),
        topics: [EVENT_TOPICS, zeroPadValue(getAddress(account), 32)],
      },
    ]);
    if (!Array.isArray(rows) || rows.length > 10000)
      throw new Error('invalid_recovery_logs');
    return rows
      .map((log) => {
        if (
          !log ||
          log.removed ||
          String(log.address).toLowerCase() !==
            chain.recoveryModule.toLowerCase() ||
          !Array.isArray(log.topics)
        )
          throw new Error('invalid_recovery_log');
        const parsed = MODULE_ABI.parseLog(log);
        if (
          !parsed ||
          String(parsed.args.account).toLowerCase() !== account.toLowerCase()
        )
          throw new Error('invalid_recovery_log');
        const blockNumber = number(log.blockNumber);
        if (blockNumber < from || blockNumber > to)
          throw new Error('invalid_recovery_log');
        return {
          kind: parsed.name,
          operationId: word(parsed.args.operationId),
          executableAt:
            parsed.name === 'RecoveryScheduled'
              ? Number(parsed.args.executableAt)
              : null,
          blockNumber,
          blockHash: word(log.blockHash),
          txHash: word(log.transactionHash),
          index: number(log.logIndex),
        };
      })
      .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  }
  return {
    head,
    getBlock,
    assertBlock,
    snapshot,
    verifySignature,
    logs,
    chain,
  };
}
module.exports = {
  createRecoveryRpc,
  MODULE_ABI,
  ACCOUNT_ABI,
  ZERO_HASH,
  scheduleWord,
  slot,
  MAX_BLOCK_AGE_MS,
};
