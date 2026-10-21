const { ZERO_HASH } = require('./recoveryRpc');

const ACTIVE = new Set(['pending', 'ready']);
function stateFor(snapshot, operationId, previous) {
  const schedule = snapshot.schedules[operationId];
  if (!schedule || !schedule.scheduledAt) return 'orphaned';
  if (schedule.executed) return 'executed';
  if (schedule.canceled) return 'canceled';
  if (!snapshot.installed || snapshot.activeOperationId !== operationId) {
    return previous &&
      previous.expires_at > 0 &&
      snapshot.block.timestamp >= previous.expires_at
      ? 'expired'
      : 'invalidated';
  }
  if (
    snapshot.block.timestamp >=
    schedule.scheduledAt + snapshot.delay + snapshot.expiration
  )
    return 'expired';
  return snapshot.block.timestamp >= schedule.scheduledAt + snapshot.delay
    ? 'ready'
    : 'pending';
}

function createRecoveryMonitor({
  repository: repo,
  users,
  chains,
  mailer,
  now = Date.now,
  log = () => {},
}) {
  let running = false;
  let delivering = false;
  let timer = null;
  let stopped = true;
  let afterId = 0;
  const byId = new Map(chains.map((entry) => [entry.chainId, entry]));
  const rpcFor = (id) => byId.get(id) && byId.get(id).rpc;

  function recordSnapshot(
    sub,
    snapshot,
    includeTerminal = false,
    retryTerminalIds = []
  ) {
    const candidates = new Set([
      ...repo
        .operations(sub.id)
        .filter((r) => includeTerminal || ACTIVE.has(r.state))
        .map((r) => r.operation_id),
      ...retryTerminalIds,
    ]);
    if (snapshot.activeOperationId !== ZERO_HASH)
      candidates.add(snapshot.activeOperationId);
    for (const operationId of candidates) {
      const old = repo.operation(sub.id, operationId);
      const schedule = snapshot.schedules[operationId];
      const state = stateFor(snapshot, operationId, old);
      const isCurrent =
        snapshot.activeOperationId === operationId && snapshot.installed;
      if (!old && (!isCurrent || !schedule || !schedule.scheduledAt)) continue;
      const row = {
        operationId,
        scheduledAt: (schedule && schedule.scheduledAt) || old.scheduled_at,
        executableAt: isCurrent
          ? schedule.scheduledAt + snapshot.delay
          : old.executable_at,
        expiresAt: isCurrent
          ? schedule.scheduledAt + snapshot.delay + snapshot.expiration
          : old.expires_at,
        state,
        txHash: old && old.tx_hash,
        blockNumber: old ? old.block_number : snapshot.block.number,
        blockHash: old ? old.block_hash : snapshot.block.hash,
      };
      repo.putOperation(sub.id, row);
      // Delivery may have seen a losing fork and superseded the first notice
      // without the poller ever persisting that terminal state. Preserve the
      // usual resumed-transition path, but repair its pending -> pending case.
      if (old && ACTIVE.has(old.state) && ACTIVE.has(state))
        repo.queueInitiation(sub.id, operationId);
      if (old && old.state === state && !ACTIVE.has(state))
        repo.rearmTerminal(sub.id, operationId);
      if (old && ACTIVE.has(state) && old.executable_at !== row.executableAt)
        repo.queue(
          sub.id,
          `${sub.id}:${operationId}:timing:${row.executableAt}`,
          'timing_changed',
          operationId
        );
      // The first snapshot can arrive after an outage outlasts the recovery
      // window. Queue its terminal result too: later log replay sees this
      // persisted row as already observed.
      if (!old && state !== 'orphaned') {
        const kind = ACTIVE.has(state) ? 'scheduled' : state;
        repo.queue(
          sub.id,
          `${sub.id}:${operationId}:${kind}`,
          kind,
          operationId
        );
      }
      if (old && !ACTIVE.has(old.state) && ACTIVE.has(state))
        repo.queue(
          sub.id,
          `${sub.id}:${operationId}:resumed:${snapshot.block.hash}`,
          'scheduled',
          operationId
        );
      if (old && ACTIVE.has(old.state) && !ACTIVE.has(state))
        repo.queue(
          sub.id,
          `${sub.id}:${operationId}:${state}`,
          state,
          operationId
        );
      if (
        old &&
        !ACTIVE.has(old.state) &&
        !ACTIVE.has(state) &&
        old.state !== state &&
        state !== 'orphaned'
      )
        // A replacement branch can change one terminal result into another.
        // The generic reorg warning must not leave the old cancellation or
        // execution as the user's last specific result. Delivery revalidates
        // this outcome, and the canonical observation key deduplicates retries.
        repo.queue(
          sub.id,
          `${sub.id}:${operationId}:${state}:changed:${snapshot.block.hash}`,
          state,
          operationId
        );
      if (
        old &&
        !ACTIVE.has(old.state) &&
        old.state !== 'orphaned' &&
        state === 'orphaned'
      )
        repo.queue(
          sub.id,
          `${sub.id}:${operationId}:orphaned:${snapshot.block.hash}`,
          'orphaned',
          operationId
        );
      // A single reminder at halfway for a short test delay or 24h before a
      // production deadline. Chain time, not the worker clock, determines due.
      const reminderAt =
        row.executableAt - Math.min(86400, Math.floor(snapshot.delay / 2));
      if (
        state === 'pending' &&
        snapshot.block.timestamp >= reminderAt &&
        repo.notificationSent(sub.id, operationId, 'scheduled')
      )
        repo.queueReminder(sub.id, operationId);
    }
  }
  function bootstrap(sub, snapshot) {
    repo.atomic(() => recordSnapshot(sub, snapshot));
  }
  async function update(sub, headPromise) {
    const rpc = rpcFor(sub.chain_id);
    const chain = byId.get(sub.chain_id);
    if (
      !rpc ||
      !chain ||
      chain.recoveryModule.toLowerCase() !== sub.module_address ||
      (rpc.chain &&
        rpc.chain.recoveryModule.toLowerCase() !== sub.module_address)
    ) {
      repo.degraded(sub.id);
      return;
    }
    try {
      const head = await headPromise;
      const pendingIds = repo
        .operations(sub.id)
        .filter((r) => ACTIVE.has(r.state))
        .map((r) => r.operation_id);
      // Do not rescan terminal history. Only retry explicitly unsent notices
      // that delivery superseded while their stored terminal state remained.
      const retryTerminalIds = repo.unnotifiedTerminalIds(sub.id);
      const observationIds = [...new Set([...pendingIds, ...retryTerminalIds])];
      let snapshot = await rpc.snapshot(sub.account, observationIds, head);
      // Urgent active-state observation does not wait behind log backfill. A
      // bounded history query can fail independently without hiding the exact
      // currently pending operation from the runtime-attested storage snapshot.
      repo.atomic(() => {
        const current = repo.getSubscription(sub.id);
        if (current && current.enabled && current.generation === sub.generation)
          recordSnapshot(sub, snapshot, false, retryTerminalIds);
      });
      let cursor = sub.cursor;
      let reorg = false;
      if (
        sub.cursor_hash &&
        (cursor > head.number ||
          (await rpc.getBlock(cursor)).hash !== sub.cursor_hash)
      ) {
        // A chain replacement cannot be silently reported as a cancellation.
        // Resnapshot the current contract state and replay a bounded overlap.
        reorg = true;
        cursor = Math.min(sub.anchor - 1, head.number - 1);
      }
      const end = Math.min(head.number, cursor + 2000);
      const logs =
        end > cursor ? await rpc.logs(sub.account, cursor + 1, end) : [];
      const eventIds = [...new Set(logs.map((event) => event.operationId))];
      const reconcileIds = reorg
        ? repo.operations(sub.id).map((row) => row.operation_id)
        : [];
      if ([...eventIds, ...reconcileIds].some((id) => !snapshot.schedules[id]))
        snapshot = await rpc.snapshot(
          sub.account,
          [...new Set([...observationIds, ...eventIds, ...reconcileIds])],
          head
        );
      const endBlock = await rpc.getBlock(end);
      await rpc.assertBlock(head);
      repo.atomic(() => {
        const current = repo.getSubscription(sub.id);
        if (
          !current ||
          !current.enabled ||
          current.generation !== sub.generation
        )
          return;
        if (reorg)
          repo.queue(sub.id, `${sub.id}:reorg:${head.hash}`, 'reorg', null);
        recordSnapshot(sub, snapshot, reorg, retryTerminalIds);
        // Logs enrich the snapshot with public transaction identifiers. They
        // never override current storage state or resurrect a canceled job.
        for (const event of logs) {
          const old = repo.operation(sub.id, event.operationId);
          if (event.kind === 'RecoveryScheduled') {
            const schedule = snapshot.schedules[event.operationId];
            if (!schedule || !schedule.scheduledAt) continue;
            const state = stateFor(snapshot, event.operationId, old);
            repo.putOperation(sub.id, {
              operationId: event.operationId,
              scheduledAt: schedule.scheduledAt,
              executableAt: event.executableAt,
              expiresAt: old ? old.expires_at : 0,
              state,
              txHash: event.txHash,
              blockNumber: event.blockNumber,
              blockHash: event.blockHash,
            });
            // A complete attempt may begin and end between polls. Notify its
            // final observed result once, not a misleading still-pending alert.
            if (!old && state !== 'orphaned')
              repo.queue(
                sub.id,
                `${sub.id}:${event.operationId}:${
                  ACTIVE.has(state) ? 'scheduled' : state
                }`,
                ACTIVE.has(state) ? 'scheduled' : state,
                event.operationId
              );
          }
        }
        repo.updateHealth(
          sub.id,
          end === head.number ? 'active' : 'catching_up',
          head,
          end,
          endBlock.hash
        );
      });
    } catch (err) {
      repo.degraded(sub.id);
      log('recovery_monitor_failed', {
        subscriptionId: sub.id,
        code: err && err.message,
      });
    }
  }
  async function deliverOne(item) {
    const sub = repo.getSubscription(item.subscription_id);
    const user = sub && users.findById(sub.user_id);
    if (
      !sub ||
      !user ||
      !user.emailVerified ||
      item.generation !== sub.generation ||
      (!sub.enabled && item.kind !== 'disabled') ||
      (sub.enabled && item.kind === 'disabled')
    ) {
      repo.supersede(item.id);
      return;
    }
    try {
      const chain = byId.get(sub.chain_id);
      if (
        item.kind !== 'disabled' &&
        (!chain || chain.recoveryModule.toLowerCase() !== sub.module_address)
      ) {
        repo.defer(item.id);
        return;
      }
      if (item.kind === 'enabled') {
        // An enrollment confirmation is a positive monitoring claim, not just
        // an acknowledgement that a row exists. In particular it must not
        // survive a restart with the registry disabled or an unhealthy worker.
        if (
          sub.status !== 'active' ||
          !sub.checked_at ||
          now() - sub.checked_at > 60000
        ) {
          repo.defer(item.id);
          return;
        }
        await chain.rpc.head();
      }
      let operation =
        item.operation_id && repo.operation(sub.id, item.operation_id);
      if (item.operation_id) {
        const rpc = rpcFor(sub.chain_id);
        if (!rpc) throw new Error('recovery_chain_unavailable');
        if (
          byId.get(sub.chain_id).recoveryModule.toLowerCase() !==
          sub.module_address
        )
          throw new Error('recovery_module_changed');
        const snapshot = await rpc.snapshot(sub.account, [item.operation_id]);
        const currentState = stateFor(snapshot, item.operation_id, operation);
        const valid =
          item.kind === 'scheduled' || item.kind === 'timing_changed'
            ? ACTIVE.has(currentState)
            : item.kind === 'reminder'
            ? currentState === 'pending'
            : item.kind === currentState;
        if (!valid) {
          repo.supersede(item.id);
          return;
        }
        operation = { ...operation, state: currentState };
        if (ACTIVE.has(currentState)) {
          const scheduledAt = snapshot.schedules[item.operation_id].scheduledAt;
          operation.scheduled_at = scheduledAt;
          operation.executable_at = scheduledAt + snapshot.delay;
          operation.expires_at = operation.executable_at + snapshot.expiration;
          const reminderAt =
            operation.executable_at -
            Math.min(86400, Math.floor(snapshot.delay / 2));
          if (
            item.kind === 'reminder' &&
            snapshot.block.timestamp < reminderAt
          ) {
            repo.defer(item.id);
            return;
          }
        } else if (
          snapshot.schedules[item.operation_id] &&
          snapshot.schedules[item.operation_id].scheduledAt !==
            operation.scheduled_at
        ) {
          // A terminal record on a replacement branch need not retain the
          // previous policy's timing. Do not present a guessed old deadline.
          operation.executable_at = 0;
          operation.expires_at = 0;
        }
      }
      const current = repo.getSubscription(sub.id);
      if (
        !current ||
        current.generation !== item.generation ||
        (!current.enabled && item.kind !== 'disabled') ||
        (current.enabled && item.kind === 'disabled')
      ) {
        repo.supersede(item.id);
        return;
      }
      await mailer.sendRecoveryAlert({
        to: user.email,
        kind: item.kind,
        account: sub.account,
        label: sub.label,
        chainName: chain ? chain.name : `Chain ${sub.chain_id}`,
        chainId: sub.chain_id,
        operationId: item.operation_id,
        operation,
        explorerUrl: chain && chain.explorerUrl,
        messageId: `<recovery-${item.id}-${sub.id}@sysnode.info>`,
      });
      repo.sent(item.id);
    } catch (err) {
      repo.retry(item.id, item.attempts);
      log('recovery_delivery_failed', {
        subscriptionId: sub.id,
        code: err && err.message,
      });
    }
  }
  async function deliver() {
    if (delivering) return;
    delivering = true;
    try {
      const items = repo.pendingOutbox(30);
      for (let offset = 0; offset < items.length; offset += 3)
        await Promise.all(items.slice(offset, offset + 3).map(deliverOne));
    } finally {
      delivering = false;
    }
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      const batch = repo.enabled(afterId, 12);
      const heads = new Map();
      for (const sub of batch) {
        const rpc = rpcFor(sub.chain_id);
        if (rpc && !heads.has(sub.chain_id))
          heads.set(
            sub.chain_id,
            rpc.head().then(
              (value) => ({ value }),
              (error) => ({ error })
            )
          );
      }
      for (let offset = 0; offset < batch.length; offset += 3)
        await Promise.all(
          batch.slice(offset, offset + 3).map(async (sub) => {
            const head = await heads.get(sub.chain_id);
            if (!head || head.error) {
              repo.degraded(sub.id);
              return;
            }
            await update(sub, Promise.resolve(head.value));
          })
        );
      afterId = batch.length === 12 ? batch[batch.length - 1].id : 0;
      await deliver();
    } finally {
      running = false;
    }
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    const loop = async () => {
      try {
        await tick();
      } catch (err) {
        log('recovery_tick_failed', { code: err && err.message });
      }
      if (!stopped) {
        timer = setTimeout(loop, 15000);
        timer.unref();
      }
    };
    timer = setTimeout(loop, 0);
    timer.unref();
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
  }
  return { tick, start, stop, bootstrap, rpcFor, chains, deliver };
}
module.exports = { createRecoveryMonitor, stateFor };
