'use strict';

const fs = require('fs');
const path = require('path');

// One-time seed for `masternode_count_daily` from the committed
// historical CSV at db/seeds/masternode-count.csv.
//
// Why this exists as code rather than a SQL migration:
//   * The historical dataset (~2900 rows) is data, not schema.
//     Inlining it into a migration would bloat the diff, make review
//     miserable, and tie schema changes to data corrections.
//   * Making the seed code idempotent lets us re-run on every boot
//     without branching on "first ever boot" state — the run is a
//     no-op once the table is populated, and `INSERT OR IGNORE` in
//     the repo guarantees a correctly-seeded table stays correct
//     even if a CSV is edited to include already-present dates.
//
// CSV format (legacy, unchanged from the retired standalone script):
//   Header: `Timestamp;Amount`
//   Rows:   `<utcMidnightMs>;<total>`
//
// Parser rules:
//   * Semicolon delimiter (the legacy format).
//   * A blank trailing line is expected and ignored.
//   * Any row that fails integer parsing is skipped with a warn log
//     rather than aborting the seed — a single corrupt row should
//     not block an otherwise-valid history from loading.

const DEFAULT_SEED_PATH = path.join(
  __dirname,
  '..',
  'db',
  'seeds',
  'masternode-count.csv'
);

// Largest absolute millisecond value that the ECMAScript Date
// object represents without producing an Invalid Date. Anything
// outside this range makes `new Date(ms).toISOString()` throw
// `RangeError: Invalid time value`, which — absent the bounds
// check below — would abort the whole seed transaction and block
// the entire history from loading over a single bad row
// (Codex PR16 P2 round 2). Spec reference: ECMA-262
// "Time Values and Time Range" (8.64e15 ms from the epoch).
const JS_DATE_MAX_ABS_MS = 8640000000000000;

function utcDateString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Generator so the transaction body can pull rows one at a time
// without materializing the whole parsed array. Keeps peak memory
// bounded even if the seed grows into millions of rows.
function* parseSeedCsv(text, log) {
  const lines = text.split(/\r?\n/);
  let headerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw == null) continue;
    const line = raw.trim();
    if (!line) continue;

    if (!headerSeen) {
      headerSeen = true;
      // Accept either a literal header row or a data row; if the
      // first non-blank line is numeric we treat it as data (some
      // hand-edited copies of the file lose the header).
      if (/^[A-Za-z]/.test(line)) continue;
    }

    const parts = line.split(';');
    if (parts.length !== 2) {
      if (log) log('warn', 'mncount_seed_skip', { line: i + 1, reason: 'shape' });
      continue;
    }
    const ts = Number(parts[0]);
    const total = Number(parts[1]);
    if (
      !Number.isFinite(ts) ||
      ts <= 0 ||
      ts > JS_DATE_MAX_ABS_MS ||
      !Number.isInteger(total) ||
      total < 0
    ) {
      if (log) log('warn', 'mncount_seed_skip', { line: i + 1, reason: 'values' });
      continue;
    }
    yield { date: utcDateString(ts), total, recordedAt: ts };
  }
}

// Runs the seed under `opts.db.transaction(...)` so either every row
// loads or none do — a partial seed (parser throws halfway) is worse
// than no seed, because the daily writer only catches up to "today"
// and would never fill the gap.
function seedMasternodeCount({
  db,
  repo,
  seedPath = DEFAULT_SEED_PATH,
  log = () => {},
  readFile = fs.readFileSync,
} = {}) {
  if (!db) throw new Error('seedMasternodeCount: db is required');
  if (!repo) throw new Error('seedMasternodeCount: repo is required');

  if (!repo.isEmpty()) {
    return { seeded: false, reason: 'not-empty', inserted: 0 };
  }

  let text;
  try {
    text = readFile(seedPath, 'utf8');
  } catch (err) {
    log('warn', 'mncount_seed_missing', {
      path: seedPath,
      err: err && err.message,
    });
    return { seeded: false, reason: 'missing', inserted: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  const txn = db.transaction(() => {
    for (const row of parseSeedCsv(text, log)) {
      const { inserted: did } = repo.upsertByDate(
        row.date,
        row.total,
        row.recordedAt
      );
      if (did) inserted++;
      else skipped++;
    }
  });
  txn();

  log('info', 'mncount_seed_loaded', { inserted, skipped, seedPath });
  return { seeded: true, reason: 'loaded', inserted, skipped };
}

module.exports = {
  seedMasternodeCount,
  parseSeedCsv,
  DEFAULT_SEED_PATH,
};
