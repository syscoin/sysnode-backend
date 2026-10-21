const { createRecoveryRpc } = require('./recoveryRpc');

// Compiled from PaliGuardianRecoveryModule.sol with solc 0.8.28, Cancun,
// viaIR, optimizer 200, metadata disabled. The creation bytecode is identical
// to Pali's canonical module. Runtime attestation guards the storage reader.
const ZK_TANENBAUM = Object.freeze({
  chainId: 57057,
  name: 'zkTanenbaum',
  testnet: true,
  rpcUrl: 'https://rpc-zk.tanenbaum.io',
  explorerUrl: 'https://explorer-zk.tanenbaum.io',
  recoveryModule: '0x8F919FC9A92da490d305054BfD862379D2760F84',
  runtimeHash:
    '0x542ee89b55395aad286ed856bfad874594ed7ae5b5066d93a52cb2e178e9d446',
  confirmations: 2,
});

function configuredRecoveryChains({
  enabled = process.env.RECOVERY_ALERTS_ENABLED,
  now = Date.now,
} = {}) {
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false')
    throw new Error('RECOVERY_ALERTS_ENABLED_invalid');
  if (enabled !== 'true') return [];
  return [{ ...ZK_TANENBAUM, rpc: createRecoveryRpc(ZK_TANENBAUM, { now }) }];
}

module.exports = { ZK_TANENBAUM, configuredRecoveryChains };
