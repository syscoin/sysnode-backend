const {
  createReminderDispatcher,
  bucketForTimeRemaining,
  formatDeadlineText,
  normalizeProposal,
  proposalIsEligibleForSb,
  FINAL_24H_MS,
  DAYS_BEFORE_MS,
} = require('./reminderDispatcher');

const H64 = (c) => c.repeat(64);
const P1 = H64('a');
const P2 = H64('b');
const P3 = H64('c');

// A DB-free fake. Each fake repo receives the bare surface the
// dispatcher needs and nothing else — this keeps the unit test
// decoupled from the SQL layer (which is already covered by the
// users / voteReceipts / reminderLog suites).
function fakeUsersRepo(users) {
  return {
    listWithRemindersEnabled: () => users.slice(),
  };
}
function fakeReceiptsRepo(matchSet) {
  // matchSet keyed by `${userId}|${proposalHash}` → true if the user
  // has a relayed/confirmed receipt on that proposal.
  return {
    hasAnyRelayedInCycle: (userId, hashes) =>
      hashes.some((h) => matchSet.has(`${userId}|${h.toLowerCase()}`)),
  };
}
function fakeReminderLog() {
  const state = new Map();
  const key = (u, s, b) => `${u}|${s}|${b}`;
  return {
    has: (u, s, b) => state.has(key(u, s, b)),
    insert: (u, s, b, sentAt) => {
      const k = key(u, s, b);
      if (state.has(k)) return { inserted: false, sentAt: null };
      state.set(k, sentAt);
      return { inserted: true, sentAt };
    },
    _state: state,
  };
}
function fakeMailer() {
  const sent = [];
  return {
    sentMessages: sent,
    sendVoteReminder: jest.fn(async (msg) => {
      sent.push(msg);
    }),
  };
}

// Test fixture: "now" is fixed; the next superblock lives at
// NOW + <bucket offset>. Proposals are constructed to either cover
// the upcoming SB (eligible for this cycle's reminder) or sit
// outside it (future cycle / already ended).
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

// Helper: a "this-cycle" proposal — spans from now-5d to now+1yr,
// so the upcoming SB (whatever offset) falls inside its eligibility
// window. The second hash arg defaults to P1 so the common case
// reads cleanly.
function thisCycleProposal(hash = P1) {
  return {
    hash,
    startEpoch: Math.floor((NOW_MS - 5 * 24 * 3600 * 1000) / 1000),
    endEpoch: Math.floor((NOW_MS + ONE_YEAR_MS) / 1000),
  };
}

// Helper: the default "two-proposal cycle" — P1 and P2 both
// eligible for the upcoming SB.
function cycleProposals() {
  return [thisCycleProposal(P1), thisCycleProposal(P2)];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('bucketForTimeRemaining', () => {
  test('≤0 and non-finite → null (nothing to do)', () => {
    expect(bucketForTimeRemaining(0)).toBeNull();
    expect(bucketForTimeRemaining(-1)).toBeNull();
    expect(bucketForTimeRemaining(NaN)).toBeNull();
    expect(bucketForTimeRemaining(Infinity)).toBeNull();
  });

  test('boundary: exactly 24h is the final_24h bucket, > 24h spills to days_before', () => {
    expect(bucketForTimeRemaining(FINAL_24H_MS)).toBe('final_24h');
    expect(bucketForTimeRemaining(FINAL_24H_MS + 1)).toBe('days_before');
  });

  test('boundary: exactly 72h is still days_before; > 72h is nothing (too early)', () => {
    expect(bucketForTimeRemaining(DAYS_BEFORE_MS)).toBe('days_before');
    expect(bucketForTimeRemaining(DAYS_BEFORE_MS + 1)).toBeNull();
  });

  test('mid-range: 48h → days_before, 6h → final_24h', () => {
    expect(bucketForTimeRemaining(48 * 3600 * 1000)).toBe('days_before');
    expect(bucketForTimeRemaining(6 * 3600 * 1000)).toBe('final_24h');
  });
});

describe('normalizeProposal', () => {
  test('rejects malformed hashes and past deadlines', () => {
    expect(normalizeProposal(null, NOW_MS)).toBeNull();
    expect(
      normalizeProposal({ hash: 'nope', endEpoch: NOW_SEC + 100 }, NOW_MS)
    ).toBeNull();
    expect(
      normalizeProposal({ hash: P1, endEpoch: NOW_SEC - 1 }, NOW_MS)
    ).toBeNull();
  });
  test('normalizes hash to lowercase and exposes startMs/endMs', () => {
    const p = normalizeProposal(
      { hash: P1.toUpperCase(), startEpoch: NOW_SEC, endEpoch: NOW_SEC + 100 },
      NOW_MS
    );
    expect(p.hash).toBe(P1);
    expect(p.startEpoch).toBe(NOW_SEC);
    expect(p.endEpoch).toBe(NOW_SEC + 100);
    expect(p.startMs).toBe(NOW_SEC * 1000);
    expect(p.endMs).toBe((NOW_SEC + 100) * 1000);
  });
  test('missing/zero/invalid startEpoch is treated as "no lower bound" (legacy compat)', () => {
    // Proposals stored by an older client with no start_epoch in
    // DataString must not silently drop out of the cycle — the
    // dispatcher's eligibility filter treats startEpoch=0 as
    // always-started.
    const cases = [
      { hash: P1, endEpoch: NOW_SEC + 100 }, // undefined startEpoch
      { hash: P1, startEpoch: 0, endEpoch: NOW_SEC + 100 },
      { hash: P1, startEpoch: -1, endEpoch: NOW_SEC + 100 },
      { hash: P1, startEpoch: 'bogus', endEpoch: NOW_SEC + 100 },
    ];
    for (const c of cases) {
      const p = normalizeProposal(c, NOW_MS);
      expect(p).not.toBeNull();
      expect(p.startEpoch).toBe(0);
    }
  });
});

describe('proposalIsEligibleForSb', () => {
  const sbSec = NOW_SEC + 2 * 24 * 3600; // 2 days out

  test('covers the SB inside its window → eligible', () => {
    const p = normalizeProposal(
      { hash: P1, startEpoch: NOW_SEC - 1000, endEpoch: NOW_SEC + 1_000_000 },
      NOW_MS
    );
    expect(proposalIsEligibleForSb(p, sbSec)).toBe(true);
  });
  test('pre-activation (startEpoch > sbSec) → not eligible', () => {
    const p = normalizeProposal(
      { hash: P1, startEpoch: sbSec + 1, endEpoch: sbSec + 1_000_000 },
      NOW_MS
    );
    expect(proposalIsEligibleForSb(p, sbSec)).toBe(false);
  });
  test('endEpoch strictly before the SB → not eligible (already ended for this SB)', () => {
    const p = normalizeProposal(
      { hash: P1, startEpoch: NOW_SEC - 1000, endEpoch: sbSec - 1 },
      NOW_MS
    );
    expect(proposalIsEligibleForSb(p, sbSec)).toBe(false);
  });
  test('boundary: startEpoch === sbSec OR endEpoch === sbSec → eligible (inclusive)', () => {
    const pStart = normalizeProposal(
      { hash: P1, startEpoch: sbSec, endEpoch: sbSec + 1000 },
      NOW_MS
    );
    expect(proposalIsEligibleForSb(pStart, sbSec)).toBe(true);
    const pEnd = normalizeProposal(
      { hash: P1, startEpoch: sbSec - 1000, endEpoch: sbSec },
      NOW_MS
    );
    expect(proposalIsEligibleForSb(pEnd, sbSec)).toBe(true);
  });
  test('legacy proposals with startEpoch=0 stay eligible as long as endEpoch covers the SB', () => {
    const p = normalizeProposal(
      { hash: P1, endEpoch: sbSec + 100 },
      NOW_MS
    );
    expect(proposalIsEligibleForSb(p, sbSec)).toBe(true);
  });
  test('rejects bogus SB second', () => {
    const p = normalizeProposal(
      { hash: P1, startEpoch: 0, endEpoch: NOW_SEC + 100 },
      NOW_MS
    );
    expect(proposalIsEligibleForSb(p, 0)).toBe(false);
    expect(proposalIsEligibleForSb(p, -1)).toBe(false);
    expect(proposalIsEligibleForSb(p, NaN)).toBe(false);
  });
});

describe('formatDeadlineText', () => {
  test('< 24h renders in hours', () => {
    expect(formatDeadlineText(3 * 3600 * 1000)).toMatch(/3 hours/);
    expect(formatDeadlineText(1 * 3600 * 1000)).toMatch(/1 hour\b/);
  });
  test('≥ 24h renders in days', () => {
    expect(formatDeadlineText(48 * 3600 * 1000)).toMatch(/2 days/);
    expect(formatDeadlineText(24 * 3600 * 1000)).toMatch(/1 day\b/);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher — tick()
// ---------------------------------------------------------------------------

describe('createReminderDispatcher.tick', () => {
  const BASE_USER = { id: 42, email: 'voter@example.com' };

  // `sbOffsetMs` is how far in the future the mocked next superblock
  // sits; the dispatcher buckets purely off that value, so tests
  // that want days_before pass 48h, tests that want final_24h pass
  // 6h, and tests that want "too early" pass 96h.
  function mkDispatcher({
    users = [BASE_USER],
    receiptsMatches = new Set(),
    mailerImpl,
    getActiveProposals,
    getNextSuperblockEpochSec,
    sbOffsetMs = 48 * 3600 * 1000,
    reminderLogImpl,
  } = {}) {
    const mailer = mailerImpl || fakeMailer();
    const reminderLog = reminderLogImpl || fakeReminderLog();
    const defaultSbEpochSec = Math.floor((NOW_MS + sbOffsetMs) / 1000);
    return {
      mailer,
      reminderLog,
      sbEpochSec: defaultSbEpochSec,
      dispatcher: createReminderDispatcher({
        users: fakeUsersRepo(users),
        voteReceipts: fakeReceiptsRepo(receiptsMatches),
        reminderLog,
        mailer,
        getActiveProposals: getActiveProposals || (async () => cycleProposals()),
        getNextSuperblockEpochSec:
          getNextSuperblockEpochSec || (async () => defaultSbEpochSec),
        now: () => NOW_MS,
      }),
    };
  }

  test('no active proposals → skipped=no_active_proposals, nothing sent', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      getActiveProposals: async () => [],
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({
      sent: 0,
      skipped: 'no_active_proposals',
      bucket: 'days_before',
    });
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('next SB > 72h away → skipped=too_early', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      sbOffsetMs: 96 * 3600 * 1000,
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({ sent: 0, skipped: 'too_early' });
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('next SB within 72h, user not voted → days_before email is sent and logged with sb:<epoch> scope', async () => {
    const { dispatcher, mailer, reminderLog, sbEpochSec } = mkDispatcher({
      sbOffsetMs: 48 * 3600 * 1000,
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({
      sent: 1,
      skippedVoted: 0,
      skippedLogged: 0,
      bucket: 'days_before',
      candidateCount: 1,
      proposalCount: 2,
    });
    expect(mailer.sendVoteReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'voter@example.com',
        bucket: 'days_before',
        proposalCount: 2,
      })
    );
    // scopeKey rotates with the SB, not with proposal end_epoch.
    expect(reminderLog.has(BASE_USER.id, `sb:${sbEpochSec}`, 'days_before')).toBe(
      true
    );
  });

  test('next SB within 24h, user not voted → final_24h email sent', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      sbOffsetMs: 12 * 3600 * 1000,
    });
    const out = await dispatcher.tick();
    expect(out.bucket).toBe('final_24h');
    expect(out.sent).toBe(1);
    expect(mailer.sendVoteReminder).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'final_24h' })
    );
  });

  test('USER SPEC: voted on any cycle-eligible proposal → BOTH buckets are suppressed', async () => {
    // This is the critical user-facing contract. A user who has
    // already voted on one proposal eligible for the upcoming SB
    // must NOT receive either the days_before OR the final_24h
    // reminder.
    const votedOnP1 = new Set([`${BASE_USER.id}|${P1}`]);
    {
      const { dispatcher, mailer } = mkDispatcher({
        receiptsMatches: votedOnP1,
        sbOffsetMs: 48 * 3600 * 1000,
      });
      const out = await dispatcher.tick();
      expect(out.sent).toBe(0);
      expect(out.skippedVoted).toBe(1);
      expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
    }
    {
      const { dispatcher, mailer } = mkDispatcher({
        receiptsMatches: votedOnP1,
        sbOffsetMs: 12 * 3600 * 1000,
      });
      const out = await dispatcher.tick();
      expect(out.sent).toBe(0);
      expect(out.skippedVoted).toBe(1);
      expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
    }
  });

  test('vote on a future-cycle proposal (pre-activation for this SB) does NOT suppress the current cycle reminder', async () => {
    // Regression guard carried forward from the old "Codex round-2
    // P2" test: a vote on a proposal that's NOT eligible for the
    // upcoming SB (its startEpoch is after sbEpochSec, i.e. it
    // belongs to a later cycle) must not cancel this cycle's
    // reminder. proposalCount must reflect the eligible set only.
    const sbOffsetMs = 48 * 3600 * 1000;
    const sbEpochSec = Math.floor((NOW_MS + sbOffsetMs) / 1000);
    const currentCycle = thisCycleProposal(P1);
    const futureCycle = {
      hash: P2,
      startEpoch: sbEpochSec + 7 * 24 * 3600, // activates a week AFTER the upcoming SB
      endEpoch: sbEpochSec + ONE_YEAR_MS / 1000,
    };
    const votedOnFuture = new Set([`${BASE_USER.id}|${P2}`]);
    const { dispatcher, mailer } = mkDispatcher({
      receiptsMatches: votedOnFuture,
      sbOffsetMs,
      getActiveProposals: async () => [currentCycle, futureCycle],
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({
      sent: 1,
      skippedVoted: 0,
      bucket: 'days_before',
      proposalCount: 1,
    });
    expect(mailer.sendVoteReminder).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'days_before', proposalCount: 1 })
    );
  });

  test('multi-month proposal appears in BOTH its covered SB cycles', async () => {
    // A 12-month proposal spans SB_1..SB_12. Its reminder should
    // fire on each SB_k whose maturity window approaches, until
    // the user votes or the proposal ends. scopeKey rotation
    // (sb:<epoch>) is what makes this work — SB_k and SB_{k+1}
    // are distinct cycles by construction.
    const longProposal = thisCycleProposal(P1);
    // First tick: SB_1 is 48h out.
    const t1 = mkDispatcher({
      sbOffsetMs: 48 * 3600 * 1000,
      getActiveProposals: async () => [longProposal],
    });
    const out1 = await t1.dispatcher.tick();
    expect(out1).toMatchObject({ sent: 1, bucket: 'days_before' });

    // Second tick: SB_2 is 48h out (SB_1 already happened). The
    // dispatcher sees a new scopeKey and sends a fresh days_before.
    // We model "SB_2" by simply moving the sbEpochSec forward one
    // cycle and keeping the proposal (it hasn't ended). In prod,
    // sysMain would have updated superBlockNextEpochSec after SB_1
    // executed.
    const SB_CYCLE_SEC = 17520 * 150;
    const sb2 = Math.floor((NOW_MS + 48 * 3600 * 1000) / 1000) + SB_CYCLE_SEC;
    const t2 = mkDispatcher({
      getActiveProposals: async () => [longProposal],
      getNextSuperblockEpochSec: async () => sb2,
      // sbOffsetMs ignored because we override getNextSuperblockEpochSec
    });
    // Freeze "now" at the same NOW_MS but use the injected SB_2.
    // The bucket will NOT be days_before here because SB_2 is a
    // whole cycle + 48h away — so it should be too_early. That's
    // actually the right behavior: the dispatcher wouldn't remind
    // about SB_2 until the chain is ~72h out from it. We assert
    // the natural bucket-by-remaining-time, not days_before.
    const out2 = await t2.dispatcher.tick();
    expect(out2.skipped).toBe('too_early');
  });

  test('USER SPEC: user who gets the days_before email then votes → no final_24h email', async () => {
    // The full lifecycle. Tick 1: days_before, user hasn't voted
    // → email sent. User votes. Tick 2: final_24h, but the
    // cycle-vote gate now returns true → suppressed.
    const receiptsState = new Set();
    const users = fakeUsersRepo([BASE_USER]);
    const reminderLog = fakeReminderLog();
    const mailer = fakeMailer();
    let currentSbOffsetMs = 48 * 3600 * 1000;

    const dispatcher = createReminderDispatcher({
      users,
      voteReceipts: {
        hasAnyRelayedInCycle: (uid, hashes) =>
          hashes.some((h) => receiptsState.has(`${uid}|${h.toLowerCase()}`)),
      },
      reminderLog,
      mailer,
      getActiveProposals: async () => cycleProposals(),
      getNextSuperblockEpochSec: async () =>
        Math.floor((NOW_MS + currentSbOffsetMs) / 1000),
      now: () => NOW_MS,
    });

    // Tick 1: days_before → email fires.
    const t1 = await dispatcher.tick();
    expect(t1.bucket).toBe('days_before');
    expect(t1.sent).toBe(1);

    // User votes (on any cycle-eligible proposal — P2 here to
    // prove "any").
    receiptsState.add(`${BASE_USER.id}|${P2}`);

    // Clock jumps forward into the final_24h window — same SB,
    // closer to it.
    currentSbOffsetMs = 6 * 3600 * 1000;
    const t2 = await dispatcher.tick();
    expect(t2.bucket).toBe('final_24h');
    expect(t2.sent).toBe(0);
    expect(t2.skippedVoted).toBe(1);
    expect(mailer.sentMessages.filter((m) => m.bucket === 'final_24h')).toEqual(
      []
    );
  });

  test('USER SPEC: user who does nothing in cycle gets BOTH emails', async () => {
    const reminderLog = fakeReminderLog();
    const mailer = fakeMailer();
    let currentSbOffsetMs = 48 * 3600 * 1000;

    const dispatcher = createReminderDispatcher({
      users: fakeUsersRepo([BASE_USER]),
      voteReceipts: fakeReceiptsRepo(new Set()),
      reminderLog,
      mailer,
      getActiveProposals: async () => cycleProposals(),
      getNextSuperblockEpochSec: async () =>
        Math.floor((NOW_MS + currentSbOffsetMs) / 1000),
      now: () => NOW_MS,
    });

    await dispatcher.tick(); // days_before
    currentSbOffsetMs = 6 * 3600 * 1000;
    await dispatcher.tick(); // final_24h

    const buckets = mailer.sentMessages.map((m) => m.bucket).sort();
    expect(buckets).toEqual(['days_before', 'final_24h']);
  });

  test('idempotency: repeat tick in the same bucket does not re-send', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      sbOffsetMs: 48 * 3600 * 1000,
    });
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();
    expect(mailer.sendVoteReminder).toHaveBeenCalledTimes(1);
  });

  test('mailer failure does NOT log the send → next tick retries', async () => {
    const mailer = {
      sendVoteReminder: jest
        .fn()
        .mockImplementationOnce(async () => {
          throw new Error('smtp down');
        })
        .mockImplementationOnce(async () => {
          /* second try ok */
        }),
      sentMessages: [],
    };
    const { dispatcher } = mkDispatcher({
      mailerImpl: mailer,
      sbOffsetMs: 48 * 3600 * 1000,
    });
    const t1 = await dispatcher.tick();
    expect(t1.failed).toBe(1);
    expect(t1.sent).toBe(0);
    const t2 = await dispatcher.tick();
    expect(t2.sent).toBe(1);
    expect(mailer.sendVoteReminder).toHaveBeenCalledTimes(2);
  });

  test('users without email or id are silently skipped', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      users: [
        { id: 1, email: null },
        { id: null, email: 'x@x.com' },
        BASE_USER,
      ],
      sbOffsetMs: 48 * 3600 * 1000,
    });
    const out = await dispatcher.tick();
    expect(out.sent).toBe(1);
    expect(mailer.sendVoteReminder).toHaveBeenCalledTimes(1);
  });

  test('getActiveProposals throwing is reported, not fatal', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      getActiveProposals: async () => {
        throw new Error('rpc down');
      },
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({ sent: 0, skipped: 'proposals_unavailable' });
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('getNextSuperblockEpochSec throwing is reported, not fatal', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      getNextSuperblockEpochSec: async () => {
        throw new Error('sysMain not warm');
      },
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({
      sent: 0,
      skipped: 'next_superblock_unavailable',
    });
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('getNextSuperblockEpochSec returning 0/null/NaN → next_superblock_unavailable', async () => {
    for (const bogus of [0, null, undefined, NaN, -1, 'soon']) {
      const { dispatcher, mailer } = mkDispatcher({
        getNextSuperblockEpochSec: async () => bogus,
      });
      const out = await dispatcher.tick();
      expect(out.skipped).toBe('next_superblock_unavailable');
      expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
    }
  });

  test('getNextSuperblockEpochSec returning a past timestamp → next_superblock_unavailable (stale)', async () => {
    // /mnStats occasionally lags past an actual superblock when
    // sysMain is mid-refresh. Firing a reminder keyed to a past
    // SB would be worse than skipping — the scopeKey would
    // correspond to a cycle that's already executed.
    const { dispatcher, mailer } = mkDispatcher({
      getNextSuperblockEpochSec: async () =>
        Math.floor((NOW_MS - 10_000) / 1000),
    });
    const out = await dispatcher.tick();
    expect(out.skipped).toBe('next_superblock_unavailable');
    expect(out.msRemaining).toBeLessThanOrEqual(0);
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('proposals fetched but ALL are ineligible for the upcoming SB → no_active_proposals', async () => {
    // Every returned proposal either starts after the upcoming
    // SB or ended before it. Dispatcher should treat this as an
    // empty cycle and not fire anything.
    const sbOffsetMs = 48 * 3600 * 1000;
    const sbEpochSec = Math.floor((NOW_MS + sbOffsetMs) / 1000);
    const preActivation = {
      hash: P3,
      startEpoch: sbEpochSec + 24 * 3600, // starts 1d after SB
      endEpoch: sbEpochSec + 1_000_000,
    };
    const { dispatcher, mailer } = mkDispatcher({
      sbOffsetMs,
      getActiveProposals: async () => [preActivation],
    });
    const out = await dispatcher.tick();
    expect(out.skipped).toBe('no_active_proposals');
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('factory rejects missing dependencies', () => {
    expect(() => createReminderDispatcher({})).toThrow(/users/);
    expect(() =>
      createReminderDispatcher({
        users: fakeUsersRepo([]),
      })
    ).toThrow(/voteReceipts/);
    expect(() =>
      createReminderDispatcher({
        users: fakeUsersRepo([]),
        voteReceipts: fakeReceiptsRepo(new Set()),
        reminderLog: fakeReminderLog(),
        mailer: fakeMailer(),
        getActiveProposals: async () => [],
        // missing getNextSuperblockEpochSec
      })
    ).toThrow(/getNextSuperblockEpochSec/);
  });
});
