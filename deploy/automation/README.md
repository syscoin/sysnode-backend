# Automatic deployment on the existing host

The `Deploy production` CI job runs only after every existing backend CI job
succeeds, on a push to `syscoin/sysnode-backend`'s exact `main` branch. The frontend
has the equivalent job for `syscoin/sysnode-info`'s `master`. Pull requests, forks,
tags, and manual workflow calls do not receive the deployment job's credentials.
The GitHub `production` environment must also restrict branches to that one
default branch. Normal PR review and branch protections remain the trust boundary
for application code.

## One host runner, two restricted identities

Install a reviewed copy of `host-deploy.cjs` outside both live checkouts, at
`/home/ubuntu/.local/libexec/sysnode-deploy/host-deploy.cjs`, with private
`config.json` beside it. Create the configured state directory as mode 0700. The
example configuration uses Node 26.12.1, the existing PM2 applications, mainnet genesis,
public HTTPS origin and loopback backend port; verify each value before enabling.
The host runner must be updated explicitly from reviewed source, not replaced by
an arbitrary candidate's deployment script.

Use **new, separate ED25519 keys** for the two repositories. Do not upload an
existing administrator key. Each public key's `authorized_keys` entry must have
`restrict` and its own fixed forced command, for example:

```text
restrict,command="/usr/bin/node /home/ubuntu/.local/libexec/sysnode-deploy/host-deploy.cjs request backend /home/ubuntu/.local/libexec/sysnode-deploy/config.json" ssh-ed25519 <backend-public-key>
restrict,command="/usr/bin/node /home/ubuntu/.local/libexec/sysnode-deploy/host-deploy.cjs request frontend /home/ubuntu/.local/libexec/sysnode-deploy/config.json" ssh-ed25519 <frontend-public-key>
```

The only accepted commands are `status` (read-only, app/ref/online identity only)
and `deploy <40-lowercase-hex-SHA> <run-id> <attempt>`. No shell, arbitrary path,
repository, branch, forwarding or runtime argument comes from the client. Use
`status` and negative commands before enabling the first deploy; preserve the
previous authorized-keys file for recovery.

The current host runs both apps as `ubuntu`. Forced commands limit what a stolen
deployment key can request; they do **not** create OS isolation from trusted
application code or npm lifecycle scripts running as that same Unix user.
Review default-branch changes and dependencies accordingly. Production credentials
are never sourced into staged tests/builds, but same-user filesystem isolation is
not claimed.

## Node runtime upgrades

Development and every CI job use Node 26.12.1, pinned in `.nvmrc`. The host runner
refuses Node versions below 26.12.1 or outside major 26. Staged npm commands and
child processes put the runner's own Node directory first on `PATH` so a different
system default cannot silently install native modules under another ABI.

Changing `.nvmrc` or merging this file does not replace the host's Node runtime,
the independently installed host runner, an existing PM2 daemon, or running apps.
Before the first deployment on the new major, an operator must separately:

1. Install and verify Node 26.12.1 and its npm on the host. The forced commands
   above currently use `/usr/bin/node`; that executable must resolve to the
   supported runtime. Confirm `node --version`, `node -p process.execPath`,
   `/usr/bin/node --version`, and the runtime used by the PM2 daemon and both apps.
2. Prepare and test fresh dependencies under Node 26.12.1. `better-sqlite3` is a
   native addon: do not reuse `node_modules` built for Node 20, 22 or 24. The host
   runner loads the installed backend addon for read-only database checks, so its
   current backend dependencies must also be compatible before the runner changes.
   Preserve old code, dependencies and the previous Node executable for rollback.
3. Coordinate a controlled restart of the existing PM2 applications under the new
   runtime, preserving `.env`, launch arguments, the SQLite database and its live
   writes. Rebuilding native dependencies is not a database migration; never remove
   `data/` or restore a stale database backup as part of this upgrade.
4. Install the reviewed `host-deploy.cjs` outside the application checkouts. It now
   requires `Jest (Node 26.12.1)` for the backend and `Jest + build (Node 26.12.1)`
   for the frontend; both workflows must match before automatic deployments resume.
5. Check the actual restarted process runtime, read-only SQLite integrity and
   schema, both public and loopback health, and exact deployed Git revisions. Then
   exercise the restricted `status` and qualified no-op deployment checks above.

This repository does not automatically upgrade the host or restart its processes.
The normal exact-commit deployment and rollback fences remain unchanged.

## GitHub environment setup

For each repo's branch-restricted `production` environment:

- Secret `SYSNODE_DEPLOY_KEY`: that repository's new private key only.
- Secret `SYSNODE_KNOWN_HOSTS`: independently verified pinned host key entry.
- Secret `SYSNODE_DEPLOY_HOST`: the private origin address (for example `192.0.2.10`).
- Variable `SYSNODE_DEPLOY_USER`: currently `ubuntu`.

The client uses a temporary mode-0600 key and known-hosts file, refuses unknown
host keys, disables agent/port forwarding and password fallback, and removes the
temporary files afterward. It performs no npm install with deployment secrets.
Default-branch push CI runs are not auto-cancelled mid-cutover; other CI runs retain
the existing cancellation behavior.

## Admission, staging and cutover

The host independently fetches public GitHub run metadata: exact repository and
head repository, push event, workflow file, branch, SHA and run attempt must match.
Every required CI job and every additional non-deployment job must have completed
successfully. It checks the fetched default-branch SHA before admission and again
under the deployment lock after staging. Older or unqualified requests fail closed.

An OS `flock` bounds admission to one requester per app and is released on process
death. There is at most one active job per app. A detached supervisor durably
records startup/lock-timeout failures and keeps the worker alive if the requesting
SSH session disappears. A second shared host `flock` serializes frontend and
backend deployments. Repeated identical run/attempt requests observe the same
job, not another deploy. A process/host crash during a critical phase requires
operator inspection of that saved job before retrying; no uncertain cutover is
silently repeated.

The worker archives only the exact qualified Git commit. It runs fresh `npm ci`,
all repository unit tests, the production audit and the repository-specific codec
or runtime/build checks in the stage. It does not copy the live `.env` or database
into those test processes. Backend schema rehearsal is a separate process against
a consistent private SQLite copy; it does not read live RPC or mail credentials.
Frontend network selection is explicit at build time. Tracked dirty files,
unexpected Git origin, runtime, process command, database path, or environment
changes stop the deployment. Existing untracked `.env.bak.*` files are neither
deleted nor copied into an artifact.
Candidate tree changes to live `.env`/local override/backup files, `node_modules`,
the frontend `build` or backend `data` directory are rejected before staging or
stopping an app. This also prevents Git from replacing an ignored runtime file
with a newly tracked file. A staged environment path must be a regular file, not
a directory or symbolic link.
The fast-forward also uses Git's `--no-overwrite-ignore` safeguard, so an ignored
runtime file outside the explicitly protected names cannot be silently replaced.

Only the affected PM2 application is stopped. Its previous source revision,
dependencies and frontend build are retained. The live `.env`, PM2 launch
configuration, other app and database path are not replaced. Health checks require
both public and loopback backend `ok: true`; backend capabilities must match the
configured network, genesis, era, complete operation set and PQ-preparation gate.
Frontend pages must serve the exact new main asset and retain `connect-src 'self'`.

## Database policy and rollback

The database is now live. Historical pre-production comments are not permission
to edit an already deployed migration or discard data. Automatic backend rollout
refuses changes to `lib/db.js` or `db/migrations/`; those need a separately reviewed
data-migration deployment. A schema fingerprint also covers actual `sqlite_master`,
migration records and user version before/after candidate startup on a copied DB,
so moving startup DDL to another file does not bypass the check.

Before backend cutover a consistent SQLite backup is made after stopping the app.
On failure the worker first stops the candidate, then checks the real schema and
integrity. If unchanged, it restores only the old code/dependencies/build and
verifies the old service. **It never automatically restores a database backup**:
that could discard newer user writes. If schema, integrity or environment changed,
the job reports manual recovery and leaves the failed candidate stopped. The old
code, backup and logs remain available for an operator's explicit recovery choice.

The last three successful jobs/backups per app are retained. Active, failed and
manual-recovery jobs are never automatically deleted. Successful npm caches and
source archives are removed; the rollback build/dependencies remain. At least
4 GiB free disk is required before staging. If failed jobs accumulate, review them
and archive/remove only individually identified completed jobs; do not delete the
state directory or live database. All saved files/logs are private to the host user.

## Verification

Backend `npm test` includes admission policy and real-filesystem failure tests.
They exercise failures before stop, ambiguous stop, partial artifact swaps,
unhealthy startup, schema changes, interrupted supervision and preservation of
post-cutover DB writes. Frontend CI tests its strict deployment-request boundary.
These synthetic checks do not replace the first real `status`, negative-command,
no-op/current-SHA and qualified default-branch deployment checks on the host.
After a failed deployment, use GitHub **Re-run all jobs**, not only the failed
deployment job: the host requires the complete green CI matrix for that exact
run attempt and deliberately does not borrow results from a previous attempt.
