// Real Express/SQLite/axios composition. Only Core is synthetic here; this
// tests delivery certainty, not cryptography or public-network voting.
const http = require('http');
const axios = require('axios');
const request = require('supertest');
const { buildTestApp } = require('./helpers/buildTestApp');
const { createGovernanceRpc } = require('../lib/governanceRpc');
const { createCurrentVotesCache } = require('../lib/voteReceipts');
const H = 'a'.repeat(64),
  P = 'b'.repeat(64),
  V = 'c'.repeat(64);
let server, ctx, cookie, coreVoteCount, mode, chainVote;

beforeEach(async () => {
  coreVoteCount = 0;
  mode = 'drop';
  chainVote = null;
  server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      const body = JSON.parse(text);
      if (body.method === 'voteraw') {
        coreVoteCount++;
        if (mode === 'drop') {
          chainVote = body.params;
          req.socket.destroy();
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: body.id,
            result: null,
            error: { code: -32603, message: 'Masternode voting too often' },
          })
        );
        return;
      }
      const p = chainVote;
      const result = p
        ? { [V]: `${p[0]}-${p[1]}:${p[5]}:${p[4]}:${p[3]}` }
        : {};
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: body.id, error: null, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const rpc = createGovernanceRpc(
    {
      url: `http://127.0.0.1:${server.address().port}`,
      instance: axios.create(),
    },
    { timeoutMs: 100 }
  );
  const cache = createCurrentVotesCache({ callRpc: rpc.getCurrentVotes });
  ctx = buildTestApp({
    masternodesProvider: () => [{ collateralHash: H, collateralIndex: 0 }],
    voteRaw: rpc.voteRaw,
    getCurrentVotes: (hash, options) => cache.get(hash, options),
    invalidateCurrentVotes: (hash) => cache.invalidate(hash),
  });
  const user = ctx.users.create({
    email: 'fixture@example.test',
    authHash: 'd'.repeat(64),
  });
  ctx.users.markEmailVerified(user.id);
  cookie = `sid=${ctx.sessions.issue(user.id).token}; csrf=fixture-csrf`;
});
afterEach(async () => {
  ctx?.db.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
const payload = () => ({
  proposalHash: P,
  voteOutcome: 'no',
  voteSignal: 'funding',
  time: Math.floor(Date.now() / 1000),
  entries: [
    {
      collateralHash: H,
      collateralIndex: 0,
      voteSig: Buffer.alloc(65).toString('base64'),
    },
  ],
});
const post = (path, body) =>
  request(ctx.app)
    .post(path)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', 'fixture-csrf')
    .send(body);

test('accepted-but-dropped HTTP response stays unknown, repeat is held, exact readback confirms', async () => {
  const body = payload();
  const first = await post('/gov/vote', body).expect(200);
  expect(first.body).toMatchObject({
    accepted: 0,
    rejected: 0,
    unknown: 1,
    notSubmitted: 0,
  });
  expect(first.body.results[0]).toMatchObject({
    uncertain: true,
    error: 'submission_unknown',
  });
  const stored = await request(ctx.app)
    .get('/gov/receipts')
    .set('Cookie', cookie)
    .query({ proposalHash: P })
    .expect(200);
  expect(stored.body.receipts[0].status).toBe('submission_unknown');
  await post('/gov/vote', body).expect(200);
  expect(coreVoteCount).toBe(1);
  const read = await post('/gov/receipts/reconcile', {
    proposalHash: P,
    refresh: true,
  }).expect(200);
  expect(read.body.reconciled).toBe(true);
  expect(read.body.receipts[0]).toMatchObject({
    status: 'confirmed',
    voteOutcome: 'no',
    voteTime: body.time,
  });
});
test('definite cold duplicate rejection does not claim requested no succeeded; readback shows actual yes', async () => {
  mode = 'reject';
  const body = payload();
  chainVote = [H, 0, P, 'funding', 'yes', body.time - 60, 'public-signature'];
  const res = await post('/gov/vote', body).expect(200);
  expect(res.body).toMatchObject({ accepted: 0, rejected: 1, unknown: 0 });
  const stored = ctx.voteReceipts.listForProposal(
    ctx.users.findByEmail('fixture@example.test').id,
    P
  )[0];
  expect(stored).toMatchObject({
    status: 'failed',
    voteOutcome: 'no',
    lastError: 'vote_too_often',
  });
  const read = await post('/gov/receipts/reconcile', {
    proposalHash: P,
    refresh: true,
  }).expect(200);
  expect(read.body.receipts[0]).toMatchObject({
    status: 'confirmed',
    voteOutcome: 'yes',
    voteTime: body.time - 60,
  });
});
