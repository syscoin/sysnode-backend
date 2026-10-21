-- Recovery watchlists contain public chain identifiers, never wallet secrets.
CREATE TABLE recovery_challenges (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  module_address TEXT NOT NULL,
  account TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX recovery_challenges_user ON recovery_challenges(user_id);

CREATE TABLE recovery_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_id INTEGER NOT NULL,
  module_address TEXT NOT NULL,
  account TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  cursor INTEGER NOT NULL,
  cursor_hash TEXT,
  anchor INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'catching_up',
  reconcile_needed INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_needed IN (0,1)),
  checked_at INTEGER,
  block_timestamp INTEGER,
  UNIQUE(user_id, chain_id, module_address, account)
);
CREATE INDEX recovery_subscriptions_enabled ON recovery_subscriptions(enabled, id);

CREATE TABLE recovery_operations (
  subscription_id INTEGER NOT NULL REFERENCES recovery_subscriptions(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  executable_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  tx_hash TEXT,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  PRIMARY KEY(subscription_id, operation_id)
);

CREATE TABLE recovery_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES recovery_subscriptions(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  operation_id TEXT,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  sent_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX recovery_outbox_due ON recovery_outbox(state, next_attempt_at);
