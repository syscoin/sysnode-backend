'use strict';

const { Interface, ZeroAddress, ensNormalize, namehash, keccak256, toUtf8Bytes, concat } = require('ethers');

// Mainnet Tornado Classic registry. Its reviewed implementation is pinned:
// governance upgrades must be reviewed before this directory follows them.
const REGISTRY = '0x58e8dcc13be9780fc42e8723d8ead4cf46943df2';
const IMPLEMENTATION = '0x84b0c75c1f6211450fec7289c32d717adadd702a';
const IMPLEMENTATION_CODE_HASH = '0x8c83915c9dca7f9306b1930e43f3a05d7d2424bd0f9edbb324b06d2cfb03ca68';
const ENS = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
const DEPLOYMENT_BLOCK = 14173129;
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const MAX_CANDIDATES = 256;
const SOURCE = Object.freeze({ chainId: 1, registry: REGISTRY, implementation: IMPLEMENTATION,
  implementationCodeHash: IMPLEMENTATION_CODE_HASH, ensRegistry: ENS, deploymentBlock: DEPLOYMENT_BLOCK,
  urlRecord: 'mainnet-tornado.<registered ENS name>:url' });
const ABI = new Interface([
  'event RelayerRegistered(bytes32 relayer,string ensName,address relayerAddress,uint256 stakedAmount)',
  'function relayers(address) view returns (uint256 balance,bytes32 ensHash)',
  'function isRelayerRegistered(address,address) view returns (bool)',
  'function owner(bytes32) view returns (address)',
  'function resolver(bytes32) view returns (address)',
  'function text(bytes32,string) view returns (string)',
]);
function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('privacy_relayer_address_invalid');
  return value.toLowerCase();
}
function candidate(value) {
  if (!value || typeof value.ensName !== 'string' || Buffer.byteLength(value.ensName) > 255 ||
      !value.ensName || ensNormalize(value.ensName) !== value.ensName || namehash(value.ensName) !== value.ensHash) throw new Error('privacy_relayer_identity_invalid');
  const registeredAddress = address(value.registeredAddress);
  if (registeredAddress === ZeroAddress) throw new Error('privacy_relayer_identity_invalid');
  return { ensName: value.ensName, ensHash: value.ensHash, registeredAddress };
}
function urlNode(ensHash) { return keccak256(concat([ensHash, keccak256(toUtf8Bytes('mainnet-tornado'))])); }
module.exports = { REGISTRY, IMPLEMENTATION, IMPLEMENTATION_CODE_HASH, IMPLEMENTATION_SLOT, ENS,
  DEPLOYMENT_BLOCK, MAX_CANDIDATES, SOURCE, ABI, address, candidate, urlNode };
