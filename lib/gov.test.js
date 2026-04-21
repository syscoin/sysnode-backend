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
// 65-byte compact sig base64. 65 bytes of 0x00 encode to 87 "A"
// characters followed by a single "=" padding char (canonical form).
// We generate it from Buffer rather than hand-rolling the string so
// the fixture stays in sync with Node's base64 encoder.
const SIG = Buffer.alloc(65).toString('base64');

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
    // 88 chars, no padding — decodes to 66 bytes, one too many.
    // Charset-only validators accept this; the byte-length check
    // is what rejects it.
    ['decodes to 66 bytes', 'A'.repeat(88)],
    // 86 chars + "==" — decodes to only 64 bytes. Syntactically a
    // valid base64 string of the "right" length but the wrong
    // payload size.
    ['decodes to 64 bytes', 'A'.repeat(86) + '=='],
    // Non-canonical encoding: swap the final data char in a valid
    // 65-byte sig for "B", which has pad bits 0b01 instead of 0b00.
    // The decoder silently discards those bits, yielding 65 zero
    // bytes — re-encoding then produces a different string, so the
    // roundtrip check fires. Belt-and-braces against encoders that
    // might leak non-zero trailing bits.
    [
      'non-canonical trailing bits',
      Buffer.alloc(65).toString('base64').slice(0, -2) + 'B=',
    ],
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

describe('relayVotes with receipts', () => {
  const proposal = VALID_HASH;
  const validated = {
    proposalHash: proposal,
    voteOutcome: 'yes',
    voteSignal: 'funding',
    time: NOW_S,
    entries: [
      { collateralHash: VALID_HASH_2, collateralIndex: 0, voteSig: SIG },
      { collateralHash: VALID_HASH_2, collateralIndex: 1, voteSig: SIG },
      { collateralHash: VALID_HASH_2, collateralIndex: 2, voteSig: SIG },
    ],
  };

  // Minimal in-memory fake of the receipts repo. Good enough to
  // exercise relayVotes' decision logic without reaching for a real
  // SQLite DB; the real repo is exhaustively covered by
  // lib/voteReceipts.test.js.
  function makeFakeRepo(initial = {}) {
    const decisions = new Map(Object.entries(initial.decisions || {})); // key -> decision
    const upserts = [];
    const upsertErrors = initial.upsertErrors || new Set();
    return {
      decisions,
      upserts,
      decideRelay: jest.fn(({ collateralHash, collateralIndex }) => {
        const key = `${collateralHash}:${collateralIndex}`;
        return decisions.get(key) || { action: 'relay' };
      }),
      upsert: jest.fn((rec) => {
        const key = `${rec.collateralHash}:${rec.collateralIndex}`;
        if (upsertErrors.has(key)) throw new Error('disk full');
        upserts.push(rec);
        return rec;
      }),
    };
  }

  test('short-circuits entries with action=skip, does not call voteRaw', async () => {
    const userId = 42;
    const voteRaw = jest.fn().mockResolvedValue('Voted successfully');
    const receipts = makeFakeRepo({
      decisions: {
        [`${VALID_HASH_2}:0`]: {
          action: 'skip',
          reason: 'already_on_chain',
        },
        [`${VALID_HASH_2}:1`]: {
          action: 'skip',
          reason: 'recently_relayed',
        },
      },
    });
    const out = await relayVotes(voteRaw, validated, { receipts, userId });
    expect(voteRaw).toHaveBeenCalledTimes(1); // only entry 2 hit Core
    expect(out.results).toEqual([
      {
        collateralHash: VALID_HASH_2,
        collateralIndex: 0,
        ok: true,
        skipped: 'already_on_chain',
      },
      {
        collateralHash: VALID_HASH_2,
        collateralIndex: 1,
        ok: true,
        skipped: 'recently_relayed',
      },
      {
        collateralHash: VALID_HASH_2,
        collateralIndex: 2,
        ok: true,
      },
    ]);
    expect(out.accepted).toBe(3);
    expect(out.rejected).toBe(0);
    // Only the actually-relayed entry gets a fresh upsert; the
    // skipped rows already represent authoritative state we want to
    // preserve (especially submitted_at).
    expect(receipts.upsert).toHaveBeenCalledTimes(1);
    expect(receipts.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        collateralHash: VALID_HASH_2,
        collateralIndex: 2,
        status: 'relayed',
        lastError: null,
        userId,
      })
    );
  });

  test('successful relay persists a relayed receipt', async () => {
    const userId = 42;
    const voteRaw = jest.fn().mockResolvedValue('ok');
    const receipts = makeFakeRepo();
    await relayVotes(voteRaw, validated, { receipts, userId });
    expect(receipts.upsert).toHaveBeenCalledTimes(3);
    const statuses = receipts.upserts.map((u) => u.status);
    expect(statuses).toEqual(['relayed', 'relayed', 'relayed']);
    // Each persisted receipt carries the correct batch-level fields.
    for (const u of receipts.upserts) {
      expect(u.userId).toBe(userId);
      expect(u.proposalHash).toBe(proposal);
      expect(u.voteOutcome).toBe('yes');
      expect(u.voteSignal).toBe('funding');
      expect(u.voteTime).toBe(NOW_S);
      expect(u.lastError).toBeNull();
    }
  });

  test('failed relay persists a failed receipt with classified code', async () => {
    const userId = 42;
    const voteRaw = jest.fn().mockImplementation((_h, idx) => {
      if (idx === 0) return Promise.resolve('ok');
      // Switched from 'Masternode voting too often' to a malformed
      // signature so the classifier yields a non-duplicate code.
      // `vote_too_often` is explicitly carved out as a benign
      // Core-side signal that must NOT overwrite prior receipt state
      // (see the dedicated test below); testing it here would be
      // testing the wrong branch.
      if (idx === 1) return Promise.reject(new Error('Malformed base64'));
      return Promise.reject(new Error('Failure to verify vote.'));
    });
    const receipts = makeFakeRepo();
    const out = await relayVotes(voteRaw, validated, { receipts, userId });
    expect(out.accepted).toBe(1);
    expect(out.rejected).toBe(2);
    const byIdx = Object.fromEntries(
      receipts.upserts.map((u) => [u.collateralIndex, u])
    );
    expect(byIdx[0]).toMatchObject({ status: 'relayed', lastError: null });
    expect(byIdx[1]).toMatchObject({
      status: 'failed',
      lastError: 'signature_malformed',
    });
    expect(byIdx[2]).toMatchObject({
      status: 'failed',
      lastError: 'signature_invalid',
    });
  });

  test('duplicate-vote RPC codes preserve a prior good receipt (confirmed/relayed)', async () => {
    // `already_voted` / `vote_too_often` are Core signals that an
    // acceptable vote is already on chain — NOT bookkeeping
    // failures. When we already hold a 'confirmed' or 'relayed'
    // receipt for the outpoint, writing status:'failed' here
    // would clobber it with a spurious failure until the next
    // reconcile caught up, surfacing a false negative in the
    // summary and retry UX. Branch on decision.previous so that
    // path stays a no-op.
    const userId = 42;
    const voteRaw = jest
      .fn()
      .mockRejectedValueOnce(new Error('Masternode voting too often'))
      .mockRejectedValueOnce(new Error('Already known valid vote'))
      .mockRejectedValueOnce(new Error('Failure to verify vote'));
    // Seed decisions such that each duplicate-code entry has a
    // GOOD prior receipt attached (one 'confirmed', one 'relayed').
    // decideRelay still returns action:'relay' (the receipt is
    // stale or vote-change) but the previous is what matters for
    // persistence branching.
    // The `validated` fixture has three entries all on VALID_HASH_2
    // (indices 0/1/2). Seed decisions so entries 0 and 1 carry a
    // prior good receipt (confirmed / relayed respectively) and
    // entry 2 defaults to plain action:'relay' with no `previous`.
    const receipts = makeFakeRepo({
      decisions: {
        [`${VALID_HASH_2}:0`]: {
          action: 'relay',
          previous: {
            status: 'confirmed',
            voteOutcome: 'yes',
            voteSignal: 'funding',
          },
        },
        [`${VALID_HASH_2}:1`]: {
          action: 'relay',
          previous: {
            status: 'relayed',
            voteOutcome: 'yes',
            voteSignal: 'funding',
          },
        },
      },
    });
    const out = await relayVotes(voteRaw, validated, { receipts, userId });
    expect(out.accepted).toBe(0);
    expect(out.rejected).toBe(3);
    expect(out.results.map((r) => r.error)).toEqual([
      'vote_too_often',
      'already_voted',
      'signature_invalid',
    ]);
    // Only the non-duplicate code persisted. The two duplicate
    // entries had prior good receipts, so upsert was NOT called
    // for them.
    expect(receipts.upsert).toHaveBeenCalledTimes(1);
    const [upserted] = receipts.upsert.mock.calls[0];
    expect(upserted.status).toBe('failed');
    expect(upserted.lastError).toBe('signature_invalid');
  });

  test('duplicate-vote RPC codes on cold start persist an anchor receipt so reconcile can backfill', async () => {
    // Codex P1 (round 6): a cold-start user (or a user whose
    // previous row is 'failed'/'stale') whose vote hits Core with
    // an already-on-chain response MUST get a receipt anchor
    // written. reconcileForProposal iterates existing rows only;
    // without an anchor the receipt is invisible forever and the
    // summary / retry UX stay inconsistent even though Core gave
    // a deterministic duplicate-vote response.
    //
    // The anchor is written with status:'relayed' and the
    // user's requested outcome. On the next reconcile the chain's
    // authoritative (outpoint, signal) -> (outcome, voteTime) wins
    // and the row flips to 'confirmed', correcting the outcome if
    // the chain has a different one (e.g. voted from another
    // device before we got the rate-limit).
    const userId = 42;
    const voteRaw = jest
      .fn()
      .mockRejectedValueOnce(new Error('Masternode voting too often'))
      .mockRejectedValueOnce(new Error('Already known valid vote'))
      .mockRejectedValueOnce(new Error('Failure to verify vote'));
    // Cold start for the first two entries (no prior row); the
    // third has a stale 'failed' prior that we're also allowed to
    // upgrade to 'relayed' on a duplicate-vote — but here the
    // third entry is a non-duplicate failure so it stays the
    // 'failed' path.
    const receipts = makeFakeRepo();
    const out = await relayVotes(voteRaw, validated, { receipts, userId });
    expect(out.results.map((r) => r.error)).toEqual([
      'vote_too_often',
      'already_voted',
      'signature_invalid',
    ]);
    // Three upserts: two duplicate-code anchors + one real failure.
    expect(receipts.upsert).toHaveBeenCalledTimes(3);
    const calls = receipts.upsert.mock.calls.map(([arg]) => arg);
    expect(calls[0]).toMatchObject({
      status: 'relayed',
      lastError: null,
      voteOutcome: 'yes',
      voteSignal: 'funding',
    });
    expect(calls[1]).toMatchObject({
      status: 'relayed',
      lastError: null,
      voteOutcome: 'yes',
      voteSignal: 'funding',
    });
    expect(calls[2]).toMatchObject({
      status: 'failed',
      lastError: 'signature_invalid',
    });
  });

  test('duplicate-vote code with prior failed/stale is upgraded to a relayed anchor', async () => {
    // If we previously wrote 'failed' (e.g. malformed signature on
    // an earlier attempt) and the user successfully re-signed
    // elsewhere such that the chain now holds their vote,
    // Core returns already_voted on our re-submit. We must still
    // write an anchor so reconcile can promote to 'confirmed' —
    // don't leave the receipt showing a false-negative 'failed'.
    const userId = 42;
    const voteRaw = jest
      .fn()
      .mockRejectedValueOnce(new Error('Already known valid vote'))
      .mockResolvedValueOnce('ok')
      .mockResolvedValueOnce('ok');
    const receipts = makeFakeRepo({
      decisions: {
        [`${VALID_HASH_2}:0`]: {
          action: 'relay',
          previous: {
            status: 'failed',
            lastError: 'signature_malformed',
            voteOutcome: 'yes',
            voteSignal: 'funding',
          },
        },
      },
    });
    const out = await relayVotes(voteRaw, validated, { receipts, userId });
    expect(out.results[0]).toMatchObject({ ok: false, error: 'already_voted' });
    // The prior 'failed' row is upgraded to 'relayed' (null error)
    // so reconcile can later flip to 'confirmed'.
    const calls = receipts.upsert.mock.calls.map(([arg]) => arg);
    const firstEntryUpsert = calls.find(
      (c) => c.collateralHash === VALID_HASH_2 && c.collateralIndex === 0
    );
    expect(firstEntryUpsert).toMatchObject({
      status: 'relayed',
      lastError: null,
    });
  });

  test('receipt upsert failures are logged but do not halt the batch', async () => {
    const userId = 42;
    const voteRaw = jest.fn().mockResolvedValue('ok');
    const receipts = makeFakeRepo({
      upsertErrors: new Set([`${VALID_HASH_2}:1`]),
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await relayVotes(voteRaw, validated, { receipts, userId });
      // All three entries still counted as accepted from the
      // chain's perspective — the receipt write is a local
      // concern.
      expect(out.accepted).toBe(3);
      expect(out.rejected).toBe(0);
      // The failing upsert triggered a single console.error call.
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  test('without a receipts repo, behaviour is the PR5 fire-and-forget shape', async () => {
    const voteRaw = jest.fn().mockResolvedValue('ok');
    // Either omit options entirely OR pass userId without repo — both
    // must degrade to "no short-circuit, no persistence".
    const out1 = await relayVotes(voteRaw, validated);
    expect(out1.results.every((r) => r.ok && !('skipped' in r))).toBe(true);
    const out2 = await relayVotes(voteRaw, validated, { userId: 42 });
    expect(out2.results.every((r) => r.ok && !('skipped' in r))).toBe(true);
  });

  test('without a userId, receipts repo is ignored (defense in depth)', async () => {
    const voteRaw = jest.fn().mockResolvedValue('ok');
    const receipts = makeFakeRepo();
    await relayVotes(voteRaw, validated, { receipts }); // no userId
    expect(receipts.decideRelay).not.toHaveBeenCalled();
    expect(receipts.upsert).not.toHaveBeenCalled();
  });

  test('decideRelay throwing does NOT block the vote — degrades to full relay', async () => {
    // Codex-review guard: receipts are best-effort infrastructure.
    // A transient SQLite failure in the decideRelay pre-pass must
    // never cause /gov/vote to 500 — that would introduce a hard
    // dependency on our bookkeeping table for core voting
    // availability. The correct degradation is to skip the
    // short-circuit optimisation for the failing row and relay to
    // Core as if there were no prior receipt.
    const voteRaw = jest.fn().mockResolvedValue('ok');
    const receipts = makeFakeRepo();
    // Make decideRelay throw for one entry, return a valid skip
    // decision for another, and fall through to default for the
    // third. All three must yield a well-formed per-entry result.
    let call = 0;
    receipts.decideRelay.mockImplementation(
      ({ collateralHash, collateralIndex }) => {
        call += 1;
        if (call === 1) throw new Error('sqlite busy');
        if (`${collateralHash}:${collateralIndex}` === `${VALID_HASH_2}:1`) {
          return { action: 'skip', reason: 'already_on_chain' };
        }
        return { action: 'relay' };
      }
    );
    const out = await relayVotes(voteRaw, validated, { receipts, userId: 42 });
    // Two entries went to Core (the throwing one, which fell back
    // to relay, and the default-relay one); one was short-circuited.
    expect(voteRaw).toHaveBeenCalledTimes(2);
    expect(out.accepted).toBe(3); // skipped entry counts as ok:true
    expect(out.rejected).toBe(0);
    // The row whose decideRelay threw still has a well-formed
    // result: ok:true from voteRaw, no `skipped` flag.
    const r0 = out.results.find((r) => r.collateralIndex === 0);
    expect(r0).toEqual({
      collateralHash: VALID_HASH_2,
      collateralIndex: 0,
      ok: true,
    });
  });
});
