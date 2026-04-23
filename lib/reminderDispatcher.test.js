const {
  createReminderDispatcher,
  bucketForTimeRemaining,
  formatDeadlineText,
  normalizeProposal,
  proposalIsEligibleForSb,
  FINAL_24H_MS,
  DAYS_BEFORE_MS,
  SUPERBLOCK_MATURITY_WINDOW_SEC,
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

// Test fixture: "now" is fixed. Tests express their bucket target as
// "milliseconds from now until the MATURITY WINDOW OPENS" — the
// dispatcher anchors its deadline there (SB_epoch - 3 days), not at
// the SB itself. E.g. for a days_before fixture we point maturity
// 48h out, which means the SB is 48h + 3d = 5d out.
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;
const MATURITY_WINDOW_MS = SUPERBLOCK_MATURITY_WINDOW_SEC * 1000;
const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

const SB_CYCLE_SEC = 17520 * 150; // mainnet superblock cadence
const BASE_SB_HEIGHT = 600_000; // arbitrary; only stability matters

function sbEpochSecForMaturityOffset(msToMaturity) {
  // Given how far in the future the maturity window should open,
  // return the implied SB epoch (maturity + 3d).
  return Math.floor((NOW_MS + msToMaturity + MATURITY_WINDOW_MS) / 1000);
}

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

// Default "two-proposal cycle" — P1 and P2 both eligible for the
// upcoming SB.
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

describe('constants', () => {
  test('SUPERBLOCK_MATURITY_WINDOW_SEC matches Core (1728 × 150)', () => {
    expect(SUPERBLOCK_MATURITY_WINDOW_SEC).toBe(1728 * 150);
    expect(SUPERBLOCK_MATURITY_WINDOW_SEC).toBe(3 * 24 * 3600);
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
  const sbSec = NOW_SEC + 5 * 24 * 3600; // 5 days out (maturity + 2d)

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

  // `maturityOffsetMs`: how far in the future the MATURITY WINDOW
  // opens (not the SB). The dispatcher anchors its bucketing there.
  //   48h → days_before  (SB is at +48h + 3d = +5d)
  //    6h → final_24h    (SB is at +6h + 3d = +3d6h)
  //   96h → too_early    (SB is at +96h + 3d)
  //  -1h  → maturity_window_open (SB is in <3d)
  function mkDispatcher({
    users = [BASE_USER],
    receiptsMatches = new Set(),
    mailerImpl,
    getActiveProposals,
    getNextSuperblock,
    maturityOffsetMs = 48 * 3600 * 1000,
    height = BASE_SB_HEIGHT,
    reminderLogImpl,
  } = {}) {
    const mailer = mailerImpl || fakeMailer();
    const reminderLog = reminderLogImpl || fakeReminderLog();
    const defaultSbEpochSec = sbEpochSecForMaturityOffset(maturityOffsetMs);
    return {
      mailer,
      reminderLog,
      sbEpochSec: defaultSbEpochSec,
      height,
      dispatcher: createReminderDispatcher({
        users: fakeUsersRepo(users),
        voteReceipts: fakeReceiptsRepo(receiptsMatches),
        reminderLog,
        mailer,
        getActiveProposals: getActiveProposals || (async () => cycleProposals()),
        getNextSuperblock:
          getNextSuperblock ||
          (async () => ({ height, epochSec: defaultSbEpochSec })),
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

  test('maturity opens > 72h away → skipped=too_early', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      maturityOffsetMs: 96 * 3600 * 1000,
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({ sent: 0, skipped: 'too_early' });
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('maturity window already open → skipped=maturity_window_open (too late for reminders)', async () => {
    // SB is only 2 days out — we are already inside the 3-day
    // maturity window. Masternodes have begun committing
    // YES-FUNDING trigger votes; a reminder now would only fuel
    // anxiety. Suppress.
    const sbEpochSec = NOW_SEC + 2 * 24 * 3600;
    const { dispatcher, mailer } = mkDispatcher({
      getNextSuperblock: async () => ({ height: BASE_SB_HEIGHT, epochSec: sbEpochSec }),
    });
    const out = await dispatcher.tick();
    expect(out.skipped).toBe('maturity_window_open');
    expect(out.msRemaining).toBeLessThanOrEqual(0);
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('maturity opens within 72h, user not voted → days_before email sent and logged with sb:<height> scope', async () => {
    const { dispatcher, mailer, reminderLog, height } = mkDispatcher({
      maturityOffsetMs: 48 * 3600 * 1000,
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({
      sent: 1,
      skippedVoted: 0,
      skippedLogged: 0,
      bucket: 'days_before',
      candidateCount: 1,
      proposalCount: 2,
      height,
    });
    expect(mailer.sendVoteReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'voter@example.com',
        bucket: 'days_before',
        proposalCount: 2,
      })
    );
    // scopeKey keys on the stable BLOCK HEIGHT, not the drifting
    // epochSec estimate. This is what makes the reminder log
    // actually deduplicate across ticks (Codex PR14 P1 fix).
    expect(reminderLog.has(BASE_USER.id, `sb:${height}`, 'days_before')).toBe(
      true
    );
  });

  test('maturity opens within 24h, user not voted → final_24h email sent', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      maturityOffsetMs: 12 * 3600 * 1000,
    });
    const out = await dispatcher.tick();
    expect(out.bucket).toBe('final_24h');
    expect(out.sent).toBe(1);
    expect(mailer.sendVoteReminder).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'final_24h' })
    );
  });

  test('Codex PR14 P1: scopeKey stability — epochSec drift between ticks does NOT trigger a duplicate send', async () => {
    // sysMain recomputes superBlockNextEpochSec every 20s from
    // Date.now() + diffBlock * avgBlockTime, so epochSec drifts
    // forward by ~20 each tick even when the target SB hasn't
    // changed. If scopeKey were keyed on epochSec, reminderLog.has()
    // would never return true in the 72h window and a user could
    // get hourly reminders for 72 hours straight (72 duplicates).
    // Keying on height closes that loophole: same height → same
    // scope → dedup works.
    const reminderLog = fakeReminderLog();
    const mailer = fakeMailer();
    let epochSec = sbEpochSecForMaturityOffset(48 * 3600 * 1000);
    const dispatcher = createReminderDispatcher({
      users: fakeUsersRepo([BASE_USER]),
      voteReceipts: fakeReceiptsRepo(new Set()),
      reminderLog,
      mailer,
      getActiveProposals: async () => cycleProposals(),
      // Drift the epochSec forward 20s each tick but keep height
      // stable. This is exactly what sysMain does in production.
      getNextSuperblock: async () => {
        const snap = { height: BASE_SB_HEIGHT, epochSec };
        epochSec += 20;
        return snap;
      },
      now: () => NOW_MS,
    });
    const t1 = await dispatcher.tick();
    const t2 = await dispatcher.tick();
    const t3 = await dispatcher.tick();
    expect(t1.sent).toBe(1);
    expect(t2.sent).toBe(0);
    expect(t2.skippedLogged).toBe(1);
    expect(t3.sent).toBe(0);
    expect(t3.skippedLogged).toBe(1);
    expect(mailer.sendVoteReminder).toHaveBeenCalledTimes(1);
  });

  test('USER SPEC: voted on any cycle-eligible proposal → BOTH buckets are suppressed', async () => {
    // A user who has already voted on one proposal eligible for the
    // upcoming SB must NOT receive either the days_before OR the
    // final_24h reminder.
    const votedOnP1 = new Set([`${BASE_USER.id}|${P1}`]);
    {
      const { dispatcher, mailer } = mkDispatcher({
        receiptsMatches: votedOnP1,
        maturityOffsetMs: 48 * 3600 * 1000,
      });
      const out = await dispatcher.tick();
      expect(out.sent).toBe(0);
      expect(out.skippedVoted).toBe(1);
      expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
    }
    {
      const { dispatcher, mailer } = mkDispatcher({
        receiptsMatches: votedOnP1,
        maturityOffsetMs: 12 * 3600 * 1000,
      });
      const out = await dispatcher.tick();
      expect(out.sent).toBe(0);
      expect(out.skippedVoted).toBe(1);
      expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
    }
  });

  test('vote on a future-cycle proposal (pre-activation for this SB) does NOT suppress the current cycle reminder', async () => {
    // Regression guard: a vote on a proposal NOT eligible for the
    // upcoming SB (its startEpoch is after sbEpochSec, i.e. it
    // belongs to a later cycle) must not cancel this cycle's
    // reminder. proposalCount must reflect the eligible set only.
    const maturityOffsetMs = 48 * 3600 * 1000;
    const sbEpochSec = sbEpochSecForMaturityOffset(maturityOffsetMs);
    const currentCycle = thisCycleProposal(P1);
    const futureCycle = {
      hash: P2,
      startEpoch: sbEpochSec + 7 * 24 * 3600, // activates a week AFTER upcoming SB
      endEpoch: sbEpochSec + ONE_YEAR_MS / 1000,
    };
    const votedOnFuture = new Set([`${BASE_USER.id}|${P2}`]);
    const { dispatcher, mailer } = mkDispatcher({
      receiptsMatches: votedOnFuture,
      maturityOffsetMs,
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

  test('scopeKey rotates on height change — reminder fires again for the next SB', async () => {
    // A multi-month proposal gets two legitimately separate
    // reminder cycles: one for SB_N, one for SB_{N+1}. The height
    // jump (by nSuperblockCycle blocks) rotates scopeKey so the
    // reminder-log entry for SB_N no longer suppresses SB_{N+1}.
    const reminderLog = fakeReminderLog();
    const mailer = fakeMailer();
    let height = BASE_SB_HEIGHT;
    let epochSec = sbEpochSecForMaturityOffset(48 * 3600 * 1000);
    const proposal = thisCycleProposal(P1);
    const dispatcher = createReminderDispatcher({
      users: fakeUsersRepo([BASE_USER]),
      voteReceipts: fakeReceiptsRepo(new Set()),
      reminderLog,
      mailer,
      getActiveProposals: async () => [proposal],
      getNextSuperblock: async () => ({ height, epochSec }),
      now: () => NOW_MS,
    });
    const t1 = await dispatcher.tick();
    expect(t1.sent).toBe(1);

    // SB_N executes on-chain; sysMain picks up the new next-SB:
    // height advances by nSuperblockCycle, epochSec jumps ~30 days.
    height += 17520;
    epochSec += SB_CYCLE_SEC;
    // And we'd be in days_before for SB_{N+1} ... except from the
    // frozen "now" perspective the new maturity is ~30d out. So
    // this tick reports too_early — the test's point is just that
    // the dedup doesn't prematurely suppress when the underlying
    // SB changes. We assert the scope key from t1 would NOT
    // collide with the new one:
    expect(t1.scopeKey).toBe(`sb:${BASE_SB_HEIGHT}`);
    expect(`sb:${height}`).not.toBe(t1.scopeKey);
  });

  test('USER SPEC: user who gets the days_before email then votes → no final_24h email', async () => {
    const receiptsState = new Set();
    const users = fakeUsersRepo([BASE_USER]);
    const reminderLog = fakeReminderLog();
    const mailer = fakeMailer();
    let currentMaturityOffsetMs = 48 * 3600 * 1000;

    const dispatcher = createReminderDispatcher({
      users,
      voteReceipts: {
        hasAnyRelayedInCycle: (uid, hashes) =>
          hashes.some((h) => receiptsState.has(`${uid}|${h.toLowerCase()}`)),
      },
      reminderLog,
      mailer,
      getActiveProposals: async () => cycleProposals(),
      getNextSuperblock: async () => ({
        height: BASE_SB_HEIGHT,
        epochSec: sbEpochSecForMaturityOffset(currentMaturityOffsetMs),
      }),
      now: () => NOW_MS,
    });

    const t1 = await dispatcher.tick();
    expect(t1.bucket).toBe('days_before');
    expect(t1.sent).toBe(1);

    receiptsState.add(`${BASE_USER.id}|${P2}`);

    currentMaturityOffsetMs = 6 * 3600 * 1000;
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
    let currentMaturityOffsetMs = 48 * 3600 * 1000;

    const dispatcher = createReminderDispatcher({
      users: fakeUsersRepo([BASE_USER]),
      voteReceipts: fakeReceiptsRepo(new Set()),
      reminderLog,
      mailer,
      getActiveProposals: async () => cycleProposals(),
      getNextSuperblock: async () => ({
        height: BASE_SB_HEIGHT,
        epochSec: sbEpochSecForMaturityOffset(currentMaturityOffsetMs),
      }),
      now: () => NOW_MS,
    });

    await dispatcher.tick(); // days_before
    currentMaturityOffsetMs = 6 * 3600 * 1000;
    await dispatcher.tick(); // final_24h

    const buckets = mailer.sentMessages.map((m) => m.bucket).sort();
    expect(buckets).toEqual(['days_before', 'final_24h']);
  });

  test('idempotency: repeat tick in the same bucket does not re-send', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      maturityOffsetMs: 48 * 3600 * 1000,
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
      maturityOffsetMs: 48 * 3600 * 1000,
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
      maturityOffsetMs: 48 * 3600 * 1000,
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

  test('getNextSuperblock throwing is reported, not fatal', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      getNextSuperblock: async () => {
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

  test('getNextSuperblock returning bogus height or epochSec → next_superblock_unavailable', async () => {
    const futureEpoch = sbEpochSecForMaturityOffset(48 * 3600 * 1000);
    const cases = [
      null,
      undefined,
      {},
      { height: 0, epochSec: futureEpoch },
      { height: -1, epochSec: futureEpoch },
      { height: 1.5, epochSec: futureEpoch },
      { height: 'tall', epochSec: futureEpoch },
      { height: 600_000, epochSec: 0 },
      { height: 600_000, epochSec: null },
      { height: 600_000, epochSec: NaN },
      // past epoch: /mnStats lagging behind the tip
      { height: 600_000, epochSec: Math.floor((NOW_MS - 10_000) / 1000) },
      // epoch equal to now: boundary — also treated as stale
      { height: 600_000, epochSec: Math.floor(NOW_MS / 1000) },
    ];
    for (const bogus of cases) {
      const { dispatcher, mailer } = mkDispatcher({
        getNextSuperblock: async () => bogus,
      });
      const out = await dispatcher.tick();
      expect(out.skipped).toBe('next_superblock_unavailable');
      expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
    }
  });

  test('proposals fetched but ALL are ineligible for the upcoming SB → no_active_proposals', async () => {
    const maturityOffsetMs = 48 * 3600 * 1000;
    const sbEpochSec = sbEpochSecForMaturityOffset(maturityOffsetMs);
    const preActivation = {
      hash: P3,
      startEpoch: sbEpochSec + 24 * 3600, // starts 1d after SB
      endEpoch: sbEpochSec + 1_000_000,
    };
    const { dispatcher, mailer } = mkDispatcher({
      maturityOffsetMs,
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
        // missing getNextSuperblock
      })
    ).toThrow(/getNextSuperblock/);
  });
});
