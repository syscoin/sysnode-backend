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
runtime hash, confirmation depth and finite block-age limit. HTTP requests cannot
supply any of these.
Each enrollment persists its chain, module and account binding. Changing the
registry cannot silently move an existing enrollment to another module: the
old watch becomes unavailable and a new module requires a fresh signed proof.
`RECOVERY_ALERTS_ENABLED=true` enables that registry; absent/false leaves it
disabled. Never add a runtime or chain without verifying its source and layout.

## Chain observations

Each observation verifies the chain ID and the exact module runtime at the
selected canonical block. zkTanenbaum uses the latest observed block, not a
finalized block, so an initiation does not wait for two more blocks. Its block
production is transaction-driven: public read-only samples on 2026-10-21 showed
blocks 3776–3784 separated by 316–333 seconds, each importing an interop root.
Its server-owned freshness bound is seven minutes; the default for other chain
configurations remains two minutes. No other chain is enabled by this change.
All calls and storage reads use the selected anchor, whose hash is checked again
afterwards. Repeated hash checks detect inconsistent observations but do not
provide finality. Emails identify this observation/reorganization boundary.
The source-pinned `_activeRecovery` and
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
Current-state observations do not wait for log backfill. A durable reconciliation
flag records provisional terminal observations and detected reorganizations so
they remain revalidated through paged backfill, restarts and read failures. It is
cleared only after all known operations are read at the same head as the committed
cursor, not by a health-status update. Reconciliation is bounded to 1,000 known
operations per account; exceeding that capacity degrades monitoring rather than
silently dropping history. Emails remain provisional and revalidated at delivery.

One worker loop starts every 15 seconds after the previous iteration completes,
with at most three subscription updates concurrently. A chain older than its
configured finite freshness bound, read failure, unsupported runtime or incomplete backfill is shown
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
3. The public API is `/api/recovery/` under the same HTTPS origin as the
   frontend. Both `/api/recovery/` and `/recovery/` mount the same authenticated
   router, supporting existing proxies that strip `/api` and those that pass
   it unchanged. Preserve the existing cookie, CSRF and CSP configuration.
4. Enable the registry only after the worker, SMTP transport and same-origin
   route have passed a testnet enrollment and delivery check. No wallet funds or
   live recovery need be risked to verify enrollment; use an owned test account
   for the controlled recovery lifecycle test.

`npm test` covers route authorization, replay and expiry, state-machine polling,
reminders, reorgs, SMTP failures, enrollment generations and the pinned RPC
reader. The Anvil integration test separately exercises real contract code and
ERC-1271 enrollment; synthetic chain fixtures are not public-chain qualification.
