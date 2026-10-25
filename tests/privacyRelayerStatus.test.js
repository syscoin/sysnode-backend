'use strict';

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { POOLS } = require('../lib/privacyRegistry');
const { createPrivacyRelayerStatus, publicAddress, endpoint, parseStatus, MAX_STATUS_BYTES, STATUS_TIMEOUT_MS } = require('../lib/privacyRelayerStatus');
function status(overrides = {}) {
  return { netId: 1, rewardAccount: '0x1111111111111111111111111111111111111111',
    instances: { eth: { decimals: 18, instanceAddress: Object.fromEntries(POOLS.map((p) => [p.id.slice(4), p.address])) } },
    tornadoServiceFee: 0.3, health: { status: 'true', errorsLog: 'never forward this' }, currentQueue: 2, version: '5.0.1', ...overrides };
}
function transport({ body = JSON.stringify(status()), statusCode = 200, headers = {}, chunks } = {}) {
  const request = jest.fn((options, callback) => {
    const req = new EventEmitter(); req.destroy = jest.fn();
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough(); res.statusCode = statusCode;
      res.headers = { 'content-type': 'application/json', ...headers };
      callback(res);
      if (!res.destroyed) { for (const chunk of chunks || [body]) res.write(chunk); res.end(); }
    });
    return req;
  });
  return request;
}
const publicDns = async () => [{ address: '8.8.8.8', family: 4 }];

describe('public relayer status transport', () => {
  test.each(['http://public.example', 'https://127.1', 'https://2130706433', 'https://[::1]',
    'https://169.254.169.254', 'https://user:pass@public.example', 'https://public.example:8443',
    'https://public.example/path', 'https://public.example?recipient=x', 'https://public.example#x',
    'https://localhost', 'https://public.example.', 'https://public.example\\@private.example'])('rejects non-fixed endpoint %s', (url) => {
    expect(() => endpoint(url)).toThrow();
  });
  test.each(['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.1.2',
    '192.168.1.1', '192.0.0.2', '198.18.0.1', '203.0.113.2', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '2001:db8::1', '2002:0808:0808::1'])('blocks non-public address %s', (ip) => {
    expect(publicAddress(ip)).toBe(false);
  });
  test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('allows public address %s', (ip) => expect(publicAddress(ip)).toBe(true));
  test('pins checked DNS to TLS host and projects only advertised fields', async () => {
    const answers = [{ address: '8.8.8.8', family: 4 }];
    const request = transport();
    const result = await createPrivacyRelayerStatus({ lookup: async () => answers, request, now: () => 123 })('https://public.example/');
    const options = request.mock.calls[0][0];
    expect(options).toMatchObject({ hostname: 'public.example', servername: 'public.example', path: '/status', port: 443, rejectUnauthorized: true, agent: false });
    answers[0].address = '127.0.0.1';
    const cb = jest.fn(); options.lookup('public.example', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(result).toEqual({ origin: 'https://public.example', rewardAccount: status().rewardAccount,
      supportedPools: POOLS.map((p) => p.id), serviceFeePercent: '0.3', reportedHealthy: true, queueLength: 2, version: '5.0.1', observedAt: 123 });
    expect(JSON.stringify(result)).not.toContain('errorsLog');
  });
  test('rejects mixed private DNS and never sends the request', async () => {
    const request = transport();
    const inspect = createPrivacyRelayerStatus({ lookup: async () => [...await publicDns(), { address: '127.0.0.1', family: 4 }], request });
    await expect(inspect('https://public.example')).rejects.toThrow('dns_rejected'); expect(request).not.toHaveBeenCalled();
  });
  test('close/deadline guard runs again after DNS and before HTTPS', async () => {
    const request = transport(); let stopped = false;
    const inspect = createPrivacyRelayerStatus({ lookup: async () => { stopped = true; return publicDns(); }, request });
    await expect(inspect('https://public.example', { beforeRequest: () => { if (stopped) throw new Error('closed'); } })).rejects.toThrow('closed');
    expect(request).not.toHaveBeenCalled();
  });
  test.each([{ statusCode: 302 }, { headers: { 'content-encoding': 'gzip' } },
    { headers: { 'content-type': 'text/html' } }, { headers: { 'content-length': String(MAX_STATUS_BYTES + 1) } }])('rejects redirects and unsupported response envelope %p', async (opts) => {
    await expect(createPrivacyRelayerStatus({ lookup: publicDns, request: transport(opts) })('https://public.example')).rejects.toThrow('status_rejected');
  });
  test('limits streamed body even without content-length', async () => {
    await expect(createPrivacyRelayerStatus({ lookup: publicDns, request: transport({ chunks: ['x'.repeat(MAX_STATUS_BYTES), 'x'] }) })('https://public.example')).rejects.toThrow('too_large');
  });
  test('total deadline covers unresolved DNS and prevents late network access', async () => {
    jest.useFakeTimers();
    try {
      let complete; const lookup = () => new Promise((resolve) => { complete = resolve; }); const request = transport();
      const result = createPrivacyRelayerStatus({ lookup, request })('https://public.example');
      const assertion = expect(result).rejects.toThrow('timeout');
      await jest.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS); await assertion;
      complete(await publicDns()); await Promise.resolve(); expect(request).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });
  test.each([{ netId: 5 }, { tornadoServiceFee: -1 }, { tornadoServiceFee: 101 }, { tornadoServiceFee: 'NaN' }, { tornadoServiceFee: '100.000000000000000001' },
    { health: { status: 'probably' } }, { rewardAccount: 'invalid' }, { currentQueue: -1 }, { version: '<script>' }])('rejects malformed advertised state %p', (override) => {
    expect(() => parseStatus(status(override))).toThrow();
  });
  test('refuses substituted pool addresses and never forwards unsupported pools', () => {
    const raw = status(); raw.instances.eth.instanceAddress['0.1'] = '0x2222222222222222222222222222222222222222';
    expect(() => parseStatus(raw)).toThrow();
    const valid = status(); valid.instances.eth.instanceAddress['1000'] = '0x2222222222222222222222222222222222222222';
    expect(parseStatus(valid).supportedPools).toEqual(POOLS.map((p) => p.id));
  });
});
