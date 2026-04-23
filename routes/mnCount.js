'use strict';

const express = require('express');

// GET /mnCount
// ------------
// Historical daily total of masternodes on the network, used by the
// TrendChart component on sysnode-info's homepage.
//
// Shape (preserved from the retired CSV route for FE compatibility):
//   [ { date: 'YYYY-MM-DD', users: <integer> }, ... ]
//
// Source: `masternode_count_daily` SQLite table, written once per UTC
// day by services/mnCountLogger.js. The legacy file-backed route
// (routes/csvParser.js reading /root/sysnode/data.csv) is retired —
// it couldn't survive a fresh deploy where the CSV hadn't been
// provisioned, which is exactly how we lost the chart on staging.
//
// Error handling: a DB read failure returns 500 with a stable body so
// the FE's error banner stays predictable. An empty table returns 200
// with `[]` — that's the correct representation of "we know of no
// history yet" and keeps the TrendChart in its "no data" state
// instead of the "network error" state.

function createMnCountRouter({ repo, log = () => {} } = {}) {
  if (!repo) {
    throw new Error('createMnCountRouter: repo is required');
  }
  const router = express.Router();

  router.get('/mnCount', (_req, res) => {
    try {
      const rows = repo.getAll();
      res.json(rows);
    } catch (err) {
      log('error', 'mncount_read_failed', { err: err && err.message });
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}

module.exports = { createMnCountRouter };
