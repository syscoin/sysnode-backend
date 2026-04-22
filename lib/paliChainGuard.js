'use strict';

// paliChainGuard — cross-check operator-declared SYSCOIN_NETWORK
// against the actual chain behind SYSCOIN_RPC_*.
// ---------------------------------------------------------------
// Motivation (Codex PR10 review): the PSBT builder trusts the
// operator's `SYSCOIN_NETWORK` env verbatim to pick xpub/HRP rules.
// If the RPC node it's paired with is on the OTHER chain (common
// mistake: "I repointed the RPC node but forgot to flip the env"),
// users can broadcast/burn 150 SYS on chain A while the dispatcher
// watches chain B → submission fails as `collateral_not_found`
// after 6 confirmations, 150 SYS is gone.
//
// The guard probes `getblockchaininfo().chain` once the RPC node is
// reachable and compares to the declared chain. Mismatch is
// permanent — it means the operator's configuration is wrong, and
// the only correct recovery is to fix the env and restart. We
// refuse to serve the Pali path for the rest of the process's life
// in that case. RPC-unreachable is transient — we retry with
// bounded exponential backoff so a late-starting RPC node doesn't
// leave the Pali path disabled forever.
//
// States:
//   'unverified' — initial; probe hasn't completed or hasn't started
//   'verified'   — probe succeeded AND actual chain matches declared
//   'mismatch'   — probe succeeded AND chains differ (terminal)
//   'rpc_down'   — probe threw; we're retrying
//
// Only 'verified' opens the Pali path. Everything else disables it.

const DEFAULT_INITIAL_DELAY_MS = 30 * 1000; // 30s after boot
const DEFAULT_RETRY_MIN_MS = 5 * 1000;
const DEFAULT_RETRY_MAX_MS = 5 * 60 * 1000;
const DEFAULT_BACKOFF_FACTOR = 2;

function noopLog() {}

// Translate whatever `getblockchaininfo.chain` returns to the same
// 'main' | 'test' vocabulary we use for `declaredChain` in
// server.js. Syscoin Core returns 'main' for mainnet and 'test'
// for the UTXO testnet (matches Bitcoin Core's convention);
// 'regtest' / 'signet' are not supported by our deploy but we
// surface them so the mismatch log is actionable.
function normalizeChainString(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().toLowerCase();
  if (t === 'main' || t === 'test' || t === 'regtest' || t === 'signet') {
    return t;
  }
  return null;
}

function createPaliChainGuard({
  declaredChain,
  fetchActualChain,
  log = noopLog,
  scheduler = { setTimeout, clearTimeout },
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  retryMinMs = DEFAULT_RETRY_MIN_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  backoffFactor = DEFAULT_BACKOFF_FACTOR,
} = {}) {
  if (typeof fetchActualChain !== 'function') {
    throw new Error('createPaliChainGuard: fetchActualChain is required');
  }

  // If the caller never declared a chain (i.e. Pali path wasn't
  // configured at all), we return a guard that is permanently
  // "unconfigured". Callers then fall through to the existing
  // `pali_path_disabled` response. We keep a real object rather
  // than null so router code doesn't have to null-check every
  // caller site.
  const declared = normalizeChainString(declaredChain);

  let status = declared ? 'unverified' : 'mismatch';
  let reason = declared ? null : 'pali_not_configured';
  let actualChain = null;
  let attempts = 0;
  let timer = null;
  let stopped = false;

  function clearTimer() {
    if (timer) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    clearTimer();
    // Unref so the guard never keeps the process alive on its own.
    // Node's setTimeout returns a Timeout object with .unref() in
    // production; in tests the scheduler injected may return a
    // plain id, so we feature-detect.
    const t = scheduler.setTimeout(runOnce, delayMs);
    if (t && typeof t.unref === 'function') t.unref();
    timer = t;
  }

  function nextRetryDelay() {
    const exp = Math.min(
      retryMaxMs,
      retryMinMs * Math.pow(backoffFactor, Math.max(0, attempts - 1))
    );
    return exp;
  }

  async function runOnce() {
    timer = null;
    if (stopped) return;
    attempts += 1;
    let observed;
    try {
      observed = await fetchActualChain();
    } catch (err) {
      status = 'rpc_down';
      reason = 'pali_path_rpc_down';
      log('warn', 'paliChainGuard.rpc_error', {
        attempts,
        err: err && err.message,
      });
      schedule(nextRetryDelay());
      return;
    }
    const norm = normalizeChainString(observed);
    if (!norm) {
      status = 'rpc_down';
      reason = 'pali_path_rpc_down';
      log('warn', 'paliChainGuard.unparseable_chain', {
        attempts,
        observed,
      });
      schedule(nextRetryDelay());
      return;
    }
    actualChain = norm;
    if (norm === declared) {
      status = 'verified';
      reason = null;
      log('info', 'paliChainGuard.verified', {
        attempts,
        declared,
        actual: norm,
      });
      // Terminal success: no more timers.
      return;
    }
    status = 'mismatch';
    reason = 'pali_path_chain_mismatch';
    // Terminal failure — log LOUDLY so the operator notices. The
    // only correct recovery is to fix the env and restart.
    log('error', 'paliChainGuard.mismatch', {
      attempts,
      declaredChain: declared,
      actualChain: norm,
      hint:
        'SYSCOIN_NETWORK does not match the chain behind SYSCOIN_RPC_*;' +
        ' Pali collateral path has been DISABLED for this process.' +
        ' Fix the env and restart to re-enable it.',
    });
  }

  function start() {
    if (!declared) {
      // Nothing to verify — stay in the unconfigured state.
      return;
    }
    if (status === 'verified' || status === 'mismatch') {
      // Terminal states; don't re-arm.
      return;
    }
    schedule(initialDelayMs);
  }

  function stop() {
    stopped = true;
    clearTimer();
  }

  return {
    start,
    stop,
    isReady() {
      return status === 'verified';
    },
    // Non-null string when not ready; null when ready or
    // indeterminate at construction time with no declared chain.
    reason() {
      return reason;
    },
    // Exposed for /network reporting + tests.
    snapshot() {
      return {
        status,
        reason,
        declaredChain: declared,
        actualChain,
        attempts,
      };
    },
  };
}

module.exports = {
  createPaliChainGuard,
  _internal: { normalizeChainString },
};
