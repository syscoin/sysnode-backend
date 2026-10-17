#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const TARGETS = Object.freeze({
  frontend: { repository: 'syscoin/sysnode-info', ref: 'refs/heads/master' },
  backend: { repository: 'syscoin/sysnode-backend', ref: 'refs/heads/main' },
});
const matches = (value, expression) => typeof value === 'string' && expression.exec(value)?.[0] === value;
function privateKeyText(value) {
  if (typeof value !== 'string') throw new Error('Missing deployment credentials');
  const normalized = value.replace(/\r\n/g, '\n').trimEnd() + '\n';
  if (!normalized.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n') ||
      !normalized.endsWith('-----END OPENSSH PRIVATE KEY-----\n')) throw new Error('Invalid deployment key format');
  return normalized;
}
function inputs(app, env) {
  const target = TARGETS[app];
  if (!target || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REPOSITORY !== target.repository ||
      env.GITHUB_REF !== target.ref || env.GITHUB_SERVER_URL !== 'https://github.com') throw new Error('Untrusted deployment event');
  if (!matches(env.GITHUB_SHA, /^[0-9a-f]{40}$/) || !matches(env.GITHUB_RUN_ID, /^[1-9][0-9]{0,17}$/) ||
      !matches(env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]{0,5}$/)) throw new Error('Invalid deployment identity');
  if (!matches(env.SYSNODE_DEPLOY_HOST, /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/) ||
      !matches(env.SYSNODE_DEPLOY_USER, /^[a-z_][a-z0-9_-]{0,31}$/)) throw new Error('Invalid deployment destination');
  privateKeyText(env.SYSNODE_DEPLOY_KEY);
  if (!(env.SYSNODE_KNOWN_HOSTS || '').trim() || env.SYSNODE_KNOWN_HOSTS.length > 16384) throw new Error('Missing deployment credentials');
  return { host: env.SYSNODE_DEPLOY_HOST, user: env.SYSNODE_DEPLOY_USER,
    command: 'deploy ' + env.GITHUB_SHA + ' ' + env.GITHUB_RUN_ID + ' ' + env.GITHUB_RUN_ATTEMPT };
}
function main(app, env = process.env) {
  const request = inputs(app, env);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-deploy-key-'));
  fs.chmodSync(temporary, 0o700);
  try {
    const key = path.join(temporary, 'key'), known = path.join(temporary, 'known_hosts');
    fs.writeFileSync(key, privateKeyText(env.SYSNODE_DEPLOY_KEY), { mode: 0o600 });
    fs.writeFileSync(known, env.SYSNODE_KNOWN_HOSTS.trim() + '\n', { mode: 0o600 });
    const result = cp.spawnSync('ssh', ['-F', '/dev/null', '-T', '-i', key,
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
      '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'VerifyHostKeyDNS=no', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UserKnownHostsFile=' + known,
      '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      request.user + '@' + request.host, request.command], { stdio: 'inherit', timeout: 55 * 60 * 1000 });
    if (result.error || result.status !== 0) throw new Error('Deployment failed; inspect the protected host job status before retrying');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (require.main === module) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { inputs, TARGETS, privateKeyText };

