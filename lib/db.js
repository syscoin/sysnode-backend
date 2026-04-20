const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

// Tracks applied migrations by filename. We keep this intentionally simple
// (single-writer, synchronous SQLite); more elaborate tooling is overkill here.
function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
}

function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function migrate(db) {
  ensureMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename)
  );
  const files = loadMigrationFiles();
  const insert = db.prepare(
    'INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)'
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const txn = db.transaction(() => {
      db.exec(sql);
      insert.run(file, Date.now());
    });
    txn();
  }
}

function openDatabase(file) {
  // Accept `:memory:` for tests; otherwise ensure the parent dir exists.
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

module.exports = {
  openDatabase,
  migrate,
};
