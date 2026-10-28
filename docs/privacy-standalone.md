# Run the local privacy API

The privacy-only process serves public Ethereum Classic pool snapshots and the
public relayer directory. It does not start Syscoin RPC, masternode/governance
workers, the account database, or wallet/secret storage. It uses the existing
pool index and directory implementations and their normal verification and
backfill rules. The repository installation still includes the full backend's
dependencies.

## Start

Use Node.js 26.12.1 or later in the 26.x series. From this repository:

```sh
npm ci
cp .env.example .env
chmod 600 .env
# Edit .env and set PRIVACY_INDEX_RPC_URL to your Ethereum mainnet RPC.
npm run privacy:start
```

For example, if an Ethereum node is listening on this machine:

```text
PRIVACY_INDEX_RPC_URL=http://127.0.0.1:8545
```

`http://localhost:8545` is mapped to `127.0.0.1` without DNS; explicit IPv6
loopback such as `http://[::1]:8545` is also accepted. Remote RPC endpoints
must use HTTPS. The node must provide finalized blocks, historical logs and
the historical contract/state reads described in [pool indexing](privacy-index.md)
and [relayer discovery](privacy-relayers.md). A pruned or partially synced full
node may not serve all of that history; Ethereum mainnet is required.

The local API binds only `127.0.0.1`, port **3477** by default. Set
`PRIVACY_PORT` in `.env` to another port if needed. Its endpoints are
`http://127.0.0.1:3477/api/privacy/v1/relayers` and
`http://127.0.0.1:3477/api/privacy/v1/pools/eth-0.1/snapshot` (and the other
fixed pool IDs). A wallet must support a configurable privacy API URL and have
browser permission to access loopback; installing this service alone does not
configure an existing wallet. Pali also uses its selected Ethereum RPC for
independent public pool-wide verification.

Both services are enabled when the RPC is configured, unless their separate
`PRIVACY_INDEX_ENABLED=false` or `PRIVACY_RELAYER_DIRECTORY_ENABLED=false`
option is set. First use activates backfill; afterward checkpoints and complete
snapshots persist in `data/privacy-index/` and `data/privacy-relayers/` under
the working directory and resume after restart. Stop with Ctrl-C for graceful
shutdown. Run **one process per data directory**; these files do not have
cross-process writer locking. The full backend and this service must not share
the same data directory while both are running.

Initial historical backfill takes time and RPC resources. A `202` response
means it is still syncing; `503` means disabled or unavailable. A ready
snapshot is anchored to a finalized block. The pool root does not prove that
the withdrawal list is complete, so its completeness still depends on the
configured Ethereum RPC and scanner. See [pool indexing](privacy-index.md).

The local API accepts no wallet addresses, notes or nullifier queries. It
binds to loopback, validates the Host header, accepts browser requests only
from extension or local origins, and permits originless native clients such as
curl. Local programs and browser extensions can still contact it; these
checks are not authentication against other software on the same computer.
The upstream Ethereum provider can see pool-wide synchronization traffic and
timing. No relayer withdrawal submissions are proxied by this API.
