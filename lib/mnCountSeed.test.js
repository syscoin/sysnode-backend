'use strict';

const path = require('path');
const { openDatabase } = require('./db');
const { createMasternodeCountRepo } = require('./masternodeCountRepo');
const {
  seedMasternodeCount,
  parseSeedCsv,
  DEFAULT_SEED_PATH,
} = require('./mnCountSeed');

describe('parseSeedCsv', () => {
  test('parses legacy Timestamp;Amount header + rows into UTC date rows', () => {
    // 1526425200000 = 2018-05-15T23:00:00Z in the legacy feed. The
    // parser does NOT force the timestamp to UTC midnight; it trusts
    // the CSV's value and only uses it to project a YYYY-MM-DD. That
    // projection must use UTC so environments in non-UTC timezones
    // produce identical output.
    const csv = 'Timestamp;Amount\n1526425200000;820\n1526511600000;823\n';
    const rows = Array.from(parseSeedCsv(csv));
    expect(rows).toEqual([
      { date: '2018-05-15', total: 820, recordedAt: 1526425200000 },
      { date: '2018-05-16', total: 823, recordedAt: 1526511600000 },
    ]);
  });

  test('skips malformed rows but keeps good ones, logging each skip', () => {
    const calls = [];
    const log = (level, event, meta) => calls.push({ level, event, meta });
    const csv = [
      'Timestamp;Amount',
      '1526425200000;820',
      'not-a-row',
      '1526511600000;-5',
      '1526598000000;abc',
      '1526684400000;843',
      '',
    ].join('\n');
    const rows = Array.from(parseSeedCsv(csv, log));
    expect(rows.map((r) => r.total)).toEqual([820, 843]);
    expect(calls.filter((c) => c.event === 'mncount_seed_skip')).toHaveLength(3);
  });

  test('accepts a headerless CSV (starts with a data row)', () => {
    const csv = '1526425200000;820\n1526511600000;823\n';
    const rows = Array.from(parseSeedCsv(csv));
    expect(rows).toHaveLength(2);
  });

  test('handles CRLF line endings', () => {
    const csv = 'Timestamp;Amount\r\n1526425200000;820\r\n1526511600000;823\r\n';
    const rows = Array.from(parseSeedCsv(csv));
    expect(rows).toHaveLength(2);
  });
});

describe('seedMasternodeCount', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = createMasternodeCountRepo(db);
  });

  afterEach(() => db.close());

  test('loads the full CSV into an empty table, reports inserted count', () => {
    const csv = 'Timestamp;Amount\n1526425200000;820\n1526511600000;823\n';
    const result = seedMasternodeCount({
      db,
      repo,
      readFile: () => csv,
    });
    expect(result).toEqual({
      seeded: true,
      reason: 'loaded',
      inserted: 2,
      skipped: 0,
    });
    expect(repo.getAll()).toEqual([
      { date: '2018-05-15', users: 820 },
      { date: '2018-05-16', users: 823 },
    ]);
  });

  test('is a no-op when the table already has rows (second boot)', () => {
    repo.upsertByDate('2020-01-01', 1000, 1577836800000);
    const csv = 'Timestamp;Amount\n1526425200000;820\n';
    const result = seedMasternodeCount({
      db,
      repo,
      readFile: () => csv,
    });
    expect(result).toEqual({ seeded: false, reason: 'not-empty', inserted: 0 });
    // The pre-existing row is untouched and no seed rows bled in.
    expect(repo.getAll()).toEqual([{ date: '2020-01-01', users: 1000 }]);
  });

  test('missing seed file reports reason="missing" without throwing', () => {
    const result = seedMasternodeCount({
      db,
      repo,
      seedPath: '/nope/does/not/exist.csv',
      readFile: () => {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    });
    expect(result.seeded).toBe(false);
    expect(result.reason).toBe('missing');
    expect(repo.isEmpty()).toBe(true);
  });

  test('runs inside a single transaction: a mid-stream throw rolls the whole seed back', () => {
    // Force `upsertByDate` to throw on the second call. If the seed
    // were row-by-row without a transaction, the first row would
    // persist — which would poison `isEmpty()` on the next boot and
    // block a retry from ever completing. A transaction makes the
    // seed all-or-nothing.
    const csv = 'Timestamp;Amount\n1526425200000;820\n1526511600000;823\n';
    const wrappedRepo = {
      ...repo,
      isEmpty: () => repo.isEmpty(),
      upsertByDate: jest
        .fn()
        .mockImplementationOnce((d, t, r) => repo.upsertByDate(d, t, r))
        .mockImplementationOnce(() => {
          throw new Error('synthetic parser failure');
        }),
    };

    expect(() =>
      seedMasternodeCount({ db, repo: wrappedRepo, readFile: () => csv })
    ).toThrow(/synthetic parser failure/);
    expect(repo.getAll()).toEqual([]);
  });

  test('DEFAULT_SEED_PATH points at the in-repo CSV under db/seeds/', () => {
    expect(DEFAULT_SEED_PATH.endsWith(path.join('db', 'seeds', 'masternode-count.csv'))).toBe(true);
  });

  test('seeding the real committed CSV loads a dense, sorted history', () => {
    // Smoke-check the actual file so a silent corruption of the seed
    // is caught here instead of surprising someone six months later.
    const result = seedMasternodeCount({ db, repo });
    expect(result.seeded).toBe(true);
    expect(result.inserted).toBeGreaterThan(2800);
    const rows = repo.getAll();
    // Rows must be sorted ascending and cover a plausible window.
    expect(rows[0].date.startsWith('2018-')).toBe(true);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].date >= rows[i - 1].date).toBe(true);
    }
    // No duplicates: PK on `date` would have made a dup throw; here
    // we verify the distinct count.
    const distinctDates = new Set(rows.map((r) => r.date));
    expect(distinctDates.size).toBe(rows.length);
  });
});
