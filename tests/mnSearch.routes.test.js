// Regression test for the stale-reference bug in routes/mnsearch.js.
//
// The masternode tracker (services/masternodeTracker.js) reassigns
// `dataStore.masternodesArr = []` every 10 seconds and then pushes
// nodes into the fresh array. Previously the route did:
//
//   const { masternodesArr } = require("../data/dataStore");
//
// which destructures *at module-load time*, capturing the initial
// `[]` from data/dataStore.js. Subsequent tracker reassignments
// pointed dataStore.masternodesArr at a different array object, but
// the route handler still referenced the original empty one — so
// `/mnsearch` always returned `{ returnArr: [], mnNumb: 0 }` in
// production.
//
// The fix is to read the property on every call. These tests pin
// that behaviour:
//
//   1. The handler reflects updates published by the tracker AFTER
//      the route module has been loaded.
//   2. Filtering by address/payee, sorting, and pagination still
//      behave as documented.
//   3. A non-array dataStore.masternodesArr (defensive: tracker
//      mid-write, RPC failure mid-cycle, etc.) does not throw.

const express = require('express');
const bodyParser = require('body-parser');
const request = require('supertest');

const dataStore = require('../data/dataStore');
const mnSearchRoute = require('../routes/mnSearch');

function buildApp() {
  const app = express();
  app.use(bodyParser.json());
  app.use(mnSearchRoute);
  return app;
}

function makeNode(over = {}) {
  return {
    address: '127.0.0.1:18370',
    payee: 'sys1qexamplepayeeaddr',
    lastpaidtime: 0,
    lastseen: Math.floor(Date.now() / 1000),
    status: 'ENABLED',
    ...over,
  };
}

describe('POST /mnsearch — live dataStore read', () => {
  // Save and restore the dataStore property so tests don't bleed state.
  let savedArr;
  beforeEach(() => {
    savedArr = dataStore.masternodesArr;
  });
  afterEach(() => {
    dataStore.masternodesArr = savedArr;
  });

  test('returns nodes published by the tracker AFTER module load', async () => {
    // Simulate the tracker's reassignment-then-push cycle.
    dataStore.masternodesArr = [];
    dataStore.masternodesArr.push(
      makeNode({ address: '10.0.0.1:18370', payee: 'sys1qalpha' }),
      makeNode({ address: '10.0.0.2:18370', payee: 'sys1qbeta' })
    );

    const res = await request(buildApp()).post('/mnsearch').send({});
    expect(res.status).toBe(200);
    expect(res.body.mnNumb).toBe(2);
    expect(res.body.returnArr).toHaveLength(2);
  });

  test('reflects a tracker REASSIGNMENT (not just in-place mutation)', async () => {
    // First cycle.
    dataStore.masternodesArr = [makeNode({ payee: 'sys1qfirst' })];
    let res = await request(buildApp()).post('/mnsearch').send({});
    expect(res.body.mnNumb).toBe(1);
    expect(res.body.returnArr[0].payee).toBe('sys1qfirst');

    // Tracker drops the array entirely and assigns a fresh one. This is
    // the case the previous destructure-at-require-time code missed.
    dataStore.masternodesArr = [
      makeNode({ payee: 'sys1qsecond' }),
      makeNode({ payee: 'sys1qthird' }),
    ];

    res = await request(buildApp()).post('/mnsearch').send({});
    expect(res.body.mnNumb).toBe(2);
    expect(res.body.returnArr.map(n => n.payee).sort()).toEqual([
      'sys1qsecond',
      'sys1qthird',
    ]);
  });

  test('filters by payee (case-insensitive substring)', async () => {
    dataStore.masternodesArr = [
      makeNode({ address: '10.0.0.1:18370', payee: 'sys1qFooBar' }),
      makeNode({ address: '10.0.0.2:18370', payee: 'sys1qBaz' }),
    ];
    const res = await request(buildApp())
      .post('/mnsearch')
      .send({ search: 'foo' });
    expect(res.body.mnNumb).toBe(1);
    expect(res.body.returnArr[0].payee).toBe('sys1qFooBar');
  });

  test('filters by IP host (port stripped from query)', async () => {
    dataStore.masternodesArr = [
      makeNode({ address: '203.0.113.7:18370', payee: 'sys1qa' }),
      makeNode({ address: '198.51.100.4:18370', payee: 'sys1qb' }),
    ];
    const res = await request(buildApp())
      .post('/mnsearch')
      .send({ search: '203.0.113.7:18370' });
    expect(res.body.mnNumb).toBe(1);
    expect(res.body.returnArr[0].address).toBe('203.0.113.7:18370');
  });

  test('paginates with caller-supplied perPage (clamped to <=90)', async () => {
    dataStore.masternodesArr = Array.from({ length: 50 }, (_, i) =>
      makeNode({ address: `10.0.0.${i}:18370`, payee: `sys1qpayee${i}` })
    );
    const res = await request(buildApp())
      .post('/mnsearch')
      .send({ page: 2, perPage: 10 });
    expect(res.body.mnNumb).toBe(50);
    expect(res.body.returnArr).toHaveLength(10);
  });

  test('survives a non-array masternodesArr without throwing', async () => {
    // Defensive: the tracker briefly leaves the property in a transitional
    // state on init, and an RPC failure path could theoretically wipe it.
    dataStore.masternodesArr = null;
    const res = await request(buildApp()).post('/mnsearch').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ returnArr: [], mnNumb: 0 });
  });
});
