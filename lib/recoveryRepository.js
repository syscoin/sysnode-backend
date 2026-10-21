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
  const notificationSent = (id, operationId, kind) => {
    const subscription = getSubscription(id);
    return Boolean(
      subscription &&
        db
          .prepare(
            "SELECT 1 FROM recovery_outbox WHERE subscription_id=? AND generation=? AND operation_id=? AND kind=? AND state='sent' LIMIT 1"
          )
          .get(id, subscription.generation, operationId, kind)
    );
  };
  const queueUnsentActiveNotice = (id, operationId, kind) => {
    if (!['scheduled', 'reminder'].includes(kind))
      throw new Error('invalid_active_notice_kind');
    const subscription = getSubscription(id);
    if (
      !subscription ||
      !subscription.enabled ||
      notificationSent(id, operationId, kind)
    )
      return;
    if (
      db
        .prepare(
          "SELECT 1 FROM recovery_outbox WHERE subscription_id=? AND generation=? AND operation_id=? AND kind=? AND state='pending' LIMIT 1"
        )
        .get(id, subscription.generation, operationId, kind)
    )
      return;
    const key = `${id}:${operationId}:${kind}`;
    queue(id, key, kind, operationId);
    // Callers verified an active operation (and, for a reminder, its due time).
    // A losing fork may have superseded its unsent notice only during delivery.
    // Re-arm that exact kind and enrollment while preserving delivery backoff;
    // never resurrect sent notices or unrelated terminal/administrative mail.
    // A queued resumed notice already serves this purpose and must not gain a
    // duplicate while it waits for delivery or its existing retry deadline.
    db.prepare(
      "UPDATE recovery_outbox SET state='pending',next_attempt_at=MAX(next_attempt_at,?) WHERE subscription_id=? AND generation=? AND event_key=? AND kind=? AND state='superseded' AND sent_at IS NULL"
    ).run(
      now(),
      id,
      subscription.generation,
      `${key}:g${subscription.generation}`,
      kind
    );
  };
  const unnotifiedTerminals = (id, operationId = null) =>
    db
      .prepare(
        `
      SELECT notice.id, operation.operation_id
      FROM recovery_operations operation
      JOIN recovery_subscriptions subscription ON subscription.id=operation.subscription_id
      JOIN recovery_outbox notice ON notice.subscription_id=subscription.id
        AND notice.generation=subscription.generation
        AND notice.operation_id=operation.operation_id AND notice.kind=operation.state
      WHERE subscription.id=? AND subscription.enabled=1
        AND (? IS NULL OR operation.operation_id=?)
        AND operation.state IN ('canceled','executed','expired','invalidated','orphaned')
        AND notice.state='superseded' AND notice.sent_at IS NULL
        AND notice.id=(SELECT MAX(newer.id) FROM recovery_outbox newer
          WHERE newer.subscription_id=subscription.id AND newer.generation=subscription.generation
            AND newer.operation_id=operation.operation_id AND newer.kind=operation.state)
        AND notice.id>COALESCE((SELECT MAX(sent.id) FROM recovery_outbox sent
          WHERE sent.subscription_id=subscription.id AND sent.generation=subscription.generation
            AND sent.operation_id=operation.operation_id AND sent.state='sent'),0)
      ORDER BY notice.id LIMIT 20
    `
      )
      .all(id, operationId, operationId);
  return {
    db,
    now,
    getSubscription,
    subscriptions,
    operations,
    reconciliationOperations(id) {
      const rows = db
        .prepare(
          'SELECT * FROM recovery_operations WHERE subscription_id=? ORDER BY operation_id LIMIT 1001'
        )
        .all(id);
      // Match the bounded RPC snapshot capacity. Never silently truncate a
      // reconciliation and then declare its cursor/terminal history healthy.
      if (rows.length > 1000)
        throw new Error('recovery_reconciliation_capacity');
      return rows;
    },
    operation,
    queue,
    queueTransition(id, operationId, kind) {
      // Call inside the same transaction that records the changed observation.
      // A canonical branch can be restored verbatim, so neither its block hash
      // nor its outcome is a unique identity for an observed transition. The
      // persisted outbox predecessor advances even when hashes/kinds repeat.
      return db.transaction(() => {
        const subscription = getSubscription(id);
        if (!subscription || !subscription.enabled) return;
        const { predecessor } = db
          .prepare(
            'SELECT COALESCE(MAX(id),0) predecessor FROM recovery_outbox WHERE subscription_id=? AND generation=? AND operation_id=?'
          )
          .get(id, subscription.generation, operationId);
        return queue(
          id,
          `${id}:${operationId}:transition:${predecessor}:${kind}`,
          kind,
          operationId
        );
      })();
    },
    notificationSent,
    queueInitiation: (id, operationId) =>
      queueUnsentActiveNotice(id, operationId, 'scheduled'),
    queueReminder: (id, operationId) =>
      queueUnsentActiveNotice(id, operationId, 'reminder'),
    unnotifiedTerminalIds: (id) =>
      unnotifiedTerminals(id).map((row) => row.operation_id),
    rearmTerminal(id, operationId) {
      // Revisit only the most recent unsent terminal result, never history that
      // a newer delivered result or enrollment has already superseded.
      for (const notice of unnotifiedTerminals(id, operationId))
        db.prepare(
          "UPDATE recovery_outbox SET state='pending',next_attempt_at=MAX(next_attempt_at,?) WHERE id=? AND state='superseded' AND sent_at IS NULL"
        ).run(now(), notice.id);
    },
    atomic: (fn) => db.transaction(fn)(),
    challenge(id, userId) {
      return db
        .prepare(
          'SELECT * FROM recovery_challenges WHERE id = ? AND user_id = ?'
        )
        .get(id, userId);
    },
    addChallenge({
      id,
      userId,
      chainId,
      recoveryModule,
      account,
      message,
      expiresAt,
    }) {
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
        'INSERT INTO recovery_challenges VALUES (?,?,?,?,?,?,?,NULL)'
      ).run(
        id,
        userId,
        chainId,
        recoveryModule.toLowerCase(),
        account,
        message,
        expiresAt
      );
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
    subscribe(userId, chainId, account, label, block, recoveryModule) {
      const moduleAddress = recoveryModule.toLowerCase();
      const existing = db
        .prepare(
          'SELECT * FROM recovery_subscriptions WHERE user_id = ? AND chain_id = ? AND module_address = ? AND account = ?'
        )
        .get(userId, chainId, moduleAddress, account);
      if (existing && existing.enabled)
        throw Object.assign(new Error('already_subscribed'), { status: 409 });
      if (subscriptions(userId).length >= 20)
        throw Object.assign(new Error('subscription_limit'), { status: 409 });
      if (existing) {
        db.prepare(
          "UPDATE recovery_subscriptions SET enabled=1,generation=generation+1,label=?,created_at=?,cursor=?,anchor=?,cursor_hash=NULL,checked_at=NULL,block_timestamp=NULL,status='catching_up',reconcile_needed=0 WHERE id=?"
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
          'INSERT INTO recovery_subscriptions (user_id,chain_id,module_address,account,label,created_at,cursor,anchor) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(
          userId,
          chainId,
          moduleAddress,
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
    markReconcileNeeded(id, generation) {
      return (
        db
          .prepare(
            'UPDATE recovery_subscriptions SET reconcile_needed=1 WHERE id=? AND generation=? AND enabled=1'
          )
          .run(id, generation).changes === 1
      );
    },
    updateHealth(id, status, block, cursor, hash, reconciled = false) {
      db.prepare(
        'UPDATE recovery_subscriptions SET status=?,checked_at=?,block_timestamp=?,cursor=?,cursor_hash=?,reconcile_needed=CASE WHEN ?=1 THEN 0 ELSE reconcile_needed END WHERE id=?'
      ).run(
        status,
        now(),
        block.timestamp,
        cursor,
        hash,
        reconciled ? 1 : 0,
        id
      );
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
    defer(id) {
      db.prepare(
        "UPDATE recovery_outbox SET next_attempt_at=? WHERE id=? AND state='pending'"
      ).run(now() + 15000, id);
    },
  };
}
module.exports = { createRecoveryRepository };
