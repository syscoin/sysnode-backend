function createRecoveryRepository(db, { now = Date.now } = {}) {
  const getSubscription = (id) =>
    db.prepare('SELECT * FROM recovery_subscriptions WHERE id = ?').get(id);
  const subscriptions = (userId) =>
    db
      .prepare(
        'SELECT * FROM recovery_subscriptions WHERE user_id = ? AND enabled = 1 ORDER BY id'
      )
      .all(userId);
  const operations = (id) =>
    db
      .prepare(
        "SELECT * FROM recovery_operations WHERE subscription_id = ? ORDER BY CASE WHEN state IN ('pending','ready') THEN 0 ELSE 1 END, scheduled_at DESC LIMIT 20"
      )
      .all(id);
  const operation = (id, op) =>
    db
      .prepare(
        'SELECT * FROM recovery_operations WHERE subscription_id = ? AND operation_id = ?'
      )
      .get(id, op);
  const queue = (subscriptionId, key, kind, op, payload = {}) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO recovery_outbox
    (subscription_id,event_key,generation,kind,operation_id,payload,next_attempt_at,created_at) VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        subscriptionId,
        `${key}:g${getSubscription(subscriptionId).generation}`,
        getSubscription(subscriptionId).generation,
        kind,
        op || null,
        JSON.stringify(payload),
        now(),
        now()
      );
  return {
    db,
    now,
    getSubscription,
    subscriptions,
    operations,
    operation,
    queue,
    notificationSent(id, operationId, kind) {
      const subscription = getSubscription(id);
      return Boolean(
        db
          .prepare(
            "SELECT 1 FROM recovery_outbox WHERE subscription_id=? AND generation=? AND operation_id=? AND kind=? AND state='sent' LIMIT 1"
          )
          .get(id, subscription.generation, operationId, kind)
      );
    },
    atomic: (fn) => db.transaction(fn)(),
    challenge(id, userId) {
      return db
        .prepare(
          'SELECT * FROM recovery_challenges WHERE id = ? AND user_id = ?'
        )
        .get(id, userId);
    },
    addChallenge({ id, userId, chainId, account, message, expiresAt }) {
      db.prepare('DELETE FROM recovery_challenges WHERE expires_at <= ?').run(
        now()
      );
      if (
        db
          .prepare(
            'SELECT COUNT(*) n FROM recovery_challenges WHERE user_id = ? AND consumed_at IS NULL'
          )
          .get(userId).n >= 5
      )
        throw Object.assign(new Error('too_many_challenges'), { status: 429 });
      db.prepare(
        'INSERT INTO recovery_challenges VALUES (?,?,?,?,?,?,NULL)'
      ).run(id, userId, chainId, account, message, expiresAt);
    },
    consume(id, userId) {
      return (
        db
          .prepare(
            'UPDATE recovery_challenges SET consumed_at = ? WHERE id = ? AND user_id = ? AND consumed_at IS NULL AND expires_at > ?'
          )
          .run(now(), id, userId, now()).changes === 1
      );
    },
    subscribe(userId, chainId, account, label, block) {
      const existing = db
        .prepare(
          'SELECT * FROM recovery_subscriptions WHERE user_id = ? AND chain_id = ? AND account = ?'
        )
        .get(userId, chainId, account);
      if (existing && existing.enabled)
        throw Object.assign(new Error('already_subscribed'), { status: 409 });
      if (subscriptions(userId).length >= 20)
        throw Object.assign(new Error('subscription_limit'), { status: 409 });
      if (existing) {
        db.prepare(
          "UPDATE recovery_subscriptions SET enabled=1,generation=generation+1,label=?,created_at=?,cursor=?,anchor=?,cursor_hash=NULL,checked_at=NULL,block_timestamp=NULL,status='catching_up' WHERE id=?"
        ).run(label, now(), block.number - 1, block.number, existing.id);
        db.prepare(
          "UPDATE recovery_outbox SET state='superseded' WHERE subscription_id=? AND state='pending'"
        ).run(existing.id);
        db.prepare(
          'DELETE FROM recovery_operations WHERE subscription_id=?'
        ).run(existing.id);
        return getSubscription(existing.id);
      }
      const out = db
        .prepare(
          'INSERT INTO recovery_subscriptions (user_id,chain_id,account,label,created_at,cursor,anchor) VALUES (?,?,?,?,?,?,?)'
        )
        .run(
          userId,
          chainId,
          account,
          label,
          now(),
          block.number - 1,
          block.number
        );
      return getSubscription(out.lastInsertRowid);
    },
    disable(id) {
      db.prepare(
        "UPDATE recovery_subscriptions SET enabled=0,status='disabled' WHERE id=?"
      ).run(id);
      db.prepare(
        "UPDATE recovery_outbox SET state='superseded' WHERE subscription_id=? AND state='pending'"
      ).run(id);
    },
    enabled(after = 0, limit = 100) {
      return db
        .prepare(
          'SELECT * FROM recovery_subscriptions WHERE enabled=1 AND id>? ORDER BY id LIMIT ?'
        )
        .all(after, limit);
    },
    updateHealth(id, status, block, cursor, hash) {
      db.prepare(
        'UPDATE recovery_subscriptions SET status=?,checked_at=?,block_timestamp=?,cursor=?,cursor_hash=? WHERE id=?'
      ).run(status, now(), block.timestamp, cursor, hash, id);
    },
    degraded(id) {
      db.prepare(
        "UPDATE recovery_subscriptions SET status='degraded' WHERE id=?"
      ).run(id);
    },
    putOperation(id, row) {
      db.prepare(
        `INSERT INTO recovery_operations VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(subscription_id,operation_id) DO UPDATE SET
        scheduled_at=excluded.scheduled_at,executable_at=excluded.executable_at,expires_at=excluded.expires_at,state=excluded.state,
        tx_hash=COALESCE(excluded.tx_hash,recovery_operations.tx_hash),block_number=excluded.block_number,block_hash=excluded.block_hash`
      ).run(
        id,
        row.operationId,
        row.scheduledAt,
        row.executableAt,
        row.expiresAt,
        row.state,
        row.txHash || null,
        row.blockNumber,
        row.blockHash
      );
    },
    setState(id, op, state) {
      db.prepare(
        'UPDATE recovery_operations SET state=? WHERE subscription_id=? AND operation_id=?'
      ).run(state, id, op);
    },
    pendingOutbox(limit = 100) {
      return db
        .prepare(
          "SELECT * FROM recovery_outbox WHERE state='pending' AND next_attempt_at<=? ORDER BY CASE WHEN attempts=0 THEN 0 ELSE 1 END,next_attempt_at,id LIMIT ?"
        )
        .all(now(), limit);
    },
    sent(id) {
      db.prepare(
        "UPDATE recovery_outbox SET state='sent',sent_at=? WHERE id=? AND state='pending'"
      ).run(now(), id);
    },
    supersede(id) {
      db.prepare(
        "UPDATE recovery_outbox SET state='superseded' WHERE id=? AND state='pending'"
      ).run(id);
    },
    retry(id, attempts) {
      db.prepare(
        'UPDATE recovery_outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?'
      ).run(now() + Math.min(3600000, 15000 * 2 ** Math.min(attempts, 8)), id);
    },
  };
}
module.exports = { createRecoveryRepository };
