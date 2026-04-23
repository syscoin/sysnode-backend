const data = require('../data/dataStore');

jest.mock('../services/rpcClient', () => {
  const mockCalls = {
    getNetworkInfo: jest.fn(),
    getBlock: jest.fn(),
    getBlockCount: jest.fn(),
    getBlockHash: jest.fn(),
    getGovernanceInfo: jest.fn(),
    getSuperblockBudget: jest.fn(),
    masternode_count: jest.fn(),
  };
  const builder = (fn) => ({ call: () => fn() });
  const rpcServices = () => ({
    getNetworkInfo: () => builder(mockCalls.getNetworkInfo),
    getBlock: (hash) => builder(() => mockCalls.getBlock(hash)),
    getBlockCount: () => builder(mockCalls.getBlockCount),
    getBlockHash: (h) => builder(() => mockCalls.getBlockHash(h)),
    getGovernanceInfo: () => builder(mockCalls.getGovernanceInfo),
    // Core supports both getSuperblockBudget() and getSuperblockBudget(height).
    // Dispatch by arity so tests can distinguish the "current" call from the
    // projected sb1..sb5 calls.
    getSuperblockBudget: (height) =>
      builder(() =>
        height === undefined
          ? mockCalls.getSuperblockBudget()
          : mockCalls.getSuperblockBudget(height)
      ),
    masternode_count: () => builder(mockCalls.masternode_count),
  });
  return {
    client: { callRpc: jest.fn() },
    rpcServices,
    __mockCalls: mockCalls,
  };
});

jest.mock('axios');
const axios = require('axios');
const { __mockCalls: rpc } = require('../services/rpcClient');

const INITIAL_DATA_SNAPSHOT = JSON.parse(JSON.stringify(data));

const HAPPY_GECKO = {
  data: {
    market_data: {
      current_price: { usd: 0.12, btc: 0.0000018 },
      circulating_supply: 700_000_000,
      total_supply: 888_000_000,
      market_cap: { usd: 84_000_000, btc: 1_260 },
      total_volume: { usd: 1_000_000, btc: 15 },
      price_change_percentage_24h: -1.23,
    },
  },
};

function primeHappyRpc() {
  rpc.getNetworkInfo.mockResolvedValue({
    version: 5080200,
    subversion: '/Syscoin Core:5.0.8.2/',
    protocolversion: 70022,
  });
  rpc.getBlock.mockImplementation(async (hash) => {
    if (hash === '00000c255f9999002258ddd4d4c86a4b758a5e2ec07e7d69b3e8e7f3fbd44b92') {
      return { time: 1456832400 }; // genesis
    }
    if (hash === 'hash:tip-1') return { time: 1_700_000_600 };
    if (hash === 'hash:tip-577') return { time: 1_700_000_600 - 86_400 };
    return { time: 1_700_000_600 };
  });
  rpc.getBlockCount.mockResolvedValue(2_000_000);
  rpc.getBlockHash.mockImplementation(async (h) => {
    if (h === 1_999_999) return 'hash:tip-1';
    if (h === 1_999_999 - 576) return 'hash:tip-577';
    return `hash:${h}`;
  });
  rpc.getGovernanceInfo.mockResolvedValue({
    lastsuperblock: 2_036_160,
    nextsuperblock: 2_053_680,
    proposalfee: 50,
  });
  // Current-cycle budget (no-arg call).
  rpc.getSuperblockBudget.mockImplementation(async (height) => {
    if (height === undefined) return 927_712;
    // Projected sb1..sb5 budgets (height-arg call).
    return 927_712 + height;
  });
  rpc.masternode_count.mockResolvedValue({ total: 1_500, enabled: 1_450 });
  axios.get.mockResolvedValue(HAPPY_GECKO);
}

function resetDataStoreToInitial() {
  for (const k of Object.keys(data)) delete data[k];
  Object.assign(data, JSON.parse(JSON.stringify(INITIAL_DATA_SNAPSHOT)));
}

// NOTE: we deliberately DO NOT call jest.resetModules() in beforeEach. The
// axios + rpcClient jest.mock() bindings at the top of this file are resolved
// against the cached module instance; resetModules() would cause sysMain to
// re-require fresh copies while the test's mock references still point at
// the stale ones, which silently decouples them. Instead we expose a
// __resetForTests() hook on sysMain to clear in-module state (currentTickMs,
// lastGoodAt, etc.) between tests.
process.env.NODE_ENV = 'test'; // suppress auto-start at require time
const sysMain = require('./sysMain');

describe('sysMain periodic aggregator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDataStoreToInitial();
    sysMain.__resetForTests();
  });

  afterEach(() => {
    sysMain.stop();
  });

  test('does NOT auto-start when NODE_ENV=test (tests drive the loop)', () => {
    // If it auto-started, currentTickMs would have changed or lastGoodAt would be set.
    expect(sysMain.getDiagnostics().lastGoodAt).toBe(0);
    expect(sysMain.getDiagnostics().currentTickMs).toBe(sysMain.BASE_TICK_MS);
  });

  test('successful tick atomically populates every expected dataStore field', async () => {
    primeHappyRpc();

    const res = await sysMain.tick();
    expect(res.ok).toBe(true);

    // Market fields (from CoinGecko)
    expect(data.sysUsd).toBe(0.12);
    expect(data.sysBtc).toBe(0.0000018);
    expect(data.circulatingSupply).toBe(700_000_000);
    expect(data.totalSupply).toBe(888_000_000);
    expect(data.marketCap).toBe(84_000_000);
    expect(data.volume).toBe(1_000_000);
    expect(data.priceChange).toBeCloseTo(-1.23);

    // Chain fields (from RPC)
    expect(data.version).toBe(5080200);
    expect(data.protocol).toBe(70022);
    expect(data.currentBlock).toBe(1_999_999);
    expect(typeof data.avgBlockTime).toBe('number');
    expect(data.avgBlockTime).toBeGreaterThan(0);

    // Governance fields
    expect(data.lastSuperBlock).toBe(2_036_160);
    expect(data.nextSuperBlock).toBe(2_053_680);
    expect(data.proposalFee).toBe(50);
    expect(data.budget).toBe(927_712);
    expect(typeof data.superBlockNextDate).toBe('string');
    expect(Number.isFinite(data.superBlockNextEpochSec)).toBe(true);
    expect(data.superBlockNextEpochSec).toBeGreaterThan(0);

    // Projected sb1..sb5 and their budgets
    for (const n of [1, 2, 3, 4, 5]) {
      expect(data[`sb${n}`]).toBe(2_053_680 + 17520 * n);
      expect(data[`sb${n}Budget`]).toBe(927_712 + (2_053_680 + 17520 * n));
      expect(typeof data[`sb${n}EstDate`]).toBe('string');
    }

    // Masternode counts
    expect(data.mnTotal).toBe(1_500);
    expect(data.mnEnabled).toBe(1_450);
    expect(data.poseBanned).toBe(50);
  });

  test('successful tick resets the backoff to BASE_TICK_MS', async () => {
    primeHappyRpc();
    // Simulate a prior failure that ramped the backoff.
    axios.get.mockRejectedValueOnce(new Error('Request failed with status code 429'));
    const failRes = await sysMain.tick();
    expect(failRes.ok).toBe(false);
    expect(sysMain.getDiagnostics().currentTickMs).toBeGreaterThan(sysMain.BASE_TICK_MS);

    // Happy path on next tick.
    axios.get.mockResolvedValueOnce(HAPPY_GECKO);
    const okRes = await sysMain.tick();
    expect(okRes.ok).toBe(true);
    expect(sysMain.getDiagnostics().currentTickMs).toBe(sysMain.BASE_TICK_MS);
  });

  test('CoinGecko 429 leaves dataStore UNCHANGED (no partial writes, cold-start stays at initial defaults)', async () => {
    axios.get.mockRejectedValue(new Error('Request failed with status code 429'));
    // RPC primed but should never be called.
    primeHappyRpc();
    axios.get.mockRejectedValue(new Error('Request failed with status code 429'));

    const res = await sysMain.tick();
    expect(res.ok).toBe(false);

    // Every field should still be at its initial value — no partial writes.
    for (const [k, v] of Object.entries(INITIAL_DATA_SNAPSHOT)) {
      expect(data[k]).toEqual(v);
    }
    // RPC should not have been touched (CoinGecko is sequential-first).
    expect(rpc.getNetworkInfo).not.toHaveBeenCalled();
    expect(rpc.masternode_count).not.toHaveBeenCalled();
  });

  test('CoinGecko 429 does NOT wipe a previously good snapshot', async () => {
    primeHappyRpc();
    const firstTick = await sysMain.tick();
    expect(firstTick.ok).toBe(true);

    const good = {
      sysUsd: data.sysUsd,
      nextSuperBlock: data.nextSuperBlock,
      superBlockNextEpochSec: data.superBlockNextEpochSec,
      mnEnabled: data.mnEnabled,
      sb3Budget: data.sb3Budget,
    };

    axios.get.mockRejectedValueOnce(new Error('Request failed with status code 429'));
    const failTick = await sysMain.tick();
    expect(failTick.ok).toBe(false);

    // Previous good values persist verbatim.
    expect(data.sysUsd).toBe(good.sysUsd);
    expect(data.nextSuperBlock).toBe(good.nextSuperBlock);
    expect(data.superBlockNextEpochSec).toBe(good.superBlockNextEpochSec);
    expect(data.mnEnabled).toBe(good.mnEnabled);
    expect(data.sb3Budget).toBe(good.sb3Budget);
  });

  test('RPC failure mid-tick does NOT partially mutate dataStore (atomic commit)', async () => {
    // CoinGecko succeeds, chain-head succeeds, but governance fails.
    axios.get.mockResolvedValue(HAPPY_GECKO);
    rpc.getNetworkInfo.mockResolvedValue({ version: 1, subversion: '/x/', protocolversion: 1 });
    rpc.getBlock.mockResolvedValue({ time: 1_700_000_000 });
    rpc.getBlockCount.mockResolvedValue(10);
    rpc.getBlockHash.mockResolvedValue('hash');
    rpc.getGovernanceInfo.mockRejectedValue(new Error('Core unavailable'));
    rpc.masternode_count.mockResolvedValue({ total: 1, enabled: 1 });

    const res = await sysMain.tick();
    expect(res.ok).toBe(false);

    // Even though CoinGecko and network info succeeded, nothing lands in
    // dataStore because the tick as a whole failed.
    for (const [k, v] of Object.entries(INITIAL_DATA_SNAPSHOT)) {
      expect(data[k]).toEqual(v);
    }
  });

  test('per-sb getSuperblockBudget failure falls back to "To be determined" and does NOT abort the tick', async () => {
    primeHappyRpc();
    // First call (no-arg, current cycle) is fine; sb1..sb5 projections 2,4 fail.
    let heightCalls = 0;
    rpc.getSuperblockBudget.mockImplementation(async (height) => {
      if (height === undefined) return 1_000_000;
      heightCalls++;
      // Fail the 2nd and 4th sb projection calls specifically.
      if (heightCalls === 2 || heightCalls === 4) {
        throw new Error('block height not found');
      }
      return 2_000_000 + height;
    });

    const res = await sysMain.tick();
    expect(res.ok).toBe(true);
    expect(data.budget).toBe(1_000_000);

    const failedBuckets = [2, 4];
    for (const n of [1, 2, 3, 4, 5]) {
      if (failedBuckets.includes(n)) {
        expect(data[`sb${n}Budget`]).toBe('To be determined');
      } else {
        expect(data[`sb${n}Budget`]).toBe(2_000_000 + data[`sb${n}`]);
      }
    }
  });

  test('consecutive failures apply exponential backoff up to MAX_BACKOFF_MS', async () => {
    axios.get.mockRejectedValue(new Error('Request failed with status code 429'));
    // Run many ticks and confirm the delay never exceeds MAX_BACKOFF_MS and
    // doubles monotonically until the ceiling.
    const seen = [];
    for (let i = 0; i < 12; i++) {
      await sysMain.tick();
      seen.push(sysMain.getDiagnostics().currentTickMs);
    }
    // Monotonically non-decreasing.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    // Reaches but does not exceed the ceiling.
    expect(Math.max(...seen)).toBe(sysMain.MAX_BACKOFF_MS);
    expect(seen.every((ms) => ms <= sysMain.MAX_BACKOFF_MS)).toBe(true);
    // First failure: base*2
    expect(seen[0]).toBe(sysMain.BASE_TICK_MS * 2);
  });
});
