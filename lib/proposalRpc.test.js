'use strict';

const { createProposalRpc } = require('./proposalRpc');

// Recording fake that mimics the @syscoin/syscoin-js "stub" shape.
// Each top-level method returns an object with `.call(verbose?)`
// that resolves to a scripted value (or throws) — matching the
// real RPCServiceFunctions surface. The factory records every
// invocation so tests can assert on the exact argument types that
// flow through to syscoind.
function makeFakeRpcServices(scripts = {}) {
  const calls = {
    gObject_submit: [],
    gObject_check: [],
    getRawTransaction: [],
  };
  const factory = () => ({
    gObject_submit(...args) {
      calls.gObject_submit.push(args);
      return {
        call: async (verbose) => {
          calls.gObject_submit[calls.gObject_submit.length - 1].verbose =
            verbose;
          if (typeof scripts.gObject_submit === 'function') {
            return scripts.gObject_submit(args, verbose);
          }
          return 'deadbeef';
        },
      };
    },
    gObject_check(...args) {
      calls.gObject_check.push(args);
      return {
        call: async () => {
          if (typeof scripts.gObject_check === 'function') {
            return scripts.gObject_check(args);
          }
          return { 'Object status': 'OK' };
        },
      };
    },
    getRawTransaction(...args) {
      calls.getRawTransaction.push(args);
      return {
        call: async () => {
          if (typeof scripts.getRawTransaction === 'function') {
            return scripts.getRawTransaction(args);
          }
          return { confirmations: 6 };
        },
      };
    },
  });
  return { factory, calls };
}

describe('createProposalRpc', () => {
  test('throws when rpcServicesFactory is not a function', () => {
    expect(() => createProposalRpc(null)).toThrow(/required/);
    expect(() => createProposalRpc({})).toThrow(/required/);
    expect(() => createProposalRpc(undefined)).toThrow(/required/);
  });

  // Codex PR8 round 16 P1: the adapter previously wrapped `revision`
  // and `time` in `String(...)` before invoking syscoin-js, which
  // forwards JS types to syscoind as-is. Core declares both as
  // `RPCArg::Type::NUM` and enforces it at dispatch, so a stringified
  // value produced an RPC_TYPE_ERROR. The dispatcher classified that
  // as transient and rows stayed in `awaiting_collateral` forever.
  // This is the regression guard.
  test('gObjectSubmit forwards revision and time as numeric JS values, not strings', async () => {
    const { factory, calls } = makeFakeRpcServices();
    const rpc = createProposalRpc(factory);
    const hash = await rpc.gObjectSubmit(
      '0',
      1,
      1800000000,
      '7b2274797065223a317d',
      'a'.repeat(64)
    );
    expect(hash).toBe('deadbeef');
    expect(calls.gObject_submit).toHaveLength(1);
    const args = calls.gObject_submit[0];
    // Positional args: [parentHash, revision, time, dataHex, feeTxid].
    expect(args[0]).toBe('0'); // parentHash — Core expects a hex string
    // revision MUST be a JS number (or bigint). Anything that
    // `typeof` reports as 'string' will be rejected by Core.
    expect(typeof args[1]).toBe('number');
    expect(args[1]).toBe(1);
    expect(typeof args[2]).toBe('number');
    expect(args[2]).toBe(1800000000);
    expect(args[3]).toBe('7b2274797065223a317d');
    expect(args[4]).toBe('a'.repeat(64));
    // `.call(true)` was used (truthy verbose path).
    expect(args.verbose).toBe(true);
  });

  test('gObjectSubmit does not coerce numeric inputs to strings in transit', async () => {
    // Extra-paranoid guard: even if a caller passes a BigInt, we
    // should forward the BigInt (syscoin-js will serialize it),
    // not a String cast that would break the type contract.
    const { factory, calls } = makeFakeRpcServices();
    const rpc = createProposalRpc(factory);
    await rpc.gObjectSubmit('0', 2, 1800000001, 'ab', 'cd');
    const args = calls.gObject_submit[0];
    expect(args[1]).toBe(2);
    expect(args[2]).toBe(1800000001);
    // Explicit: not strings.
    expect(args[1]).not.toBe('2');
    expect(args[2]).not.toBe('1800000001');
  });

  test('gObjectCheck forwards exactly one positional arg (hex_data)', async () => {
    // Codex PR8 round 6 P1 guard: Core's gobject_check takes a
    // single positional arg. Historically this adapter sent four
    // and Core rejected with RPC_INVALID_PARAMS. Make sure we do
    // not regress back to the 4-arg shape.
    const { factory, calls } = makeFakeRpcServices();
    const rpc = createProposalRpc(factory);
    const res = await rpc.gObjectCheck('ab12');
    expect(res).toEqual({ 'Object status': 'OK' });
    expect(calls.gObject_check).toHaveLength(1);
    expect(calls.gObject_check[0]).toHaveLength(1);
    expect(calls.gObject_check[0][0]).toBe('ab12');
  });

  test('getRawTransaction maps boolean verbose to 0/1', async () => {
    // syscoin Core's getrawtransaction `verbose` param accepts 0
    // or 1 (integer). The adapter translates the JS boolean to
    // that wire form so callers can use a clean `true`/`false`
    // API.
    const { factory, calls } = makeFakeRpcServices();
    const rpc = createProposalRpc(factory);
    await rpc.getRawTransaction('a'.repeat(64), true);
    await rpc.getRawTransaction('b'.repeat(64), false);
    expect(calls.getRawTransaction).toHaveLength(2);
    expect(calls.getRawTransaction[0]).toEqual(['a'.repeat(64), 1]);
    expect(calls.getRawTransaction[1]).toEqual(['b'.repeat(64), 0]);
  });

  test('errors from syscoin-js bubble up unchanged', async () => {
    const { factory } = makeFakeRpcServices({
      gObject_submit: () => {
        throw new Error('rpc-type-error: Expected type number, got string');
      },
    });
    const rpc = createProposalRpc(factory);
    await expect(
      rpc.gObjectSubmit('0', 1, 1, 'ab', 'cd')
    ).rejects.toThrow(/Expected type number/);
  });
});
