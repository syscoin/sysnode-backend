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
test('deadline after the real server receives a vote is unknown and never automatically retried', async () => {
  let count = 0;
  let received;
  const server = http.createServer((req) => {
    count++;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => received(JSON.parse(Buffer.concat(chunks).toString())));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const actualSetTimeout = global.setTimeout;
  const transport = axios.create();
  // Keep the real HTTP connection, while controlling which deadline fires.
  // Axios's own timeout is disabled here so the server receipt is observed
  // before the RPC's 30 ms deadline callback is invoked deterministically.
  const instance = {
    post: jest.fn((url, body, options) => {
      expect(options.timeout).toBe(30);
      return transport.post(url, body, { ...options, timeout: 0 });
    }),
  };
  const rpc = createGovernanceRpc(
    { url: `http://127.0.0.1:${server.address().port}`, instance },
    { timeoutMs: 30 }
  );
  try {
    async function afterReceipt(call, expectedMethod, expectedParams) {
      const requestReceived = new Promise((resolve) => { received = resolve; });
      let expire;
      const spy = jest.spyOn(global, 'setTimeout').mockImplementationOnce((fn, ms) => {
        expect(ms).toBe(30);
        expire = fn;
        // Return a real, cleared timer handle for the RPC's normal cleanup.
        return actualSetTimeout(() => {}, ms);
      });
      let result;
      try {
        result = call();
      } finally {
        spy.mockRestore();
      }
      const body = await requestReceived;
      expect(body).toMatchObject({ method: expectedMethod, params: expectedParams });
      expire();
      return result;
    }
    await expect(afterReceipt(() => rpc.voteRaw(...args), 'voteraw', args)).rejects.toMatchObject({
      code: 'submission_unknown',
      uncertain: true,
    });
    expect(count).toBe(1);
    expect(instance.post).toHaveBeenCalledTimes(1);
    await expect(afterReceipt(() => rpc.getCurrentVotes(args[2]), 'gobject_getcurrentvotes', [args[2]])).rejects.toMatchObject({
      code: 'governance_rpc_unavailable',
    });
    expect(count).toBe(2);
    expect(instance.post).toHaveBeenCalledTimes(2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('real HTTP timeout is uncertain even when delivery cannot be established', async () => {
  let count = 0;
  const server = http.createServer((req) => {
    count++;
    req.resume();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const instance = axios.create();
  const post = jest.spyOn(instance, 'post');
  const rpc = createGovernanceRpc(
    { url: `http://127.0.0.1:${server.address().port}`, instance },
    { timeoutMs: 30 }
  );
  try {
    await expect(rpc.voteRaw(...args)).rejects.toMatchObject({
      code: 'submission_unknown', uncertain: true,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(count).toBeLessThanOrEqual(1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
