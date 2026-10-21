# Recovery alert integration tests

`npm test -- --runInBand` covers deterministic authentication, storage,
monitoring, outbox, freshness, and reorganization cases.

`npm run test:recovery-anvil` additionally runs the HTTP API against real Pali
contracts in an isolated local Anvil chain. Install Anvil 1.7.1 and the supported
Node dependencies first. CI runs this check before production deployment.
The test fails if Anvil is unavailable; it does not silently substitute mocks.

The integration test:

- Deploys the Pali ECDSA validator, guardian recovery module, EntryPoint v0.9,
  and smart-account implementation behind an OpenZeppelin ERC1967 proxy. The
  account's constructor argument points to that local EntryPoint; its executable
  contract source is unchanged.
- Schedules a recovery before alert enrollment and verifies the complete
  current-state snapshot, including its exact execution and expiration times.
- Exercises real `personal_sign`/ERC-7739/1271 verification through authenticated
  HTTP: wrong-account, wrong-chain and raw EOA signatures fail; a correct
  account-bound signature succeeds once.
- Confirms initiation and execution notices, completed attempts between polls,
  repeat-poll deduplication, a real Anvil chain reorganization, and authenticated
  opt-out.
- Rejects an unauthorized direct module removal and an invalid UserOperation
  signature. A real owner-signed UserOperation then removes guardian recovery,
  invalidating the pending operation without a `RecoveryCanceled` event. The
  owner's original ERC-1271 authority remains usable afterward.

Contract creation bytecodes are read from Pali commit
`2505f9a88d9a7bf3cc167bb08f39223ca95c378f` and the complete source is checked
against SHA-256
`073b5172698f9964b56fdbe2ff897024ec0b793fa8fa8b3df42b9335d858baa4`.
The guardian runtime must match the production registry's bytecode hash.
The fixture uses local deployment addresses and test-only keys held in memory.
It never connects a wallet to a public chain, submits a public transaction, or
loads production keys or funds.

By default the test downloads that immutable source from GitHub. For an offline
run, set `PALI_DEPLOYMENT_SOURCE` to a local copy of the same `deployment.ts`;
the digest check still applies. `ANVIL_BIN` can specify the Anvil executable.
Updating any bytecode pin requires rechecking the corresponding source, runtime,
storage layout and signature compatibility.
