'use strict';

// Unit tests for lib/proposalPsbt.js.
//
// We stub `syscoinClient.createTransaction` so these tests run in
// isolation from syscoinjs-lib / Blockbook — the goal is to pin down:
//   1. Input validation behaves exactly as documented in the module.
//   2. The OP_RETURN script we hand into createTransaction is byte-
//      for-byte what Syscoin Core's IsCollateralValid expects.
//   3. The 150-SYS value is a BN (coinselect needs `BN.isBN(v)`), and
//      the collateral output carries that value unchanged.
//   4. Error translation covers the actual shapes syscoinjs-lib /
//      axios emit on the unhappy paths we care about.

const BN = require('bn.js');
const {
  buildCollateralPsbt,
  _internal: {
    buildOpReturnScript,
    assertXpubMatchesNetwork,
    assertChangeAddress,
    normalizeFeeRate,
    translateSyscoinError,
    COLLATERAL_FEE_SATS_BN,
    DEFAULT_FEE_RATE,
    MIN_FEE_RATE,
    MAX_FEE_RATE,
  },
} = require('./proposalPsbt');

// A 64-hex dummy proposal hash — exercises the full 32-byte push path.
const SAMPLE_OP_RETURN_HEX =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// A zpub that starts with the mainnet prefix. The content after the
// prefix is irrelevant to our validator (we don't decode base58);
// we just need the right prefix bytes for the regex we apply.
const SAMPLE_MAINNET_XPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const SAMPLE_TESTNET_XPUB =
  'vpub5SLqN2bLY4WeahzxN4sfhUDZBJKPPcx7YbG98hDrcppJ3NKmPWDMmtFKccJ4yMkspGFcN5hnDVfA2dcrNzscCLkRf4JtyyGkVqeDfo8nAJ4';

// Real sys1 bech32 address (from the existing route tests) — decoded
// by bitcoinjs on the mainnet network.
const SAMPLE_MAINNET_ADDRESS = 'sys1qw508d6qejxtdg4y5r3zarvary0c5xw7kygmkq9';
// Corresponding tsys1 bech32 on testnet.
const SAMPLE_TESTNET_ADDRESS = 'tsys1qw508d6qejxtdg4y5r3zarvary0c5xw7kxn5q3y';

// A stub bitcoinjs.address that handles the bech32 HRP check without
// pulling in real bitcoinjs-lib for every test. Returns a Buffer when
// the address matches the expected HRP for the network, throws with
// the "has no matching Script" shape bitcoinjs uses otherwise.
function makeFakeBitcoinjs(expectedHrp) {
  return {
    address: {
      toOutputScript(addr, _network) {
        if (typeof addr !== 'string' || addr.length < 10) {
          const e = new Error('Invalid checksum');
          throw e;
        }
        if (!addr.toLowerCase().startsWith(expectedHrp)) {
          const e = new Error(
            `${addr} has no matching Script on the configured network`
          );
          throw e;
        }
        return Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex');
      },
    },
  };
}

function makeSyscoinClientStub({
  networkKey = 'mainnet',
  expectedHrp = 'sys1',
  createTransaction,
  exportPsbtToJson,
} = {}) {
  return {
    network: { /* opaque network object */ },
    networkKey,
    bitcoinjs: makeFakeBitcoinjs(expectedHrp),
    exportPsbtToJson:
      exportPsbtToJson ||
      (() => ({ psbt: 'BASE64PSBT==', assets: '[]' })),
    createTransaction:
      createTransaction ||
      (async () => ({
        psbt: { fakePsbtMarker: true },
        fee: 2000,
      })),
  };
}

describe('buildOpReturnScript', () => {
  test('emits 0x6a 0x20 <32 bytes> for a 64-hex input', () => {
    const out = buildOpReturnScript(SAMPLE_OP_RETURN_HEX);
    expect(out.length).toBe(34);
    expect(out[0]).toBe(0x6a); // OP_RETURN
    expect(out[1]).toBe(0x20); // push 32 bytes
    expect(out.slice(2).toString('hex')).toBe(SAMPLE_OP_RETURN_HEX);
  });

  test('rejects non-hex / wrong-length payloads', () => {
    for (const bad of [
      '',
      'abc',
      'zz'.repeat(32),
      SAMPLE_OP_RETURN_HEX.toUpperCase(), // our regex is lowercase-only
      SAMPLE_OP_RETURN_HEX + '00', // 66 chars
      null,
      undefined,
      42,
    ]) {
      let thrown;
      try {
        buildOpReturnScript(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown.code).toBe('bad_op_return');
    }
  });
});

describe('assertXpubMatchesNetwork', () => {
  test('accepts zpub for mainnet, vpub for testnet', () => {
    expect(() =>
      assertXpubMatchesNetwork(SAMPLE_MAINNET_XPUB, 'mainnet')
    ).not.toThrow();
    expect(() =>
      assertXpubMatchesNetwork(SAMPLE_TESTNET_XPUB, 'testnet')
    ).not.toThrow();
  });

  test('rejects cross-network xpub with network_mismatch', () => {
    expect.assertions(2);
    try {
      assertXpubMatchesNetwork(SAMPLE_MAINNET_XPUB, 'testnet');
    } catch (err) {
      expect(err.code).toBe('network_mismatch');
    }
    try {
      assertXpubMatchesNetwork(SAMPLE_TESTNET_XPUB, 'mainnet');
    } catch (err) {
      expect(err.code).toBe('network_mismatch');
    }
  });

  test('rejects wrong-shape inputs with bad_xpub', () => {
    for (const bad of ['', 'xpub', null, undefined, 'x'.repeat(200), 42]) {
      let thrown;
      try {
        assertXpubMatchesNetwork(bad, 'mainnet');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown.code).toBe('bad_xpub');
    }
  });
});

describe('assertChangeAddress', () => {
  test('passes for a matching-network bech32 address', () => {
    expect(() =>
      assertChangeAddress(
        makeFakeBitcoinjs('sys1'),
        SAMPLE_MAINNET_ADDRESS,
        { /* fake network */ },
        'mainnet'
      )
    ).not.toThrow();
  });

  test('maps cross-network bitcoinjs error to network_mismatch', () => {
    try {
      assertChangeAddress(
        makeFakeBitcoinjs('sys1'),
        SAMPLE_TESTNET_ADDRESS,
        {},
        'mainnet'
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('network_mismatch');
    }
  });

  test('maps other bitcoinjs errors to bad_change_address', () => {
    try {
      assertChangeAddress(
        {
          address: {
            toOutputScript() {
              throw new Error('Invalid checksum');
            },
          },
        },
        'sys1junk',
        {},
        'mainnet'
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('bad_change_address');
    }
  });
});

describe('normalizeFeeRate', () => {
  test('defaults to DEFAULT_FEE_RATE', () => {
    expect(normalizeFeeRate().toNumber()).toBe(DEFAULT_FEE_RATE);
    expect(normalizeFeeRate(null).toNumber()).toBe(DEFAULT_FEE_RATE);
    expect(normalizeFeeRate('').toNumber()).toBe(DEFAULT_FEE_RATE);
  });

  test('accepts integer inputs within [MIN,MAX]', () => {
    expect(normalizeFeeRate(MIN_FEE_RATE).toNumber()).toBe(MIN_FEE_RATE);
    expect(normalizeFeeRate(MAX_FEE_RATE).toNumber()).toBe(MAX_FEE_RATE);
    expect(normalizeFeeRate('42').toNumber()).toBe(42);
  });

  test('rejects out-of-range / non-integer inputs', () => {
    for (const bad of [
      0,
      -1,
      MAX_FEE_RATE + 1,
      1.5,
      'foo',
      NaN,
      Infinity,
    ]) {
      let thrown;
      try {
        normalizeFeeRate(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();
      expect(thrown.code).toBe('bad_fee_rate');
    }
  });
});

describe('translateSyscoinError', () => {
  test('insufficient_funds picks up shortfall from BN', () => {
    const bn = new BN('12345');
    const e = translateSyscoinError({
      code: 402,
      message: 'insufficient funds',
      shortfall: bn,
    });
    expect(e.code).toBe('insufficient_funds');
    expect(e.shortfallSats).toBe('12345');
  });

  test('blockbook transient codes map to blockbook_unreachable', () => {
    for (const c of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT']) {
      const e = translateSyscoinError({ code: c, message: 'boom' });
      expect(e.code).toBe('blockbook_unreachable');
      expect(e.detail).toBe(c);
    }
  });

  test('blockbook 5xx HTTP error maps to blockbook_unreachable', () => {
    const e = translateSyscoinError({
      response: { status: 503 },
      message: 'server down',
    });
    expect(e.code).toBe('blockbook_unreachable');
    expect(e.detail).toBe('upstream_503');
  });

  test('unknown error shape -> pali_psbt_build_failed', () => {
    const e = translateSyscoinError({ message: 'weird' });
    expect(e.code).toBe('pali_psbt_build_failed');
  });
});

describe('buildCollateralPsbt (integration via stub)', () => {
  test('builds a 150-SYS OP_RETURN output byte-for-byte', async () => {
    let captured;
    const client = makeSyscoinClientStub({
      createTransaction: async (txOpts, change, outs, feeRate, xpub) => {
        captured = { txOpts, change, outs, feeRate, xpub };
        return { psbt: { stub: true }, fee: 3210 };
      },
    });

    const result = await buildCollateralPsbt({
      opReturnHex: SAMPLE_OP_RETURN_HEX,
      xpub: SAMPLE_MAINNET_XPUB,
      changeAddress: SAMPLE_MAINNET_ADDRESS,
      syscoinClient: client,
    });

    // ---- returned envelope ---------------------------------------
    expect(result).toEqual({
      psbt: { psbt: 'BASE64PSBT==', assets: '[]' },
      feeSats: '3210',
    });

    // ---- createTransaction call shape ----------------------------
    expect(captured.txOpts).toEqual({ rbf: false });
    expect(captured.change).toBe(SAMPLE_MAINNET_ADDRESS);
    expect(captured.xpub).toBe(SAMPLE_MAINNET_XPUB);
    // Default fee rate = 10 (BN).
    expect(BN.isBN(captured.feeRate)).toBe(true);
    expect(captured.feeRate.toNumber()).toBe(DEFAULT_FEE_RATE);

    // ---- outputs array: one script-only 150-SYS collateral -------
    expect(captured.outs).toHaveLength(1);
    const out = captured.outs[0];
    expect(Object.prototype.hasOwnProperty.call(out, 'address')).toBe(false);
    expect(Buffer.isBuffer(out.script)).toBe(true);
    expect(out.script[0]).toBe(0x6a);
    expect(out.script[1]).toBe(0x20);
    expect(out.script.slice(2).toString('hex')).toBe(SAMPLE_OP_RETURN_HEX);
    expect(BN.isBN(out.value)).toBe(true);
    // Equal to 150 SYS in sats (150 * 1e8 = 15_000_000_000).
    expect(out.value.eq(COLLATERAL_FEE_SATS_BN)).toBe(true);
    expect(out.value.toString(10)).toBe('15000000000');
  });

  test('passes through caller feeRate when valid', async () => {
    let capturedFeeRate;
    const client = makeSyscoinClientStub({
      createTransaction: async (_o, _c, _outs, feeRate) => {
        capturedFeeRate = feeRate;
        return { psbt: { stub: true }, fee: 0 };
      },
    });
    await buildCollateralPsbt({
      opReturnHex: SAMPLE_OP_RETURN_HEX,
      xpub: SAMPLE_MAINNET_XPUB,
      changeAddress: SAMPLE_MAINNET_ADDRESS,
      feeRate: 42,
      syscoinClient: client,
    });
    expect(capturedFeeRate.toNumber()).toBe(42);
  });

  test('translates syscoinjs insufficient_funds to typed error', async () => {
    const client = makeSyscoinClientStub({
      createTransaction: async () => {
        const e = new Error('insufficient funds or invalid inputs');
        e.code = 402;
        e.shortfall = new BN('99999999');
        throw e;
      },
    });
    await expect(
      buildCollateralPsbt({
        opReturnHex: SAMPLE_OP_RETURN_HEX,
        xpub: SAMPLE_MAINNET_XPUB,
        changeAddress: SAMPLE_MAINNET_ADDRESS,
        syscoinClient: client,
      })
    ).rejects.toMatchObject({
      code: 'insufficient_funds',
      shortfallSats: '99999999',
    });
  });

  test('translates axios ENOTFOUND to blockbook_unreachable', async () => {
    const client = makeSyscoinClientStub({
      createTransaction: async () => {
        const e = new Error('getaddrinfo ENOTFOUND');
        e.code = 'ENOTFOUND';
        throw e;
      },
    });
    await expect(
      buildCollateralPsbt({
        opReturnHex: SAMPLE_OP_RETURN_HEX,
        xpub: SAMPLE_MAINNET_XPUB,
        changeAddress: SAMPLE_MAINNET_ADDRESS,
        syscoinClient: client,
      })
    ).rejects.toMatchObject({
      code: 'blockbook_unreachable',
      detail: 'ENOTFOUND',
    });
  });

  test('rejects cross-network xpub before any RPC', async () => {
    let called = false;
    const client = makeSyscoinClientStub({
      networkKey: 'testnet',
      expectedHrp: 'tsys1',
      createTransaction: async () => {
        called = true;
        return { psbt: { stub: true }, fee: 0 };
      },
    });
    await expect(
      buildCollateralPsbt({
        opReturnHex: SAMPLE_OP_RETURN_HEX,
        xpub: SAMPLE_MAINNET_XPUB, // zpub on testnet client
        changeAddress: SAMPLE_TESTNET_ADDRESS,
        syscoinClient: client,
      })
    ).rejects.toMatchObject({ code: 'network_mismatch' });
    expect(called).toBe(false);
  });

  test('rejects missing syscoinClient.createTransaction', async () => {
    await expect(
      buildCollateralPsbt({
        opReturnHex: SAMPLE_OP_RETURN_HEX,
        xpub: SAMPLE_MAINNET_XPUB,
        changeAddress: SAMPLE_MAINNET_ADDRESS,
        syscoinClient: {},
      })
    ).rejects.toThrow(/syscoinClient/);
  });

  test('rejects malformed syscoinClient (missing bitcoinjs/export)', async () => {
    await expect(
      buildCollateralPsbt({
        opReturnHex: SAMPLE_OP_RETURN_HEX,
        xpub: SAMPLE_MAINNET_XPUB,
        changeAddress: SAMPLE_MAINNET_ADDRESS,
        syscoinClient: {
          createTransaction: async () => ({ psbt: {}, fee: 0 }),
        },
      })
    ).rejects.toThrow(/malformed/);
  });
});
