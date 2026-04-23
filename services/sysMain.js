const moment = require("moment");
const axios = require("axios");
const { client, rpcServices } = require("../services/rpcClient");
const data = require("../data/dataStore");

// ─────────────────────────────────────────────────────────────────────────────
// sysMain — periodic aggregation of market + chain + governance stats into the
// shared dataStore consumed by /mnstats (via services/calculations.js).
//
// Robustness model:
//   • Atomic commit of the last-good payload. Every tick assembles its values
//     into a local `next` object and only `Object.assign(data, next)` once the
//     whole payload succeeded. A failed tick leaves the previous tick's values
//     intact — we never half-overwrite dataStore with a mix of fresh + stale
//     fields. On cold start with no prior success yet, dataStore keeps its
//     initialised defaults (see data/dataStore.js) rather than becoming
//     partially zeroed halfway through a failure.
//   • Exponential backoff on failure. External calls (notably CoinGecko's
//     public API) occasionally rate-limit this host. Instead of hammering at
//     a fixed 20s interval through a 429 window, we double the tick delay
//     after every failure up to MAX_BACKOFF_MS and reset to BASE_TICK_MS on
//     the first successful commit.
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
let lastGoodAt = 0;         // ms epoch of the last successful commit (observability / tests)
let tickTimer = null;
let stopped = false;
let started = false;        // idempotency guard for start(); set synchronously so two
                             // near-simultaneous start() calls can't both spawn
                             // independent scheduler loops (tickTimer alone is not
                             // sufficient because runAndReschedule() only sets it
                             // after the in-flight tick finishes / the watchdog fires)
let tickGen = 0;            // monotonically increasing per tick()
let lastCommittedGen = 0;   // gen of the newest tick that successfully committed
let lastCompletedGen = 0;   // gen of the newest tick whose result has been published
                             // (committed OR rejected OR watchdog-abandoned). Used to
                             // no-op late-arriving results from superseded ticks so a
                             // stalled tick can't roll back backoff or overwrite data.
let watchdogFires = 0;      // observability / tests

async function fetchMarketData() {
  const gecko = await axios.get(
    "https://api.coingecko.com/api/v3/coins/syscoin?tickers=true&market_data=true",
    { timeout: COINGECKO_TIMEOUT_MS }
  );
  const m = gecko.data.market_data;
  return {
    sysUsd: m.current_price.usd,
    sysBtc: m.current_price.btc,
    circulatingSupply: m.circulating_supply,
    totalSupply: m.total_supply,
    marketCap: m.market_cap.usd,
    marketCapBtc: m.market_cap.btc,
    volume: m.total_volume.usd,
    volumeBtc: m.total_volume.btc,
    priceChange: m.price_change_percentage_24h,
  };
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

async function tick(externalGen) {
  // If the scheduler allocated the generation for us (so the watchdog can
  // name the same tick we're running), use that; otherwise allocate our
  // own — this supports direct `tick()` invocation from unit tests.
  const gen = externalGen !== undefined ? externalGen : ++tickGen;
  try {
    const next = {};

    Object.assign(next, await fetchMarketData());
    Object.assign(next, await fetchChainHead());
    Object.assign(next, await fetchGovernance());

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

    // Stale-commit guard. If a newer tick (or the watchdog on our behalf)
    // has already published a result, our payload is by definition stale:
    // it may mix values read before the supersession with values read
    // after, and committing it would also roll back the newer tick's
    // backoff reset. No-op instead.
    if (gen <= lastCompletedGen) {
      return { ok: false, stale: true, gen };
    }

    // Atomic commit: only touch dataStore once the whole payload resolved.
    Object.assign(data, next);
    lastCommittedGen = gen;
    lastCompletedGen = gen;
    lastGoodAt = Date.now();
    currentTickMs = BASE_TICK_MS;
    return { ok: true, gen };
  } catch (err) {
    console.error("[sysMain]", err.message);
    // Same guard as the success path: if we've been superseded (newer
    // commit landed, newer rejection landed, or watchdog already
    // accounted for us), don't double-apply backoff or overwrite a
    // newer signal.
    if (gen <= lastCompletedGen) {
      return { ok: false, stale: true, err, gen };
    }
    lastCompletedGen = gen;
    currentTickMs = Math.min(currentTickMs * 2, MAX_BACKOFF_MS);
    return { ok: false, err, gen };
  }
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
    rescheduled = true;
    scheduleNext();
  }

  const watchdog = setTimeout(() => {
    // Only act if this tick hasn't already published a result itself.
    if (gen > lastCompletedGen) {
      watchdogFires++;
      lastCompletedGen = gen;
      currentTickMs = Math.min(currentTickMs * 2, MAX_BACKOFF_MS);
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
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

function getDiagnostics() {
  return {
    currentTickMs,
    lastGoodAt,
    tickGen,
    lastCommittedGen,
    lastCompletedGen,
    watchdogFires,
  };
}

// Test-only: reset module-scope state so a test suite can exercise cold-start
// semantics and backoff math deterministically without tearing down and re-
// requiring the whole module (which would detach jest.mock() bindings that
// other test-file-scoped references rely on).
function __resetForTests() {
  currentTickMs = BASE_TICK_MS;
  lastGoodAt = 0;
  tickGen = 0;
  lastCommittedGen = 0;
  lastCompletedGen = 0;
  watchdogFires = 0;
  stopped = false;
  started = false;
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
