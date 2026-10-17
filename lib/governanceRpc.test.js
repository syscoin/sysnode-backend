const http = require('http');
const axios = require('axios');
const { createGovernanceRpc } = require('./governanceRpc');
const args = [
  'a'.repeat(64),
  0,
  'b'.repeat(64),
  'funding',
  'yes',
  1800000000,
  Buffer.alloc(65).toString('base64'),
];

function fake(response) {
  const post = jest.fn(async (_url, body) => response(body));
  return {
    post,
    rpc: createGovernanceRpc(
      { url: 'http://fixture.test', instance: { post } },
      { timeoutMs: 100 }
    ),
  };
}
test('preserves exact vote fields and validates a real Core success envelope', async () => {
  const { rpc, post } = fake((body) => ({
    data: { id: body.id, error: null, result: 'Voted successfully' },
  }));
  expect(await rpc.voteRaw(...args)).toBe('Voted successfully');
  expect(post.mock.calls[0][1]).toMatchObject({
    method: 'voteraw',
    params: args,
  });
  expect(post.mock.calls[0][2]).toMatchObject({
    timeout: 100,
    maxRedirects: 0,
    maxContentLength: 16777216,
  });
});
test('HTTP500 with a valid Core rejection is definite, not transport uncertainty', async () => {
  const { rpc } = fake((body) => {
    throw {
      response: {
        data: {
          id: body.id,
          error: { code: -32603, message: 'Failure to verify vote.' },
          result: null,
        },
      },
    };
  });
  await expect(rpc.voteRaw(...args)).rejects.toMatchObject({
    definiteCoreRejection: true,
    message: 'Failure to verify vote.',
  });
});
test.each(['wrong-id', 'wrong-result', 'missing-error'])(
  'malformed vote response is unknown, never accepted: %s',
  async (kind) => {
    const { rpc } = fake((body) => ({
      data:
        kind === 'wrong-id'
          ? { id: 'wrong', error: null, result: 'Voted successfully' }
          : kind === 'wrong-result'
          ? { id: body.id, error: null, result: true }
          : { id: body.id, result: 'Voted successfully' },
    }));
    await expect(rpc.voteRaw(...args)).rejects.toMatchObject({
      code: 'submission_unknown',
      uncertain: true,
    });
  }
);
test('already aborted batch performs no HTTP request', async () => {
  const { rpc, post } = fake(() => {});
  const c = new AbortController();
  c.abort();
  await expect(
    rpc.voteRaw(...args, { signal: c.signal })
  ).rejects.toMatchObject({ notSubmitted: true });
  expect(post).not.toHaveBeenCalled();
});
test('malformed current-vote data is not certified as an empty tally', async () => {
  const { rpc } = fake((body) => ({
    data: { id: body.id, error: null, result: { ['c'.repeat(64)]: 'invalid' } },
  }));
  await expect(rpc.getCurrentVotes(args[2])).rejects.toMatchObject({
    code: 'governance_rpc_unavailable',
  });
});
test('actual HTTP timeout after receiving vote is unknown and never automatically retried', async () => {
  let count = 0;
  const server = http.createServer((req) => {
    count++;
    req.resume();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const rpc = createGovernanceRpc(
    {
      url: `http://127.0.0.1:${server.address().port}`,
      instance: axios.create(),
    },
    { timeoutMs: 30 }
  );
  try {
    await expect(rpc.voteRaw(...args)).rejects.toMatchObject({
      uncertain: true,
    });
    expect(count).toBe(1);
    await expect(rpc.getCurrentVotes(args[2])).rejects.toMatchObject({
      code: 'governance_rpc_unavailable',
    });
    expect(count).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
