const moment = require("moment");
const axios = require("axios");
const { client, rpcServices } = require("../services/rpcClient");
const data = require("../data/dataStore");
const {
  markStatsSuccess,
  markStatsFailure,
  resetStatsMetadata,
} = require("../lib/statsSnapshot");

// ─────────────────────────────────────────────────────────────────────────────
// sysMain — periodic aggregation of market + chain + governance stats into the
// shared dataStore consumed by /mnstats (via services/calculations.js).
//
// Robustness model:
//   • Chain, governance and node counts commit as one last-good snapshot.
//     Optional market data has a separate snapshot and retry clock: a public
//     price-feed outage must not prevent healthy Core stats from refreshing.
//     Failed groups retain their values but become stale; never-fetched groups
//     remain unavailable, so initial zero defaults are not presented as facts.
//   • Independent exponential backoff on Core and market failures. A market
//     rate-limit does not slow down the normal 20s Core polling cadence, and
//     Core failure cannot cause the price API to be hammered on every retry.
//   • Per-sb budget failures are isolated. getSuperblockBudget() for each of
//     sb1..sb5 is allowed to fail individually (the RPC sometimes returns
//     "block height not found" for projections too far in the future). A
//     per-sb failure falls back to "To be determined" and does not abort the
//     whole tick — matching the prior fire-and-forget .catch semantics.
//   • Watchdog-driven rescheduling. The previous setInterval kept firing
//     every 20s even when a tick was stuck mid-call. Switching naively to
//     "await tick(); then schedule next" reintroduces a failure mode where
//     a hung CoinGecko or RPC socket (no upstream timeout is configured on
//     the RPC client) freezes the loop forever, so /mnstats stays stale
//     indefinitely. We instead schedule the next tick from whichever fires
//     first: tick completion OR a TICK_WATCHDOG_MS timer. A tick generation
//     counter guards against a stalled tick later resolving and overwriting
//     a committed payload from a subsequent tick.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_TICK_MS = 20_000;
const MAX_BACKOFF_MS = 5 * 60_000; // 5 min ceiling
const TICK_WATCHDOG_MS = 60_000;   // 60s hard cap per tick before forced reschedule
const COINGECKO_TIMEOUT_MS = 10_000;
// Per-RPC timeout for getSuperblockBudget. The SyscoinRpcClient has no
// configurable socket timeout, so any individual call that hangs would
// sit inside Promise.allSettled until the outer tick watchdog fires and
// abandons the whole tick. With five projected-sb calls and a single
// repeatedly-hanging height, every generation would get abandoned and
// /mnstats would stop refreshing even though market/chain/governance
// reads all succeeded. A per-call race forces each projected budget
// lookup to fall back to "To be determined" after this deadline.
const SB_BUDGET_TIMEOUT_MS = 5_000;
const SUPERBLOCK_INTERVAL = 17520; // mainnet nSuperblockCycle (kept identical to previous logic)
const GENESIS_HASH = "00000c255f9999002258ddd4d4c86a4b758a5e2ec07e7d69b3e8e7f3fbd44b92";
const CORE_GROUPS = ["chain", "node", "governance"];

// Promise.race a work-promise against a timeout timer. The timer is unref'd
// so it can never keep the event loop alive on its own, and is cleared on
// either outcome so GC collects it promptly.
function withTimeout(promise, ms, label) {
  let timerHandle;
  const timeout = new Promise((_, reject) => {
    timerHandle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    if (timerHandle && typeof timerHandle.unref === "function") timerHandle.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timerHandle) clearTimeout(timerHandle);
  });
}

let currentTickMs = BASE_TICK_MS;
let marketTickMs = BASE_TICK_MS;
let marketNextAt = 0;
let lastGoodAt = 0;         // ms epoch of the last successful Core snapshot
let tickTimer = null;
let stopped = false;
let started = false;        // idempotency guard for start(); set synchronously so two
                             // near-simultaneous start() calls can't both spawn
                             // independent scheduler loops (tickTimer alone is not
                             // sufficient because runAndReschedule() only sets it
                             // after the in-flight tick finishes / the watchdog fires)
let activeRunToken = null;  // unique-per-run-loop token. Captured by runAndReschedule,
                             // invalidated by stop(). rescheduleOnce / watchdog compare
                             // against this so callbacks created before a stop()+start()
                             // cycle cannot affect the post-restart loop (Codex round 4 P2).
let tickGen = 0;            // monotonically increasing per tick()
let lastCommittedGen = 0;   // gen of the newest tick that successfully committed
let lastCompletedGen = 0;   // gen of the newest tick whose result has been published
                             // (committed OR rejected OR watchdog-abandoned). Used to
                             // no-op late-arriving results from superseded ticks so a
                             // stalled tick can't roll back backoff or overwrite data.
let lastCoreCompletedGen = 0;
let lastMarketCompletedGen = 0;
let lastMarketStartedGen = 0;
let watchdogFires = 0;      // observability / tests

async function fetchMarketData() {
  const gecko = await axios.get(
    "https://api.coingecko.com/api/v3/coins/syscoin?tickers=true&market_data=true",
    { timeout: COINGECKO_TIMEOUT_MS }
  );
  const m = gecko.data && gecko.data.market_data;
  if (!m || typeof m !== "object") throw new Error("Invalid market data response");
  // CoinGecko can legitimately omit individual quantities (for example total
  // supply). Missing/non-finite values are unavailable, never zero estimates.
  const quantity = (value) =>
    Number.isFinite(value) && value >= 0 ? value : null;
  const result = {
    sysUsd: quantity(m.current_price?.usd),
    sysBtc: quantity(m.current_price?.btc),
    circulatingSupply: quantity(m.circulating_supply),
    totalSupply: quantity(m.total_supply),
    marketCap: quantity(m.market_cap?.usd),
    marketCapBtc: quantity(m.market_cap?.btc),
    volume: quantity(m.total_volume?.usd),
    volumeBtc: quantity(m.total_volume?.btc),
    priceChange: Number.isFinite(m.price_change_percentage_24h)
      ? m.price_change_percentage_24h : null,
  };
  if (Object.values(result).every((value) => value === null)) {
    throw new Error("Market response contains no usable statistics");
  }
  return result;
}

async function fetchChainHead() {
  const network = await rpcServices(client.callRpc).getNetworkInfo().call();
  const genesis = await rpcServices(client.callRpc).getBlock(GENESIS_HASH).call();

  const blockCount = await rpcServices(client.callRpc).getBlockCount().call();
  let block = blockCount;
  let blockHash;
  while (block > 0) {
    try {
      blockHash = await rpcServices(client.callRpc).getBlockHash(block - 1).call();
      block--;
      break;
    } catch {
      block--;
    }
  }
  const blockData = await rpcServices(client.callRpc).getBlock(blockHash).call();
  const nowTime = blockData.time;
  // Pin the chain-head height BEFORE the one-day-ago retry below. The
  // original pre-refactor implementation wrote `data.currentBlock = block`
  // at exactly this point, so a later failure in the one-day-ago loop
  // (which also decrements `block`) never polluted currentBlock. The
  // refactor returns this at the end of the function, so we must capture
  // the head here to preserve that invariant — otherwise a transient
  // getBlockHash failure would lower currentBlock and skew
  // superBlockNextEpochSec / voting-deadline math in the committed
  // snapshot (Codex round 2 P2).
  const currentBlock = block;

  const oneDayAgoBlock = currentBlock - 576;
  let hashOneDayAgo;
  // Separate retry cursor so decrements here never affect currentBlock.
  let cursor = currentBlock;
  while (cursor > 0) {
    try {
      hashOneDayAgo = await rpcServices(client.callRpc).getBlockHash(oneDayAgoBlock).call();
      break;
    } catch {
      cursor--;
    }
  }
  const blockOneDayAgo = await rpcServices(client.callRpc).getBlock(hashOneDayAgo).call();
  const diff = nowTime - blockOneDayAgo.time;

  return {
    version: network.version,
    subVersion: network.subversion,
    protocol: network.protocolversion,
    date: moment(genesis.time * 1000).format("MMMM Do YYYY, h:mm:ss a"),
    currentBlock,
    avgBlockTime: (diff * 1000) / 576,
  };
}

async function fetchGovernance() {
  const gov = await rpcServices(client.callRpc).getGovernanceInfo().call();
  let budget;
  try {
    budget = await rpcServices(client.callRpc).getSuperblockBudget().call();
  } catch {
    budget = "To be determined";
  }
  return {
    lastSuperBlock: gov.lastsuperblock,
    nextSuperBlock: gov.nextsuperblock,
    proposalFee: gov.proposalfee,
    budget,
  };
}

async function fetchProjectedSuperblocks({ nextSuperBlock, currentBlock, avgBlockTime }) {
  const projections = [1, 2, 3, 4, 5].map((n) => ({
    n,
    block: nextSuperBlock + SUPERBLOCK_INTERVAL * n,
  }));

  // Allow per-sb budget calls to fail independently — matches the prior
  // .catch(() => "To be determined") semantics — without aborting the whole
  // tick and throwing away the rest of the atomic payload. Each call is
  // also raced against SB_BUDGET_TIMEOUT_MS: without this, a single
  // perpetually-hanging projected-block RPC (remember: SyscoinRpcClient has
  // no configurable socket timeout) would starve every future tick out of
  // ever reaching atomic commit — the outer watchdog would fire, abandon
  // the tick, and the next tick would hit the same hang. This way a stuck
  // projection falls back to "To be determined" within a bounded window
  // and the rest of the payload still commits (Codex round 2 P1).
  const budgetResults = await Promise.allSettled(
    projections.map((p) =>
      withTimeout(
        rpcServices(client.callRpc).getSuperblockBudget(p.block).call(),
        SB_BUDGET_TIMEOUT_MS,
        `getSuperblockBudget(${p.block})`
      )
    )
  );

  const out = {};
  projections.forEach((p, i) => {
    out[`sb${p.n}`] = p.block;
    out[`sb${p.n}EstDate`] = moment(
      Date.now() + (p.block - currentBlock) * avgBlockTime
    ).format("MMMM Do YYYY");
    out[`sb${p.n}Budget`] =
      budgetResults[i].status === "fulfilled"
        ? budgetResults[i].value
        : "To be determined";
  });
  return out;
}

async function fetchMasternodeCount() {
  const mnCount = await rpcServices(client.callRpc).masternode_count().call();
  return {
    mnTotal: mnCount.total,
    mnEnabled: mnCount.enabled,
    poseBanned: mnCount.total - mnCount.enabled,
  };
}

async function fetchCoreData() {
  const next = {};
  Object.assign(next, await fetchChainHead());
  Object.assign(next, await fetchGovernance());

  for (const key of ["version", "protocol", "currentBlock", "nextSuperBlock"]) {
    if (!Number.isSafeInteger(next[key]) || next[key] <= 0) {
      throw new Error(`Invalid Core statistic: ${key}`);
    }
  }
  if (!Number.isFinite(next.avgBlockTime) || next.avgBlockTime <= 0) {
    throw new Error("Invalid Core statistic: avgBlockTime");
  }
  for (const key of ["lastSuperBlock", "proposalFee"]) {
    if (!Number.isFinite(next[key]) || next[key] < 0) {
      throw new Error(`Invalid Core statistic: ${key}`);
    }
  }

  const diffBlock = next.nextSuperBlock - next.currentBlock;
  const sbDate = Date.now() + diffBlock * next.avgBlockTime;
  next.superBlockNextDate = moment(sbDate).format("MMMM Do YYYY, h:mm:ss a");
  // Raw next-superblock epoch (UNIX seconds) for API consumers that need a
  // numeric anchor instead of parsing the human-formatted string
  // (e.g. the /governance/new wizard's computeProposalWindow).
  next.superBlockNextEpochSec = Math.floor(sbDate / 1000);

  const voteDeadlineBlock = next.nextSuperBlock - 1728;
  const voteDeadlineDate =
    Date.now() + (voteDeadlineBlock - next.currentBlock) * next.avgBlockTime;
  next.votingDeadlineDate = moment(voteDeadlineDate).format(
    "MMMM Do YYYY, h:mm:ss a"
  );

  Object.assign(
    next,
    await fetchProjectedSuperblocks({
      nextSuperBlock: next.nextSuperBlock,
      currentBlock: next.currentBlock,
      avgBlockTime: next.avgBlockTime,
    })
  );

  Object.assign(next, await fetchMasternodeCount());
  if (!Number.isSafeInteger(next.mnTotal) || next.mnTotal < 0 ||
      !Number.isSafeInteger(next.mnEnabled) || next.mnEnabled < 0 ||
      next.mnEnabled > next.mnTotal) {
    throw new Error("Invalid Core masternode count");
  }
  return next;
}

async function tick(externalGen) {
  // The scheduler and watchdog share this generation. Direct test/operator
  // calls allocate their own; neither source can publish an obsolete result.
  const gen = externalGen !== undefined ? externalGen : ++tickGen;
  const fetchMarket = Date.now() >= marketNextAt;
  if (fetchMarket) lastMarketStartedGen = gen;
  // Publish each independent source as soon as it completes. A stuck Core
  // socket cannot suppress a healthy price observation, or vice versa.
  // Per-source generation fences also prevent an older result from undoing
  // the same source's newer success/failure before the entire tick finishes.
  const observe = (work, publish) => work.then(
    (value) => { publish({ status: "fulfilled", value }); return true; },
    (reason) => { publish({ status: "rejected", reason }); return false; }
  );
  const [coreOk, marketOk] = await Promise.all([
    observe(fetchCoreData(), (result) => {
      if (gen <= lastCompletedGen || gen <= lastCoreCompletedGen) return;
      lastCoreCompletedGen = gen;
      if (result.status === "fulfilled") {
        Object.assign(data, result.value);
        markStatsSuccess(CORE_GROUPS);
        lastGoodAt = Date.now();
        currentTickMs = BASE_TICK_MS;
        lastCommittedGen = Math.max(lastCommittedGen, gen);
      } else {
        console.error("[sysMain] Core stats:", result.reason.message);
        markStatsFailure(CORE_GROUPS);
        currentTickMs = Math.min(currentTickMs * 2, MAX_BACKOFF_MS);
      }
    }),
    fetchMarket ? observe(fetchMarketData(), (result) => {
      if (gen <= lastCompletedGen || gen <= lastMarketCompletedGen) return;
      lastMarketCompletedGen = gen;
      if (result.status === "fulfilled") {
        Object.assign(data, result.value);
        markStatsSuccess(["market"]);
        marketTickMs = BASE_TICK_MS;
        lastCommittedGen = Math.max(lastCommittedGen, gen);
      } else {
        console.error("[sysMain] Market stats:", result.reason.message);
        markStatsFailure(["market"]);
        marketTickMs = Math.min(marketTickMs * 2, MAX_BACKOFF_MS);
      }
      marketNextAt = Date.now() + marketTickMs;
    }) : Promise.resolve(false),
  ]);
  if (gen <= lastCompletedGen) return { ok: false, stale: true, gen };
  lastCompletedGen = gen;
  return {
    ok: coreOk && (!fetchMarket || marketOk),
    coreOk,
    marketOk,
    marketSkipped: !fetchMarket,
    gen,
  };
}

function scheduleNext() {
  if (stopped) return;
  tickTimer = setTimeout(runAndReschedule, currentTickMs);
  // Don't keep the event loop alive solely for this timer in test / CLI
  // contexts where the server isn't holding other handles open.
  if (tickTimer && typeof tickTimer.unref === "function") tickTimer.unref();
}

async function runAndReschedule() {
  if (stopped) return;

  // Capture a per-run-loop token. If stop() (or a subsequent restart)
  // happens while this tick is still in flight, our token will no longer
  // match `activeRunToken`, and rescheduleOnce / the watchdog will
  // recognize themselves as belonging to a defunct run loop and no-op
  // rather than scheduling on top of the fresh loop (Codex round 4 P2).
  const myToken = {};
  activeRunToken = myToken;

  // Allocate the tick's generation here so the watchdog and the tick
  // body refer to the same in-flight tick. If the watchdog fires first
  // we mark this gen as "completed" (abandoned) so its eventual late
  // resolution will see itself as stale and no-op cleanly.
  const gen = ++tickGen;

  // The next tick is scheduled by whichever of these fires first:
  //  - tick() resolving / rejecting normally (via the finally block)
  //  - TICK_WATCHDOG_MS elapsing (via the watchdog timer)
  // rescheduleOnce() ensures we never double-schedule, even if the stuck
  // tick eventually resolves after the watchdog already fired.
  let rescheduled = false;
  function rescheduleOnce() {
    if (rescheduled || stopped) return;
    // Belongs to a run loop that was stopped (and possibly restarted).
    // The new loop owns scheduling; we must not interfere.
    if (activeRunToken !== myToken) return;
    rescheduled = true;
    scheduleNext();
  }

  const watchdog = setTimeout(() => {
    // If this run loop was stopped (and maybe restarted) while the tick
    // was in flight, leave shared state alone — the new loop is driving
    // things now.
    if (activeRunToken !== myToken) return;
    // Only act if this tick hasn't already published a result itself.
    if (gen > lastCompletedGen) {
      watchdogFires++;
      lastCompletedGen = gen;
      if (gen > lastCoreCompletedGen) {
        lastCoreCompletedGen = gen;
        currentTickMs = Math.min(currentTickMs * 2, MAX_BACKOFF_MS);
        markStatsFailure(CORE_GROUPS);
      }
      if (lastMarketStartedGen === gen && gen > lastMarketCompletedGen) {
        lastMarketCompletedGen = gen;
        marketTickMs = Math.min(marketTickMs * 2, MAX_BACKOFF_MS);
        marketNextAt = Date.now() + marketTickMs;
        markStatsFailure(["market"]);
      }
      console.error(
        `[sysMain] tick watchdog fired after ${TICK_WATCHDOG_MS}ms — rescheduling without awaiting the stuck tick`
      );
    }
    rescheduleOnce();
  }, TICK_WATCHDOG_MS);
  if (watchdog && typeof watchdog.unref === "function") watchdog.unref();

  // Swallow rejections from the tick so they can't escape as unhandled
  // promise rejections — tick() already logs + adjusts backoff internally.
  tick(gen).catch(() => {}).finally(() => {
    clearTimeout(watchdog);
    rescheduleOnce();
  });
}

function start() {
  if (started) return;
  started = true;
  stopped = false;
  // Kick off immediately; scheduleNext() will then use currentTickMs.
  runAndReschedule();
}

function stop() {
  stopped = true;
  started = false;
  // Invalidate any in-flight run loop's rescheduleOnce / watchdog so that
  // if start() is called again before their tick settles, those stale
  // callbacks can't schedule a duplicate loop on top of the new one.
  activeRunToken = null;
  // Retired callbacks cannot publish data/health after stop, including during
  // a later start whose fresh observation is still in flight.
  lastCompletedGen = Math.max(lastCompletedGen, tickGen);
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

function getDiagnostics() {
  return {
    currentTickMs,
    marketTickMs,
    marketNextAt,
    lastGoodAt,
    tickGen,
    lastCommittedGen,
    lastCompletedGen,
    lastCoreCompletedGen,
    lastMarketCompletedGen,
    watchdogFires,
  };
}

// Test-only: reset module-scope state so a test suite can exercise cold-start
// semantics and backoff math deterministically without tearing down and re-
// requiring the whole module (which would detach jest.mock() bindings that
// other test-file-scoped references rely on).
function __resetForTests() {
  currentTickMs = BASE_TICK_MS;
  marketTickMs = BASE_TICK_MS;
  marketNextAt = 0;
  lastGoodAt = 0;
  tickGen = 0;
  lastCommittedGen = 0;
  lastCompletedGen = 0;
  lastCoreCompletedGen = 0;
  lastMarketCompletedGen = 0;
  lastMarketStartedGen = 0;
  watchdogFires = 0;
  stopped = false;
  started = false;
  activeRunToken = null;
  resetStatsMetadata();
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

// Preserve the long-standing side-effect import contract:
//   require('./services/sysMain')  // in server.js auto-starts the loop
// Tests can still import { tick, start, stop, getDiagnostics } and drive the
// loop manually without the auto-start interfering (start() is idempotent,
// and stop() halts any in-flight scheduling).
if (process.env.NODE_ENV !== "test") {
  start();
}

module.exports = {
  tick,
  start,
  stop,
  getDiagnostics,
  __resetForTests,
  // exported for tests / operators wanting to read configured pacing
  BASE_TICK_MS,
  MAX_BACKOFF_MS,
  TICK_WATCHDOG_MS,
  SB_BUDGET_TIMEOUT_MS,
};
