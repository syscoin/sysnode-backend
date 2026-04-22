'use strict';

const {
  computeProposalHash,
  writeCompactSize,
  displayHashToOpReturnBytes,
  opReturnBytesToDisplayHash,
} = require('./proposalHash');

// The input -> output pair below is the anchor of this module. It was
// computed with this implementation using the "flat" sysnode-* payload
// shape and is the same vector used during the staging integration
// test against a live syscoind (see PR 8 description). If this test
// ever starts failing, do NOT update the expected value — the hash
// format is consensus-frozen and any change here means the collateral
// OP_RETURN would no longer match what Core expects, which is a ship-
// stopping bug. Track it down first.
const GOLDEN = Object.freeze({
  input: {
    parentHash: '0',
    revision: 1,
    time: 1700000123,
    dataHex: Buffer.from(
      JSON.stringify({
        type: 1,
        name: 'test-proposal',
        start_epoch: 1700000000,
        end_epoch: 1702592000,
        payment_address: 'sys1q9h6mlnq2mwmlyyz4wa3q69lzq7h6mlsfqsp7mt',
        payment_amount: 42.5,
        url: 'https://example.org/p',
      }),
      'utf8'
    ).toString('hex'),
  },
  displayHex: 'f68f7f716fac9df8b994d5af316da6ca120a5285769673d796b1d5a73a3a208e',
  opReturnHex: '8e203a3aa7d5b196d773967685520a12caa66d31afd594b9f89dac6f717f8ff6',
});

describe('writeCompactSize', () => {
  test('encodes n<253 as single byte', () => {
    expect(writeCompactSize(0)).toEqual(Buffer.from([0x00]));
    expect(writeCompactSize(1)).toEqual(Buffer.from([0x01]));
    expect(writeCompactSize(252)).toEqual(Buffer.from([0xfc]));
  });

  test('encodes 253..0xffff as 0xfd + uint16 LE', () => {
    expect(writeCompactSize(253)).toEqual(Buffer.from([0xfd, 0xfd, 0x00]));
    expect(writeCompactSize(0xffff)).toEqual(Buffer.from([0xfd, 0xff, 0xff]));
  });

  test('encodes 0x10000..0xffffffff as 0xfe + uint32 LE', () => {
    expect(writeCompactSize(0x10000)).toEqual(
      Buffer.from([0xfe, 0x00, 0x00, 0x01, 0x00])
    );
  });

  test('encodes > 0xffffffff as 0xff + uint64 LE', () => {
    expect(writeCompactSize(0x100000000)).toEqual(
      Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00])
    );
  });

  test('rejects negative and non-integer inputs', () => {
    expect(() => writeCompactSize(-1)).toThrow(/non-negative/);
    expect(() => writeCompactSize(1.5)).toThrow(/non-negative/);
    expect(() => writeCompactSize('0')).toThrow(/non-negative/);
  });
});

describe('computeProposalHash — golden vector', () => {
  test('matches the frozen reference output', () => {
    const { displayHex, opReturnBytes } = computeProposalHash(GOLDEN.input);
    expect(displayHex).toBe(GOLDEN.displayHex);
    expect(opReturnBytes.toString('hex')).toBe(GOLDEN.opReturnHex);
  });

  test('opReturnBytes is the byte-reversal of displayHex', () => {
    const { displayHex, opReturnBytes } = computeProposalHash(GOLDEN.input);
    expect(Buffer.from(displayHex, 'hex').reverse().equals(opReturnBytes)).toBe(
      true
    );
  });
});

describe('computeProposalHash — output shape', () => {
  test('displayHex is 64 lowercase hex chars', () => {
    const { displayHex } = computeProposalHash(GOLDEN.input);
    expect(displayHex).toMatch(/^[0-9a-f]{64}$/);
  });

  test('opReturnBytes is a 32-byte Buffer', () => {
    const { opReturnBytes } = computeProposalHash(GOLDEN.input);
    expect(Buffer.isBuffer(opReturnBytes)).toBe(true);
    expect(opReturnBytes.length).toBe(32);
  });

  test('is deterministic for identical input', () => {
    const a = computeProposalHash(GOLDEN.input);
    const b = computeProposalHash(GOLDEN.input);
    expect(a.displayHex).toBe(b.displayHex);
    expect(a.opReturnBytes.equals(b.opReturnBytes)).toBe(true);
  });
});

describe('computeProposalHash — field sensitivity', () => {
  // Any change to any hashed field must produce a different hash,
  // otherwise the hash function doesn't actually commit to those
  // fields and the on-chain protocol is broken.
  const base = GOLDEN.input;
  const baseHash = computeProposalHash(base).displayHex;

  test('changing revision changes the hash', () => {
    const h = computeProposalHash({ ...base, revision: 2 }).displayHex;
    expect(h).not.toBe(baseHash);
  });

  test('changing time changes the hash', () => {
    const h = computeProposalHash({ ...base, time: base.time + 1 }).displayHex;
    expect(h).not.toBe(baseHash);
  });

  test('changing one byte of dataHex changes the hash', () => {
    const flipped =
      base.dataHex.slice(0, -2) +
      (base.dataHex.slice(-2) === 'ff' ? '00' : 'ff');
    const h = computeProposalHash({ ...base, dataHex: flipped }).displayHex;
    expect(h).not.toBe(baseHash);
  });

  test('changing parentHash (to non-zero) changes the hash', () => {
    const h = computeProposalHash({
      ...base,
      parentHash:
        'a'.repeat(63) + '1',
    }).displayHex;
    expect(h).not.toBe(baseHash);
  });

  test('"0", null, undefined, and empty string all mean the zero uint256', () => {
    const ref = computeProposalHash({ ...base, parentHash: '0' }).displayHex;
    expect(computeProposalHash({ ...base, parentHash: null }).displayHex).toBe(
      ref
    );
    expect(
      computeProposalHash({ ...base, parentHash: undefined }).displayHex
    ).toBe(ref);
    expect(computeProposalHash({ ...base, parentHash: '' }).displayHex).toBe(
      ref
    );
    // Also explicit 64 zero hex chars should match
    expect(
      computeProposalHash({ ...base, parentHash: '0'.repeat(64) }).displayHex
    ).toBe(ref);
  });
});

describe('computeProposalHash — normalization', () => {
  test('dataHex is case-insensitive (Core lowercases via HexStr)', () => {
    const lower = GOLDEN.input.dataHex;
    const upper = lower.toUpperCase();
    const mixed = lower.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
    const ref = computeProposalHash({ ...GOLDEN.input, dataHex: lower })
      .displayHex;
    expect(
      computeProposalHash({ ...GOLDEN.input, dataHex: upper }).displayHex
    ).toBe(ref);
    expect(
      computeProposalHash({ ...GOLDEN.input, dataHex: mixed }).displayHex
    ).toBe(ref);
  });

  test('parentHash is case-insensitive', () => {
    const lower = 'a'.repeat(64);
    const upper = 'A'.repeat(64);
    const a = computeProposalHash({ ...GOLDEN.input, parentHash: lower });
    const b = computeProposalHash({ ...GOLDEN.input, parentHash: upper });
    expect(a.displayHex).toBe(b.displayHex);
  });

  test('empty dataHex is accepted (valid Core input for empty proposals)', () => {
    const { displayHex } = computeProposalHash({
      parentHash: '0',
      revision: 1,
      time: 1,
      dataHex: '',
    });
    expect(displayHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeProposalHash — input validation', () => {
  const ok = GOLDEN.input;
  test('revision must be an integer', () => {
    expect(() => computeProposalHash({ ...ok, revision: 'x' })).toThrow(
      /revision must be an integer/
    );
    expect(() => computeProposalHash({ ...ok, revision: 1.5 })).toThrow(
      /revision must be an integer/
    );
  });

  test('time must be positive integer', () => {
    expect(() => computeProposalHash({ ...ok, time: 0 })).toThrow(
      /time must be a positive integer/
    );
    expect(() => computeProposalHash({ ...ok, time: -1 })).toThrow(
      /time must be a positive integer/
    );
    expect(() => computeProposalHash({ ...ok, time: 1.5 })).toThrow(
      /time must be a positive integer/
    );
  });

  test('dataHex must be valid hex', () => {
    expect(() => computeProposalHash({ ...ok, dataHex: 'abc' })).toThrow(
      /even length/
    );
    expect(() => computeProposalHash({ ...ok, dataHex: 'zz' })).toThrow(
      /only hex/
    );
    expect(() => computeProposalHash({ ...ok, dataHex: 42 })).toThrow(
      /must be a string/
    );
  });

  test('parentHash must be "0" or 64 hex chars', () => {
    expect(() =>
      computeProposalHash({ ...ok, parentHash: 'abc' })
    ).toThrow(/parentHash/);
    expect(() =>
      computeProposalHash({ ...ok, parentHash: 'z'.repeat(64) })
    ).toThrow(/parentHash/);
  });
});

describe('displayHashToOpReturnBytes / opReturnBytesToDisplayHash', () => {
  test('round-trip is identity', () => {
    const display = GOLDEN.displayHex;
    const bytes = displayHashToOpReturnBytes(display);
    expect(opReturnBytesToDisplayHash(bytes)).toBe(display);
  });

  test('converts to/from the exact golden bytes', () => {
    expect(
      displayHashToOpReturnBytes(GOLDEN.displayHex).toString('hex')
    ).toBe(GOLDEN.opReturnHex);
    expect(
      opReturnBytesToDisplayHash(Buffer.from(GOLDEN.opReturnHex, 'hex'))
    ).toBe(GOLDEN.displayHex);
  });

  test('rejects non-hex / wrong-length inputs', () => {
    expect(() => displayHashToOpReturnBytes('zz')).toThrow(/64 hex/);
    expect(() => displayHashToOpReturnBytes('a'.repeat(63))).toThrow(/64 hex/);
    expect(() => opReturnBytesToDisplayHash(Buffer.alloc(31))).toThrow(
      /32-byte/
    );
    expect(() => opReturnBytesToDisplayHash('not a buffer')).toThrow(
      /32-byte/
    );
  });
});
