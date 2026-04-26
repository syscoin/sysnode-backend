'use strict';

const express = require('express');
const request = require('supertest');
const { openDatabase } = require('../lib/db');
const { createMasternodeCountRepo } = require('../lib/masternodeCountRepo');
const { createMnCountRouter } = require('./mnCount');

function mountApp(router) {
  const app = express();
  app.use(router);
  return app;
}

describe('GET /mncount', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = createMasternodeCountRepo(db);
  });

  afterEach(() => db.close());

  test('empty table → 200 with []', async () => {
    const app = mountApp(createMnCountRouter({ repo }));
    const res = await request(app).get('/mncount');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('populated table → 200 with ascending [{date, users}] rows', async () => {
    repo.upsertByDate('2024-03-15', 2200, Date.parse('2024-03-15T00:00:05Z'));
    repo.upsertByDate('2024-03-14', 2199, Date.parse('2024-03-14T00:00:05Z'));
    repo.upsertByDate('2024-03-16', 2201, Date.parse('2024-03-16T00:00:05Z'));

    const app = mountApp(createMnCountRouter({ repo }));
    const res = await request(app).get('/mncount');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { date: '2024-03-14', users: 2199 },
      { date: '2024-03-15', users: 2200 },
      { date: '2024-03-16', users: 2201 },
    ]);
  });

  test('repo read failure → 500 {error: "internal"} and logs the failure', async () => {
    const logs = [];
    const blowingRepo = {
      getAll: () => {
        throw new Error('db corrupt');
      },
    };
    const app = mountApp(
      createMnCountRouter({
        repo: blowingRepo,
        log: (level, event, meta) => logs.push({ level, event, meta }),
      })
    );
    const res = await request(app).get('/mncount');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(logs.some((l) => l.event === 'mncount_read_failed')).toBe(true);
  });

  test('constructor rejects missing repo', () => {
    expect(() => createMnCountRouter({})).toThrow(/repo is required/);
  });
});
