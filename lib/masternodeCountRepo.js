// Thin repo over the `masternode_count_daily` table (see migration 001).
//
// Owns all SQL for the historical masternode-count time series so
// the writer (services/mnCountLogger.js), the seeder
// (lib/mnCountSeed.js) and the reader (routes/mnCount.js) can share
// one vocabulary and one set of prepared statements instead of
// scattering raw SQL across three files.
//
// Two design choices worth calling out:
//
//   1. INSERT OR IGNORE, not INSERT. The PK on `date` makes the write
//      idempotent per UTC calendar day. A restart-storm, a catch-up
//      that overlaps with the regular midnight tick, or a seed that
//      is re-run on an already-populated table all collapse to a
//      no-op rather than either throwing a UNIQUE violation (which
//      callers would have to branch on) or overwriting the original
//      recorded_at (which we deliberately preserve as audit
//      provenance — the first sample wins).
//
//   2. getAll() returns `{ date, users }` rows, not `{ date, total }`.
//      That is the shape the FE chart (TrendChart.js) already speaks
//      and the shape the retired CSV reader produced. The table
//      column is named `total` because that's what Core's
//      masternode_count RPC calls it; the projection happens here so
//      the route handler stays a thin pass-through.

function createMasternodeCountRepo(db) {
  if (!db) throw new Error('createMasternodeCountRepo: db is required');

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO masternode_count_daily (date, total, recorded_at)
     VALUES (?, ?, ?)`
  );

  const selectAllStmt = db.prepare(
    `SELECT date, total
       FROM masternode_count_daily
      ORDER BY date ASC`
  );

  const selectLatestDateStmt = db.prepare(
    `SELECT date
       FROM masternode_count_daily
      ORDER BY date DESC
      LIMIT 1`
  );

  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM masternode_count_daily`
  );

  function validateDate(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(
        `masternodeCountRepo: date must be 'YYYY-MM-DD', got ${JSON.stringify(date)}`
      );
    }
  }

  function validateTotal(total) {
    if (!Number.isInteger(total) || total < 0) {
      throw new Error(
        `masternodeCountRepo: total must be a non-negative integer, got ${JSON.stringify(total)}`
      );
    }
  }

  // Returns { inserted: boolean }. `inserted` is false when the row
  // already existed (PK collision swallowed by INSERT OR IGNORE) so
  // callers can log "skipped — already recorded" without inspecting
  // better-sqlite3 internals.
  function upsertByDate(date, total, recordedAt) {
    validateDate(date);
    validateTotal(total);
    const when =
      Number.isFinite(recordedAt) && recordedAt >= 0 ? recordedAt : Date.now();
    const info = insertStmt.run(date, total, when);
    return { inserted: info.changes > 0 };
  }

  function getAll() {
    return selectAllStmt.all().map((r) => ({ date: r.date, users: r.total }));
  }

  function getLatestDate() {
    const row = selectLatestDateStmt.get();
    return row ? row.date : null;
  }

  function isEmpty() {
    return countStmt.get().n === 0;
  }

  return { upsertByDate, getAll, getLatestDate, isEmpty };
}

module.exports = { createMasternodeCountRepo };
