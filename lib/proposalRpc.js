'use strict';

// Thin adapter that wraps the `@syscoin/syscoin-js` service surface
// into the camelCase API the proposal dispatcher + prepare pre-flight
// expect. Extracted from `server.js` so we can unit-test it directly
// (otherwise the argument shape sent to syscoin-js / syscoind is only
// exercised in integration, and a regression in types — e.g. passing
// strings where syscoind expects numbers — silently ships).
//
// The factory takes a `rpcServices`-like function that returns the
// object with `.gObject_submit(...)`, `.gObject_check(...)`,
// `.getRawTransaction(...)` stubs you `.call()` to actually fire.
// Every adapter method returns a Promise that resolves to the
// parsed RPC result or rejects with the upstream Error.

function createProposalRpc(rpcServicesFactory) {
  if (typeof rpcServicesFactory !== 'function') {
    throw new Error('createProposalRpc: rpcServicesFactory is required');
  }

  return {
    async getRawTransaction(txid, verbose) {
      return rpcServicesFactory()
        .getRawTransaction(txid, verbose ? 1 : 0)
        .call();
    },

    async gObjectSubmit(parentHash, revision, time, dataHex, feeTxid) {
      // Codex PR8 round 16 P1: `gobject_submit` declares `revision`
      // and `time` as `RPCArg::Type::NUM` in Syscoin Core (see
      // syscoin/src/rpc/governance.cpp: CRPCCommand gobject_submit,
      // params[1]=revision NUM, params[2]=time NUM). Syscoin Core
      // enforces the JSON type via RPCTypeCheck at dispatch before
      // `params[1].getInt<int>()` runs. Earlier this adapter routed
      // both args through `String(...)`, which serialized to a JSON
      // string on the wire — Core rejected with an
      // "Expected type number, got string" RPC_TYPE_ERROR. The
      // dispatcher's terminal/transient classifier treated that as
      // transient and left rows stuck in `awaiting_collateral`
      // forever; no proposal ever transitioned to `submitted` or
      // `failed` in production. The String() wrappers were a
      // leftover from mirroring the syscoin-CLI shape (rpc/client.cpp
      // has `{"gobject_submit", 1, "revision"}` conversion entries,
      // but those rules are applied by the CLI *before* forwarding
      // to the daemon — they do NOT apply to direct JSON-RPC callers
      // like @syscoin/syscoin-js, which forwards JS types as-is).
      // Pass the numeric JS values through so syscoin-js emits JSON
      // numbers and Core accepts the call.
      return rpcServicesFactory()
        .gObject_submit(parentHash, revision, time, dataHex, feeTxid)
        .call(true);
    },

    async gObjectCheck(dataHex) {
      // Codex PR8 round 6 P1: Syscoin Core's `gobject_check` takes
      // exactly ONE positional arg — `hex_data` — and derives
      // parentHash, revision and nTime itself (see
      // syscoin/src/rpc/governance.cpp::gobject_check, which calls
      //   CGovernanceObject govobj(uint256(), 1, GetAdjustedTime(),
      //                             uint256(), strDataHex)
      // ). Earlier iterations matched the 4-arg gobject_submit
      // signature, which Core rejected with RPC_INVALID_PARAMS: too
      // many positional arguments, and the route layer masqueraded
      // that as 422 core_rejected on otherwise-valid proposals.
      //
      // gObject_check is read-only (no state mutation, no fee). The
      // route layer swallows "Not Implemented" style errors so that
      // older Core builds degrade silently to "skip pre-flight".
      return rpcServicesFactory()
        .gObject_check(dataHex)
        .call();
    },
  };
}

module.exports = { createProposalRpc };
