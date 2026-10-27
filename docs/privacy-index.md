# Public Classic ETH pool snapshots

`GET /api/privacy/v1/pools/:poolId/snapshot` supplies public deposit and withdrawal data for
Pali's local Tornado Classic Merkle-tree reconstruction and note-status checks. It never receives a
note, commitment, nullifier, leaf position, account address, signing key, RPC
URL or arbitrary contract address. Every query string or request body is
rejected. Only the following Ethereum mainnet pools are accepted:

| ID | Pool address | Deployment block |
| --- | --- | --- |
| `eth-0.1` | `0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc` | 9116966 |
| `eth-1` | `0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936` | 9117609 |
| `eth-10` | `0x910cbd523d972eb0a6f4cae4618ad62622b39dbf` | 9117720 |
| `eth-100` | `0xa160cdab225685da1d56aa342ad8841c3b53f291` | 9161895 |

These are pinned from the original
[CLI registry](https://github.com/tornadocash/tornado-cli/blob/378ddf8b8b92a4924037d7b64a94dbfd5a7dd6e8/config.js).

## Configuration and deployment

The feature is enabled by default when `PRIVACY_INDEX_RPC_URL` supplies an
operator-controlled HTTPS Ethereum mainnet RPC. Set `PRIVACY_INDEX_ENABLED=false`
to disable it independently. With no RPC it remains disabled; explicitly setting
`PRIVACY_INDEX_ENABLED=true` without an RPC is a configuration error. No default
RPC is selected. URLs containing credentials or fragments are rejected. A provider API
token may be in its path/query; it never enters responses or application logs.
The RPC must support `finalized` headers, historical `eth_call`/`eth_getCode`,
and `eth_getLogs` from the deployment blocks. Scans start with 5,000-block
ranges and shrink on provider range/response-size failures. After three sparse
successful full ranges, the scanner doubles the range toward the original
5,000-block cap. The cap is not increased based on an assumed provider capability. There is no
fallback to unfinalized data or to a different provider. A provider which cannot
serve even one block of historical logs needs a suitable endpoint before enabling.

Enabling the endpoint does not start a new pool's backfill by itself. An unused
pool sends no RPC. Its first request durably activates it and starts
a job, bounded to 16 chunks and a 45-second scheduling budget (an already-started
RPC can take another 10 seconds). A global queue runs only one job at a time;
requests for the same pool share it. Activated pools continue unfinished backfill
in bounded jobs separated by one second, then refresh once a minute without
requiring another client request. Failures back off for 30 seconds. On restart,
only previously activated pools resume. The single scheduled timer is unreferenced;
`index.close()` cancels future work and waits for the current bounded job. The
standalone app exposes its index handle for test/server lifecycle cleanup.
Any caller with access to the endpoint can activate a pool, and the resulting
backfill and refresh consume provider quota and may incur charges.
Per-process IP limits allow 60 requests/minute and apply IPv6 subnet bucketing.
Run one writer process for this file store; multiple workers require explicit
shared locking and shared request limits before deployment.

The backend process needs write access to `data/privacy-index/`, resolved from
its working directory. Checkpoints and complete snapshots live in separate
files with checksums and are published by same-directory atomic rename. An
allowlisted per-pool activation marker preserves activation even if the first
RPC fails. Existing snapshot/checkpoint filenames also identify previously used
pools during migration; unknown filenames activate nothing. They
contain only public data, can be rebuilt, and never change `sysnode.db` or its
schema. The existing deployment preserves `data/`. The feature needs no SQL
migration, but the Ethereum RPC and nginx route must be configured
separately; automatic deployment does not modify the host environment or nginx.
The internal `/privacy/v1` mount also supports existing proxies which strip
`/api`; clients still use the public `/api/privacy/v1` URL. See the
`/api/privacy/v1/` location in the nginx example for path-preserving proxies. It disables access
logging for this path; any upstream CDN/load balancer also needs an equivalent
policy if operators want to avoid recording client IP/pool access metadata.
The endpoint is anonymous with wildcard CORS and does not parse sessions or
set cookies. This does not conceal a client's IP from the serving operator.

## Response contract

An initial or incomplete index returns HTTP 202:

```json
{"phase":"syncing","scannedBlock":9116965,"startBlock":9116966,"targetBlock":9116965}
```

Before the first RPC completes, `targetBlock` equals `startBlock - 1`; it is
then the pinned finalized target for that scan. `scannedBlock` is the last
fully accepted block, so initially it also equals `startBlock - 1`.

HTTP 200 contains only:

```text
{ version: 1, chainId: 1, poolAddress, asOfBlockNumber, asOfBlockHash,
  leafCount, root, leaves: ["0x<64 lowercase hex digits>", ...],
  withdrawnNullifiers: ["0x<64 lowercase hex digits>", ...] }
```

The additive `withdrawnNullifiers` field is required in new cache files. Old
deposit-only snapshots and version-1 checkpoints are discarded and rebuilt,
never interpreted as an empty spent list. Checkpoints now use internal version 2.
Each array is bounded to 2^20 entries, withdrawals cannot outnumber deposits, and
the complete serialized snapshot/file is bounded to 160 MiB. Existing clients
which project the deposit fields can keep using public version 1; clients using
spent-note status must require the added field.

A single OR-topic request scans Deposit and Withdrawal events over the same
block range. Deposits are ordered by canonical event position and must have contiguous
indices starting at zero. The server validates field ranges, the pool's
20-level configuration and denomination, and matches total count and root
metadata at the pinned finalized block. It rejects removed/malformed logs,
missing indices, duplicate commitments/nullifiers, inconsistent event ordering,
count mismatches and changed block anchors. Withdrawal nullifiers are unique
and appear in event order at the same snapshot block as the deposits. JSON-RPC responses
have a 10-second timeout, 4-MiB bound, no redirects and exact response-ID checks.

The server does **not** independently reconstruct the MiMC root or authenticate
the configured RPC cryptographically. Pali must reconstruct the tree and check
the returned root against its own trusted chain observation before use. This
service is a public-data accelerator, not a replacement for wallet verification.

**The deposit root does not authenticate completeness of the withdrawal/nullifier
feed.** A missing withdrawal can pass the deposit-count/root checks. Spent-status
users additionally rely on the configured RPC and scanner returning all canonical
Withdrawal events; checksums and block fences do not remove that trust assumption.
An old or partial snapshot must not be called a current unspent result. No API
accepts a note or a per-user nullifier to resolve this on the server.
Even a fresh finalized snapshot does not include withdrawals in newer blocks or
the mempool; absence from its list is an observation at that block, not a
guarantee that a withdrawal will succeed now.

Complete snapshots remain immutable while a refresh is incomplete or fails.
`X-Privacy-Index-State` reports `ready`, `refreshing`, or `stale`; the block/hash
in the response remain the observation anchor, not the current HTTP time.
Strong ETags support `If-None-Match`/304 with the same freshness header.
`Cache-Control: public, max-age=0, must-revalidate` requires revalidation.
202/503 responses are not cached and carry `Retry-After`.

A persisted snapshot is withheld after restart until its block/hash,
on-chain count and root are checked again. Known checkpoint/snapshot reorgs
discard the affected pool's data files and restart from deployment; its
activation marker is retained. A gap discards
unfinished work and retries from the last complete snapshot or deployment. An RPC
outage does not destroy a previously validated in-memory snapshot; cold starts
during an outage return 503. Invalid/corrupt files are never served.

## Validation

```sh
npm test -- --runInBand tests/privacyIndex.test.js tests/privacyRpc.test.js tests/privacy.routes.test.js
npm test -- --runInBand --ci
npm run test:sentry-codec
npm run audit:prod
```

Tests use synthetic RPCs and temporary directories and never make mainnet
writes. They cover restart/resume, gaps, reorgs, unavailable sources,
deduplication, withdrawal coverage and old-cache rebuilds, periodic refresh,
timer cleanup, atomic snapshot availability, malformed inputs and anonymous
HTTP/ETag behavior. No deployment or live pool claim is part of these tests.
