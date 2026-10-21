const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate } = require('./db');
const { createRecoveryRepository } = require('./recoveryRepository');

test('new migration preserves an existing verified account and cascades alert data only on explicit user deletion', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(
    fs.readFileSync(
      path.join(__dirname, '../db/migrations/001_init.sql'),
      'utf8'
    )
  );
  db.exec(
    'CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)'
  );
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(
    '001_init.sql',
    1
  );
  db.prepare(
    'INSERT INTO users(id,email,stored_auth,salt_v,email_verified,created_at,updated_at) VALUES (1,?,?,?,?,?,?)'
  ).run('existing@example.com', 'original-hash', 'aa', 1, 1, 1);
  migrate(db);
  expect(
    db.prepare('SELECT stored_auth,email_verified FROM users WHERE id=1').get()
  ).toEqual({ stored_auth: 'original-hash', email_verified: 1 });
  const repo = createRecoveryRepository(db, { now: () => 1000 });
  const sub = repo.subscribe(
    1,
    57057,
    '0x' + '11'.repeat(20),
    'Existing account',
    { number: 100 },
    '0x' + '22'.repeat(20)
  );
  repo.queue(sub.id, 'test', 'enabled', null);
  expect(repo.pendingOutbox()).toHaveLength(1);
  db.prepare('DELETE FROM users WHERE id=1').run();
  expect(repo.pendingOutbox()).toEqual([]);
  expect(repo.getSubscription(sub.id)).toBeUndefined();
  db.close();
});
