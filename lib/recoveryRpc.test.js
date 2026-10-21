const { Interface, keccak256, toBeHex, zeroPadValue } = require('ethers');
const {
  createRecoveryRpc,
  slot,
  scheduleWord,
  MODULE_ABI,
  ACCOUNT_ABI,
  ZERO_HASH,
  MAX_BLOCK_AGE_MS,
} = require('./recoveryRpc');
const ACCOUNT = '0x' + '11'.repeat(20),
  MODULE = '0x' + '22'.repeat(20),
  OP = '0x' + '33'.repeat(32),
  HASH = '0x' + '44'.repeat(32);
const time = 1800000000;
function fixture(overrides = {}) {
  const storage = new Map([
    [slot('address', ACCOUNT, 3), OP],
    [slot('bytes32', OP, 4), zeroPadValue(toBeHex(time), 32)],
  ]);
  const request = jest.fn(async (method, args) => {
    if (method === 'eth_chainId') return '0xdee1';
    if (method === 'eth_getBlockByNumber')
      return {
        number: args[0] === 'latest' ? '0x64' : args[0],
        hash: HASH,
        timestamp: toBeHex(time),
      };
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_getStorageAt') return storage.get(args[1]) || ZERO_HASH;
    if (method === 'eth_call') {
      const data = args[0].data;
      if (data.startsWith(MODULE_ABI.getFunction('config').selector))
        return MODULE_ABI.encodeFunctionResult('config', [
          [259200, 604800, 1, true],
        ]);
      if (data.startsWith(MODULE_ABI.getFunction('policyEpoch').selector))
        return MODULE_ABI.encodeFunctionResult('policyEpoch', [1]);
      if (
        data.startsWith(ACCOUNT_ABI.getFunction('isModuleInstalled').selector)
      )
        return ACCOUNT_ABI.encodeFunctionResult('isModuleInstalled', [true]);
      if (data.startsWith(ACCOUNT_ABI.getFunction('isValidSignature').selector))
        return ACCOUNT_ABI.encodeFunctionResult('isValidSignature', [
          '0x1626ba7e',
        ]);
    }
    throw new Error('unexpected_call');
  });
  const chain = {
    chainId: 57057,
    recoveryModule: MODULE,
    runtimeHash: keccak256('0x6000'),
    confirmations: 2,
    ...overrides,
  };
  return {
    rpc: createRecoveryRpc(chain, { request, now: () => time * 1000 }),
    request,
    storage,
    chain,
  };
}
test('storage layout decodes uint48 and flags without assuming private slots are public methods', () => {
  expect(
    scheduleWord(zeroPadValue(toBeHex(BigInt(time) | (1n << 48n)), 32))
  ).toEqual({ scheduledAt: time, executed: true, canceled: false });
  expect(
    scheduleWord(zeroPadValue(toBeHex(BigInt(time) | (1n << 56n)), 32))
  ).toEqual({ scheduledAt: time, executed: false, canceled: true });
  expect(() => scheduleWord('0x' + 'ff'.repeat(32))).toThrow(
    'unsupported_recovery_layout'
  );
});
test('attests exact runtime and chain and reads all state at one canonical block', async () => {
  const f = fixture();
  const head = await f.rpc.head();
  const s = await f.rpc.snapshot(ACCOUNT, [], head);
  expect(head.number).toBe(98);
  expect(s.activeOperationId).toBe(OP);
  expect(s.schedules[OP].scheduledAt).toBe(time);
  expect(
    f.request.mock.calls
      .filter(([m]) =>
        ['eth_call', 'eth_getCode', 'eth_getStorageAt'].includes(m)
      )
      .every(([, p]) => p[p.length - 1] === '0x62')
  ).toBe(true);
});
test.each([
  ['stale', MAX_BLOCK_AGE_MS / 1000 + 1],
  ['future', -31],
])(
  'rejects a %s confirmed anchor even while the latest block is fresh',
  async (_, age) => {
    const f = fixture();
    const original = f.request.getMockImplementation();
    f.request.mockImplementation(async (method, args) => {
      const result = await original(method, args);
      if (method === 'eth_getBlockByNumber' && args[0] !== 'latest')
        result.timestamp = toBeHex(time - age);
      return result;
    });
    await expect(f.rpc.head()).rejects.toThrow('recovery_chain_stale');
    expect(f.chain.confirmations).toBe(2);
    expect(
      f.request.mock.calls.some(([method]) => method === 'eth_getCode')
    ).toBe(false);
  }
);
test('accepts a confirmed anchor at the freshness limit without reducing confirmations', async () => {
  const f = fixture();
  const original = f.request.getMockImplementation();
  f.request.mockImplementation(async (method, args) => {
    const result = await original(method, args);
    if (method === 'eth_getBlockByNumber' && args[0] !== 'latest')
      result.timestamp = toBeHex(time - MAX_BLOCK_AGE_MS / 1000);
    return result;
  });
  await expect(f.rpc.head()).resolves.toMatchObject({
    number: 98,
    timestamp: time - MAX_BLOCK_AGE_MS / 1000,
  });
});
test.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid server-owned block-age limit %s',
  (maxBlockAgeMs) => {
    expect(() => fixture({ maxBlockAgeMs })).toThrow(
      'invalid_recovery_block_age'
    );
  }
);
test.each([NaN, Infinity, -1, 0.5])(
  'rejects invalid confirmation depth %s',
  (confirmations) => {
    expect(() => fixture({ confirmations })).toThrow(
      'invalid_recovery_confirmations'
    );
  }
);
test('scoped latest-observed policy accepts normal sparse blocks without a future-block wait', async () => {
  const f = fixture({ confirmations: 0, maxBlockAgeMs: 420000 });
  const original = f.request.getMockImplementation();
  f.request.mockImplementation(async (method, args) => {
    const result = await original(method, args);
    if (method === 'eth_getBlockByNumber')
      result.timestamp = toBeHex(time - 330);
    return result;
  });
  const block = await f.rpc.head();
  const snapshot = await f.rpc.snapshot(ACCOUNT, [], block);
  expect(block).toMatchObject({ number: 100, timestamp: time - 330 });
  expect(snapshot.activeOperationId).toBe(OP);
  expect(
    f.request.mock.calls
      .filter(([m]) => m === 'eth_getBlockByNumber')
      .every(([, p]) => p[0] === 'latest' || p[0] === '0x64')
  ).toBe(true);
});
test('scoped latest-observed policy still rejects a chain older than seven minutes', async () => {
  const f = fixture({ confirmations: 0, maxBlockAgeMs: 420000 });
  const original = f.request.getMockImplementation();
  f.request.mockImplementation(async (method, args) => {
    const result = await original(method, args);
    if (method === 'eth_getBlockByNumber')
      result.timestamp = toBeHex(time - 421);
    return result;
  });
  await expect(f.rpc.head()).rejects.toThrow('recovery_chain_stale');
});
test('wrong bytecode or chain cannot produce a snapshot', async () => {
  const f = fixture();
  f.chain.runtimeHash = keccak256('0x6001');
  await expect(f.rpc.snapshot(ACCOUNT)).rejects.toThrow(
    'recovery_module_mismatch'
  );
});
test('ordinary EOA produces an actionable recovery-not-installed error', async () => {
  const f = fixture();
  const original = f.request.getMockImplementation();
  f.request.mockImplementation((method, args) =>
    method === 'eth_getCode' && args[0] === ACCOUNT
      ? '0x'
      : original(method, args)
  );
  await expect(f.rpc.snapshot(ACCOUNT)).rejects.toThrow(
    'recovery_not_installed'
  );
  expect(
    f.request.mock.calls.some(([method]) => method === 'eth_getStorageAt')
  ).toBe(false);
});
test('odd-length block quantities stay canonical across headers, calls, storage and logs', async () => {
  const f = fixture();
  const original = f.request.getMockImplementation();
  const quantity = (value) =>
    expect(value).toMatch(/^0x(?:0|[1-9a-f][0-9a-f]*)$/);
  f.request.mockImplementation(async (method, args) => {
    if (method === 'eth_getBlockByNumber' && args[0] !== 'latest')
      quantity(args[0]);
    if (method === 'eth_getCode') quantity(args[1]);
    if (method === 'eth_getStorageAt') quantity(args[2]);
    if (method === 'eth_call') quantity(args[1]);
    if (method === 'eth_getLogs') {
      quantity(args[0].fromBlock);
      quantity(args[0].toBlock);
      return [];
    }
    const value = await original(method, args);
    if (method === 'eth_getBlockByNumber' && args[0] === 'latest')
      value.number = '0x102';
    return value;
  });
  const head = await f.rpc.head();
  expect(head.number).toBe(256);
  await f.rpc.snapshot(ACCOUNT, [], head);
  await f.rpc.verifySignature(ACCOUNT, 'Test quantity', '0x1234', head);
  await f.rpc.logs(ACCOUNT, 1, 256);
  expect(
    f.request.mock.calls.some(
      ([method, args]) =>
        method === 'eth_getBlockByNumber' && args[0] === '0x100'
    )
  ).toBe(true);
});
test('changed canonical hash fails closed after reads', async () => {
  const f = fixture();
  let calls = 0;
  const original = f.request.getMockImplementation();
  f.request.mockImplementation(async (m, p) => {
    const value = await original(m, p);
    if (m === 'eth_getBlockByNumber' && ++calls >= 3)
      value.hash = '0x' + '55'.repeat(32);
    return value;
  });
  await expect(f.rpc.snapshot(ACCOUNT)).rejects.toThrow('recovery_reorg');
});
test('ERC1271 uses raw EIP191 hash and accepts the complete long wallet signature', async () => {
  const f = fixture();
  const signature = '0x' + 'aa'.repeat(10000);
  expect(await f.rpc.verifySignature(ACCOUNT, 'Enable alerts', signature)).toBe(
    true
  );
  const call = f.request.mock.calls.find(
    ([m, p]) =>
      m === 'eth_call' &&
      p[0].data.startsWith(ACCOUNT_ABI.getFunction('isValidSignature').selector)
  );
  expect(
    ACCOUNT_ABI.decodeFunctionData('isValidSignature', call[1][0].data)[1]
  ).toBe(signature);
});
