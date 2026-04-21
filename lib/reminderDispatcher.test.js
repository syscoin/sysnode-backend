const {
  createReminderDispatcher,
  bucketForTimeRemaining,
  formatDeadlineText,
  normalizeProposal,
  FINAL_24H_MS,
  DAYS_BEFORE_MS,
} = require('./reminderDispatcher');

const H64 = (c) => c.repeat(64);
const P1 = H64('a');
const P2 = H64('b');

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

// Test fixture: "now" is fixed; proposals carry their endEpoch in
// unix seconds. Adjust by constructing proposals that sit in the
// desired bucket. P1 and P2 share the same end_epoch so they are
// in the same governance cycle (matches Syscoin semantics where
// proposals voting for the same superblock share the same voting
// deadline). Mixed-deadline scenarios get their own dedicated
// helper below.
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

function proposalsEndingIn(msFromNow) {
  const endEpoch = Math.floor((NOW_MS + msFromNow) / 1000);
  return [
    { hash: P1, endEpoch },
    { hash: P2, endEpoch }, // same cycle
  ];
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
    expect(normalizeProposal({ hash: 'nope', endEpoch: NOW_SEC + 100 }, NOW_MS)).toBeNull();
    expect(normalizeProposal({ hash: P1, endEpoch: NOW_SEC - 1 }, NOW_MS)).toBeNull();
  });
  test('normalizes hash to lowercase and exposes deadlineMs', () => {
    const p = normalizeProposal({ hash: P1.toUpperCase(), endEpoch: NOW_SEC + 100 }, NOW_MS);
    expect(p.hash).toBe(P1);
    expect(p.deadlineMs).toBe((NOW_SEC + 100) * 1000);
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

  function mkDispatcher({
    users = [BASE_USER],
    receiptsMatches = new Set(),
    mailerImpl,
    getActiveProposals,
    reminderLogImpl,
  } = {}) {
    const mailer = mailerImpl || fakeMailer();
    const reminderLog = reminderLogImpl || fakeReminderLog();
    return {
      mailer,
      reminderLog,
      dispatcher: createReminderDispatcher({
        users: fakeUsersRepo(users),
        voteReceipts: fakeReceiptsRepo(receiptsMatches),
        reminderLog,
        mailer,
        getActiveProposals,
        now: () => NOW_MS,
      }),
    };
  }

  test('no active proposals → skipped=no_active_proposals, nothing sent', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      getActiveProposals: async () => [],
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({ sent: 0, skipped: 'no_active_proposals' });
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('deadline > 72h away → skipped=too_early', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      getActiveProposals: async () => proposalsEndingIn(96 * 3600 * 1000),
    });
    const out = await dispatcher.tick();
    expect(out).toMatchObject({ sent: 0, skipped: 'too_early' });
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('deadline within 72h, user not voted → days_before email is sent and logged', async () => {
    const { dispatcher, mailer, reminderLog } = mkDispatcher({
      getActiveProposals: async () => proposalsEndingIn(48 * 3600 * 1000),
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
    // Scope key embeds the earliest end_epoch (seconds) so repeat
    // ticks within the same cycle are idempotent.
    const earliestSec = Math.floor((NOW_MS + 48 * 3600 * 1000) / 1000);
    expect(reminderLog.has(BASE_USER.id, `cycle:${earliestSec}`, 'days_before'))
      .toBe(true);
  });

  test('deadline within 24h, user not voted → final_24h email sent', async () => {
    const { dispatcher, mailer } = mkDispatcher({
      getActiveProposals: async () => proposalsEndingIn(12 * 3600 * 1000),
    });
    const out = await dispatcher.tick();
    expect(out.bucket).toBe('final_24h');
    expect(out.sent).toBe(1);
    expect(mailer.sendVoteReminder).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'final_24h' })
    );
  });

  test('USER SPEC: voted on any cycle proposal → BOTH buckets are suppressed', async () => {
    // This is the critical user-facing contract. A user who has
    // already voted on one proposal in the cycle must NOT receive
    // either the days_before OR the final_24h reminder.
    //
    // We run the dispatcher in the days_before window first, then
    // advance to the final_24h window. Both ticks must be no-ops for
    // this user.
    const votedOnP1 = new Set([`${BASE_USER.id}|${P1}`]);
    {
      const { dispatcher, mailer } = mkDispatcher({
        receiptsMatches: votedOnP1,
        getActiveProposals: async () => proposalsEndingIn(48 * 3600 * 1000),
      });
      const out = await dispatcher.tick();
      expect(out.sent).toBe(0);
      expect(out.skippedVoted).toBe(1);
      expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
    }
    {
      const { dispatcher, mailer } = mkDispatcher({
        receiptsMatches: votedOnP1,
        getActiveProposals: async () => proposalsEndingIn(12 * 3600 * 1000),
      });
      const out = await dispatcher.tick();
      expect(out.sent).toBe(0);
      expect(out.skippedVoted).toBe(1);
      expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
    }
  });

  test('Codex round-2 P2: vote on a later-cycle proposal does NOT suppress the current cycle reminder', async () => {
    // Regression guard for the bug Codex flagged: `tick()` computes
    // the cycle from the earliest end_epoch, but the old code built
    // `proposalHashes` from ALL active proposals. That let a vote
    // on a future-cycle proposal incorrectly satisfy the
    // "already voted in this cycle" gate and drop the current
    // cycle's reminder.
    //
    // Fixture:
    //   P1 — ends in 48h (current cycle, days_before bucket)
    //   P2 — ends in 96h (future cycle, > 72h away so alone would
    //        be "too_early")
    //
    // User has voted on P2 only. The reminder for P1's cycle must
    // still fire; proposalCount must reflect the cycle (= 1, P1
    // only), not the full active list (= 2).
    const earlyEpoch = Math.floor((NOW_MS + 48 * 3600 * 1000) / 1000);
    const lateEpoch = Math.floor((NOW_MS + 96 * 3600 * 1000) / 1000);
    const votedOnFuture = new Set([`${BASE_USER.id}|${P2}`]);
    const { dispatcher, mailer } = mkDispatcher({
      receiptsMatches: votedOnFuture,
      getActiveProposals: async () => [
        { hash: P1, endEpoch: earlyEpoch },
        { hash: P2, endEpoch: lateEpoch },
      ],
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

  test('USER SPEC: user who gets the days_before email then votes → no final_24h email', async () => {
    // The full lifecycle. Tick 1: days_before window, user hasn't
    // voted → email sent. User votes. Tick 2: final_24h window, but
    // the cycle-vote gate now returns true → suppressed.
    const receiptsState = new Set();
    const users = fakeUsersRepo([BASE_USER]);
    const reminderLog = fakeReminderLog();
    const mailer = fakeMailer();
    let currentProposalsMs = 48 * 3600 * 1000;

    const dispatcher = createReminderDispatcher({
      users,
      voteReceipts: {
        hasAnyRelayedInCycle: (uid, hashes) =>
          hashes.some((h) => receiptsState.has(`${uid}|${h.toLowerCase()}`)),
      },
      reminderLog,
      mailer,
      getActiveProposals: async () => proposalsEndingIn(currentProposalsMs),
      now: () => NOW_MS,
    });

    // Tick 1: days_before → email fires.
    const t1 = await dispatcher.tick();
    expect(t1.bucket).toBe('days_before');
    expect(t1.sent).toBe(1);

    // User votes (on any cycle proposal — P2 here to prove "any").
    receiptsState.add(`${BASE_USER.id}|${P2}`);

    // Clock jumps forward into the final_24h window.
    currentProposalsMs = 6 * 3600 * 1000;
    const t2 = await dispatcher.tick();
    expect(t2.bucket).toBe('final_24h');
    expect(t2.sent).toBe(0);
    expect(t2.skippedVoted).toBe(1);
    // And no second email went out.
    expect(mailer.sentMessages.filter((m) => m.bucket === 'final_24h')).toEqual(
      []
    );
  });

  test('USER SPEC: user who does nothing in cycle gets BOTH emails', async () => {
    // The complementary case to the one above. A fresh log and a
    // user who never votes must receive one email per bucket.
    const reminderLog = fakeReminderLog();
    const mailer = fakeMailer();
    let currentProposalsMs = 48 * 3600 * 1000;

    const dispatcher = createReminderDispatcher({
      users: fakeUsersRepo([BASE_USER]),
      voteReceipts: fakeReceiptsRepo(new Set()),
      reminderLog,
      mailer,
      getActiveProposals: async () => proposalsEndingIn(currentProposalsMs),
      now: () => NOW_MS,
    });

    await dispatcher.tick();                    // days_before
    currentProposalsMs = 6 * 3600 * 1000;
    await dispatcher.tick();                    // final_24h

    const buckets = mailer.sentMessages.map((m) => m.bucket).sort();
    expect(buckets).toEqual(['days_before', 'final_24h']);
  });

  test('idempotency: repeat tick in the same bucket does not re-send', async () => {
    // Defends against a boot-loop, a clock wobble, or an operator
    // manually running tick() on a schedule tighter than intended.
    const { dispatcher, mailer } = mkDispatcher({
      getActiveProposals: async () => proposalsEndingIn(48 * 3600 * 1000),
    });
    await dispatcher.tick();
    await dispatcher.tick();
    await dispatcher.tick();
    expect(mailer.sendVoteReminder).toHaveBeenCalledTimes(1);
  });

  test('mailer failure does NOT log the send → next tick retries', async () => {
    // If we logged before sending, a flaky SMTP would permanently
    // drop the reminder. Log-after-send is the safer trade.
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
      getActiveProposals: async () => proposalsEndingIn(48 * 3600 * 1000),
    });
    const t1 = await dispatcher.tick();
    expect(t1.failed).toBe(1);
    expect(t1.sent).toBe(0);
    const t2 = await dispatcher.tick();
    expect(t2.sent).toBe(1);
    expect(mailer.sendVoteReminder).toHaveBeenCalledTimes(2);
  });

  test('users without email or id are silently skipped', async () => {
    // Defensive: users.listWithRemindersEnabled should never return
    // malformed rows, but if it did (e.g. a corrupted DB read during
    // a mid-migration state), we skip rather than blow up the tick.
    const { dispatcher, mailer } = mkDispatcher({
      users: [
        { id: 1, email: null },
        { id: null, email: 'x@x.com' },
        BASE_USER,
      ],
      getActiveProposals: async () => proposalsEndingIn(48 * 3600 * 1000),
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
    expect(out).toEqual({ sent: 0, skipped: 'proposals_unavailable' });
    expect(mailer.sendVoteReminder).not.toHaveBeenCalled();
  });

  test('factory rejects missing dependencies', () => {
    expect(() => createReminderDispatcher({})).toThrow(/users/);
    expect(() =>
      createReminderDispatcher({
        users: fakeUsersRepo([]),
      })
    ).toThrow(/voteReceipts/);
  });
});
