const { parseReminderProposals } = require('./reminderProposals');
const {
  createReminderDispatcher,
  SUPERBLOCK_MATURITY_WINDOW_SEC,
} = require('./reminderDispatcher');

const objectHash = 'a'.repeat(64),
  dataHash = 'b'.repeat(64);
const now = 1800000000000;
function proposal(overrides = {}) {
  return {
    Hash: dataHash,
    ObjectType: 1,
    fBlockchainValidity: true,
    fCachedValid: true,
    fCachedDelete: false,
    DataString: JSON.stringify({
      start_epoch: now / 1000 - 1000,
      end_epoch: now / 1000 + 30 * 86400,
    }),
    ...overrides,
  };
}

test('uses Core governance object ID rather than the unrelated DataHash for voting identity', () => {
  expect(parseReminderProposals({ [objectHash]: proposal() })).toEqual([
    expect.objectContaining({ hash: objectHash }),
  ]);
});

test('a real object-ID receipt suppresses the production-shaped proposal reminder', async () => {
  const sendVoteReminder = jest.fn();
  const dispatcher = createReminderDispatcher({
    users: {
      listWithRemindersEnabled: () => [
        { id: 1, email: 'fixture@example.test' },
      ],
    },
    voteReceipts: {
      hasAnyRelayedInCycle: (_user, hashes) => hashes.includes(objectHash),
    },
    reminderLog: { has: () => false, insert: () => ({ inserted: true }) },
    mailer: { sendVoteReminder },
    getActiveProposals: async () =>
      parseReminderProposals({ [objectHash]: proposal() }),
    getNextSuperblock: async () => ({
      height: 100000,
      currentHeight: 98248,
      maturityBlocks: 1728,
      observedAt: now,
      epochSec: now / 1000 + SUPERBLOCK_MATURITY_WINDOW_SEC + 3600,
    }),
    now: () => now,
  });
  await dispatcher.tick();
  expect(sendVoteReminder).not.toHaveBeenCalled();
});

test.each([
  { ObjectType: 2 },
  { fCachedValid: false },
  { fCachedDelete: true },
  { fBlockchainValidity: false },
  { fBlockchainValidity: undefined },
])(
  'does not treat an ineligible governance object as an active proposal: %p',
  (overrides) => {
    expect(
      parseReminderProposals({ [objectHash]: proposal(overrides) })
    ).toEqual([]);
  }
);

test.each([1743371426000, '1800000000', NaN, Infinity, 12.5, -1, 0])(
  'rejects unsupported end-epoch without rewriting it: %s',
  (end) => {
    expect(
      parseReminderProposals({
        [objectHash]: proposal({
          DataString: JSON.stringify({ start_epoch: 1, end_epoch: end }),
        }),
      })
    ).toEqual([]);
  }
);

test('explicit zero start is valid; absent start and zero object ID are not', () => {
  const zero = proposal({
    DataString: JSON.stringify({
      start_epoch: 0,
      end_epoch: now / 1000 + 1000,
    }),
  });
  expect(parseReminderProposals({ [objectHash]: zero })).toHaveLength(1);
  expect(parseReminderProposals({ ['0'.repeat(64)]: zero })).toEqual([]);
  expect(
    parseReminderProposals({
      [objectHash]: proposal({ DataString: '{"end_epoch":1800000010}' }),
    })
  ).toEqual([]);
});
