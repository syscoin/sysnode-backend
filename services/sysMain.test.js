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

  test('CoinGecko call is issued with a timeout option (no indefinite hangs on the HTTP layer)', async () => {
    primeHappyRpc();
    await sysMain.tick();
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('api.coingecko.com'),
      expect.objectContaining({ timeout: expect.any(Number) })
    );
    const opts = axios.get.mock.calls[0][1];
    expect(opts.timeout).toBeGreaterThan(0);
  });

  test('a stalled tick that eventually resolves is discarded if a newer tick has already committed (stale-gen guard)', async () => {
    // First: seed a committed snapshot with a distinct sb1 value so we can
    // detect any late-arriving overwrite.
    primeHappyRpc();
    rpc.getGovernanceInfo.mockResolvedValueOnce({
      lastsuperblock: 2_036_160,
      nextsuperblock: 2_053_680,
      proposalfee: 50,
    });
    await sysMain.tick();
    const committedSb1 = data.sb1;
    const committedGen = sysMain.getDiagnostics().lastCommittedGen;
    expect(committedGen).toBeGreaterThan(0);

    // Now simulate a stalled tick. We start the stall BEFORE the newer
    // commit lands — mimicking the watchdog scenario where gen N is still
    // in flight when gen N+1 starts and commits ahead of it.
    let releaseStall;
    const stallPromise = new Promise((resolve) => {
      releaseStall = resolve;
    });
    rpc.masternode_count.mockReturnValueOnce(stallPromise);

    const stalledTick = sysMain.tick(); // gen = committedGen + 1 (N)
    // Let the stalled tick progress past the non-stalled awaits.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Meanwhile: a subsequent, normal tick (gen = committedGen + 2) runs
    // to completion and commits fresh values.
    rpc.getGovernanceInfo.mockResolvedValueOnce({
      lastsuperblock: 2_036_160,
      nextsuperblock: 2_071_200,
      proposalfee: 99,
    });
    const freshTick = await sysMain.tick();
    expect(freshTick.ok).toBe(true);
    expect(data.proposalFee).toBe(99);
    expect(data.sb1).not.toBe(committedSb1); // nextsuperblock rotated

    const newCommittedSb1 = data.sb1;
    const newCommittedProposalFee = data.proposalFee;

    // Now release the stalled tick. It should observe gen <= lastCommittedGen
    // and return without touching dataStore.
    releaseStall({ total: 9999, enabled: 9999 });
    const stalledResult = await stalledTick;
    expect(stalledResult.ok).toBe(false);
    expect(stalledResult.stale).toBe(true);

    // Fresh commit is preserved — no late-arriving rollback.
    expect(data.sb1).toBe(newCommittedSb1);
    expect(data.proposalFee).toBe(newCommittedProposalFee);
    expect(data.mnTotal).not.toBe(9999);
  });

  test('a late-rejecting stalled tick does NOT undo backoff nor touch dataStore', async () => {
    // Commit a good snapshot first.
    primeHappyRpc();
    await sysMain.tick();
    const goodSb1 = data.sb1;

    // Stall, then supersede with another tick that FAILS so backoff advances.
    let rejectStall;
    rpc.masternode_count.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectStall = reject;
      })
    );
    const stalledTick = sysMain.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    axios.get.mockRejectedValueOnce(new Error('Request failed with status code 429'));
    const freshFail = await sysMain.tick();
    expect(freshFail.ok).toBe(false);
    const backoffAfterFreshFail = sysMain.getDiagnostics().currentTickMs;
    expect(backoffAfterFreshFail).toBeGreaterThan(sysMain.BASE_TICK_MS);

    // Now let the stalled tick reject late.
    rejectStall(new Error('masternode_count timed out'));
    const stalledResult = await stalledTick;
    expect(stalledResult.ok).toBe(false);

    // dataStore unchanged relative to the most recent good commit.
    expect(data.sb1).toBe(goodSb1);
    // Backoff not double-applied by the late rejection.
    expect(sysMain.getDiagnostics().currentTickMs).toBe(backoffAfterFreshFail);
  });

  test('watchdog reschedules the next tick even if the current one never resolves', async () => {
    jest.useFakeTimers();
    try {
      primeHappyRpc();
      // Make masternode_count never resolve — simulating a stuck RPC socket.
      rpc.masternode_count.mockReturnValueOnce(new Promise(() => {}));

      sysMain.start();
      // Let the first kick-off microtasks drain.
      await Promise.resolve();
      await Promise.resolve();

      expect(sysMain.getDiagnostics().watchdogFires).toBe(0);

      // Advance fake time past the watchdog.
      jest.advanceTimersByTime(sysMain.TICK_WATCHDOG_MS + 100);
      await Promise.resolve();

      expect(sysMain.getDiagnostics().watchdogFires).toBe(1);
      // Backoff must have advanced since this tick never committed.
      expect(sysMain.getDiagnostics().currentTickMs).toBeGreaterThan(sysMain.BASE_TICK_MS);
      // And a next tick must have been scheduled.
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    } finally {
      sysMain.stop();
      jest.useRealTimers();
    }
  });

  test('currentBlock is pinned BEFORE the one-day-ago retry loop — a transient one-day-ago getBlockHash failure does NOT lower currentBlock (Codex round 2 P2)', async () => {
    primeHappyRpc();
    // Make the one-day-ago height lookup fail once then succeed, to force
    // the retry loop's cursor to decrement. The chain tip must remain at
    // 1_999_999 in the committed snapshot regardless.
    let oneDayCall = 0;
    rpc.getBlockHash.mockImplementation(async (h) => {
      if (h === 1_999_999) return 'hash:tip-1';
      if (h === 1_999_999 - 576) {
        oneDayCall++;
        if (oneDayCall === 1) throw new Error('transient node pause');
        return 'hash:tip-577';
      }
      return `hash:${h}`;
    });

    const res = await sysMain.tick();
    expect(res.ok).toBe(true);
    expect(data.currentBlock).toBe(1_999_999);
    // And sb1..sb5 projections are consistent with the pinned head.
    for (const n of [1, 2, 3, 4, 5]) {
      expect(data[`sb${n}`]).toBe(2_053_680 + 17520 * n);
    }
  });

  test('a single projected-sb budget RPC that hangs is bounded by SB_BUDGET_TIMEOUT_MS and does not prevent commit (Codex round 2 P1)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] });
    try {
      primeHappyRpc();
      // sb2 hangs forever; sb1/sb3/sb4/sb5 resolve fine.
      let heightCalls = 0;
      rpc.getSuperblockBudget.mockImplementation((height) => {
        if (height === undefined) return Promise.resolve(1_000_000);
        heightCalls++;
        if (heightCalls === 2) return new Promise(() => {}); // hang
        return Promise.resolve(2_000_000 + height);
      });

      const tickPromise = sysMain.tick();
      // Let the tick's awaits progress past the non-hanging work and queue
      // the withTimeout race for the stuck sb2 call.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      // Advance fake time past the per-sb timeout so the race rejects.
      jest.advanceTimersByTime(sysMain.SB_BUDGET_TIMEOUT_MS + 100);
      // Drain the resulting microtasks.
      for (let i = 0; i < 20; i++) await Promise.resolve();

      const res = await tickPromise;
      expect(res.ok).toBe(true);
      // sb2 falls back, the rest commit.
      expect(data.sb2Budget).toBe('To be determined');
      expect(data.sb1Budget).toBe(2_000_000 + data.sb1);
      expect(data.sb3Budget).toBe(2_000_000 + data.sb3);
      // And the main payload landed too.
      expect(data.budget).toBe(1_000_000);
      expect(data.mnEnabled).toBe(1_450);
    } finally {
      jest.useRealTimers();
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
