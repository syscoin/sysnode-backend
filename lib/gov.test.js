const {
  OUTCOMES,
  SIGNALS,
  MAX_LOOKUP_ADDRESSES,
  MAX_VOTE_ENTRIES,
  validateLookupBody,
  validateVoteBody,
  lookupMatches,
  relayVotes,
  classifyRpcError,
} = require('./gov');

// Fixed test clock aligned to a "nTime" the validators accept. All time-
// sensitive tests pass `nowMs` explicitly so the suite is deterministic
// and doesn't drift on slow CI runners.
const NOW_S = 1_700_000_000;
const NOW_MS = NOW_S * 1000;

const VALID_HASH =
  '1111111111111111111111111111111111111111111111111111111111111111';
const VALID_HASH_2 =
  '2222222222222222222222222222222222222222222222222222222222222222';
// 65-byte compact sig base64. "AA...A" is syntactically valid base64
// of the right length and avoids any risk of accidentally matching a
// real signature.
const SIG = 'A'.repeat(86) + '==';

describe('OUTCOMES / SIGNALS enum values match Syscoin Core', () => {
  test('outcomes use Core integer mapping', () => {
    expect(OUTCOMES).toEqual({ yes: 1, no: 2, abstain: 3 });
  });
  test('signals limited to funding in PR 5', () => {
    expect(SIGNALS).toEqual({ funding: 1 });
  });
});

describe('validateLookupBody', () => {
  test('rejects non-object body', () => {
    expect(validateLookupBody(null)).toEqual({ ok: false, error: 'invalid_body' });
    expect(validateLookupBody('x')).toEqual({ ok: false, error: 'invalid_body' });
  });
  test('rejects non-array votingAddresses', () => {
    expect(validateLookupBody({ votingAddresses: 'sys1q...' })).toEqual({
      ok: false,
      error: 'invalid_body',
    });
  });
  test('accepts empty array as a trivial no-op', () => {
    expect(validateLookupBody({ votingAddresses: [] })).toEqual({
      ok: true,
      votingAddresses: [],
    });
  });
  test('enforces cap', () => {
    const tooMany = Array.from(
      { length: MAX_LOOKUP_ADDRESSES + 1 },
      (_, i) => `sys1q${i}`
    );
    expect(validateLookupBody({ votingAddresses: tooMany })).toEqual({
      ok: false,
      error: 'too_many_addresses',
    });
  });
  test('rejects non-string / empty / oversized entries', () => {
    expect(
      validateLookupBody({ votingAddresses: [''] })
    ).toEqual({ ok: false, error: 'invalid_address' });
    expect(
      validateLookupBody({ votingAddresses: [123] })
    ).toEqual({ ok: false, error: 'invalid_address' });
    expect(
      validateLookupBody({ votingAddresses: ['x'.repeat(200)] })
    ).toEqual({ ok: false, error: 'invalid_address' });
  });
  test('trims whitespace on accepted entries', () => {
    expect(
      validateLookupBody({ votingAddresses: ['  sys1qabcdef  '] })
    ).toEqual({ ok: true, votingAddresses: ['sys1qabcdef'] });
  });
});

describe('validateVoteBody', () => {
  function goodBody(overrides = {}) {
    return {
      proposalHash: VALID_HASH,
      voteOutcome: 'yes',
      voteSignal: 'funding',
      time: NOW_S,
      entries: [
        { collateralHash: VALID_HASH_2, collateralIndex: 0, voteSig: SIG },
      ],
      ...overrides,
    };
  }

  test('accepts a well-formed body', () => {
    const out = validateVoteBody(goodBody(), { nowMs: NOW_MS });
    expect(out.ok).toBe(true);
    expect(out.proposalHash).toBe(VALID_HASH);
    expect(out.voteOutcome).toBe('yes');
    expect(out.voteSignal).toBe('funding');
    expect(out.time).toBe(NOW_S);
    expect(out.entries).toHaveLength(1);
  });

  test('rejects non-hex proposalHash', () => {
    const bad = validateVoteBody(goodBody({ proposalHash: 'not-hex' }), {
      nowMs: NOW_MS,
    });
    expect(bad).toEqual({ ok: false, error: 'invalid_proposal_hash' });
  });

  test('rejects non-64-char proposalHash', () => {
    const bad = validateVoteBody(goodBody({ proposalHash: '1234' }), {
      nowMs: NOW_MS,
    });
    expect(bad).toEqual({ ok: false, error: 'invalid_proposal_hash' });
  });

  test('rejects unknown outcome', () => {
    const bad = validateVoteBody(goodBody({ voteOutcome: 'maybe' }), {
      nowMs: NOW_MS,
    });
    expect(bad).toEqual({ ok: false, error: 'invalid_vote_outcome' });
  });

  test.each(['valid', 'delete', 'endorsed', 'none', ''])(
    'rejects non-funding signal (%s) until PR 6',
    (signal) => {
      const bad = validateVoteBody(goodBody({ voteSignal: signal }), {
        nowMs: NOW_MS,
      });
      expect(bad).toEqual({ ok: false, error: 'unsupported_vote_signal' });
    }
  );

  test('rejects times more than 1h in the future (Core rule)', () => {
    const bad = validateVoteBody(
      goodBody({ time: NOW_S + 3601 }),
      { nowMs: NOW_MS }
    );
    expect(bad).toEqual({ ok: false, error: 'time_in_future' });
  });

  test('accepts time exactly at the +1h boundary', () => {
    const out = validateVoteBody(
      goodBody({ time: NOW_S + 3600 }),
      { nowMs: NOW_MS }
    );
    expect(out.ok).toBe(true);
  });

  test('rejects times more than 2h in the past', () => {
    const bad = validateVoteBody(
      goodBody({ time: NOW_S - 7201 }),
      { nowMs: NOW_MS }
    );
    expect(bad).toEqual({ ok: false, error: 'time_too_old' });
  });

  test('rejects zero-length entries', () => {
    const bad = validateVoteBody(goodBody({ entries: [] }), {
      nowMs: NOW_MS,
    });
    expect(bad).toEqual({ ok: false, error: 'no_entries' });
  });

  test('enforces entry cap', () => {
    const tooMany = Array.from({ length: MAX_VOTE_ENTRIES + 1 }, (_, i) => ({
      collateralHash: VALID_HASH_2,
      collateralIndex: i,
      voteSig: SIG,
    }));
    const bad = validateVoteBody(goodBody({ entries: tooMany }), {
      nowMs: NOW_MS,
    });
    expect(bad).toEqual({ ok: false, error: 'too_many_entries' });
  });

  test('rejects duplicate outpoints in one batch', () => {
    const entries = [
      { collateralHash: VALID_HASH_2, collateralIndex: 0, voteSig: SIG },
      { collateralHash: VALID_HASH_2, collateralIndex: 0, voteSig: SIG },
    ];
    const bad = validateVoteBody(goodBody({ entries }), { nowMs: NOW_MS });
    expect(bad).toEqual({ ok: false, error: 'duplicate_entry:1' });
  });

  test('same hash but different index is NOT a duplicate', () => {
    const entries = [
      { collateralHash: VALID_HASH_2, collateralIndex: 0, voteSig: SIG },
      { collateralHash: VALID_HASH_2, collateralIndex: 1, voteSig: SIG },
    ];
    const out = validateVoteBody(goodBody({ entries }), { nowMs: NOW_MS });
    expect(out.ok).toBe(true);
  });

  test('normalises proposal / collateral hash to lowercase', () => {
    const out = validateVoteBody(
      goodBody({
        proposalHash: VALID_HASH.toUpperCase(),
        entries: [
          {
            collateralHash: VALID_HASH_2.toUpperCase(),
            collateralIndex: 3,
            voteSig: SIG,
          },
        ],
      }),
      { nowMs: NOW_MS }
    );
    expect(out.ok).toBe(true);
    expect(out.proposalHash).toBe(VALID_HASH);
    expect(out.entries[0].collateralHash).toBe(VALID_HASH_2);
  });

  test.each([
    ['short', 'A'],
    ['non-base64', '!'.repeat(88)],
    ['oversized', 'A'.repeat(100)],
  ])('rejects %s voteSig', (_label, voteSig) => {
    const bad = validateVoteBody(
      goodBody({
        entries: [
          { collateralHash: VALID_HASH_2, collateralIndex: 0, voteSig },
        ],
      }),
      { nowMs: NOW_MS }
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/voteSig$/);
  });

  test('rejects negative / fractional collateralIndex', () => {
    for (const bad of [-1, 1.5, NaN, '0']) {
      const res = validateVoteBody(
        goodBody({
          entries: [
            {
              collateralHash: VALID_HASH_2,
              collateralIndex: bad,
              voteSig: SIG,
            },
          ],
        }),
        { nowMs: NOW_MS }
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/collateralIndex$/);
    }
  });
});

describe('lookupMatches', () => {
  function mn(overrides = {}) {
    return {
      votingaddress: 'sys1qaaa',
      proTxHash: 'p1',
      collateralHash: VALID_HASH,
      collateralIndex: 0,
      status: 'ENABLED',
      address: '1.2.3.4:8369',
      payee: 'SY1pay1',
      ...overrides,
    };
  }

  test('returns empty on empty inputs', () => {
    expect(lookupMatches([], ['sys1qaaa'])).toEqual([]);
    expect(lookupMatches([mn()], [])).toEqual([]);
    expect(lookupMatches(null, ['sys1qaaa'])).toEqual([]);
    expect(lookupMatches([mn()], null)).toEqual([]);
  });

  test('matches on votingaddress (case-insensitive)', () => {
    const arr = [mn({ votingaddress: 'sys1qabc' })];
    const out = lookupMatches(arr, ['SYS1QABC']);
    expect(out).toHaveLength(1);
    expect(out[0].votingaddress).toBe('sys1qabc');
  });

  test('drops MNs without a parsed outpoint', () => {
    const arr = [
      mn({ votingaddress: 'sys1qbad', collateralHash: null, collateralIndex: null }),
      mn({ votingaddress: 'sys1qok' }),
    ];
    const out = lookupMatches(arr, ['sys1qbad', 'sys1qok']);
    expect(out).toHaveLength(1);
    expect(out[0].votingaddress).toBe('sys1qok');
  });

  test('projects only the subset the frontend needs', () => {
    const arr = [
      mn({
        votingaddress: 'sys1qabc',
        operatorPubKey: 'SHOULD_NOT_LEAK',
        secretField: 'nope',
      }),
    ];
    const out = lookupMatches(arr, ['sys1qabc']);
    expect(out[0]).toEqual({
      votingaddress: 'sys1qabc',
      proTxHash: 'p1',
      collateralHash: VALID_HASH,
      collateralIndex: 0,
      status: 'ENABLED',
      address: '1.2.3.4:8369',
      payee: 'SY1pay1',
    });
    expect(out[0].operatorPubKey).toBeUndefined();
    expect(out[0].secretField).toBeUndefined();
  });

  test('a lookup of 3 addrs against 500 MNs returns only the 3 matches', () => {
    const arr = Array.from({ length: 500 }, (_, i) =>
      mn({ votingaddress: `sys1qv${i}`, collateralIndex: i })
    );
    const out = lookupMatches(arr, ['sys1qv4', 'sys1qv42', 'sys1qv499']);
    expect(out.map((m) => m.votingaddress).sort()).toEqual([
      'sys1qv4',
      'sys1qv42',
      'sys1qv499',
    ]);
  });
});

describe('classifyRpcError', () => {
  test.each([
    ['Failure to find masternode in list : abcd-0', 'mn_not_found'],
    ['Failure to verify vote.', 'signature_invalid'],
    ['Masternode voting too often', 'vote_too_often'],
    ['Governance object not found', 'proposal_not_found'],
    ['Invalid vote signal. Please using one of...', 'invalid_vote_signal'],
    ['Invalid vote outcome. Please use one of...', 'invalid_vote_outcome'],
    ['Malformed base64 encoding', 'signature_malformed'],
    ['Already known valid vote', 'already_voted'],
    ['some wholly unrecognised error', 'rpc_error'],
    [undefined, 'rpc_error'],
  ])('%s -> %s', (msg, expected) => {
    expect(classifyRpcError(msg)).toBe(expected);
  });
});

describe('relayVotes', () => {
  const validated = {
    proposalHash: VALID_HASH,
    voteOutcome: 'yes',
    voteSignal: 'funding',
    time: NOW_S,
    entries: [
      { collateralHash: VALID_HASH_2, collateralIndex: 0, voteSig: SIG },
      { collateralHash: VALID_HASH_2, collateralIndex: 1, voteSig: SIG },
      { collateralHash: VALID_HASH_2, collateralIndex: 2, voteSig: SIG },
    ],
  };

  test('happy path: all entries accepted', async () => {
    const voteRaw = jest.fn().mockResolvedValue('Voted successfully');
    const out = await relayVotes(voteRaw, validated);
    expect(out.accepted).toBe(3);
    expect(out.rejected).toBe(0);
    expect(out.results.every((r) => r.ok)).toBe(true);
    // voteRaw is called with the contract Core expects:
    // (collateralHash, collateralIndex, proposalHash, signal, outcome, time, sigBase64)
    for (let i = 0; i < 3; i++) {
      expect(voteRaw).toHaveBeenNthCalledWith(
        i + 1,
        VALID_HASH_2,
        i,
        VALID_HASH,
        'funding',
        'yes',
        NOW_S,
        SIG
      );
    }
  });

  test('mixed: per-entry failures surface with codes, do not sink the batch', async () => {
    const voteRaw = jest.fn().mockImplementation((_h, idx) => {
      if (idx === 1) throw new Error('Failure to verify vote.');
      if (idx === 2)
        return Promise.reject(new Error('Masternode voting too often'));
      return Promise.resolve('Voted successfully');
    });
    const out = await relayVotes(voteRaw, validated, { concurrency: 2 });
    expect(out.accepted).toBe(1);
    expect(out.rejected).toBe(2);
    expect(out.results).toEqual([
      { collateralHash: VALID_HASH_2, collateralIndex: 0, ok: true },
      {
        collateralHash: VALID_HASH_2,
        collateralIndex: 1,
        ok: false,
        error: 'signature_invalid',
      },
      {
        collateralHash: VALID_HASH_2,
        collateralIndex: 2,
        ok: false,
        error: 'vote_too_often',
      },
    ]);
  });

  test('result ordering matches input ordering under concurrency', async () => {
    // Staggered resolutions: entry 0 slow, entry 1 fast, entry 2 medium.
    const voteRaw = jest.fn().mockImplementation(
      (_h, idx) =>
        new Promise((resolve) =>
          setTimeout(() => resolve('Voted successfully'), [30, 5, 15][idx])
        )
    );
    const out = await relayVotes(voteRaw, validated, { concurrency: 3 });
    expect(out.results.map((r) => r.collateralIndex)).toEqual([0, 1, 2]);
  });

  test('throws if voteRaw is missing', async () => {
    await expect(relayVotes(undefined, validated)).rejects.toThrow(
      /voteRaw function is required/
    );
  });
});
