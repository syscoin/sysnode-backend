'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { ABI } = require('../lib/privacyRpc');
const { POOLS } = require('../lib/privacyRegistry');

const source = path.resolve(__dirname, '../privacy-server.js');
const fence = path.resolve(__dirname, 'helpers/privacyStandaloneFence.cjs');
async function withTimeout(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

test('standalone process uses no Syscoin workers, activates locally, and waits for in-flight work on shutdown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-standalone-test-'));
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  let gotCall;
  const called = new Promise((resolve) => { gotCall = resolve; });
  let release;
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      release = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: '0xaa36a7' })); };
      gotCall();
    });
  });
  await new Promise((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PRIVACY_')) delete env[key];
  Object.assign(env, { PRIVACY_PORT: String(port), PRIVACY_INDEX_ENABLED: 'false',
    PRIVACY_INDEX_RPC_URL: `http://localhost:${rpc.address().port}`,
    PRIVACY_RELAYER_DIRECTORY_ENABLED: 'true', NODE_OPTIONS: `--require=${fence}` });
  const child = spawn(process.execPath, [source], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (v) => { stdout += v; });
  child.stderr.on('data', (v) => { stderr += v; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    for (let i = 0; i < 100 && !stdout.includes('listening'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stdout).toContain('Local privacy API listening');
    expect(fs.existsSync(path.join(dir, 'data/sysnode.db'))).toBe(false);
    const get = (pathname) => new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}${pathname}`, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
    });
    expect(await get('/health')).toBe(200);
    expect(await get('/api/privacy/v1/relayers')).toBe(202);
    await withTimeout(called, 3000, 'RPC was not activated');
    child.kill('SIGTERM');
    // An already-started RPC is allowed to finish before the process exits.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();
    release(); release = null;
    const result = await withTimeout(exited, 5000, 'shutdown stalled');
    expect(result).toEqual({ code: 0, signal: null });
    expect(stderr).toBe('');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (release) release();
    await new Promise((resolve) => rpc.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('standalone pool snapshot persists and resumes after restart without starting Syscoin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-pool-restart-'));
  const reserve = net.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  let calls = 0;
  const block = (number) => ({ number: `0x${number.toString(16)}`,
    hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`,
    timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` });
  const target = POOLS[0].deploymentBlock + 1;
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (v) => { body += v; });
    req.on('end', () => {
      calls++;
      const { id, method, params } = JSON.parse(body);
      let result;
      if (method === 'eth_chainId') result = '0x1';
      else if (method === 'eth_getBlockByNumber') result = block(params[0] === 'finalized' ? target : Number(BigInt(params[0])));
      else if (method === 'eth_getCode') result = '0x01';
      else if (method === 'eth_getLogs') result = [];
      else if (method === 'eth_call') {
        const { name } = ABI.parseTransaction(params[0]);
        const values = { levels: 20n, denomination: BigInt(POOLS[0].denomination), nextIndex: 0n, getLastRoot: `0x${'00'.repeat(32)}` };
        result = ABI.encodeFunctionResult(name, [values[name]]);
      } else { res.writeHead(500).end(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PRIVACY_')) delete env[key];
  Object.assign(env, { PRIVACY_PORT: String(port), PRIVACY_INDEX_RPC_URL: `http://127.0.0.1:${rpc.address().port}`,
    PRIVACY_RELAYER_DIRECTORY_ENABLED: 'false', NODE_OPTIONS: `--require=${fence}` });
  let child;
  const launch = async () => {
    child = spawn(process.execPath, [source], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (v) => { output += v; });
    for (let i = 0; i < 100 && !output.includes('listening'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(output).toContain('Local privacy API listening');
  };
  const stop = async () => { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await withTimeout(exited, 5000, 'shutdown stalled'); };
  const read = () => new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/api/privacy/v1/pools/eth-0.1/snapshot`, (res) => {
    let body = ''; res.on('data', (v) => { body += v; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  }).on('error', reject));
  try {
    await launch();
    expect((await read()).status).toBe(202);
    let snapshot;
    for (let i = 0; i < 100; i++) { snapshot = await read(); if (snapshot.status === 200) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toEqual(expect.objectContaining({ asOfBlockNumber: target, leafCount: 0, withdrawnNullifiers: [] }));
    expect(fs.existsSync(path.join(dir, 'data/privacy-index/eth-0.1.snapshot.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'data/sysnode.db'))).toBe(false);
    await stop();
    const priorCalls = calls;
    await launch();
    for (let i = 0; i < 100 && calls === priorCalls; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBeGreaterThan(priorCalls); // Existing active pool revalidates without another request.
    for (let i = 0; i < 100; i++) { snapshot = await read(); if (snapshot.status === 200) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.asOfBlockNumber).toBe(target);
    await stop();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await new Promise((resolve) => rpc.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
