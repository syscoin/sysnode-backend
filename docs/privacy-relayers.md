# Public Classic ETH relayer directory

`GET /api/privacy/v1/relayers` is a single anonymous bulk directory. It accepts
no query strings, request body, wallet address, note, nullifier, proof, pool
selector or caller-supplied URL. It is independent of note storage, local note
balance computation and the optional direct-withdrawal path.

## Deployment

The directory is disabled by default. Opt in with
`PRIVACY_RELAYER_DIRECTORY_ENABLED=true` and the existing
`PRIVACY_INDEX_RPC_URL` set to an operator-controlled HTTPS Ethereum mainnet RPC.
`PRIVACY_INDEX_ENABLED` does not enable the directory and need not be enabled
for this route. The RPC needs historical `eth_getLogs`, `eth_getStorageAt`,
`eth_getCode` and `eth_call`, plus finalized block support. There is no fallback
to `latest` or a caller-provided provider. Existing deployments stripping `/api`
before proxying are supported by the internal `/privacy/v1` mount; clients
continue to use `/api/privacy/v1`. The reference nginx configuration preserves
the external path. No new nginx location is required where the existing `/api`
proxy already forwards this namespace. Access logs should be disabled for the
public privacy namespace, including any upstream proxy/CDN, if operators do not
want to retain client IP/access metadata.

The first request activates one directory scanner. It persists only public ENS
registration candidates and a canonical scan checkpoint under
`data/privacy-relayers/registry-checkpoint.json`. A persisted checkpoint resumes
after restart; an unused directory sends no RPC or relayer requests. Endpoint
status, fee observations and verification are never restored as trusted from
disk. One writer process is supported. No database migration is needed.

Each job has a 45-second scheduling deadline and checks it before every outbound
request. A started operator RPC has a 10-second timeout; a relayer DNS/TLS/body
request has a 5-second total deadline. Jobs scan at most 16 ranges of 50,000
blocks and inspect at most eight candidates before yielding for one second.
Provider range errors shrink subsequent ranges. At most 256 distinct ENS
candidates are retained; an overflow fails explicitly, without truncation. A
single unreferenced timer refreshes every five minutes; failures back off for
30 seconds, and HTTP polling cannot bypass that backoff. `close()` cancels future
work and waits for any already-started bounded request. The app factory exposes
`privacyRelayers` for lifecycle cleanup.

## Pinned source and current registration

The source is Ethereum mainnet registry proxy
`0x58e8dcc13be9780fc42e8723d8ead4cf46943df2`, from block 14,173,129. The reviewed
implementation is `0x84b0c75c1f6211450fec7289c32d717adadd702a`, runtime Keccak-256
`0x8c83915c9dca7f9306b1930e43f3a05d7d2424bd0f9edbb324b06d2cfb03ca68`.
Its proxy slot and code are checked at the same finalized block used for the
registry reads. An implementation change fails closed until reviewed. Sources
are independently available from
[Sourcify's verified registry source](https://sourcify.dev/server/v2/contract/1/0x84b0c75c1f6211450fec7289c32d717adadd702a?fields=sources).

Historical `RelayerRegistered` events only discover candidate ENS names. Before
contacting an endpoint, the service reads the current ENS owner, requires that
owner's registry metadata to contain the exact ENS hash, and requires
`isRelayerRegistered(owner, owner)`. Regular and governance registration both set
that self-mapping; the contract prevents unregistering the master as a worker.
A status `rewardAccount` may be a registered worker, but it must separately pass
`isRelayerRegistered(owner, rewardAccount)`. Initial minimum stake is not treated
as an ongoing eligibility threshold: the contract permits governance admission
below it, and balance can change. The current registry balance is reported.

The URL is the parent ENS resolver's `text` record for
`mainnet-tornado.<registered ENS name>`, key `url`. This matches the original
[verified RelayerAggregator](https://sourcify.dev/server/v2/contract/1/0xE8F47A78A6D52D317D0D2FFFac56739fE14D1b49?fields=sources): it uses the registered
parent's resolver to read the child-node text record. All ENS/registry reads
share one finalized block, fenced before publication. Reorgs or a changed
implementation discard the published directory. The operator RPC is still a
trust assumption; these reads are not a cryptographic Ethereum light client.

## Endpoint boundaries and response meaning

ENS records are untrusted. A bare DNS hostname is normalized to a root HTTPS URL;
root HTTPS URLs on DNS hostnames with the standard 443 port are also accepted.
Credentials, IP literals, custom paths, queries
and fragments are rejected. Only fixed `/status` is requested. DNS must return
one to eight public addresses, all of which pass IPv4/IPv6 special-range checks.
An approved address is pinned into the actual TLS request, with the original
hostname retained for certificate verification. There is no second DNS lookup,
redirect, environment proxy, decompression or caller-selected path. Headers and
body are bounded to 8 KiB and 64 KiB respectively. The status schema bounds
advertised fields and matches supported ETH denominations to the four fixed
Classic pool addresses. Unknown assets and raw errors/logs are not forwarded.
An operator may additionally restrict service egress to public networks.

HTTP 202 means initial backfill/verification is incomplete; 503 means disabled
or unavailable. HTTP 200 includes `source`, `asOfBlockNumber`, `asOfBlockHash`,
`asOfBlockTimestamp`, observation time, candidate/unavailable counts, and current
registered relayers. Entries with an unavailable/rejected status retain public
identity only, without an endpoint or fee to select. A healthy status includes
`endpoint`, `rewardAccount`, `supportedPools`, `advertisedServiceFeePercent`,
`advertisedQueueLength`, `version`, and its own `statusObservedAt`.

The fee is the endpoint's advertised **percentage**, not a guaranteed total quote;
gas and relayer rules can add cost. Health/queue are self-reported and do not prove
that a withdrawal will be accepted. The status schema follows the original
[relayer status handler](https://github.com/tornadocash/tornado-relayer/blob/2247730603f2c249f90da0b07058325619435387/src/contollers/status.js).
No submission, proof generation or funds transfer is performed by this service.
A client must freshly check the selected relayer and final fee/reward parameters
before constructing a withdrawal proof. A directory is optional discovery,
not an authorization to submit private data automatically.

`X-Privacy-Index-State` reports `ready`, `refreshing` or `stale`; the ETag and
body retain the original observation while a refresh fails. A catalogue is also stale if its earliest included endpoint status is over five
minutes old, even when assembly has just completed. Old data does not
become fresh because it was downloaded again. Unreachable/unverified candidates
are counted explicitly; the directory does not claim every historical candidate
is currently serviceable or that a stale directory remains current.

## Validation

```sh
npm test -- --runInBand tests/privacyRelayerStatus.test.js tests/privacyRelayerRpc.test.js tests/privacyRelayerDirectory.test.js tests/privacyRelayer.routes.test.js
npm test -- --runInBand --ci
```

Tests use synthetic registry/RPC/DNS/HTTPS responses and public verified runtime
bytecode fixtures. They make no relayer connections, send no on-chain transactions,
activate no live service and contain no wallet notes.
