'use strict';

// Codex PR8 round 8 P2 regression.
//
// `stopProposalDispatcher()` used to only call `clearTimeout()` on the
// pending timer handle. If a tick was already *in flight* — i.e. we
// were past `await dispatcher.tick()` at the moment stop was called —
// the callback would continue running and call setTimeout(...) again,
// re-arming the polling loop after it was supposed to be stopped.
// That leaked the dispatcher into test teardown and shutdown paths.
//
// This test forces that exact race: we stub the dispatcher so every
// tick awaits a deferred promise we control. While a tick is parked in
// its `await`, we call stopProposalDispatcher(); then we release the
// deferred. If the fix is in place, no new timer should arm and no
// further ticks should run.

jest.useRealTimers();

const express = require('express');

// We need to replace createProposalDispatcher with a stub we can
// orchestrate. jest.doMock is OK here because appFactory.js requires
// the module synchronously at load time.
const tickGate = {
  pending: [],
  tickCount: 0,
  nextDeferred() {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    const d = { promise, resolve };
    this.pending.push(d);
    return d;
  },
};

jest.doMock('../lib/proposalDispatcher', () => ({
  createProposalDispatcher: () => ({
    async tick() {
      tickGate.tickCount += 1;
      const d = tickGate.nextDeferred();
      await d.promise;
    },
  }),
}));

const { openDatabase } = require('../lib/db');
const { createMailer } = require('../lib/mailer');
const { createApp } = require('../lib/appFactory');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('appFactory: stopProposalDispatcher (Codex round 8 P2)', () => {
  test('stop during an in-flight tick does NOT rearm the loop', async () => {
    const db = openDatabase(':memory:');
    const mailer = createMailer({ transport: 'memory', from: 't@x.com' });
    // Minimal RPC adapter is enough — dispatcher itself is stubbed,
    // so it never actually calls into this.
    const proposalRpc = {
      getRawTransaction: async () => ({ confirmations: 0 }),
      gObjectSubmit: async () => 'hash',
      gObjectCheck: async () => ({ 'Object status': 'OK' }),
    };

    // Use a stripped-down createApp invocation. We bypass mailer-URL
    // requirements by providing a dummy mailer and no /gov masternode
    // deps, which createApp treats as optional. The dispatcher timing
    // is what we care about — fire the kickoff almost immediately so
    // we don't spin Jest for 5s.
    const { stopProposalDispatcher } = createApp({
      db,
      mailer,
      proposalRpc,
      startProposalDispatcher: true,
      // Make the *next-interval* setTimeout short so we'd notice a
      // rearm quickly. The *kickoff* timer is capped by
      // `Math.min(5000, proposalDispatcherIntervalMs)` in appFactory
      // so setting this to 50 also makes the kickoff fire in ~50ms.
      proposalDispatcherIntervalMs: 50,
    });

    try {
      // Wait for the first tick to enter its `await`.
      for (let i = 0; i < 200; i++) {
        if (tickGate.tickCount >= 1 && tickGate.pending.length >= 1) break;
        await wait(10);
      }
      expect(tickGate.tickCount).toBe(1);
      expect(tickGate.pending).toHaveLength(1);

      // Stop while the tick is still parked on its deferred.
      stopProposalDispatcher();

      // Release the in-flight tick. The fix must prevent the callback
      // from re-arming after this resolves.
      tickGate.pending[0].resolve();

      // Give the event loop plenty of time for a rogue rearm to fire.
      // proposalDispatcherIntervalMs is 50ms; we wait ~10x to be sure.
      await wait(500);

      expect(tickGate.tickCount).toBe(1);
    } finally {
      stopProposalDispatcher();
      db.close();
    }
  });
});
