'use strict';
const BN = require('bn.js');
const crypto = require('crypto');
const { failure } = require('./sentryManagement');
const { _internal } = require('./proposalPsbt');

// This is deliberately not a JSON-RPC proxy. Method names and argument
// shapes are chosen here; no URL, RPC method or operator secret comes from
// a browser. The configured service is the trusted chain observation source.
const METHODS = new Set(['getblockchaininfo', 'getblockhash', 'gettxout', 'protx_capabilities', 'protx_operator_key_info', 'protx_info', 'protx_list', 'getrawtransaction', 'testmempoolaccept', 'sendrawtransaction']);
function createSentryAdapter({ rpcCall, network, genesisHash, sdk, fundingClient, maxFeeSatoshis = '1000000' }) {
  if (!/^[a-f0-9]{64}$/.test(genesisHash || '')) throw failure('sentry_config_invalid');
  const bitcoinjs = fundingClient.bitcoinjs;
  const call = (method, args = []) => {
    if (!METHODS.has(method)) throw failure('rpc_method_forbidden');
    return rpcCall(method, args);
  };
  const assertNetwork = async (requested) => {
    if (requested !== network) throw failure('network_unavailable', 409);
    const [info, observedGenesis, capabilities] = await Promise.all([
      call('getblockchaininfo'), call('getblockhash', [0]),
      call('protx_capabilities').catch(() => { throw failure('core_sentry_capabilities_required', 503); }),
    ]);
    if (observedGenesis !== genesisHash || info.chain !== ({ mainnet: 'main', testnet: 'test', regtest: 'regtest' })[network]) throw failure('network_mismatch', 503);
    if (capabilities.version !== 1 || capabilities.genesisHash !== genesisHash || capabilities.network !== info.chain ||
        !Number.isSafeInteger(capabilities.height) || capabilities.height < 0 || !/^[a-f0-9]{64}$/.test(capabilities.blockHash || '')) throw failure('core_sentry_capabilities_required', 503);
    const era = capabilities.era;
    if (!['legacy-v3', 'pq-v4'].includes(era)) throw failure('protocol_not_supported', 503);
    return { chain: { genesisHash, era }, capabilities };
  };
  const script = (address) => address ? Buffer.from(bitcoinjs.address.toOutputScript(address, fundingClient.network)).toString('hex') : '';
  const networkEncoding = { bech32Hrp: fundingClient.network.bech32, pubKeyHash: fundingClient.network.pubKeyHash, scriptHash: fundingClient.network.scriptHash };
  const keyId = (address) => {
    const value = script(address);
    if (/^0014[0-9a-f]{40}$/.test(value)) return value.slice(4);
    if (/^76a914[0-9a-f]{40}88ac$/.test(value)) return value.slice(6, -4);
    throw failure('invalid_authority_address');
  };
  async function context(requested, proTxHash, collateral) {
    const { chain, capabilities } = await assertNetwork(requested);
    if (collateral) {
      if (!/^[a-f0-9]{64}$/.test(collateral.txid || '') || !Number.isSafeInteger(collateral.vout) || collateral.vout < 0) throw failure('invalid_collateral');
      if (!/^[1-9][0-9]*$/.test(capabilities.requiredCollateralSatoshis || '')) throw failure('core_sentry_capabilities_required', 503);
      const [collateralTransactionHex, coin] = await Promise.all([
        call('getrawtransaction', [collateral.txid, false]), call('gettxout', [collateral.txid, collateral.vout, true]),
      ]);
      if (!coin || !(coin.confirmations > 0)) throw failure('collateral_not_confirmed_or_spent', 409);
      const registrations = await call('protx_list', ['registered', true]);
      if (!Array.isArray(registrations)) throw failure('node_list_unavailable', 503);
      if (registrations.some((entry) => entry.collateralHash === collateral.txid && entry.collateralIndex === collateral.vout)) throw failure('collateral_already_registered', 409);
      return { chain, network: networkEncoding, registration: { collateralTransactionHex,
        collateralVout: collateral.vout, requiredCollateralSatoshis: capabilities.requiredCollateralSatoshis } };
    }
    const raw = await call('protx_info', [proTxHash]);
    const state = raw.state;
    if (!state || raw.proTxHash !== proTxHash) throw failure('node_not_found', 404);
    // Preserve explicit unavailable states; management never treats a banned
    // or not-yet-confirmed node as ready merely because a key was imported.
    const registration = await call('getrawtransaction', [proTxHash, true]);
    if (!(registration.confirmations > 0)) throw failure('node_not_confirmed', 409);
    const node = {
      proTxHash,
      operatorPublicKey: state.pubKeyOperator,
      service: state.service,
      operatorPayoutScript: script(state.operatorPayoutAddress),
      nevmAddress: state.nevmAddress || '',
      collateralOutpoint: { txid: raw.collateralHash, vout: raw.collateralIndex },
      confirmedHash: state.confirmedHash,
      poseBanHeight: state.PoSeBanHeight,
      revocationReason: state.revocationReason,
      ownerKeyId: state.ownerKeyType === 'slh-dsa' && state.pqOwnerPublicKey && state.pqOwnerKeyVersion > 0
        ? '00'.repeat(20) : keyId(state.ownerAddress),
      votingKeyId: keyId(state.votingAddress),
      payoutScript: script(state.payoutAddress),
      ...(state.pqOwnerPublicKey ? { pqOwnerRecord: { publicKey: state.pqOwnerPublicKey,
        keyVersion: state.pqOwnerKeyVersion, activatedHeight: state.pqOwnerKeyActivationHeight } } : {}),
      ...(state.pqVotingPublicKey ? { pqVotingPublicKey: state.pqVotingPublicKey } : {}),
    };
    if (chain.era === 'pq-v4' || capabilities.preparationActive === true) {
      let key;
      try { key = await call('protx_operator_key_info', [proTxHash, true]); }
      catch (error) {
        if (error?.code !== -8 || error?.message !== 'Masternode has no active global key') throw error;
      }
      if (key) {
        if (key.genesisHash !== genesisHash || key.height !== capabilities.height || key.blockHash !== capabilities.blockHash) throw failure('chain_context_changed', 409);
        if (typeof key.hasGlobalKey !== 'boolean' || typeof key.active !== 'boolean') throw failure('core_sentry_capabilities_required', 503);
        if (key.hasGlobalKey) {
          node.globalKeyVersion = key.keyVersion;
          node.operatorRevoked = key.active === false || key.revoked === true;
          node.pqRecord = { version: key.recordVersion, profile: key.profile, publicKey: key.publicKey,
            keyVersion: key.keyVersion, childKeyCommitmentHex: key.childKeyCommitment, activatedHeight: key.activatedHeight };
          if (chain.era === 'pq-v4') node.operatorPublicKey = key.publicKey;
        } else if (chain.era === 'pq-v4') node.operatorPublicKey = '';
      } else if (chain.era === 'pq-v4') node.operatorPublicKey = '';
    }
    return { chain, node, network: networkEncoding,
      allowOperatorPreparation: capabilities.preparationActive === true,
      allowOwnerPreparation: capabilities.preparationActive === true };
  }
  async function priorTransactions(tx) {
    const ids = [...new Set(tx.ins.map((input) => Buffer.from(input.hash).reverse().toString('hex')))];
    if (!ids.length || ids.length > 32) throw failure('funding_input_limit');
    return Promise.all(ids.map((id) => call('getrawtransaction', [id, false])));
  }
  const decode = (hex) => bitcoinjs.Transaction.fromHex(hex);
  function psbtFor(tx, fundingPsbt) {
    const original = bitcoinjs.Psbt.fromBase64(fundingPsbt, { network: fundingClient.network });
    const result = new bitcoinjs.Psbt({ network: fundingClient.network });
    result.setVersion(tx.version); result.setLocktime(tx.locktime);
    tx.ins.forEach((input, index) => result.addInput({
      ...original.data.inputs[index], hash: input.hash, index: input.index, sequence: input.sequence,
    }));
    tx.outs.forEach((output) => result.addOutput({ script: output.script, value: output.value }));
    // The SDK moves the zero-value payload to the last output. Match public
    // address metadata by the actual script/value, never by an old index.
    tx.outs.forEach((output, index) => {
      const originalIndex = original.txOutputs.findIndex((candidate) =>
        candidate.value === output.value && Buffer.from(candidate.script).equals(Buffer.from(output.script)));
      const metadata = original.data.outputs[originalIndex];
      if (metadata?.unknownKeyVals) metadata.unknownKeyVals.forEach((entry) => result.addUnknownKeyValToOutput(index, entry));
    });
    return result;
  }
  async function liveReview(row, transactionHex) {
    const isService = row.prepared.request.operation === 'updateService';
    const current = row.prepared.collateralOutpoint
      ? await context(row.network, undefined, row.prepared.collateralOutpoint)
      : await context(row.network, row.protx_hash);
    const anchor = ({ chain, node, registration }) => ({ chain, ...(node ? { node } : {}), ...(registration ? { registration } : {}) });
    if (JSON.stringify(anchor(current)) !== JSON.stringify(row.prepared.anchor)) throw failure('node_state_changed', 409);
    const tx = decode(transactionHex);
    const previousTransactions = await priorTransactions(tx);
    const request = { ...row.prepared.request, transactionHex };
    const reviewContext = { ...current, previousTransactions, maxFeeSatoshis };
    const review = isService ? sdk.reviewSentryOperation(request, reviewContext) : sdk.reviewSentryManagementOperation(request, reviewContext);
    if (isService && review.authorizationHash !== row.prepared.review.authorizationHash) throw failure('operation_changed', 409);
    if (!isService && !sdk.matchesSentryManagementIntent(row.prepared.request, request)) throw failure('operation_changed', 409);
    const expected = sdk.decodeSentryTransaction(row.prepared.request.transactionHex);
    const actual = sdk.decodeSentryTransaction(transactionHex);
    const feeIndependentShape = (transaction) => ({
      version: transaction.version, lockTime: transaction.lockTime,
      inputs: transaction.inputs.map(({ txid, vout, sequence }) => ({ txid, vout, sequence })),
      outputs: transaction.outputs.filter((output) => !output.scriptHex.startsWith('6a')),
    });
    if (JSON.stringify(feeIndependentShape(expected)) !== JSON.stringify(feeIndependentShape(actual))) throw failure('operation_changed', 409);
    const valid = isService ? await sdk.verifySentryOperation(request, reviewContext) : await sdk.verifySentryManagementOperation(request, reviewContext);
    if (!valid) throw failure('invalid_node_authorization');
    return { tx, request, reviewContext };
  }
  return {
    async capabilities() {
      const { chain, capabilities } = await assertNetwork(network);
      return { version: 1, network, chain, preparationActive: capabilities.preparationActive === true, ...sdk.getSentryCapabilities(), operations: ['register', 'updateService', 'updateRegistrar', 'revoke',
        ...(capabilities.preparationActive || chain.era === 'pq-v4' ? ['registerOperator'] : []), ...(chain.era === 'pq-v4' ? ['rotateOperator'] : [])], providers: [{ id: 'self-hosted', name: 'Self-hosted', supported: true }, { id: 'nodehub', name: 'NodeHub', supported: false, reason: 'Provider integration is not configured. Keys remain in Pali.' }] };
    },
    context,
    async prepare(body) {
      const operation = body.operation || 'updateService';
      const current = operation === 'register' ? await context(body.network, undefined, body.collateralOutpoint) : await context(body.network, body.proTxHash);
      _internal.assertXpubMatchesNetwork(body.xpub, network);
      _internal.assertChangeAddress(bitcoinjs, body.changeAddress, fundingClient.network, network);
      const feeRate = _internal.normalizeFeeRate(body.feeRate);
      const registrations = await call('protx_list', ['registered', true]);
      if (!Array.isArray(registrations)) throw failure('node_list_unavailable', 503);
      const changes = { ...body.changes };
      for (const name of ['ownerAddress', 'votingAddress']) {
        if (Object.hasOwn(changes, name)) { changes[name === 'ownerAddress' ? 'ownerKeyId' : 'votingKeyId'] = keyId(changes[name]); delete changes[name]; }
      }
      if (Object.hasOwn(changes, 'payoutAddress')) { changes.payoutScript = script(changes.payoutAddress); delete changes.payoutAddress; }
      if (operation === 'updateRegistrar' && current.allowOwnerPreparation && changes.pqOwnerPublicKey) changes.ownerPreparation = true;
      if (operation === 'registerOperator' || operation === 'rotateOperator') {
        changes.mode = operation === 'registerOperator' ? 'initial' : 'rotate';
        changes.candidate = { version: 1, profile: 1, keyVersion: changes.keyVersion,
          publicKey: changes.operatorPublicKey, childKeyCommitmentHex: changes.childKeyCommitment, activatedHeight: 0 };
        delete changes.keyVersion; delete changes.operatorPublicKey; delete changes.childKeyCommitment;
      }
      if (Object.hasOwn(changes, 'operatorPayoutAddress')) {
        changes.operatorPayoutScript = script(changes.operatorPayoutAddress);
        delete changes.operatorPayoutAddress;
      }
      if (Object.hasOwn(changes, 'nevmAddress')) {
        changes.nevmAddress = changes.nevmAddress.toLowerCase();
        if (changes.nevmAddress !== current.node.nevmAddress) {
          if (!/^[a-f0-9]{64}$/.test(current.node.confirmedHash || '') || /^0+$/.test(current.node.confirmedHash)) throw failure('node_not_confirmed', 409);
          if (current.node.poseBanHeight !== -1) throw failure('node_banned', 409);
        }
        if (changes.nevmAddress) {
          if (registrations.some((node) => node.proTxHash !== body.proTxHash && node.state?.nevmAddress?.toLowerCase() === changes.nevmAddress)) throw failure('nevm_address_in_use', 409);
        }
      }
      if (['updateService', 'revoke'].includes(operation) && current.chain.era === 'pq-v4' && (!current.node.pqRecord || current.node.operatorRevoked)) throw failure('operator_enrollment_required', 409);
      const builder = { updateService: sdk.buildSentryServiceUpdate, register: sdk.buildSentryRegistration,
        updateRegistrar: sdk.buildSentryRegistrarUpdate, revoke: sdk.buildSentryRevocation,
        registerOperator: sdk.buildSentryOperatorUpdate, rotateOperator: sdk.buildSentryOperatorUpdate }[operation];
      if (!builder) throw failure('operation_not_supported');
      const buildArgs = { ...current, ...changes, ...(body.collateralOutpoint ? { collateralOutpoint: body.collateralOutpoint } : {}) };
      const placeholder = builder({ ...buildArgs,
        inputs: [{ txid: 'ff'.repeat(32), vout: 0 }], outputs: [],
      });
      const payload = decode(placeholder.transactionHex).outs.at(-1).script;
      if (!fundingClient.fetchUtxos) throw failure('sentry_funding_unavailable', 503);
      const rawFunding = await fundingClient.fetchUtxos(body.xpub);
      const fundingOutputs = Array.isArray(rawFunding) ? rawFunding : rawFunding?.utxos;
      if (!Array.isArray(fundingOutputs) || fundingOutputs.length > 10000) throw failure('invalid_funding_response', 503);
      const reserved = new Set(registrations.map((entry) => `${entry.collateralHash}:${entry.collateralIndex}`));
      if (body.collateralOutpoint) reserved.add(`${body.collateralOutpoint.txid}:${body.collateralOutpoint.vout}`);
      const available = fundingOutputs.filter((entry) => !entry.assetInfo && entry.confirmations > 0 && !reserved.has(`${entry.txid || entry.txId}:${entry.vout}`));
      if (!available.length) throw failure('no_unreserved_fee_funds');
      const funded = await fundingClient.createTransaction({ rbf: false }, body.changeAddress,
        [{ script: Buffer.from(payload), value: new BN(0) }], feeRate, body.xpub, { utxos: available, assets: [] });
      if (!funded?.psbt) throw failure('funding_failed');
      const fundingPsbt = funded.psbt.toBase64();
      const unsigned = funded.psbt.__CACHE.__TX;
      const request = builder({ ...buildArgs,
        inputs: unsigned.ins.map((input) => ({ txid: Buffer.from(input.hash).reverse().toString('hex'), vout: input.index, sequence: input.sequence })),
        outputs: unsigned.outs.filter((output) => output.script[0] !== 0x6a).map((output) => ({ valueSatoshis: String(output.value), scriptHex: Buffer.from(output.script).toString('hex') })),
        lockTime: unsigned.locktime,
      });
      const previousTransactions = await priorTransactions(decode(request.transactionHex));
      const review = operation === 'updateService' ? sdk.reviewSentryOperation(request, { ...current, previousTransactions, maxFeeSatoshis })
        : sdk.reviewSentryManagementOperation(request, { ...current, previousTransactions, maxFeeSatoshis });
      return { request, review, fundingPsbt,
        anchor: { chain: current.chain, ...(current.node ? { node: current.node } : {}), ...(current.registration ? { registration: current.registration } : {}) },
        ...(body.collateralOutpoint ? { collateralOutpoint: body.collateralOutpoint } : {}) };
    },
    async authorize(row, authorization) {
      const validator = row.prepared.request.operation === 'updateService' ? sdk.validateSentryOperationRequest : sdk.validateSentryManagementRequest;
      validator({ ...row.prepared.request, transactionHex: authorization?.transactionHex });
      const { tx } = await liveReview(row, authorization.transactionHex);
      return { psbt: { psbt: psbtFor(tx, row.prepared.fundingPsbt).toBase64(), assets: '[]' }, feeSatoshis: row.prepared.review.feeSatoshis };
    },
    async validateSigned(row, signedPsbt) {
      if (typeof signedPsbt !== 'string' || signedPsbt.length > 300000) throw failure('invalid_signed_transaction');
      const psbt = bitcoinjs.Psbt.fromBase64(signedPsbt, { network: fundingClient.network });
      const tx = psbt.extractTransaction();
      await liveReview(row, tx.toHex());
      const currentNodes = await call('protx_list', ['registered', true]);
      if (!Array.isArray(currentNodes)) throw failure('node_list_unavailable', 503);
      const collateral = new Set(currentNodes.map((entry) => `${entry.collateralHash}:${entry.collateralIndex}`));
      if (tx.ins.some((input) => collateral.has(`${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`))) throw failure('registered_collateral_spend');
      const accepted = await call('testmempoolaccept', [[tx.toHex()]]);
      if (!Array.isArray(accepted) || accepted.length !== 1 || !accepted[0].allowed) throw failure('transaction_rejected', 422);
      return { transactionHex: tx.toHex(), txid: tx.getId() };
    },
    async validateStored(row) {
      await assertNetwork(row.network);
      if (typeof row.signed_hex !== 'string' || row.signed_hex.length > 400000 || decode(row.signed_hex).getId() !== row.txid) throw failure('stored_transaction_invalid', 409);
      const currentNodes = await call('protx_list', ['registered', true]);
      if (!Array.isArray(currentNodes)) throw failure('node_list_unavailable', 503);
      const collateral = new Set(currentNodes.map((entry) => `${entry.collateralHash}:${entry.collateralIndex}`));
      if (decode(row.signed_hex).ins.some((input) => collateral.has(`${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`))) throw failure('registered_collateral_spend');
      const accepted = await call('testmempoolaccept', [[row.signed_hex]]);
      if (!Array.isArray(accepted) || accepted.length !== 1 || !accepted[0].allowed) throw failure('transaction_rejected', 422);
    },
    broadcast: (hex) => call('sendrawtransaction', [hex]),
    async readback(row) {
      let tx;
      try { tx = await call('getrawtransaction', [row.txid, true]); }
      catch (error) {
        // Core also uses -5 when txindex is disabled or still syncing. Only
        // its definitive indexed not-found response is absence; transport,
        // protocol and index failures leave the journal unchanged.
        if (error?.code === -5 && error.message === 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.') {
          await assertNetwork(row.network);
          return { confirmed: false, matches: false };
        }
        throw error;
      }
      if (!(tx.confirmations > 0)) {
        await assertNetwork(row.network);
        return { confirmed: false, matches: false, known: true };
      }
      const operation = row.prepared.request.operation;
      const observed = await context(row.network, operation === 'register' ? row.txid : row.protx_hash);
      if (operation === 'revoke') return { confirmed: true, matches: observed.node.poseBanHeight >= 0 && observed.node.revocationReason === Number(row.prepared.review.fields.reason) };
      if (operation === 'registerOperator' || operation === 'rotateOperator') return { confirmed: true,
        matches: observed.node.pqRecord?.publicKey === row.prepared.review.fields.operatorPublicKey &&
          observed.node.pqRecord?.keyVersion === Number(row.prepared.review.fields.globalKeyVersion) };
      if (operation === 'register' || operation === 'updateRegistrar') {
        const fields = row.prepared.review.fields;
        const expected = Object.entries({ ownerKeyId: fields.ownerKeyId, votingKeyId: fields.votingKeyId,
          service: fields.service, payoutScript: fields.payoutAddress ? script(fields.payoutAddress) : undefined,
          operatorPublicKey: fields.operatorPublicKey, pqVotingPublicKey: fields.pqVotingPublicKey });
        if (fields.pqOwnerPublicKey && observed.node.pqOwnerRecord?.publicKey !== fields.pqOwnerPublicKey) return { confirmed: true, matches: false };
        return { confirmed: true, matches: expected.every(([key, value]) => !value || observed.node[key]?.toLowerCase() === value.toLowerCase()) };
      }
      const intended = row.prepared.review.changes;
      return { confirmed: true, matches: ['service', 'operatorPayoutScript', 'nevmAddress'].every((key) => observed.node[key].toLowerCase() === intended[key].next.toLowerCase()) };
    },
  };
}
function createConfiguredSentryAdapter({ rpcCall, network, genesisHash, fundingClient }) {
  if (!network || !genesisHash || !fundingClient) return null;
  let loaded;
  const load = () => {
    if (!loaded) loaded = import('@sidhujag/sysweb3-sentry').then((sdk) =>
      createSentryAdapter({ rpcCall, network, genesisHash, sdk, fundingClient }));
    return loaded;
  };
  return Object.fromEntries(['capabilities', 'context', 'prepare', 'authorize', 'validateSigned', 'validateStored', 'broadcast', 'readback']
    .map((method) => [method, async (...args) => (await load())[method](...args)]));
}
function createSentryRpc(client) {
  return async (method, args = []) => {
    if (!METHODS.has(method)) throw failure('rpc_method_forbidden');
    const id = crypto.randomUUID();
    let data;
    try { data = (await client.instance.post(client.url, { jsonrpc: '1.0', id, method, params: args })).data; }
    catch (error) {
      if (!error?.response?.data?.error) throw failure('sentry_rpc_unavailable', 503);
      data = error.response.data;
    }
    if (!data || data.id !== id) throw failure('sentry_rpc_response_mismatch', 503);
    if (data.error) throw Object.assign(new Error(data.error.message), { code: data.error.code });
    return data.result;
  };
}
module.exports = { createSentryAdapter, createConfiguredSentryAdapter, createSentryRpc, METHODS };
