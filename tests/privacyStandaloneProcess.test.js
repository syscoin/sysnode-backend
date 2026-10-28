'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

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
