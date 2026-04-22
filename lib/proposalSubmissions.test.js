'use strict';

const { openDatabase } = require('./db');
const {
  createProposalSubmissionsRepo,
  STATUS,
} = require('./proposalSubmissions');

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

function validInput(userId, overrides = {}) {
  return {
    userId,
    parentHash: '0',
    revision: 1,
    timeUnix: 1800000000,
    dataHex: '7b2274797065223a317d', // {"type":1}
    proposalHash: 'a'.repeat(64),
    title: 'Test',
    name: 'test-proposal',
    url: 'https://example.org/p',
    paymentAddress: 'sys1qabcdefghij1234567890',
    paymentAmountSats: 4250000000n,
    paymentCount: 1,
    startEpoch: 1800000000,
    endEpoch: 1802592000,
    ...overrides,
  };
}

// Custom matcher-esque helper: assert that calling `fn` throws an Error
// whose .code matches the given string. We check the machine-stable
// `.code` (not the human message), since that's what the route layer
// maps to HTTP status / user copy.
function expectThrowsCode(fn, expectedCode) {
  try {
    fn();
  } catch (e) {
    expect(e.code).toBe(expectedCode);
    return;
  }
  throw new Error(`expected throw with code ${expectedCode}, got nothing`);
}

function setup() {
  const db = openDatabase(':memory:');
  const user1 = seedUser(db, 'a@x.com');
  const user2 = seedUser(db, 'b@x.com');
  let clock = 1_700_000_000_000;
  const repo = createProposalSubmissionsRepo(db, { now: () => clock });
  return {
    db,
    repo,
    user1,
    user2,
    tick: (ms = 1000) => {
      clock += ms;
      return clock;
    },
  };
}

// ---------------- create ----------------
describe('create', () => {
  test('creates a row in status=prepared with all canonical fields', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expect(s.status).toBe(STATUS.PREPARED);
    expect(s.userId).toBe(user1);
    expect(s.proposalHash).toBe('a'.repeat(64));
    expect(s.paymentAmountSats).toBe(4250000000n);
    expect(s.collateralTxid).toBeNull();
    expect(s.collateralConfs).toBe(0);
    expect(s.governanceHash).toBeNull();
  });

  test('preserves BigInt amount above 2^53', () => {
    const { repo, user1 } = setup();
    const huge = 18014398509481985n;
    const s = repo.create(validInput(user1, { paymentAmountSats: huge }));
    expect(s.paymentAmountSats).toBe(huge);
    expect(repo.getById(s.id).paymentAmountSats).toBe(huge);
  });

  test.each([
    ['userId', { userId: 0 }, 'user_required'],
    ['timeUnix', { timeUnix: 0 }, 'time_required'],
    ['dataHex', { dataHex: 'not hex' }, 'data_hex_invalid'],
    ['proposalHash', { proposalHash: 'short' }, 'proposal_hash_invalid'],
    ['name', { name: '' }, 'name_required'],
    ['url', { url: '' }, 'url_required'],
    ['paymentAddress', { paymentAddress: '' }, 'paymentAddress_required'],
    ['paymentAmountSats (zero)', { paymentAmountSats: 0n }, 'amount_invalid'],
    ['startEpoch missing', { startEpoch: null }, 'epoch_required'],
  ])('rejects invalid input: %s', (_label, patch, code) => {
    const { repo, user1 } = setup();
    expectThrowsCode(() => repo.create(validInput(user1, patch)), code);
  });
});

// ---------------- user isolation ----------------
describe('user isolation', () => {
  test('getByIdForUser returns null for a non-owner', () => {
    const { repo, user1, user2 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.getByIdForUser(s.id, user2)).toBeNull();
  });

  test('listForUser scopes to owner', () => {
    const { repo, user1, user2 } = setup();
    repo.create(validInput(user1, { proposalHash: 'a'.repeat(64) }));
    repo.create(validInput(user2, { proposalHash: 'b'.repeat(64) }));
    expect(repo.listForUser(user1).map((r) => r.proposalHash)).toEqual([
      'a'.repeat(64),
    ]);
    expect(repo.listForUser(user2).map((r) => r.proposalHash)).toEqual([
      'b'.repeat(64),
    ]);
  });
});

// ---------------- attachCollateral ----------------
describe('attachCollateral', () => {
  const txid = 'f'.repeat(64);

  test('prepared → awaiting_collateral and stores lowercase txid', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    const out = repo.attachCollateral(s.id, user1, txid.toUpperCase());
    expect(out.status).toBe(STATUS.AWAITING_COLLATERAL);
    expect(out.collateralTxid).toBe(txid);
  });

  test('returns null for a non-owner', () => {
    const { repo, user1, user2 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.attachCollateral(s.id, user2, txid)).toBeNull();
  });

  test('rejects from non-prepared status', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, txid);
    expectThrowsCode(
      () => repo.attachCollateral(s.id, user1, txid),
      'status_not_prepared'
    );
  });

  test('rejects an invalid txid', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expectThrowsCode(
      () => repo.attachCollateral(s.id, user1, 'not-hex'),
      'txid_invalid'
    );
  });

  test('rejects a txid already used by another submission', () => {
    const { repo, user1, user2 } = setup();
    const a = repo.create(validInput(user1));
    const b = repo.create(
      validInput(user2, { proposalHash: 'b'.repeat(64) })
    );
    repo.attachCollateral(a.id, user1, txid);
    expectThrowsCode(
      () => repo.attachCollateral(b.id, user2, txid),
      'txid_already_used'
    );
  });

  test(
    'normalizes write-level unique constraint races to txid_already_used (Codex round 3 P2)',
    () => {
      // Scenario: two concurrent attach-collateral requests for the
      // same txid both pass the read-before-write pre-check and both
      // issue an UPDATE. In-process we can't truly interleave
      // better-sqlite3 calls, so we simulate the second request's
      // race by planting the clashing row BETWEEN the pre-check and
      // the UPDATE via a direct SQL write bypass. The partial unique
      // index `idx_proposal_submissions_collateral_txid` must then
      // reject the UPDATE, and the repo must translate that raw
      // SQLite error into the same stable `.code = txid_already_used`
      // the pre-check raises — so the route layer keeps returning a
      // clean 409 regardless of which branch fired.
      const { db, repo, user1, user2 } = setup();
      const a = repo.create(validInput(user1));
      const b = repo.create(
        validInput(user2, { proposalHash: 'b'.repeat(64) })
      );
      // Monkey-patch byTxidStmt indirectly: there's no hook, so
      // exercise the equivalent behavior by writing a competing row
      // under the radar of the pre-check. We do this by racing the
      // UPDATE via a second prepared statement that the repo will
      // not observe until AFTER its pre-read has already returned
      // null. Because better-sqlite3 is synchronous, we achieve the
      // same effect by intercepting the prepare + run once.
      const origPrepare = db.prepare.bind(db);
      const mutator = db
        .prepare(
          `UPDATE proposal_submissions
              SET status = ?, collateral_txid = ?, updated_at = ?
            WHERE id = ? AND user_id = ?`
        );
      let planted = false;
      db.prepare = (sql) => {
        const stmt = origPrepare(sql);
        if (!planted && /SET status = \?, collateral_txid = \?/.test(sql)) {
          planted = true;
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...args) => {
            // Plant row A's collateral_txid BEFORE the repo's own
            // UPDATE fires. This mirrors the "second tick beat us to
            // it" race that the partial unique index is there to
            // catch.
            mutator.run('awaiting_collateral', txid, Date.now(), a.id, user1);
            return originalRun(...args);
          };
        }
        return stmt;
      };
      try {
        expectThrowsCode(
          () => repo.attachCollateral(b.id, user2, txid),
          'txid_already_used'
        );
      } finally {
        db.prepare = origPrepare;
      }
    }
  );

  test(
    'CAS: concurrent status transition out of prepared is rejected, not silently overwritten (Codex round 4 P1)',
    () => {
      // Scenario: row S is 'prepared'. Two concurrent attach
      // requests arrive with DIFFERENT txids. Both pass the
      // pre-read status check. Before the prior fix, the later
      // UPDATE would silently overwrite collateral_txid — binding
      // the submission to the wrong collateral.
      //
      // With the CAS guard (AND status='prepared' in WHERE), the
      // racer that flips status first wins; the other's UPDATE
      // matches 0 rows and we throw `status_not_prepared` with
      // the row's real current state intact.
      const { db, repo, user1 } = setup();
      const s = repo.create(validInput(user1));
      const txidA = 'a'.repeat(64);
      const txidB = 'b'.repeat(64);

      // Prepare a writer that flips the row to awaiting_collateral
      // with txidA — the simulated "other worker that beat us".
      const flip = db.prepare(
        `UPDATE proposal_submissions
            SET status = ?, collateral_txid = ?, updated_at = ?
          WHERE id = ?`
      );

      const origPrepare = db.prepare.bind(db);
      let planted = false;
      db.prepare = (sql) => {
        const stmt = origPrepare(sql);
        // Intercept only the repo's CAS UPDATE (now includes
        // `AND status = ?`) — do NOT intercept `flip` above,
        // which is a different SQL string.
        if (
          !planted &&
          /SET status = \?, collateral_txid = \?/.test(sql) &&
          /AND status = \?/.test(sql)
        ) {
          planted = true;
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...args) => {
            flip.run('awaiting_collateral', txidA, Date.now(), s.id);
            return originalRun(...args);
          };
        }
        return stmt;
      };

      try {
        expectThrowsCode(
          () => repo.attachCollateral(s.id, user1, txidB),
          'status_not_prepared'
        );
      } finally {
        db.prepare = origPrepare;
      }

      // Critical invariant: the row's collateral_txid must STILL
      // be the winner's (txidA), never the loser's (txidB).
      const final = repo.getByIdForUser(s.id, user1);
      expect(final.status).toBe(STATUS.AWAITING_COLLATERAL);
      expect(final.collateralTxid).toBe(txidA);
    }
  );
});

// ---------------- partial unique index: per-user/dataHex/prepared ----
describe('partial unique index: prepared rows are unique per (user_id, data_hex)', () => {
  test(
    'two prepared rows with the same user+dataHex are rejected at DB layer (Codex round 3 P2)',
    () => {
      const { repo, user1 } = setup();
      repo.create(validInput(user1));
      expect(() =>
        repo.create(
          validInput(user1, { proposalHash: 'b'.repeat(64) })
        )
      ).toThrow(/UNIQUE constraint failed/);
    }
  );

  test(
    'same user+dataHex is allowed once the first row has left prepared (status moves it out of the partial index)',
    () => {
      const { repo, user1 } = setup();
      const a = repo.create(validInput(user1));
      // Advance a past prepared so the partial index no longer covers it.
      repo.attachCollateral(a.id, user1, 'f'.repeat(64));
      const b = repo.create(
        validInput(user1, { proposalHash: 'b'.repeat(64) })
      );
      expect(b.status).toBe('prepared');
      expect(b.id).not.toBe(a.id);
    }
  );

  test(
    'two different users may each have a prepared row with the same dataHex',
    () => {
      const { repo, user1, user2 } = setup();
      const a = repo.create(validInput(user1));
      const b = repo.create(
        validInput(user2, { proposalHash: 'b'.repeat(64) })
      );
      expect(a.id).not.toBe(b.id);
    }
  );
});

// ---------------- updateConfirmations ----------------
describe('updateConfirmations', () => {
  test('bumps confs and updated_at', () => {
    const { repo, user1, tick } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    tick(1000);
    const after = repo.updateConfirmations(s.id, 4);
    expect(after.collateralConfs).toBe(4);
    expect(after.updatedAt).toBeGreaterThan(s.updatedAt);
  });

  test('rejects negative/non-integer confs', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expectThrowsCode(() => repo.updateConfirmations(s.id, -1), 'confs_invalid');
    expectThrowsCode(() => repo.updateConfirmations(s.id, 1.5), 'confs_invalid');
  });
});

// ---------------- markSubmitted ----------------
describe('markSubmitted', () => {
  const txid = 'a'.repeat(64);
  const govHash = 'b'.repeat(64);

  function arrange() {
    const ctx = setup();
    const s = ctx.repo.create(validInput(ctx.user1));
    ctx.repo.attachCollateral(s.id, ctx.user1, txid);
    return { ...ctx, s };
  }

  test('awaiting_collateral → submitted, records governanceHash lowercase', () => {
    const { repo, s } = arrange();
    const out = repo.markSubmitted(s.id, { governanceHash: govHash.toUpperCase() });
    expect(out.status).toBe(STATUS.SUBMITTED);
    expect(out.governanceHash).toBe(govHash);
  });

  test('rejects from a non-awaiting status', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expectThrowsCode(
      () => repo.markSubmitted(s.id, { governanceHash: govHash }),
      'status_not_awaiting'
    );
  });

  test('rejects an invalid governance hash', () => {
    const { repo, s } = arrange();
    expectThrowsCode(
      () => repo.markSubmitted(s.id, { governanceHash: 'bad' }),
      'governance_hash_invalid'
    );
  });

  test('rejects a governance hash already recorded on another row', () => {
    const { db, repo, user1, user2 } = setup();
    const a = repo.create(validInput(user1));
    const b = repo.create(validInput(user2, { proposalHash: 'c'.repeat(64) }));
    repo.attachCollateral(a.id, user1, 'a'.repeat(64));
    repo.attachCollateral(b.id, user2, 'd'.repeat(64));
    repo.markSubmitted(a.id, { governanceHash: govHash });
    expectThrowsCode(
      () => repo.markSubmitted(b.id, { governanceHash: govHash }),
      'governance_hash_clash'
    );
    db.close();
  });

  test(
    'CAS: concurrent status transition out of awaiting_collateral is a no-op, not a duplicate submit (Codex round 5 P1)',
    () => {
      // Scenario: two dispatcher workers both pick up the same
      // awaiting_collateral row. Both call rpc.gObjectSubmit, both
      // (eventually) reach markSubmitted. Before the round-5 CAS
      // guard the UPDATE only filtered by id, so BOTH would pass
      // their pre-read status check AND BOTH would commit their
      // UPDATE — each treating the transition as its own success
      // and each firing onSubmitted (duplicate "submitted" emails).
      //
      // With `AND status = 'awaiting_collateral'` folded into the
      // WHERE clause, only the first UPDATE changes a row; the
      // second matches zero rows and we return null so the
      // dispatcher's `if (submittedRow)` guard skips the second
      // hook fire. The winner keeps the emit-once role.
      const { db, repo, user1 } = setup();
      const s = repo.create(validInput(user1));
      repo.attachCollateral(s.id, user1, 'a'.repeat(64));

      // Prepare a direct writer that flips the row to 'submitted'
      // with the SAME governance hash — the simulated winner.
      const flip = db.prepare(
        `UPDATE proposal_submissions
            SET status = ?, governance_hash = ?, updated_at = ?
          WHERE id = ?`
      );

      const origPrepare = db.prepare.bind(db);
      let planted = false;
      db.prepare = (sql) => {
        const stmt = origPrepare(sql);
        // Intercept only the repo's CAS UPDATE (contains the
        // governance_hash set and the `AND status = ?` guard).
        if (
          !planted &&
          /SET status = \?, governance_hash = \?/.test(sql) &&
          /AND status = \?/.test(sql)
        ) {
          planted = true;
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...args) => {
            flip.run('submitted', govHash, Date.now(), s.id);
            return originalRun(...args);
          };
        }
        return stmt;
      };

      let out;
      try {
        out = repo.markSubmitted(s.id, { governanceHash: govHash });
      } finally {
        db.prepare = origPrepare;
      }

      // Critical: the losing worker got null, NOT a throw and NOT
      // a fake-success row. Dispatcher code uses `if (submittedRow)`
      // before firing onSubmitted, so null correctly skips the
      // duplicate hook fire.
      expect(out).toBeNull();

      // And the row still reflects the winner's write — same hash,
      // same terminal status.
      const final = repo.getById(s.id);
      expect(final.status).toBe(STATUS.SUBMITTED);
      expect(final.governanceHash).toBe(govHash);
    }
  );
});

// ---------------- markFailed ----------------
describe('markFailed', () => {
  test('can fail from prepared', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    const out = repo.markFailed(s.id, {
      reason: 'canceled',
      detail: 'user aborted',
    });
    expect(out.status).toBe(STATUS.FAILED);
    expect(out.failReason).toBe('canceled');
    expect(out.failDetail).toBe('user aborted');
  });

  test('can fail from awaiting_collateral', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    const out = repo.markFailed(s.id, { reason: 'confirm_timeout' });
    expect(out.status).toBe(STATUS.FAILED);
  });

  test('cannot fail a submitted row', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    repo.markSubmitted(s.id, { governanceHash: 'b'.repeat(64) });
    expectThrowsCode(
      () => repo.markFailed(s.id, { reason: 'late_fail' }),
      'status_terminal'
    );
  });

  test('cannot fail an already-failed row (no double-writes)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.markFailed(s.id, { reason: 'canceled' });
    expectThrowsCode(
      () => repo.markFailed(s.id, { reason: 'canceled' }),
      'status_terminal'
    );
  });

  test(
    'CAS: concurrent status transition into submitted is NOT overwritten back to failed (Codex round 7 P1)',
    () => {
      // Scenario: a dispatcher worker takes the "terminal reject"
      // path in proposalDispatcher.js (e.g. gObjectSubmit throws a
      // validation-ish error) and calls markFailed. Between the
      // pre-read status check and the UPDATE, a sibling worker has
      // already flipped the same row to `submitted` (via
      // markSubmitted's CAS). Before the round-7 CAS guard the
      // UPDATE only filtered by id, so THIS call would stomp the
      // winning `submitted` row back to `failed` — corrupting the
      // terminal state and triggering onFailed side effects
      // (wrong email, wrong UI) for a row that actually went live
      // on-chain.
      //
      // With `AND status NOT IN ('submitted', 'failed')` folded
      // into the WHERE clause, the UPDATE matches zero rows; we
      // return null so the dispatcher's `if (failedRow)` guard
      // skips the onFailed hook and the winner keeps emit-once.
      const { db, repo, user1 } = setup();
      const s = repo.create(validInput(user1));
      repo.attachCollateral(s.id, user1, 'a'.repeat(64));

      // Direct writer that races the row to `submitted` AFTER the
      // markFailed pre-read returns `awaiting_collateral` but
      // BEFORE the CAS UPDATE runs. Same pattern as the R5 test.
      const flip = db.prepare(
        `UPDATE proposal_submissions
            SET status = ?, governance_hash = ?, updated_at = ?
          WHERE id = ?`
      );

      const origPrepare = db.prepare.bind(db);
      let planted = false;
      db.prepare = (sql) => {
        const stmt = origPrepare(sql);
        // Match the markFailed CAS UPDATE (sets fail_reason AND has
        // the `AND status NOT IN (?, ?)` guard).
        if (
          !planted &&
          /SET status = \?, fail_reason = \?/.test(sql) &&
          /AND status NOT IN \(\?, \?\)/.test(sql)
        ) {
          planted = true;
          const originalRun = stmt.run.bind(stmt);
          stmt.run = (...args) => {
            flip.run('submitted', 'b'.repeat(64), Date.now(), s.id);
            return originalRun(...args);
          };
        }
        return stmt;
      };

      let out;
      try {
        out = repo.markFailed(s.id, { reason: 'submit_rejected' });
      } finally {
        db.prepare = origPrepare;
      }

      // Losing worker got null — NOT a throw and NOT a fake-success
      // row. Dispatcher's `if (failedRow)` will skip onFailed so
      // the winner's onSubmitted is the only emitted side effect.
      expect(out).toBeNull();

      // Row still reflects the winner's write.
      const final = repo.getById(s.id);
      expect(final.status).toBe(STATUS.SUBMITTED);
      expect(final.governanceHash).toBe('b'.repeat(64));
      expect(final.failReason).toBeNull();
    }
  );
});

// ---------------- remove ----------------
describe('remove', () => {
  test('removes a prepared row', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.remove(s.id, user1)).toBe(1);
    expect(repo.getById(s.id)).toBeNull();
  });

  test('removes a failed row', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.markFailed(s.id, { reason: 'canceled' });
    expect(repo.remove(s.id, user1)).toBe(1);
  });

  test('refuses to remove awaiting_collateral (confirmations in flight)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    expect(repo.remove(s.id, user1)).toBe(0);
    expect(repo.getById(s.id)).not.toBeNull();
  });

  test('refuses to remove submitted (permanent record)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    repo.markSubmitted(s.id, { governanceHash: 'b'.repeat(64) });
    expect(repo.remove(s.id, user1)).toBe(0);
  });

  test('isolates users', () => {
    const { repo, user1, user2 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.remove(s.id, user2)).toBe(0);
    expect(repo.getById(s.id)).not.toBeNull();
  });
});

// ---------------- listByStatus / finders ----------------
describe('finders', () => {
  test('listByStatus returns rows matching a given status', () => {
    const { repo, user1 } = setup();
    const a = repo.create(validInput(user1));
    // Different dataHex to avoid the partial-unique-index for prepared
    // rows (Codex round 3 P2): same user may not hold two prepared
    // rows for identical canonical payloads.
    const b = repo.create(
      validInput(user1, {
        proposalHash: 'd'.repeat(64),
        dataHex: '7b2274797065223a327d', // {"type":2}
      })
    );
    repo.attachCollateral(b.id, user1, 'c'.repeat(64));
    expect(repo.listByStatus(STATUS.PREPARED).map((r) => r.id)).toEqual([a.id]);
    expect(repo.listByStatus(STATUS.AWAITING_COLLATERAL).map((r) => r.id)).toEqual([
      b.id,
    ]);
  });

  test('listByStatus rejects unknown status', () => {
    const { repo } = setup();
    expectThrowsCode(() => repo.listByStatus('bogus'), 'status_invalid');
  });

  test('findByCollateralTxid finds a row by txid (lowercased)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'A'.repeat(64));
    expect(repo.findByCollateralTxid('a'.repeat(64)).id).toBe(s.id);
    expect(repo.findByCollateralTxid('nonexistent')).toBeNull();
  });

  test('findByGovernanceHash finds a row by gov hash (lowercased)', () => {
    const { repo, user1 } = setup();
    const s = repo.create(validInput(user1));
    repo.attachCollateral(s.id, user1, 'a'.repeat(64));
    repo.markSubmitted(s.id, { governanceHash: 'B'.repeat(64) });
    expect(repo.findByGovernanceHash('b'.repeat(64)).id).toBe(s.id);
  });

  test('findByProposalHashForUser scopes to owner', () => {
    const { repo, user1, user2 } = setup();
    const s = repo.create(validInput(user1));
    expect(repo.findByProposalHashForUser(user1, s.proposalHash).id).toBe(s.id);
    expect(
      repo.findByProposalHashForUser(user2, s.proposalHash)
    ).toBeNull();
  });

  test('findPreparedByDataHexForUser returns only prepared rows, scoped to owner (Codex round 2 P1)', () => {
    const { repo, user1, user2 } = setup();
    // user1: one prepared row.
    const a = repo.create(validInput(user1));
    // Same user, same dataHex — if we ever allowed a duplicate row,
    // the ORDER BY created_at DESC picks the newest. We assert only
    // that we get back a prepared row for (user, dataHex).
    expect(
      repo.findPreparedByDataHexForUser(user1, a.dataHex).id
    ).toBe(a.id);
    // Different user, same dataHex → no cross-tenant leak.
    expect(
      repo.findPreparedByDataHexForUser(user2, a.dataHex)
    ).toBeNull();
    // Unknown dataHex → null.
    expect(
      repo.findPreparedByDataHexForUser(user1, 'deadbeef')
    ).toBeNull();
    // After the row moves out of `prepared`, we no longer return it —
    // the idempotency check in /prepare must NOT collide against
    // awaiting_collateral / submitted / failed rows.
    repo.attachCollateral(a.id, user1, 'd'.repeat(64));
    expect(
      repo.findPreparedByDataHexForUser(user1, a.dataHex)
    ).toBeNull();
  });
});

// ---------------- cascade ----------------
describe('cascade on user delete', () => {
  test('submissions for a deleted user are removed', () => {
    const { db, repo, user1 } = setup();
    repo.create(validInput(user1));
    db.prepare('DELETE FROM users WHERE id = ?').run(user1);
    expect(repo.listForUser(user1)).toEqual([]);
  });
});
