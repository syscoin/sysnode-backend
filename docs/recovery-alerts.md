# Smart-account recovery alerts

Recovery alerts are an opt-in security notification, not a custody service.
Users link a deployed smart account to their verified Sysnode email with a
one-use, five-minute `personal_sign` message. Sysnode checks the complete
signature with ERC-1271 on that account; it never receives a private key and
cannot cancel or execute a recovery. Disabling a watch requires the account
password and its configured TOTP factor.

The initial supported network is **zkTanenbaum (57057)**. Mainnet networks are
not advertised before the pinned recovery module has been deployed and checked.
The server-owned registry contains the RPC, chain ID, module address, exact
runtime hash and confirmation depth. HTTP requests cannot supply any of these.
`RECOVERY_ALERTS_ENABLED=true` enables that registry; absent/false leaves it
disabled. Never add a runtime or chain without verifying its source and layout.

## Chain observations

Each observation verifies the chain ID and the exact module runtime at a
two-block-confirmed anchor. All calls and storage reads use that anchor, whose
hash is checked again afterwards. The source-pinned `_activeRecovery` and
`_schedules` storage layout closes two otherwise ambiguous cases: an operation
already pending before enrollment, and uninstall/reinstall that silently cancels
an operation without emitting `RecoveryCanceled`. The layout fixture comes from
solc 0.8.28, optimizer 200, viaIR, Cancun, metadata disabled; its creation code
matches Pali's embedded canonical module. Unknown runtime means unavailable, not
an assumption that no recovery exists.

Enrollment takes a current-state snapshot and begins the persistent log cursor
with an overlapping block. It does not need years of archive history or guess a
safe lookback. The worker catches up in bounded 2,000-block chunks and keeps
attempts that start and finish between polls. On a changed checkpoint hash it
resnapshots state, warns about the reorganization and replays from the enrollment
anchor. An orphaned observation is not reported as an operator cancellation.

One worker loop starts every 15 seconds after the previous iteration completes,
with at most three subscription updates concurrently. A stale RPC chain (over two
minutes old), read failure, unsupported runtime or incomplete backfill is shown
as degraded/catching up. The API also expires a saved healthy status after one
minute without a successful check, including when the process is down. Use one
backend worker per SQLite database; horizontal worker leasing is not implemented.

Initiation, cancellation/policy invalidation, completion and expiry notices use
on-chain state. One pending reminder is eligible 24 hours before a long delay,
or halfway through a short test delay. The worker rechecks the state immediately
before delivery and suppresses stale pending notices. Message identities and
retries are persisted and scoped to each enrollment generation; disabling or
re-enabling cannot send a stale disable notice. SMTP handoff and SQLite cannot be
made atomic: a crash after SMTP acceptance can produce a duplicate. Email delivery
and monitoring are best effort, never a guarantee that a user has time to act.

## Rollout

1. Review the exact code, test results and runtime/storage-layout evidence.
2. This change adds `002_recovery_alerts.sql` to an already live database. The
   existing automatic-deployment migration fence must remain enabled. Use the
   separately reviewed manual migration procedure, a consistent SQLite backup,
   and a copied-database rehearsal before cutover. Do not reset or replace live
   user data, and do not automatically roll back the database after new writes.
3. Forward `/recovery/` unchanged under the same HTTPS origin as the frontend,
   like `/auth/`. Preserve the existing cookie, CSRF and CSP configuration.
4. Enable the registry only after the worker, SMTP transport and same-origin
   route have passed a testnet enrollment and delivery check. No wallet funds or
   live recovery need be risked to verify enrollment; use an owned test account
   for the controlled recovery lifecycle test.

`npm test` covers route authorization, replay and expiry, state-machine polling,
reminders, reorgs, SMTP failures, enrollment generations and the pinned RPC
reader. The Anvil integration test separately exercises real contract code and
ERC-1271 enrollment; synthetic chain fixtures are not public-chain qualification.
