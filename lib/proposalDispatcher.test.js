'use strict';

const { openDatabase } = require('./db');
const { createProposalSubmissionsRepo } = require('./proposalSubmissions');
const {
  createProposalDispatcher,
  REQUIRED_CONFS,
  DEFAULT_TIMEOUT_MS,
} = require('./proposalDispatcher');

const FAKE_SALT_V = 'aa'.repeat(32);

function seedUser(db, email = 'u@x.com') {
  const t = Date.now();
  const r = db
    .prepare(
      `INSERT INTO users (email, stored_auth, salt_v, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, 'h', FAKE_SALT_V, t, t);
  return Number(r.lastInsertRowid);
}

function makeSubmission(repo, userId, overrides = {}) {
  return repo.create({
    userId,
    parentHash: '0',
    revision: 1,
    timeUnix: 1800000000,
    dataHex: '7b2274797065223a317d',
    proposalHash: 'a'.repeat(64),
    title: 'T',
    name: 'name',
    url: 'https://example.org/p',
    paymentAddress: 'sys1qabcdefghij1234567890',
    paymentAmountSats: 100n,
    paymentCount: 1,
    startEpoch: 1800000000,
    endEpoch: 1802592000,
    ...overrides,
  });
}

// A minimal fake RPC that lets us script per-txid responses and
// per-call behavior for gObjectSubmit. Keeps tests declarative.
function makeFakeRpc() {
  const txs = new Map(); // txid (lowercase) -> { confirmations } | error (Error instance)
  const submitScript = []; // FIFO: each entry is { result } or { error }
  const calls = { getRawTransaction: [], gObjectSubmit: [] };

  return {
    txs,
    submitScript,
    calls,
    rpc: {
      async getRawTransaction(txid /* , verbose */) {
        calls.getRawTransaction.push(txid);
        const entry = txs.get(txid.toLowerCase());
        if (entry instanceof Error) throw entry;
        if (!entry) {
          const e = new Error('No such mempool or blockchain transaction');
          throw e;
        }
        return entry;
      },
      async gObjectSubmit(parentHash, revision, time, dataHex, txid) {
        calls.gObjectSubmit.push({ parentHash, revision, time, dataHex, txid });
        if (submitScript.length === 0) {
          throw new Error('fakeRpc: no submit script entries queued');
        }
        const next = submitScript.shift();
        if (next.error) throw next.error;
        return next.result;
      },
    },
  };
}

function setup() {
  const db = openDatabase(':memory:');
  const userId = seedUser(db);
  let clock = 1_700_000_000_000;
  const repo = createProposalSubmissionsRepo(db, { now: () => clock });
  const logs = [];
  const fake = makeFakeRpc();
  const dispatcher = createProposalDispatcher({
    submissions: repo,
    rpc: fake.rpc,
    log: (level, event, meta) => logs.push({ level, event, meta }),
    now: () => clock,
  });
  return {
    db,
    repo,
    dispatcher,
    fake,
    logs,
    userId,
    tick: (ms) => {
      clock += ms;
      return clock;
    },
  };
}

// ---------------- confirmation tracking ----------------
describe('proposalDispatcher — confirmation tracking', () => {
  test('exports REQUIRED_CONFS = 6', () => {
    expect(REQUIRED_CONFS).toBe(6);
  });

  test('records confs from RPC, does not submit before threshold', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'f'.repeat(64));
    fake.txs.set('f'.repeat(64), { confirmations: 3 });
    const stats = await dispatcher.tick();
    expect(stats.scanned).toBe(1);
    const after = repo.getById(s.id);
    expect(after.collateralConfs).toBe(3);
    expect(after.status).toBe('awaiting_collateral');
    expect(fake.calls.gObjectSubmit.length).toBe(0);
  });

  test('0 confirmations (mempool only) is tolerated', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'f'.repeat(64));
    // No `confirmations` field — mempool-only shape
    fake.txs.set('f'.repeat(64), { txid: 'f'.repeat(64) });
    await dispatcher.tick();
    expect(repo.getById(s.id).collateralConfs).toBe(0);
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
  });

  test('skipped rows that are prepared/submitted/failed', async () => {
    const { repo, dispatcher, userId } = setup();
    const s = makeSubmission(repo, userId);
    // Still in 'prepared' — dispatcher should not touch it
    const stats = await dispatcher.tick();
    expect(stats.scanned).toBe(0);
    expect(repo.getById(s.id).status).toBe('prepared');
  });
});

// ---------------- submit once mature ----------------
describe('proposalDispatcher — submission', () => {
  test('submits when confs >= threshold and flips to submitted', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ result: 'b'.repeat(64) });

    const stats = await dispatcher.tick();
    expect(stats.advanced).toBe(1);
    expect(fake.calls.gObjectSubmit).toHaveLength(1);
    expect(fake.calls.gObjectSubmit[0]).toMatchObject({
      parentHash: '0',
      revision: 1,
      time: 1800000000,
      dataHex: '7b2274797065223a317d',
      txid: 'a'.repeat(64),
    });
    const after = repo.getById(s.id);
    expect(after.status).toBe('submitted');
    expect(after.governanceHash).toBe('b'.repeat(64));
  });

  test('accepts governance hash in uppercase and lowercases it', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 10 });
    fake.submitScript.push({ result: 'B'.repeat(64) });
    await dispatcher.tick();
    expect(repo.getById(s.id).governanceHash).toBe('b'.repeat(64));
  });

  test('bad response shape: leaves row in awaiting_collateral and logs', async () => {
    const { repo, dispatcher, fake, logs, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ result: { not: 'a string' } });
    await dispatcher.tick();
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
    expect(logs.find((l) => l.event === 'gObject_submit_bad_response')).toBeTruthy();
  });

  test('terminal Core error → row marked failed', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({
      error: new Error(
        'Governance object is not valid - b...b - payment_address is invalid'
      ),
    });
    await dispatcher.tick();
    const after = repo.getById(s.id);
    expect(after.status).toBe('failed');
    expect(after.failReason).toBe('submit_rejected');
    expect(after.failDetail).toMatch(/payment_address is invalid/);
  });

  test('"already exists" Core error → row promotes to submitted with frozen hash (no false failure, terminates loop)', async () => {
    // Codex PR8 round 1 P2: duplicate-submit errors must NOT mark
    // the row failed — the object is already live on chain.
    //
    // Codex PR8 round 2 P1: but leaving the row in
    // awaiting_collateral forever (the first-round fix) is also wrong:
    // if Core keeps returning "already exists", the row has no
    // terminal transition and the user never gets a completion
    // signal. Core indexes govobj by CGovernanceObject::GetHash(),
    // which is exactly what computeProposalHash() reproduces at
    // prepare time, so the on-chain hash == our frozen proposalHash.
    // Promote using that hash.
    const { repo, dispatcher, fake, userId, logs } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({
      error: new Error(
        "Governance object already exists in the node's object store"
      ),
    });
    await dispatcher.tick();
    const after = repo.getById(s.id);
    expect(after.status).toBe('submitted');
    expect(after.failReason).toBeNull();
    expect(after.governanceHash).toBe(s.proposalHash);
    expect(logs.find((l) => l.event === 'submit_already_exists')).toBeTruthy();
    expect(
      logs.find((l) => l.event === 'submitted_via_duplicate')
    ).toBeTruthy();
  });

  test(
    '"already exists" where repo rejects markSubmitted (hash clash) → terminal failed with duplicate_governance_hash (Codex round 10 P1)',
    async () => {
      // Rare path: another row already claims this governance_hash
      // (a concurrent dispatcher tick beat us; or — very unlikely
      // — two users submitted identical canonical text at the same
      // unix timestamp). The on-chain governance object exists but
      // is tracked by the OTHER row on our books, and the UNIQUE
      // index on governance_hash will keep rejecting our UPDATE
      // forever.
      //
      // Round 9 behavior (left row in awaiting_collateral) caused
      // the dispatcher to retry the same row every tick forever
      // with no terminal user-visible outcome. Round 10 fix: flip
      // to terminal `failed` with reason `duplicate_governance_hash`
      // so the dispatcher stops spinning AND the user gets a
      // final, actionable notification.
      // Use the local setup() (which doesn't take hooks) and wire
      // onFailed via a fresh dispatcher factory below, so we can
      // observe the emitted event.
      const { repo, fake, userId, logs } = setup();
      const failedEvents = [];
      const localDispatcher = createProposalDispatcher({
        submissions: repo,
        rpc: fake.rpc,
        log: (level, event, meta) => logs.push({ level, event, meta }),
        onFailed: (a) => failedEvents.push(a),
      });
      const s = makeSubmission(repo, userId);
      repo.attachCollateral(s.id, userId, 'a'.repeat(64));
      fake.txs.set('a'.repeat(64), { confirmations: 6 });

      // Pre-plant a different row that already owns this governance
      // hash, so the UNIQUE index will fire on markSubmitted.
      const s2 = makeSubmission(repo, userId, { proposalName: 'other' });
      repo.attachCollateral(s2.id, userId, 'b'.repeat(64));
      repo.markSubmitted(s2.id, { governanceHash: s.proposalHash });

      fake.submitScript.push({
        error: new Error(
          "Governance object already exists in the node's object store"
        ),
      });
      await localDispatcher.tick();
      const after = repo.getById(s.id);
      expect(after.status).toBe('failed');
      expect(after.failReason).toBe('duplicate_governance_hash');
      expect(
        logs.find((l) => l.event === 'markSubmitted_after_duplicate_failed')
      ).toBeTruthy();
      expect(
        logs.find((l) => l.event === 'failed_duplicate_governance_hash')
      ).toBeTruthy();
      // onFailed must fire so the user gets the notification.
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].submission.id).toBe(s.id);
      expect(failedEvents[0].submission.failReason).toBe(
        'duplicate_governance_hash'
      );

      // And crucially: a second dispatcher tick does NOT retry this
      // row (it's now terminal, so listByStatus('awaiting_collateral')
      // won't see it).
      fake.submitScript.push({
        error: new Error(
          "Governance object already exists in the node's object store"
        ),
      });
      const submitsBefore = fake.calls.gObjectSubmit.length;
      await localDispatcher.tick();
      expect(fake.calls.gObjectSubmit.length).toBe(submitsBefore);
    }
  );

  test('transient Core error → row stays awaiting_collateral, will retry', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ error: new Error('ECONNREFUSED') });
    await dispatcher.tick();
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
  });

  test('two back-to-back ticks: first submits, second is a no-op', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ result: 'c'.repeat(64) });

    await dispatcher.tick();
    // Second tick — no new submit scripting queued; a rescan should
    // find no rows in awaiting_collateral so gObjectSubmit isn't called.
    await dispatcher.tick();
    expect(fake.calls.gObjectSubmit.length).toBe(1);
    expect(repo.getById(s.id).status).toBe('submitted');
  });

  test('multiple rows: error in one doesn\u2019t block the others', async () => {
    const { repo, dispatcher, fake, userId } = setup();
    // Different dataHex to avoid the partial unique index that
    // guarantees a user can't have two `prepared` rows for the same
    // canonical payload (Codex round 3 P2).
    const a = makeSubmission(repo, userId, { proposalHash: 'a'.repeat(64) });
    const b = makeSubmission(repo, userId, {
      proposalHash: 'b'.repeat(64),
      dataHex: '7b2274797065223a327d',
    });
    repo.attachCollateral(a.id, userId, '1'.repeat(64));
    repo.attachCollateral(b.id, userId, '2'.repeat(64));
    fake.txs.set('1'.repeat(64), { confirmations: 6 });
    fake.txs.set('2'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ error: new Error('ECONNREFUSED') }); // a transient
    fake.submitScript.push({ result: 'd'.repeat(64) }); // b submits OK

    await dispatcher.tick();
    expect(repo.getById(a.id).status).toBe('awaiting_collateral');
    expect(repo.getById(b.id).status).toBe('submitted');
  });
});

// ---------------- missing collateral tx ----------------
describe('proposalDispatcher — missing tx handling', () => {
  test('tx not found (fresh row): row untouched, retries next tick', async () => {
    const { repo, dispatcher, userId } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    // No tx in fake.txs → "No such mempool" thrown
    await dispatcher.tick();
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
  });

  test('tx not found after timeout → marked failed', async () => {
    const { repo, dispatcher, userId, tick } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    tick(DEFAULT_TIMEOUT_MS + 1);
    await dispatcher.tick();
    const after = repo.getById(s.id);
    expect(after.status).toBe('failed');
    expect(after.failReason).toBe('collateral_not_found');
  });

  test('other RPC errors do NOT trigger timeout-based fail', async () => {
    const { repo, dispatcher, fake, userId, tick } = setup();
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), new Error('Node overloaded, try again'));
    tick(DEFAULT_TIMEOUT_MS + 1);
    await dispatcher.tick();
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
  });
});

// ---------------- onSubmitted / onFailed hooks ----------------
//
// These are the seam the mailer hooks into. The dispatcher owns state
// transitions; hooks ride along so the mailer never observes an
// in-flight row. Hook semantics we verify:
//   1. onSubmitted fires ONCE per real prepared → submitted transition
//   2. onFailed fires on both failure paths (timeout + terminal Core err)
//   3. Hook receives the freshly re-read row (status reflects transition)
//   4. Neither hook fires when the transition doesn't happen
//   5. Hook exceptions are swallowed and logged, never bubble up
//   6. An async hook is awaited (rather than fire-and-forget)
describe('proposalDispatcher — success/fail hooks', () => {
  function setupWithHooks({ onSubmitted, onFailed } = {}) {
    const db = openDatabase(':memory:');
    const userId = seedUser(db);
    let clock = 1_700_000_000_000;
    const repo = createProposalSubmissionsRepo(db, { now: () => clock });
    const logs = [];
    const fake = makeFakeRpc();
    const dispatcher = createProposalDispatcher({
      submissions: repo,
      rpc: fake.rpc,
      log: (level, event, meta) => logs.push({ level, event, meta }),
      now: () => clock,
      onSubmitted,
      onFailed,
    });
    return {
      db,
      repo,
      dispatcher,
      fake,
      logs,
      userId,
      tick: (ms) => {
        clock += ms;
        return clock;
      },
    };
  }

  test('onSubmitted fires with the submitted row, exactly once', async () => {
    const events = [];
    const { repo, dispatcher, fake, userId } = setupWithHooks({
      onSubmitted: (arg) => {
        events.push(arg);
      },
    });
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ result: 'b'.repeat(64) });

    await dispatcher.tick();

    expect(events).toHaveLength(1);
    expect(events[0].submission.id).toBe(s.id);
    expect(events[0].submission.status).toBe('submitted');
    expect(events[0].submission.governanceHash).toBe('b'.repeat(64));

    // Second tick: nothing to advance → hook must not re-fire.
    await dispatcher.tick();
    expect(events).toHaveLength(1);
  });

  test('onFailed fires on timeout (collateral_not_found)', async () => {
    const events = [];
    const { repo, dispatcher, userId, tick } = setupWithHooks({
      onFailed: (arg) => {
        events.push(arg);
      },
    });
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    tick(DEFAULT_TIMEOUT_MS + 1);
    await dispatcher.tick();
    expect(events).toHaveLength(1);
    expect(events[0].submission.id).toBe(s.id);
    expect(events[0].submission.status).toBe('failed');
    expect(events[0].submission.failReason).toBe('collateral_not_found');
  });

  test('onFailed fires on terminal Core error (submit_rejected)', async () => {
    const events = [];
    const { repo, dispatcher, fake, userId } = setupWithHooks({
      onFailed: (arg) => {
        events.push(arg);
      },
    });
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({
      error: new Error('Governance object is not valid - payment_address is invalid'),
    });
    await dispatcher.tick();
    expect(events).toHaveLength(1);
    expect(events[0].submission.status).toBe('failed');
    expect(events[0].submission.failReason).toBe('submit_rejected');
    expect(events[0].submission.failDetail).toMatch(/payment_address/);
  });

  test('hooks do not fire for non-transitions (transient error)', async () => {
    const submittedEvents = [];
    const failedEvents = [];
    const { repo, dispatcher, fake, userId } = setupWithHooks({
      onSubmitted: (a) => submittedEvents.push(a),
      onFailed: (a) => failedEvents.push(a),
    });
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ error: new Error('ECONNREFUSED') });
    await dispatcher.tick();
    expect(submittedEvents).toHaveLength(0);
    expect(failedEvents).toHaveLength(0);
    // Row still awaiting — proves no failure-state transition happened.
    expect(repo.getById(s.id).status).toBe('awaiting_collateral');
  });

  test('async hook is awaited', async () => {
    let resolved = false;
    const { repo, dispatcher, fake, userId } = setupWithHooks({
      onSubmitted: async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      },
    });
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ result: 'c'.repeat(64) });
    await dispatcher.tick();
    expect(resolved).toBe(true);
  });

  test('hook that throws is swallowed and logged', async () => {
    const { repo, dispatcher, fake, logs, userId } = setupWithHooks({
      onSubmitted: () => {
        throw new Error('mailer fire');
      },
    });
    const s = makeSubmission(repo, userId);
    repo.attachCollateral(s.id, userId, 'a'.repeat(64));
    fake.txs.set('a'.repeat(64), { confirmations: 6 });
    fake.submitScript.push({ result: 'e'.repeat(64) });
    const stats = await dispatcher.tick();
    expect(stats.advanced).toBe(1);
    expect(repo.getById(s.id).status).toBe('submitted');
    expect(logs.find((l) => l.event === 'hook_threw')).toBeTruthy();
  });

  test('rejects non-function / non-null onSubmitted', () => {
    expect(() =>
      createProposalDispatcher({
        submissions: { listByStatus: () => [] },
        rpc: { getRawTransaction: () => {}, gObjectSubmit: () => {} },
        onSubmitted: 'nope',
      })
    ).toThrow(/onSubmitted/);
  });

  test(
    'transient RPC error containing the word "invalid" is NOT treated as terminal (Codex round 10 P2)',
    async () => {
      // Regression: the previous TERMINAL_CORE_ERRORS list had a
      // blanket /invalid/i catch, so any transport / parser error
      // whose message happened to contain the word "invalid" —
      // very common in JSON-RPC client libraries ("invalid
      // JSON-RPC response", "invalid response from server",
      // "invalid utf-8 sequence", socket error wrappers, etc.) —
      // got misclassified as a permanent Core rejection, flipped
      // the row to `failed`, and fired a user-visible failure
      // email the user could never actually fix.
      //
      // The fix narrows the list to phrases Syscoin Core actually
      // emits for validation failures from gobject_submit /
      // CGovernanceObject::IsValidLocally. Anything else — bare
      // "invalid" in a transport error included — stays classified
      // as transient and is retried on the next tick.
      const failedEvents = [];
      const { repo, dispatcher, fake, userId } = setupWithHooks({
        onFailed: (a) => failedEvents.push(a),
      });
      const s = makeSubmission(repo, userId);
      repo.attachCollateral(s.id, userId, 'a'.repeat(64));
      fake.txs.set('a'.repeat(64), { confirmations: 6 });

      // Exactly the class of error Codex flagged: transport /
      // parser failure wrapped with the word "invalid". Must NOT
      // terminate the row.
      fake.submitScript.push({
        error: new Error('invalid JSON-RPC response from server'),
      });
      await dispatcher.tick();

      expect(repo.getById(s.id).status).toBe('awaiting_collateral');
      expect(failedEvents).toHaveLength(0);

      // And the previously-terminal Core phrasings still terminate.
      fake.submitScript.push({
        error: new Error(
          'Governance object is not valid - payment_address is invalid'
        ),
      });
      await dispatcher.tick();
      expect(repo.getById(s.id).status).toBe('failed');
      expect(repo.getById(s.id).failReason).toBe('submit_rejected');
      expect(failedEvents).toHaveLength(1);
    }
  );

  test(
    'transient proxy 429 "rate limit" is NOT terminal; only Core\'s exact "Object creation rate limit exceeded" is (Codex round 12 P1)',
    async () => {
      // Regression: the previous `/rate limit/i` pattern was too
      // broad. HTTP proxies / RPC providers routinely return 429
      // with bodies like "rate limit exceeded, try again later"
      // or "rate-limited by upstream" — those are transient and
      // must be retried. Only Core's exact permanent-reject
      // phrase (thrown at syscoin/src/rpc/governance.cpp:204)
      //   "Object creation rate limit exceeded"
      // is a terminal rate-limit condition; it means the object's
      // governance hash is burned for this cycle and no retry
      // will ever succeed.
      const failedEvents = [];
      const { repo, dispatcher, fake, userId } = setupWithHooks({
        onFailed: (a) => failedEvents.push(a),
      });
      const s = makeSubmission(repo, userId);
      repo.attachCollateral(s.id, userId, 'a'.repeat(64));
      fake.txs.set('a'.repeat(64), { confirmations: 6 });

      // Proxy 429 — transient. Row must stay in awaiting_collateral.
      fake.submitScript.push({
        error: new Error('429 Too Many Requests: rate limit exceeded'),
      });
      await dispatcher.tick();
      expect(repo.getById(s.id).status).toBe('awaiting_collateral');
      expect(failedEvents).toHaveLength(0);

      // Core's exact phrase — terminal.
      fake.submitScript.push({
        error: new Error('Object creation rate limit exceeded'),
      });
      await dispatcher.tick();
      expect(repo.getById(s.id).status).toBe('failed');
      expect(repo.getById(s.id).failReason).toBe('submit_rejected');
      expect(failedEvents).toHaveLength(1);
    }
  );

  test('rejects non-function / non-null onFailed', () => {
    expect(() =>
      createProposalDispatcher({
        submissions: { listByStatus: () => [] },
        rpc: { getRawTransaction: () => {}, gObjectSubmit: () => {} },
        onFailed: 42,
      })
    ).toThrow(/onFailed/);
  });
});

// ---------------- factory arg validation ----------------
describe('proposalDispatcher — factory validation', () => {
  test('requires submissions repo', () => {
    expect(() =>
      createProposalDispatcher({
        rpc: { getRawTransaction: () => {}, gObjectSubmit: () => {} },
      })
    ).toThrow(/submissions/);
  });

  test('requires rpc.getRawTransaction', () => {
    expect(() =>
      createProposalDispatcher({
        submissions: { listByStatus: () => [] },
        rpc: { gObjectSubmit: () => {} },
      })
    ).toThrow(/getRawTransaction/);
  });

  test('requires rpc.gObjectSubmit', () => {
    expect(() =>
      createProposalDispatcher({
        submissions: { listByStatus: () => [] },
        rpc: { getRawTransaction: () => {} },
      })
    ).toThrow(/gObjectSubmit/);
  });
});
