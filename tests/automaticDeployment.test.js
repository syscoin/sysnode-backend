'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { parseCommand, validateNodeRuntime, validateRun, validateJobsPage, validateCapabilities, sourceRuntimeFence, canonical, compareState, schema, stageEnvironment, supervise, requestDeploy, retainSuccessful } = require('../deploy/automation/host-deploy.cjs');
const { inputs, privateKeyText } = require('../scripts/request-deploy.cjs');

const sha = 'a'.repeat(40);
const request = { sha, runId: '123', attempt: '2' };
const run = { id: 123, run_attempt: 2, event: 'push', head_branch: 'main', head_sha: sha, repository: { full_name: 'syscoin/sysnode-backend' }, head_repository: { full_name: 'syscoin/sysnode-backend' }, path: '.github/workflows/ci.yml', status: 'in_progress' };
const jobs = ['Jest (Node 26.12.1)', 'Production dependency audit', 'Schema sanity'].map(name => ({ name, status: 'completed', conclusion: 'success' }));
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'syscoin/sysnode-backend', GITHUB_REF: 'refs/heads/main', GITHUB_SERVER_URL: 'https://github.com', GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', SYSNODE_DEPLOY_HOST: '192.0.2.10', SYSNODE_DEPLOY_USER: 'ubuntu', SYSNODE_DEPLOY_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-only\n-----END OPENSSH PRIVATE KEY-----', SYSNODE_KNOWN_HOSTS: 'host ssh-ed25519 synthetic' };

test('real OpenSSH keys remain parseable when secrets omit final LF or use CRLF', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-key-format-'));
  fs.chmodSync(root, 0o700);
  try {
    const original = path.join(root, 'generated');
    cp.execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', original], { stdio: 'ignore' });
    const source = fs.readFileSync(original, 'utf8');
    const expectedPublic = cp.execFileSync('ssh-keygen', ['-y', '-f', original], { encoding: 'utf8' });
    for (const variant of [source, source.trimEnd(), source.replace(/\n/g, '\r\n'), source.trimEnd().replace(/\n/g, '\r\n')]) {
      const normalized = path.join(root, 'normalized');
      fs.writeFileSync(normalized, privateKeyText(variant), { mode: 0o600 });
      const parsedPublic = cp.execFileSync('ssh-keygen', ['-y', '-f', normalized], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(parsedPublic).toBe(expectedPublic);
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('host deployment requires the supported patched Node runtime', () => {
  for (const version of ['26.12.1', '26.12.2', '26.13.0']) expect(() => validateNodeRuntime(version)).not.toThrow();
  for (const version of ['20.20.0', '22.22.0', '24.22.1', '26.11.9', '26.12.0', '27.0.0', '26.12.1-rc.1', '26.12.1\n', 'invalid']) expect(() => validateNodeRuntime(version)).toThrow('node_26_12_1_or_later_required');
});

test('forced command accepts only exact status or SHA/run/attempt deployment', () => {
  expect(parseCommand('status')).toEqual({ status: true });
  expect(parseCommand(`deploy ${sha} 123 2`)).toEqual(request);
  for (const value of [`deploy ${sha} 123 2; id`, `deploy ${sha} 123 2\n`, `deploy ${sha} 0 2`, `deploy ${sha} 123 -1`, `deploy ${sha.toUpperCase()} 123 2`, 'bash', 'status && id', ' deploy ' + sha + ' 123 2']) expect(() => parseCommand(value)).toThrow();
});
test('CI proof binds repository, branch, workflow, SHA and exact run attempt', () => {
  expect(() => validateRun('backend', request, run, [...jobs, { name: 'Deploy production', status: 'in_progress' }])).not.toThrow();
  for (const mutation of [{ event: 'pull_request' }, { head_branch: 'other' }, { head_sha: 'b'.repeat(40) }, { repository: { full_name: 'fork/repo' } }, { head_repository: { full_name: 'fork/repo' } }, { path: 'other.yml' }, { run_attempt: 1 }, { status: 'completed', conclusion: 'cancelled' }]) expect(() => validateRun('backend', request, { ...run, ...mutation }, jobs)).toThrow();
});
test('missing, failed, skipped and additional unfinished jobs all fail closed', () => {
  expect(() => validateRun('backend', request, run, jobs.slice(1))).toThrow();
  for (const conclusion of ['failure', 'skipped', 'cancelled', null]) expect(() => validateRun('backend', request, run, jobs.map((job, index) => index ? job : { ...job, conclusion }))).toThrow();
  expect(() => validateRun('backend', request, run, [...jobs, { name: 'New required check', status: 'queued' }])).toThrow();
});
test('CI job pages must be complete and bounded before accepting any success list', () => {
  expect(() => validateJobsPage({ total_count: jobs.length, jobs })).not.toThrow();
  for (const page of [{ jobs }, { total_count: jobs.length + 1, jobs }, { total_count: 101, jobs }, { total_count: 1.5, jobs }, { total_count: -1, jobs }]) expect(() => validateJobsPage(page)).toThrow('incomplete_ci_jobs');
});
test.each(['frontend', 'backend'])('the %s source fence covers runtime files before git can overwrite them', app => {
  const read = jest.fn(() => '');
  expect(sourceRuntimeFence('/app', 'old', 'new', app, read)).toBe(true);
  expect(read.mock.calls[0]).toEqual(['/app', 'diff', '--name-only', '-z', '--no-renames', 'old', 'new', '--']);
  read.mockReturnValue('.env');
  expect(sourceRuntimeFence('/app', 'old', 'new', app, read)).toBe(false);
});

test.each(['file', 'directory', 'symlink'])('real Git runtime fence rejects a protected %s path', shape => {
  for (const [app, member] of [['frontend', 'build'], ['backend', 'data'], ['frontend', 'node_modules'], ['backend', 'node_modules'], ['frontend', '.env.production.local'], ['backend', '.env.bak.test']]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-path-fence-'));
    const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Deployment fixture');
      fs.writeFileSync(path.join(root, 'README'), 'fixture'); git('add', 'README'); git('commit', '-qm', 'baseline');
      const previous = git('rev-parse', 'HEAD'), target = path.join(root, member);
      if (shape === 'directory') { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'member'), 'fixture'); }
      else if (shape === 'symlink') fs.symlinkSync('/synthetic-missing-target', target);
      else fs.writeFileSync(target, 'fixture');
      git('add', '--', member); git('commit', '-qm', 'candidate');
      expect(sourceRuntimeFence(root, previous, 'HEAD', app)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true }); }
  }
}, 15000);

test('actual Git fast-forward never overwrites an ignored runtime file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-ignore-fence-'));
  const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Deployment fixture');
    fs.writeFileSync(path.join(root, '.gitignore'), 'runtime-state.txt\n'); git('add', '.gitignore'); git('commit', '-qm', 'baseline');
    const previous = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'runtime-state.txt'), 'candidate contents'); git('add', '-f', 'runtime-state.txt'); git('commit', '-qm', 'force added file');
    const candidate = git('rev-parse', 'HEAD'); git('switch', '--detach', previous);
    fs.writeFileSync(path.join(root, 'runtime-state.txt'), 'live runtime data');
    expect(() => git('merge', '--ff-only', '--no-overwrite-ignore', candidate)).toThrow();
    expect(git('rev-parse', 'HEAD')).toBe(previous);
    expect(fs.readFileSync(path.join(root, 'runtime-state.txt'), 'utf8')).toBe('live runtime data');
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('client never admits PRs, forks, wrong refs or SSH argument injection', () => {
  expect(inputs('backend', env).command).toBe(`deploy ${sha} 123 2`);
  for (const mutation of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'fork/repo' }, { GITHUB_REF: 'refs/heads/master' }, { SYSNODE_DEPLOY_HOST: '-oProxyCommand=bad' }, { SYSNODE_DEPLOY_USER: 'ubuntu;bad' }, { GITHUB_RUN_ATTEMPT: '1;bad' }]) expect(() => inputs('backend', { ...env, ...mutation })).toThrow();
});
test('the workflow treats the origin host as a masked secret', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
  expect(workflow).toContain('SYSNODE_DEPLOY_HOST: ${{ secrets.SYSNODE_DEPLOY_HOST }}');
  expect(workflow).not.toContain('vars.SYSNODE_DEPLOY_HOST');
});
test('configuration comparison ignores property insertion order but rejects material changes', () => {
  expect(JSON.stringify(canonical({ b: 1, a: { y: 3, x: 2 } }))).toBe(JSON.stringify(canonical({ a: { x: 2, y: 3 }, b: 1 })));
  const before = { apps: { backend: { head: 'old', envHash: 'e', launch: 'l', pid: 1 }, frontend: { head: 'same', pid: 2 } }, database: { path: '/db', ino: 3 } };
  const after = { ...before, apps: { ...before.apps, backend: { ...before.apps.backend, head: 'new', pid: 4 } } };
  expect(() => compareState(before, after, 'backend', 'new')).not.toThrow();
  expect(() => compareState(before, { ...after, apps: { ...after.apps, backend: { ...after.apps.backend, pid: 1 } } }, 'backend', 'new')).toThrow('application_process_was_not_replaced');
  expect(() => compareState(before, { ...after, database: { path: '/other' } }, 'backend', 'new')).toThrow();
  expect(() => compareState(before, { ...after, apps: { ...after.apps, frontend: { ...after.apps.frontend, pid: 5 } } }, 'backend', 'new')).toThrow();
});
test('actual SQLite schema fingerprint sees DDL outside migration files', () => {
  const Database = require('better-sqlite3'); const db = new Database(':memory:');
  try { db.exec('CREATE TABLE known (id INTEGER PRIMARY KEY)'); const first = schema(db); db.exec('INSERT INTO known VALUES (1)'); expect(schema(db)).toBe(first); db.exec('CREATE TABLE hidden_startup_ddl (id INTEGER)'); expect(schema(db)).not.toBe(first); } finally { db.close(); }
});
test('staging never inherits the live application environment', () => {
  process.env.SMTP_PASS = 'synthetic-only';
  try { expect(stageEnvironment('/tmp/job')).not.toHaveProperty('SMTP_PASS'); expect(stageEnvironment('/tmp/job')).not.toHaveProperty('SYSNODE_DB_PATH'); expect(stageEnvironment('/tmp/job').NPM_CONFIG_USERCONFIG).toBe('/dev/null'); } finally { delete process.env.SMTP_PASS; }
});
test('staging resolves Node from the verified host runner before system defaults', () => {
  const directory = path.dirname(process.execPath);
  const env = stageEnvironment('/tmp/job');
  expect(env.PATH.split(path.delimiter)[0]).toBe(directory);
  expect(cp.execFileSync('node', ['-p', 'process.execPath'], { env, encoding: 'utf8' }).trim()).toBe(process.execPath);
});

test('health capabilities preserve the exact configured chain and PQ gate', () => {
  const config = { network: 'mainnet', era: 'legacy-v3', genesisHash: 'ab'.repeat(32) };
  const caps = { version: 1, network: 'mainnet', chain: { era: 'legacy-v3', genesisHash: config.genesisHash }, operations: ['register', 'updateService', 'updateRegistrar', 'revoke'], preparationActive: false };
  expect(() => validateCapabilities(caps, config)).not.toThrow();
  for (const mutation of [{ version: 2 }, { network: 'testnet' }, { preparationActive: true }, { operations: [...caps.operations, 'registerOperator'] }, { chain: { ...caps.chain, genesisHash: 'cd'.repeat(32) } }]) expect(() => validateCapabilities({ ...caps, ...mutation }, config)).toThrow();
});

test.each(['exit', 'error'])('a detached flock %s cannot strand a permanently queued job', async kind => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-worker-test-'));
  const job = path.join(root, 'job'); fs.mkdirSync(job);
  fs.writeFileSync(path.join(job, 'status.json'), JSON.stringify({ state: 'queued' }));
  const child = new EventEmitter();
  const spy = jest.spyOn(cp, 'spawn').mockImplementation(() => { process.nextTick(() => child.emit(kind, kind === 'exit' ? 1 : new Error('fixture'))); return child; });
  try {
    await supervise({ flock: '/fixture/flock', stateRoot: root }, 'backend', '/fixture/config', request, job);
    expect(JSON.parse(fs.readFileSync(path.join(job, 'status.json')))).toMatchObject({ state: 'failed', code: 'deployment_worker_failed_to_start_or_complete' });
  } finally { spy.mockRestore(); fs.rmSync(root, { recursive: true }); }
});

test('invalid CI is rejected before creating a job or detached process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-admission-test-'));
  const spy = jest.spyOn(cp, 'spawn');
  try {
    await expect(requestDeploy('/fixture/config', 'backend', request, { configAt: () => ({ stateRoot: root }), verifyCi: async () => { throw new Error('invalid CI'); } })).rejects.toThrow('invalid CI');
    expect(fs.readdirSync(path.join(root, 'jobs'))).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(fs.readdirSync(root).some(name => name.startsWith('admission-'))).toBe(false);
  } finally { spy.mockRestore(); fs.rmSync(root, { recursive: true }); }
});

test('only one active job per app may be admitted even with different valid runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-bound-test-'));
  const job = path.join(root, 'jobs', 'existing'); fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, 'status.json'), JSON.stringify({ state: 'running' }));
  fs.writeFileSync(path.join(root, 'active-backend.json'), JSON.stringify({ job }));
  const spy = jest.spyOn(cp, 'spawn');
  try {
    await expect(requestDeploy('/fixture/config', 'backend', request, { configAt: () => ({ stateRoot: root }), verifyCi: async () => {}, verifySource: () => '/fixture' })).rejects.toThrow('deployment_already_active');
    expect(spy).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(root, 'jobs'))).toEqual(['existing']);
  } finally { spy.mockRestore(); fs.rmSync(root, { recursive: true }); }
});

test('retention keeps three successes and every failed or active recovery record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysnode-retention-test-'));
  const jobs = path.join(root, 'jobs'); fs.mkdirSync(jobs);
  const paths = [];
  try {
    for (let index = 1; index <= 6; index++) {
      const job = path.join(jobs, `backend-${sha}-${index}-1`); paths.push(job); fs.mkdirSync(job);
      const file = path.join(job, 'status.json'); fs.writeFileSync(file, JSON.stringify({ state: index === 1 ? 'failed' : 'success' })); fs.utimesSync(file, new Date(index * 1000), new Date(index * 1000));
    }
    fs.writeFileSync(path.join(root, 'active-backend.json'), JSON.stringify({ job: paths[5] }));
    fs.mkdirSync(path.join(paths[5], 'npm-cache'));
    retainSuccessful({ stateRoot: root }, 'backend', paths[5]);
    expect(fs.existsSync(paths[0])).toBe(true);
    expect(fs.existsSync(paths[1])).toBe(false);
    expect(fs.existsSync(paths[2])).toBe(false);
    expect(paths.slice(3).every(file => fs.existsSync(file))).toBe(true);
    expect(fs.existsSync(path.join(paths[5], 'npm-cache'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true }); }
});
