'use strict';

const {
  MAX_DATA_SIZE,
  MAX_NAME_SIZE,
  SATS_PER_SYS,
  formatSysAmount,
  sanitizeName,
  parsePaymentAmountToSats,
  normalizeInput,
  canonicalize,
  buildCanonicalJSON,
  validateStructural,
  parseCoreRejectMessage,
} = require('./proposalValidate');

const validInput = {
  name: 'Test-Proposal',
  url: 'https://example.org/p',
  payment_address: 'sys1q9h6mlnq2mwmlyyz4wa3q69lzq7h6mlsfqsp7mt',
  payment_amount: '42.5',
  start_epoch: 1800000000,
  end_epoch: 1802592000,
};

// -----------------------------------------------------------------------
// formatSysAmount — canonical decimal representation
// -----------------------------------------------------------------------
describe('formatSysAmount', () => {
  test('whole SYS has no decimal point', () => {
    expect(formatSysAmount(0n)).toBe('0');
    expect(formatSysAmount(SATS_PER_SYS)).toBe('1');
    expect(formatSysAmount(150n * SATS_PER_SYS)).toBe('150');
  });

  test('fractional SYS drops trailing zeros', () => {
    expect(formatSysAmount(10000000n)).toBe('0.1');
    expect(formatSysAmount(50000000n)).toBe('0.5');
    expect(formatSysAmount(4250000000n)).toBe('42.5');
  });

  test('one satoshi is 0.00000001, never scientific', () => {
    expect(formatSysAmount(1n)).toBe('0.00000001');
    expect(formatSysAmount(10n)).toBe('0.0000001');
  });

  test('huge values don\u2019t overflow', () => {
    const big = BigInt('99999999') * SATS_PER_SYS;
    expect(formatSysAmount(big)).toBe('99999999');
  });

  test('accepts number/string inputs by coercion to BigInt', () => {
    expect(formatSysAmount(100000000)).toBe('1');
    expect(formatSysAmount('100000000')).toBe('1');
  });
});

// -----------------------------------------------------------------------
// parsePaymentAmountToSats — bigint-safe SYS -> sats
// -----------------------------------------------------------------------
describe('parsePaymentAmountToSats', () => {
  test('simple whole SYS', () => {
    expect(parsePaymentAmountToSats('1')).toBe(SATS_PER_SYS);
    expect(parsePaymentAmountToSats(1)).toBe(SATS_PER_SYS);
  });

  test('fractional SYS', () => {
    expect(parsePaymentAmountToSats('42.5')).toBe(4250000000n);
    expect(parsePaymentAmountToSats('0.1')).toBe(10000000n);
    expect(parsePaymentAmountToSats('0.00000001')).toBe(1n);
  });

  test('rejects more than 8 decimal places', () => {
    expect(() => parsePaymentAmountToSats('0.123456789')).toThrow(
      /more than 8 decimal/
    );
  });

  test('rejects non-numeric strings', () => {
    expect(() => parsePaymentAmountToSats('abc')).toThrow(/not a decimal/);
    expect(() => parsePaymentAmountToSats('')).toThrow(/not a decimal/);
  });

  test('accepts BigInt directly', () => {
    expect(parsePaymentAmountToSats(123n)).toBe(123n);
  });

  // Codex PR8 round 13 P2: JS Number.toString() uses scientific
  // notation for magnitudes outside ~[1e-6, 1e21), so the numeric
  // input branch must route through a decimal form before the
  // regex check. Otherwise valid sats-scale amounts are rejected
  // as `payment_amount is not a decimal number` even though the
  // function documents support for numeric inputs.
  test('numeric input that stringifies to scientific notation', () => {
    // 1 sat as a JS number: (0.00000001).toString() === "1e-8"
    expect(parsePaymentAmountToSats(0.00000001)).toBe(1n);
    // 2 sats: (0.00000002).toString() === "2e-8"
    expect(parsePaymentAmountToSats(0.00000002)).toBe(2n);
    // A middling exponent magnitude that also defaults to exp form
    // in some engines: 5e-7 === 50 sats
    expect(parsePaymentAmountToSats(0.0000005)).toBe(50n);
    // And plain decimals still work identically.
    expect(parsePaymentAmountToSats(1.5)).toBe(150000000n);
  });

  test('numeric zero and negative zero normalize to 0n sats', () => {
    expect(parsePaymentAmountToSats(0)).toBe(0n);
    expect(parsePaymentAmountToSats(-0)).toBe(0n);
  });

  // Codex PR8 round 14 P1: numeric inputs with more than 8 decimal
  // places must be REJECTED, matching the string path's behavior.
  // Earlier code routed through `toFixed(8)` which silently rounded
  // — `0.000000009` became 1 sat and `1.999999999` became 2 SYS,
  // so the on-chain payment_amount could differ from what the
  // client sent. Correct behavior: throw so the caller's /prepare
  // or /drafts PATCH surfaces a `validation_failed` issue and the
  // user re-enters a representable amount.
  test('numeric over-precision is rejected, not silently rounded', () => {
    expect(() => parsePaymentAmountToSats(0.000000009)).toThrow(
      /more than 8 decimal/
    );
    // 9 decimals — mid-range, also scientific-notation territory
    // on some engines. Must throw.
    expect(() => parsePaymentAmountToSats(0.0000000099)).toThrow(
      /more than 8 decimal/
    );
    // 10 decimals in the "middle" (no exponent form in toString),
    // still must throw. 1.0000000001 = 1 + 1e-10; toString yields
    // "1.0000000001".
    expect(() => parsePaymentAmountToSats(1.0000000001)).toThrow(
      /more than 8 decimal/
    );
  });

  test('numeric values at exactly 8 decimals are preserved, not rounded', () => {
    // 1 sat must remain 1 sat, not get rounded to a neighbor by a
    // faulty normalization path.
    expect(parsePaymentAmountToSats(0.00000001)).toBe(1n);
    // 1.00000001 SYS = 100_000_001 sats. Precision at 8 decimals.
    // This value is exactly representable as a sum of powers of 2?
    // Close enough via JS; what matters is the accepted decimal
    // representation from toString preserves 8 digits without
    // introducing a 9th.
    // Note: (1.00000001).toString() === "1.00000001" on V8.
    expect(parsePaymentAmountToSats(1.00000001)).toBe(100000001n);
  });
});

// -----------------------------------------------------------------------
// sanitizeName — Core's rule: lowercase, strip chars outside [-_a-z0-9]
// -----------------------------------------------------------------------
describe('sanitizeName', () => {
  test('lowercases input', () => {
    expect(sanitizeName('HELLO')).toBe('hello');
  });

  test('preserves dashes and underscores', () => {
    expect(sanitizeName('my-proposal_1')).toBe('my-proposal_1');
  });

  test('strips spaces and symbols', () => {
    expect(sanitizeName('My Test! @#$')).toBe('mytest');
  });

  test('returns empty string for garbage input', () => {
    expect(sanitizeName('!!!')).toBe('');
    expect(sanitizeName(null)).toBe('');
    expect(sanitizeName(undefined)).toBe('');
    expect(sanitizeName(42)).toBe('');
  });
});

// -----------------------------------------------------------------------
// normalizeInput — glue between user input and the canonical form
// -----------------------------------------------------------------------
describe('normalizeInput', () => {
  test('accepts SYS decimal and converts to sats', () => {
    const n = normalizeInput({ ...validInput });
    expect(n.payment_amount_sats).toBe(4250000000n);
  });

  test('accepts payment_amount_sats directly (BigInt-safe)', () => {
    const n = normalizeInput({
      ...validInput,
      payment_amount: undefined,
      payment_amount_sats: '999999999999',
    });
    expect(n.payment_amount_sats).toBe(999999999999n);
  });

  test('sanitizes name', () => {
    const n = normalizeInput({ ...validInput, name: 'Some Title!!' });
    expect(n.name).toBe('sometitle');
  });

  test('trims strings', () => {
    const n = normalizeInput({
      ...validInput,
      payment_address: '  sys1qabc  ',
      url: '  https://x.co  ',
    });
    expect(n.payment_address).toBe('sys1qabc');
    expect(n.url).toBe('https://x.co');
  });

  test('sets payment_amount_sats to null on unparsable input (so validator flags it)', () => {
    const n = normalizeInput({ ...validInput, payment_amount: 'not a number' });
    expect(n.payment_amount_sats).toBeNull();
  });
});

// -----------------------------------------------------------------------
// canonicalize / buildCanonicalJSON — determinism
// -----------------------------------------------------------------------
describe('canonicalize — determinism', () => {
  test('fixed key order: type, name, start_epoch, end_epoch, address, amount, url', () => {
    const { json } = canonicalize(validInput);
    const keyOrder = json.match(/"(\w+)"\s*:/g).map((m) => m.match(/"(\w+)"/)[1]);
    expect(keyOrder).toEqual([
      'type',
      'name',
      'start_epoch',
      'end_epoch',
      'payment_address',
      'payment_amount',
      'url',
    ]);
  });

  test('two identical inputs produce byte-identical output', () => {
    const a = canonicalize(validInput);
    const b = canonicalize(validInput);
    expect(a.json).toBe(b.json);
    expect(a.dataHex).toBe(b.dataHex);
  });

  test('input key order does not affect output bytes', () => {
    const reversed = {};
    for (const k of Object.keys(validInput).reverse()) reversed[k] = validInput[k];
    expect(canonicalize(reversed).json).toBe(canonicalize(validInput).json);
  });

  test('type is always 1', () => {
    const { json } = canonicalize(validInput);
    expect(json).toMatch(/"type":1,/);
  });

  test('byteLength matches UTF-8 byte count of the JSON', () => {
    const c = canonicalize(validInput);
    expect(c.byteLength).toBe(Buffer.byteLength(c.json, 'utf8'));
  });

  test('dataHex is a valid even-length lowercase hex string', () => {
    const { dataHex } = canonicalize(validInput);
    expect(dataHex).toMatch(/^[0-9a-f]+$/);
    expect(dataHex.length % 2).toBe(0);
  });

  test('UTF-8 encoding: multi-byte chars in name are counted correctly', () => {
    // Names are sanitized so only ASCII survives, but URLs can have
    // unicode. Verify byte counting is UTF-8 aware.
    const c = canonicalize({ ...validInput, url: 'https://example.org/\u00e9' });
    // "é" is 2 bytes in UTF-8; the JSON string would contain the escape
    // or the raw bytes. Either way byteLength should match Buffer.
    expect(c.byteLength).toBe(Buffer.byteLength(c.json, 'utf8'));
  });
});

describe('buildCanonicalJSON — number precision', () => {
  test('payment_amount round-trips as decimal SYS, never scientific', () => {
    const one_sat = canonicalize({ ...validInput, payment_amount: '0.00000001' }).json;
    expect(one_sat).toContain('"payment_amount":0.00000001');
    expect(one_sat).not.toContain('e-');
  });

  test('whole-SYS amounts have no decimal point', () => {
    const hundred = canonicalize({ ...validInput, payment_amount: '100' }).json;
    expect(hundred).toContain('"payment_amount":100');
  });

  test('epochs are emitted as integer literals (no decimal point)', () => {
    const { json } = canonicalize({
      ...validInput,
      start_epoch: 1700000000,
      end_epoch: 1800000000,
    });
    expect(json).toContain('"start_epoch":1700000000,');
    expect(json).toContain('"end_epoch":1800000000,');
  });
});

// -----------------------------------------------------------------------
// validateStructural — Core's rules + our UX-stricter ones
// -----------------------------------------------------------------------
describe('validateStructural — happy path', () => {
  test('valid input passes', () => {
    const c = canonicalize(validInput);
    expect(validateStructural(c).ok).toBe(true);
  });

  test('maximum-size valid payload passes', () => {
    // Push name to 40 chars; url length within what still fits.
    const c = canonicalize({
      ...validInput,
      name: 'x'.repeat(40),
    });
    expect(validateStructural(c).ok).toBe(true);
  });
});

describe('validateStructural — name', () => {
  test('empty name', () => {
    const c = canonicalize({ ...validInput, name: '' });
    const r = validateStructural(c);
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'name_required')).toBeTruthy();
  });

  test('name > 40 chars', () => {
    // 40-char limit applies after sanitize; feed 50 alphanumerics.
    const raw = 'a'.repeat(50);
    const c = canonicalize({ ...validInput, name: raw });
    const r = validateStructural(c);
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'name_too_long')).toBeTruthy();
  });

  test('name with invalid chars is auto-sanitized; empty after sanitize fails', () => {
    const c = canonicalize({ ...validInput, name: '!!!' });
    const r = validateStructural(c);
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'name_required')).toBeTruthy();
  });
});

describe('validateStructural — epochs', () => {
  test('missing epochs', () => {
    const c = canonicalize({ ...validInput, start_epoch: null, end_epoch: null });
    const r = validateStructural(c);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'epoch_missing')).toBe(true);
  });

  test('end <= start', () => {
    const c = canonicalize({
      ...validInput,
      start_epoch: 1800000000,
      end_epoch: 1800000000,
    });
    const r = validateStructural(c);
    expect(r.issues.find((i) => i.code === 'epoch_order')).toBeTruthy();
  });

  test('end in the past (when nowSeconds provided)', () => {
    const c = canonicalize({
      ...validInput,
      start_epoch: 1700000000,
      end_epoch: 1700001000,
    });
    const r = validateStructural(c, { nowSeconds: 1800000000 });
    expect(r.issues.find((i) => i.code === 'epoch_past')).toBeTruthy();
  });
});

describe('validateStructural — amount', () => {
  test('zero', () => {
    const c = canonicalize({ ...validInput, payment_amount: '0' });
    const r = validateStructural(c);
    expect(r.issues.find((i) => i.code === 'amount_not_positive')).toBeTruthy();
  });

  test('unparsable amount', () => {
    const c = canonicalize({ ...validInput, payment_amount: 'xyz' });
    const r = validateStructural(c);
    expect(r.issues.find((i) => i.code === 'amount_not_positive')).toBeTruthy();
  });

  test('tiny positive amount is fine', () => {
    const c = canonicalize({ ...validInput, payment_amount: '0.00000001' });
    const r = validateStructural(c);
    expect(r.ok).toBe(true);
  });
});

describe('validateStructural — address', () => {
  test('empty', () => {
    const c = canonicalize({ ...validInput, payment_address: '' });
    const r = validateStructural(c);
    expect(r.issues.find((i) => i.code === 'address_required')).toBeTruthy();
  });

  test('contains whitespace', () => {
    const c = canonicalize({
      ...validInput,
      payment_address: 'sys1q xyz abc',
    });
    const r = validateStructural(c);
    expect(
      r.issues.find(
        (i) => i.code === 'address_whitespace' || i.code === 'address_invalid'
      )
    ).toBeTruthy();
  });

  test('fails sanity regex (too short)', () => {
    const c = canonicalize({ ...validInput, payment_address: 'abc' });
    const r = validateStructural(c);
    expect(r.issues.find((i) => i.code === 'address_invalid')).toBeTruthy();
  });
});

describe('validateStructural — url', () => {
  test('empty', () => {
    const c = canonicalize({ ...validInput, url: '' });
    const r = validateStructural(c);
    expect(r.issues.find((i) => i.code === 'url_required')).toBeTruthy();
  });

  test('too short', () => {
    const c = canonicalize({ ...validInput, url: 'a' });
    const r = validateStructural(c);
    expect(
      r.issues.find((i) => i.code === 'url_too_short' || i.code === 'url_scheme')
    ).toBeTruthy();
  });

  test('missing scheme', () => {
    const c = canonicalize({ ...validInput, url: 'example.org' });
    const r = validateStructural(c);
    expect(r.issues.find((i) => i.code === 'url_scheme')).toBeTruthy();
  });

  test('javascript: URL rejected by our stricter rule', () => {
    const c = canonicalize({ ...validInput, url: 'javascript:alert(1)' });
    const r = validateStructural(c);
    expect(r.issues.find((i) => i.code === 'url_scheme')).toBeTruthy();
  });

  test('whitespace in url', () => {
    const c = canonicalize({ ...validInput, url: 'https://ex ample.com' });
    const r = validateStructural(c);
    expect(
      r.issues.find((i) => i.code === 'url_whitespace' || i.code === 'url_scheme')
    ).toBeTruthy();
  });
});

describe('validateStructural — payload size', () => {
  test('payload over 512 bytes rejected', () => {
    // 40-char name + long URL should still overflow because the
    // address + scaffolding plus a bloated URL can exceed 512.
    const longUrl = 'https://example.org/' + 'x'.repeat(500);
    const c = canonicalize({ ...validInput, url: longUrl });
    expect(c.byteLength).toBeGreaterThan(MAX_DATA_SIZE);
    const r = validateStructural(c);
    expect(r.issues.find((i) => i.code === 'payload_too_large')).toBeTruthy();
  });
});

describe('validateStructural — multiple issues surfaced together', () => {
  test('returns all issues in one call', () => {
    const c = canonicalize({
      ...validInput,
      name: '',
      url: '',
      payment_amount: '0',
    });
    const r = validateStructural(c);
    expect(r.ok).toBe(false);
    const codes = new Set(r.issues.map((i) => i.code));
    expect(codes.has('name_required')).toBe(true);
    expect(codes.has('url_required')).toBe(true);
    expect(codes.has('amount_not_positive')).toBe(true);
  });
});

// -----------------------------------------------------------------------
// parseCoreRejectMessage — translate Core's error strings
// -----------------------------------------------------------------------
describe('parseCoreRejectMessage', () => {
  test('maps multiple concatenated reasons', () => {
    const out = parseCoreRejectMessage(
      'Invalid name;name exceeds 40 characters;Invalid URL;url too short;'
    );
    const codes = out.map((i) => i.code);
    expect(codes).toContain('name_too_long');
    expect(codes).toContain('url_invalid');
  });

  test('maps script-address rejection', () => {
    const out = parseCoreRejectMessage('script addresses are not supported;');
    expect(out[0].code).toBe('address_script_type');
  });

  test('maps data-exceeds-max-size', () => {
    const out = parseCoreRejectMessage('data exceeds 512 characters;');
    expect(out[0].code).toBe('payload_too_large');
  });

  test('falls back to raw message when nothing matches', () => {
    const out = parseCoreRejectMessage('something weird we did not anticipate');
    expect(out[0].code).toBe('core_rejected');
    expect(out[0].message).toMatch(/something weird/);
  });

  test('returns [] for empty/null input', () => {
    expect(parseCoreRejectMessage('')).toEqual([]);
    expect(parseCoreRejectMessage(null)).toEqual([]);
  });
});
