#!/usr/bin/env node
'use strict';

// Install this reviewed file outside both application checkouts. SSH keys call
// only `request <fixed-app> <fixed-config>`; the candidate cannot replace it.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseEnv, isDeepStrictEqual } = require('node:util');

const APPS = Object.freeze({
  frontend: { repo: 'syscoin/sysnode-info', branch: 'master', directory: 'sysnode-info', jobs: ['Jest + build (Node 20)', 'Jest + build (Node 22)'] },
  backend: { repo: 'syscoin/sysnode-backend', branch: 'main', directory: 'sysnode-backend', jobs: ['Jest (Node 20)', 'Jest (Node 22)', 'Production dependency audit', 'Schema sanity'] },
});
const sha256 = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function parseCommand(command) {
  if (command === 'status') return { status: true };
  const match = /^deploy ([0-9a-f]{40}) ([1-9][0-9]{0,17}) ([1-9][0-9]{0,5})$/.exec(command || '');
  if (!match || match[0] !== command) fail('invalid_deploy_command');
  return { sha: match[1], runId: match[2], attempt: match[3] };
}
function validateRun(app, request, run, jobs) {
  if (!APPS[app] || run.event !== 'push' || run.head_branch !== APPS[app].branch || run.head_sha !== request.sha ||
      run.head_repository?.full_name !== APPS[app].repo || run.repository?.full_name !== APPS[app].repo || String(run.id) !== request.runId || String(run.run_attempt) !== request.attempt ||
      run.path !== '.github/workflows/ci.yml' || !['in_progress', 'completed'].includes(run.status) ||
      (run.status === 'completed' && run.conclusion !== 'success')) fail('untrusted_ci_run');
  if (!Array.isArray(jobs) || jobs.length > 100) fail('invalid_ci_jobs');
  const checks = jobs.filter(job => job.name !== 'Deploy production');
  if (APPS[app].jobs.some(name => !checks.some(job => job.name === name))) fail('missing_required_ci_job');
  if (checks.some(job => job.status !== 'completed' || job.conclusion !== 'success')) fail('ci_not_successful');
}
function failedIfUnfinished(job, code) {
  const file = path.join(job, 'status.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!['success', 'failed'].includes(current.state)) writeJson(file, { state: 'failed', phase: 'deployment stopped before completion', code });
}
async function supervise(config, app, configFile, request, job) {
  const args = ['--exclusive', '--wait', '1800', path.join(config.stateRoot, 'deployment.lock'), process.execPath, __filename, 'worker', app, configFile, request.sha, request.runId, request.attempt, job];
  const result = await new Promise(resolve => {
    const child = cp.spawn(config.flock, args, { stdio: 'inherit' });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
  if (!result) failedIfUnfinished(job, 'deployment_worker_failed_to_start_or_complete');
}
function safeDirectory(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || !fs.statSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('unsafe_directory');
}
function configAt(file) {
  if (!path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink() || (fs.statSync(file).mode & 0o022)) fail('unsafe_config');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const name of ['appsRoot', 'stateRoot']) safeDirectory(config[name]);
  if (fs.statSync(config.stateRoot).mode & 0o077) fail('state_directory_not_private');
  if (!path.isAbsolute(config.pm2) || !path.isAbsolute(config.flock)) fail('invalid_tools');
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) fail('invalid_public_origin');
  if (!/^[0-9a-f]{64}$/.test(config.genesisHash) || !['mainnet', 'testnet'].includes(config.network) || !['legacy-v3', 'pq-v4'].includes(config.era)) fail('invalid_chain_config');
  if (!Number.isSafeInteger(config.backendPort) || config.backendPort < 1 || config.backendPort > 65535) fail('invalid_backend_port');
  return config;
}
async function jsonGet(url, limit = 512 * 1024) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
  if (response.status !== 200) fail('verification_http_status');
  if (!response.headers.get('content-type')?.includes('application/json')) fail('verification_not_json');
  const bytes = await readBounded(response, limit);
  return JSON.parse(bytes.toString('utf8'));
}
async function readBounded(response, limit) {
  const chunks = []; let total = 0;
  for await (const chunk of response.body) { total += chunk.length; if (total > limit) fail('verification_response_too_large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function verifyCi(app, request) {
  const base = `https://api.github.com/repos/${APPS[app].repo}/actions/runs/${request.runId}`;
  const run = await jsonGet(base);
  const data = await jsonGet(`${base}/attempts/${request.attempt}/jobs?per_page=100`);
  if (data.total_count > 100) fail('too_many_ci_jobs');
  validateRun(app, request, run, data.jobs);
}
function command(file, args, options = {}) {
  const result = cp.spawnSync(file, args, { stdio: 'inherit', timeout: 15 * 60 * 1000, ...options });
  if (result.error || result.status !== 0) fail('deployment_command_failed');
  return result.stdout;
}
function output(file, args, options = {}) {
  return command(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024, ...options }).trim();
}
function git(root, ...args) { return output('git', ['-C', root, ...args]); }
function writeJson(file, value) {
  const temporary = `${file}.new`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function retainSuccessful(config, app, currentJob) {
  const jobs = path.join(config.stateRoot, 'jobs');
  const protectedJobs = new Set([currentJob]);
  for (const name of Object.keys(APPS)) {
    const file = path.join(config.stateRoot, `active-${name}.json`);
    if (fs.existsSync(file)) protectedJobs.add(JSON.parse(fs.readFileSync(file, 'utf8')).job);
  }
  const completed = [];
  for (const name of fs.readdirSync(jobs)) {
    if (!new RegExp(`^${app}-[0-9a-f]{40}-[1-9][0-9]{0,17}-[1-9][0-9]{0,5}$`).test(name)) continue;
    const job = path.join(jobs, name);
    if (fs.lstatSync(job).isSymbolicLink() || !fs.statSync(job).isDirectory()) continue;
    const file = path.join(job, 'status.json');
    if (!fs.existsSync(file)) continue;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.state !== 'success') continue;
    completed.push({ job, modified: fs.statSync(file).mtimeMs });
  }
  completed.sort((a, b) => b.modified - a.modified);
  for (const { job } of completed.slice(3)) {
    if (!protectedJobs.has(job)) fs.rmSync(job, { recursive: true });
  }
  // Rebuildable npm cache/archive are not rollback artifacts.
  for (const member of ['npm-cache', 'source.tar']) {
    const file = path.join(currentJob, member);
    if (fs.existsSync(file)) fs.rmSync(file, { recursive: true });
  }
}
function stageEnvironment(job) {
  return { PATH: '/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin', HOME: os.homedir(), LANG: 'C.UTF-8', CI: 'true', NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_CACHE: path.join(job, 'npm-cache') };
}
function databasePath(config, apps) {
  const root = path.join(config.appsRoot, APPS.backend.directory);
  const file = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
  const inherited = apps.find(app => app.name === APPS.backend.directory).pm2_env;
  const effective = key => Object.hasOwn(inherited, key) ? inherited[key] : file[key];
  const result = path.resolve(root, effective('SYSNODE_DB_PATH') || './data/sysnode.db');
  if (result !== path.join(root, 'data/sysnode.db') || effective('SYSCOIN_NETWORK') !== config.network || effective('SYSCOIN_SENTRY_GENESIS_HASH') !== config.genesisHash) fail('unexpected_live_database_or_chain');
  return result;
}
function capture(config) {
  const apps = JSON.parse(output(config.pm2, ['jlist']));
  const state = { apps: {} };
  for (const name of Object.keys(APPS)) {
    const root = path.join(config.appsRoot, APPS[name].directory);
    safeDirectory(root);
    if (git(root, 'status', '--porcelain', '--untracked-files=no')) fail('tracked_worktree_changes');
    const matches = apps.filter(app => app.name === APPS[name].directory);
    if (matches.length !== 1) fail('unexpected_pm2_app_count');
    const app = matches[0], env = app.pm2_env;
    const args = ['-c', name === 'backend' ? 'node --env-file=.env server.js' : 'node server.js'];
    if (env.status !== 'online' || !Number.isSafeInteger(app.pid) || app.pid <= 0 || env.pm_cwd !== root || env.pm_exec_path !== '/usr/bin/bash' || !isDeepStrictEqual(env.args, args)) fail('unexpected_pm2_launch');
    state.apps[name] = { head: git(root, 'rev-parse', 'HEAD'), pid: app.pid, envHash: sha256(fs.readFileSync(path.join(root, '.env'))), launch: sha256(JSON.stringify(canonical([env.pm_cwd, env.pm_exec_path, env.args, env.env]))) };
  }
  const database = databasePath(config, apps), stat = fs.statSync(database);
  if (fs.lstatSync(database).isSymbolicLink()) fail('unsafe_database');
  state.database = { path: database, dev: stat.dev, ino: stat.ino };
  return state;
}
function compareState(before, after, app, expected) {
  const other = app === 'frontend' ? 'backend' : 'frontend';
  if (!isDeepStrictEqual(before.apps[other], after.apps[other]) || !isDeepStrictEqual(before.database, after.database)) fail('unrelated_application_or_database_changed');
  if (after.apps[app].head !== expected || after.apps[app].envHash !== before.apps[app].envHash || after.apps[app].launch !== before.apps[app].launch) fail('application_configuration_changed');
  if (expected !== before.apps[app].head && after.apps[app].pid === before.apps[app].pid) fail('application_process_was_not_replaced');
}
function schema(db) {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const migrations = rows.some(row => row.name === 'schema_migrations') ? db.prepare('SELECT * FROM schema_migrations ORDER BY filename').all() : [];
  return sha256(JSON.stringify(canonical({ rows, migrations, userVersion: db.pragma('user_version', { simple: true }) })));
}
function checkDatabase(config, file, snapshot) {
  // Preserve the already-loaded native constructor across node_modules swaps.
  const Database = config.Database || (config.Database = require(path.join(config.appsRoot, APPS.backend.directory, 'node_modules/better-sqlite3')));
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) fail('database_integrity_failed');
    const digest = schema(db);
    return snapshot ? db.backup(snapshot).then(() => digest).finally(() => db.close()) : digest;
  } finally { if (!snapshot) db.close(); }
}
function sourceSchemaFence(root, previous, candidate) {
  return git(root, 'diff', '--name-only', previous, candidate, '--', 'db/migrations', 'lib/db.js').length === 0;
}
async function rehearseSchema(config, stage, job, source, oldSchema) {
  const copy = path.join(job, 'schema-rehearsal.sqlite');
  fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
  const script = `const root=process.argv[1],file=process.argv[2]; const db=require(root+'/lib/db').openDatabase(file); try {require(root+'/lib/appFactory').buildServices({db,secureCookies:true});}finally{db.close();}`;
  command(process.execPath, ['-e', script, stage, copy], { env: { ...stageEnvironment(job), NODE_ENV: 'test' }, timeout: 60000 });
  if (await checkDatabase(config, copy) !== oldSchema) fail('schema_change_requires_manual_rollout');
}
async function publicHealth(config, app, stage) {
  const health = await jsonGet(`${config.origin}/api/health`, 128 * 1024);
  if (health?.ok !== true) fail('health_failed');
  const localHealth = await jsonGet(`http://127.0.0.1:${config.backendPort}/health`, 128 * 1024);
  if (localHealth?.ok !== true) fail('local_health_failed');
  if (app === 'backend') {
    const caps = await jsonGet(`${config.origin}/api/sentry/v1/capabilities?network=${config.network}`, 128 * 1024);
    validateCapabilities(caps, config);
  } else {
    const index = fs.readFileSync(path.join(stage, 'build/index.html'), 'utf8');
    const asset = /src="([^"]*\/static\/js\/main\.[a-f0-9]+\.js)"/.exec(index)?.[1];
    if (!asset || !asset.startsWith('/static/js/')) fail('missing_main_asset');
    for (const route of ['/nodes', '/governance']) {
      const response = await fetch(config.origin + route, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) fail('frontend_unhealthy');
      if (!response.headers.get('content-security-policy')?.split(';').some(value => value.trim() === "connect-src 'self'")) fail('frontend_csp_changed');
      if (!(await readBounded(response, 1024 * 1024)).toString().includes(asset)) fail('stale_frontend');
    }
    const response = await fetch(config.origin + asset, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (response.status !== 200 || sha256(await readBounded(response, 8 * 1024 * 1024)) !== sha256(fs.readFileSync(path.join(stage, 'build', asset.slice(1))))) fail('public_asset_mismatch');
  }
}
function validateCapabilities(caps, config) {
  const operations = ['register', 'updateService', 'updateRegistrar', 'revoke'];
  if (config.era === 'pq-v4') operations.push('registerOperator', 'rotateOperator');
  if (caps?.version !== 1 || caps.network !== config.network || caps.chain?.genesisHash !== config.genesisHash || caps.chain?.era !== config.era ||
      !Array.isArray(caps.operations) || caps.operations.length !== operations.length || new Set(caps.operations).size !== operations.length ||
      operations.some(operation => !caps.operations.includes(operation)) || typeof caps.preparationActive !== 'boolean' ||
      (config.era === 'legacy-v3' && caps.preparationActive !== false)) fail('public_capabilities_mismatch');
}
async function retryHealth(config, app, root) {
  for (let attempt = 0; attempt < 6; attempt++) { try { await publicHealth(config, app, root); return; } catch (error) { if (attempt === 5) throw error; await new Promise(resolve => setTimeout(resolve, 3000)); } }
}
function verifySource(config, app, request) {
  const target = APPS[app], root = path.join(config.appsRoot, target.directory);
  if (git(root, 'remote', 'get-url', 'origin') !== `https://github.com/${target.repo}.git`) fail('unexpected_git_remote');
  command('git', ['-C', root, 'fetch', 'origin', target.branch]);
  if (git(root, 'rev-parse', `origin/${target.branch}`) !== request.sha) fail('superseded_default_branch_sha');
  command('git', ['-C', root, 'merge-base', '--is-ancestor', 'HEAD', request.sha]);
  return root;
}
async function deploy(config, app, request, job, io = {}) {
  const op = { verifyCi, verifySource, capture, checkDatabase, rehearseSchema, retryHealth, publicHealth, sourceSchemaFence, command, git, ...io };
  const status = (phase, state = 'running', code) => writeJson(path.join(job, 'status.json'), { state, phase, code });
  status('verifying CI');
  await op.verifyCi(app, request);
  const root = op.verifySource(config, app, request), before = op.capture(config), previous = before.apps[app].head;
  const oldSchema = await op.checkDatabase(config, before.database.path);
  writeJson(path.join(job, 'before.json'), before);
  if (previous === request.sha) { await op.publicHealth(config, app, root); status('already deployed and healthy', 'success'); return; }
  if (app === 'backend' && !op.sourceSchemaFence(root, previous, request.sha)) fail('schema_source_requires_manual_rollout');
  const disk = fs.statfsSync(config.stateRoot);
  if (Number(disk.bavail) * Number(disk.bsize) < (config.minFreeBytes || 4 * 1024 ** 3)) fail('retention_cleanup_required_low_disk');
  const stage = path.join(job, 'stage'); fs.mkdirSync(stage, { mode: 0o700 });
  status('staging exact commit');
  const archive = path.join(job, 'source.tar');
  op.command('git', ['-C', root, 'archive', '--output', archive, request.sha]);
  op.command('tar', ['-xf', archive, '-C', stage]);
  const candidateEnv = path.join(stage, '.env');
  if (fs.existsSync(candidateEnv) && sha256(fs.readFileSync(candidateEnv)) !== before.apps[app].envHash) fail('candidate_would_replace_environment');
  const env = stageEnvironment(job);
  op.command('npm', ['ci', '--include=dev'], { cwd: stage, env });
  status('testing staged commit');
  if (app === 'backend') {
    op.command('npm', ['test', '--', '--runInBand', '--ci'], { cwd: stage, env: { ...env, NODE_ENV: 'test' } });
    op.command('npm', ['run', 'test:sentry-codec'], { cwd: stage, env: { ...env, NODE_ENV: 'test' } });
    op.command('npm', ['run', 'audit:prod'], { cwd: stage, env });
    const snapshot = path.join(job, 'prestage.sqlite'); await op.checkDatabase(config, before.database.path, snapshot);
    await op.rehearseSchema(config, stage, job, snapshot, oldSchema);
  } else {
    op.command('npm', ['run', 'test:ci'], { cwd: stage, env });
    op.command('npm', ['run', 'test:production-runtime'], { cwd: stage, env });
    op.command('npm', ['audit', '--omit=dev', '--audit-level=high'], { cwd: stage, env });
    op.command('npm', ['run', 'build'], { cwd: stage, env: { ...env, NODE_ENV: 'production', REACT_APP_NETWORK: config.network } });
  }
  status('final preflight');
  await op.verifyCi(app, request); op.verifySource(config, app, request);
  compareState(before, op.capture(config), app, previous);
  if (await op.checkDatabase(config, before.database.path) !== oldSchema) fail('live_schema_changed');
  const backup = path.join(job, 'backup'); fs.mkdirSync(backup, { mode: 0o700 });
  fs.copyFileSync(path.join(root, '.env'), path.join(backup, 'environment'), fs.constants.COPYFILE_EXCL);
  writeJson(path.join(backup, 'manifest.json'), { app, previous, candidate: request.sha, runId: request.runId, attempt: request.attempt, oldSchema });
  let stopped = false;
  try {
    status('cutover');
    stopped = true;
    op.command(config.pm2, ['stop', APPS[app].directory]);
    if (app === 'backend') await op.checkDatabase(config, before.database.path, path.join(backup, 'precutover.sqlite'));
    op.command('git', ['-C', root, 'merge', '--ff-only', request.sha]);
    for (const member of app === 'frontend' ? ['node_modules', 'build'] : ['node_modules']) {
      safeDirectory(path.join(root, member)); safeDirectory(path.join(stage, member));
      fs.renameSync(path.join(root, member), path.join(backup, member));
      fs.renameSync(path.join(stage, member), path.join(root, member));
    }
    op.command(config.pm2, ['restart', APPS[app].directory]);
    await op.retryHealth(config, app, root);
    if (await op.checkDatabase(config, before.database.path) !== oldSchema) fail('unexpected_schema_after_startup');
    compareState(before, op.capture(config), app, request.sha);
    status('deployed and verified', 'success');
  } catch (error) {
    if (!stopped) throw error;
    // Never restore a database snapshot: it can overwrite writes after cutover.
    op.command(config.pm2, ['stop', APPS[app].directory]);
    let currentSchema;
    try { currentSchema = await op.checkDatabase(config, before.database.path); }
    catch { fail('manual_recovery_database_unreadable'); }
    if (currentSchema !== oldSchema) fail('manual_recovery_schema_changed');
    status('restoring previous code');
    if (op.git(root, 'status', '--porcelain', '--untracked-files=no') || sha256(fs.readFileSync(path.join(root, '.env'))) !== before.apps[app].envHash) fail('manual_recovery_configuration_changed');
    op.command('git', ['-C', root, 'switch', '--detach', previous]);
    for (const member of app === 'frontend' ? ['node_modules', 'build'] : ['node_modules']) {
      if (fs.existsSync(path.join(backup, member))) {
        if (fs.existsSync(path.join(root, member))) fs.renameSync(path.join(root, member), path.join(backup, `failed-${member}`));
        fs.renameSync(path.join(backup, member), path.join(root, member));
      }
    }
    op.command(config.pm2, ['restart', APPS[app].directory]);
    await op.retryHealth(config, app, root);
    compareState(before, op.capture(config), app, previous);
    fail('deployment_failed_previous_code_restored');
  }
}
async function requestDeploy(configFile, app, request, io = {}) {
  const op = { configAt, verifyCi, verifySource, ...io };
  const config = op.configAt(configFile);
  if (!APPS[app]) fail('unknown_application');
  if (request.status) {
    const state = capture(config);
    process.stdout.write(JSON.stringify({ app, repository: APPS[app].repo, branch: APPS[app].branch, head: state.apps[app].head, online: true }) + '\n');
    return;
  }
  const jobs = path.join(config.stateRoot, 'jobs'); fs.mkdirSync(jobs, { recursive: true, mode: 0o700 }); safeDirectory(jobs);
  const job = path.join(jobs, `${app}-${request.sha}-${request.runId}-${request.attempt}`);
  {
    // A leaked restricted key cannot fork lock waiters for arbitrary inputs.
    await op.verifyCi(app, request); op.verifySource(config, app, request);
    const activeFile = path.join(config.stateRoot, `active-${app}.json`);
    if (fs.existsSync(activeFile)) {
      const active = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      if (typeof active.job !== 'string' || path.dirname(active.job) !== jobs) fail('invalid_active_job');
      const state = JSON.parse(fs.readFileSync(path.join(active.job, 'status.json'), 'utf8'));
      if (!['success', 'failed'].includes(state.state) && active.job !== job) fail('deployment_already_active');
    }
    if (fs.existsSync(job)) safeDirectory(job);
    else {
      fs.mkdirSync(job, { mode: 0o700 });
      writeJson(path.join(job, 'status.json'), { state: 'queued', phase: 'waiting for shared host lock' });
      writeJson(activeFile, { job });
      const log = fs.openSync(path.join(job, 'private.log'), 'wx', 0o600);
      const child = cp.spawn(process.execPath, [__filename, 'supervise', app, configFile, request.sha, request.runId, request.attempt, job], { detached: true, stdio: ['ignore', log, log], env: stageEnvironment(job) });
      child.once('error', () => failedIfUnfinished(job, 'deployment_supervisor_failed_to_start'));
      child.once('exit', code => { if (code !== 0) failedIfUnfinished(job, 'deployment_supervisor_failed'); });
      child.unref(); fs.closeSync(log);
    }
  }
  let last;
  for (let tick = 0; tick < 1800; tick++) {
    const state = JSON.parse(fs.readFileSync(path.join(job, 'status.json'), 'utf8'));
    const report = JSON.stringify(state);
    if (report !== last) { process.stdout.write(`${app}: ${state.phase}${state.code ? ` (${state.code})` : ''}\n`); last = report; }
    if (state.state === 'success') return;
    if (state.state === 'failed') fail(state.code || 'deployment_failed');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  fail('deployment_status_timeout_worker_may_continue');
}
async function main() {
  process.env.PATH = '/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin';
  if (Number(process.versions.node.split('.')[0]) !== 22) fail('node_22_required');
  const [mode, app, configFile, sha, runId, attempt, job] = process.argv.slice(2);
  if (['request', 'admitted'].includes(mode) && process.argv.length === 5) {
    if (!APPS[app]) fail('unknown_application');
    const request = parseCommand(process.env.SSH_ORIGINAL_COMMAND);
    if (mode === 'admitted' || request.status) return requestDeploy(configFile, app, request);
    const config = configAt(configFile);
    // An OS lock is released on disconnect/death; no persistent mkdir mutex.
    command(config.flock, ['--exclusive', '--nonblock', '--close', path.join(config.stateRoot, `admission-${app}.lock`), process.execPath, __filename, 'admitted', app, configFile], {
      timeout: 60 * 60 * 1000,
      env: { ...stageEnvironment(config.stateRoot), SSH_ORIGINAL_COMMAND: `deploy ${request.sha} ${request.runId} ${request.attempt}` },
    });
    return;
  }
  if (!['worker', 'supervise'].includes(mode) || process.argv.length !== 9 || !APPS[app]) fail('invalid_invocation');
  const config = configAt(configFile), request = parseCommand(`deploy ${sha} ${runId} ${attempt}`);
  if (job !== path.join(config.stateRoot, 'jobs', `${app}-${sha}-${runId}-${attempt}`)) fail('invalid_job_path');
  safeDirectory(job);
  if (mode === 'supervise') return supervise(config, app, configFile, request, job);
  try {
    await deploy(config, app, request, job);
    try { retainSuccessful(config, app, job); }
    catch { console.error('retention_cleanup_required'); }
  }
  catch (error) { writeJson(path.join(job, 'status.json'), { state: 'failed', phase: 'deployment stopped', code: /^[a-z_]+$/.test(error.code || '') ? error.code : 'deployment_failed' }); throw error; }
}
if (require.main === module) main().catch(error => { console.error(/^[a-z_]+$/.test(error.code || '') ? error.code : 'deployment_failed'); process.exitCode = 1; });
module.exports = { APPS, canonical, parseCommand, validateRun, validateCapabilities, sourceSchemaFence, schema, compareState, stageEnvironment, deploy, requestDeploy, supervise, failedIfUnfinished, retainSuccessful };
