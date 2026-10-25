# Public Classic ETH pool snapshots

`GET /api/privacy/v1/pools/:poolId/snapshot` supplies public deposit data for
Pali's local Tornado Classic Merkle-tree reconstruction. It never receives a
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

The feature is disabled unless `PRIVACY_INDEX_ENABLED=true` and
`PRIVACY_INDEX_RPC_URL` supplies an operator-controlled HTTPS Ethereum mainnet
RPC. URLs containing credentials or fragments are rejected. A provider API
token may be in its path/query; it never enters responses or application logs.
The RPC must support `finalized` headers, historical `eth_call`/`eth_getCode`,
and `eth_getLogs` from the deployment blocks. Scans start with 5,000-block
ranges and shrink on provider range/response-size failures. There is no
fallback to unfinalized data or to a different provider. A provider which cannot
serve even one block of historical logs needs a suitable endpoint before enabling.

No RPC is sent at startup. The first request starts a job, bounded to 16 chunks
and a 45-second scheduling budget (an already-started RPC can take another
10 seconds). A global queue runs only one job at a time; requests for the same
pool share it. Further requests resume incomplete work. Successful snapshots
are checked for refresh at most once a minute; failures back off for 30 seconds.
Per-process IP limits allow 60 requests/minute and apply IPv6 subnet bucketing.
Run one writer process for this file store; multiple workers require explicit
shared locking and shared request limits before deployment.

The backend process needs write access to `data/privacy-index/`, resolved from
its working directory. Checkpoints and complete snapshots live in separate
files with checksums and are published by same-directory atomic rename. They
contain only public data, can be rebuilt, and never change `sysnode.db` or its
schema. The existing deployment preserves `data/`. The feature needs no SQL
migration, but the opt-in environment values and nginx route must be configured
separately; automatic deployment does not modify the host environment or nginx.
See the `/api/privacy/v1/` location in the nginx example. It disables access
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
  leafCount, root, leaves: ["0x<64 lowercase hex digits>", ...] }
```

Deposits are ordered by canonical event position and must have contiguous
indices starting at zero. The server validates field ranges, the pool's
20-level configuration and denomination, and matches total count and root
metadata at the pinned finalized block. It rejects removed/malformed logs,
missing indices, count mismatches and changed block anchors. JSON-RPC responses
have a 10-second timeout, 4-MiB bound, no redirects and exact response-ID checks.

The server does **not** independently reconstruct the MiMC root or authenticate
the configured RPC cryptographically. Pali must reconstruct the tree and check
the returned root against its own trusted chain observation before use. This
service is a public-data accelerator, not a replacement for wallet verification.

Complete snapshots remain immutable while a refresh is incomplete or fails.
`X-Privacy-Index-State` reports `ready`, `refreshing`, or `stale`; the block/hash
in the response remain the observation anchor, not the current HTTP time.
Strong ETags support `If-None-Match`/304 with the same freshness header.
`Cache-Control: public, max-age=0, must-revalidate` requires revalidation.
202/503 responses are not cached and carry `Retry-After`.

A persisted snapshot is withheld after restart until its block/hash,
on-chain count and root are checked again. Known checkpoint/snapshot reorgs
discard the affected pool's files and restart from deployment. A gap discards
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
deduplication, atomic snapshot availability, malformed inputs and anonymous
HTTP/ETag behavior. No deployment or live pool claim is part of these tests.
