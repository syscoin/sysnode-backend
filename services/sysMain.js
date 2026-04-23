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
// ─────────────────────────────────────────────────────────────────────────────

const BASE_TICK_MS = 20_000;
const MAX_BACKOFF_MS = 5 * 60_000; // 5 min ceiling
const SUPERBLOCK_INTERVAL = 17520; // mainnet nSuperblockCycle (kept identical to previous logic)
const GENESIS_HASH = "00000c255f9999002258ddd4d4c86a4b758a5e2ec07e7d69b3e8e7f3fbd44b92";

let currentTickMs = BASE_TICK_MS;
let lastGoodAt = 0; // ms epoch of the last successful commit (observability / tests)
let tickTimer = null;
let stopped = false;

async function fetchMarketData() {
  const gecko = await axios.get(
    "https://api.coingecko.com/api/v3/coins/syscoin?tickers=true&market_data=true"
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

  const oneDayAgoBlock = block - 576;
  let hashOneDayAgo;
  while (block > 0) {
    try {
      hashOneDayAgo = await rpcServices(client.callRpc).getBlockHash(oneDayAgoBlock).call();
      break;
    } catch {
      block--;
    }
  }
  const blockOneDayAgo = await rpcServices(client.callRpc).getBlock(hashOneDayAgo).call();
  const diff = nowTime - blockOneDayAgo.time;

  return {
    version: network.version,
    subVersion: network.subversion,
    protocol: network.protocolversion,
    date: moment(genesis.time * 1000).format("MMMM Do YYYY, h:mm:ss a"),
    currentBlock: block,
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
  // tick and throwing away the rest of the atomic payload.
  const budgetResults = await Promise.allSettled(
    projections.map((p) =>
      rpcServices(client.callRpc).getSuperblockBudget(p.block).call()
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

async function tick() {
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

    // Atomic commit: only touch dataStore once the whole payload resolved.
    Object.assign(data, next);
    lastGoodAt = Date.now();
    currentTickMs = BASE_TICK_MS;
    return { ok: true };
  } catch (err) {
    console.error("[sysMain]", err.message);
    currentTickMs = Math.min(currentTickMs * 2, MAX_BACKOFF_MS);
    return { ok: false, err };
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
  await tick();
  scheduleNext();
}

function start() {
  if (tickTimer) return;
  stopped = false;
  // Kick off immediately; scheduleNext() will then use currentTickMs.
  runAndReschedule();
}

function stop() {
  stopped = true;
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

function getDiagnostics() {
  return { currentTickMs, lastGoodAt };
}

// Test-only: reset module-scope state so a test suite can exercise cold-start
// semantics and backoff math deterministically without tearing down and re-
// requiring the whole module (which would detach jest.mock() bindings that
// other test-file-scoped references rely on).
function __resetForTests() {
  currentTickMs = BASE_TICK_MS;
  lastGoodAt = 0;
  stopped = false;
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
};
