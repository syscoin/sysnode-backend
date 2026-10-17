'use strict';

const crypto = require('crypto');
const { parseVoteString } = require('./voteReceipts');
const RPC_TIMEOUT_MS = 10000;
const error = (code, fields = {}) =>
  Object.assign(new Error(code), { code, ...fields });

// Fixed read/vote methods only. Keep credentials on the existing configured
// client/interceptors; no caller-supplied endpoint or arbitrary RPC method.
function createGovernanceRpc(client, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
  async function call(method, params, externalSignal) {
    const writing = method === 'voteraw';
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted)
      throw error('not_submitted', { notSubmitted: true });
    externalSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    const id = crypto.randomUUID();
    let invoked = false;
    let rejectOnAbort;
    try {
      let response;
      try {
        if (controller.signal.aborted)
          throw error('not_submitted', { notSubmitted: true });
        invoked = true;
        const aborted = new Promise((_, reject) => {
          rejectOnAbort = () => reject(error('transport_aborted'));
          controller.signal.addEventListener('abort', rejectOnAbort, {
            once: true,
          });
        });
        response = await Promise.race([
          client.instance.post(
            client.url,
            { jsonrpc: '1.0', id, method, params },
            {
              signal: controller.signal,
              timeout: timeoutMs,
              maxContentLength: 16 * 1024 * 1024,
              maxBodyLength: 64 * 1024,
              maxRedirects: 0,
            }
          ),
          aborted,
        ]);
      } catch (cause) {
        // Core normally returns a JSON-RPC error with HTTP 500. That remains
        // a definite rejection, unlike a timeout/disconnect/malformed envelope.
        if (cause?.response?.data) response = cause.response;
        else throw cause;
      }
      const body = response?.data;
      if (
        !body ||
        body.id !== id ||
        !Object.hasOwn(body, 'error') ||
        !Object.hasOwn(body, 'result')
      ) {
        throw error('invalid_rpc_response');
      }
      if (body.error !== null) {
        if (
          !body.error ||
          !Number.isSafeInteger(body.error.code) ||
          typeof body.error.message !== 'string'
        ) {
          throw error('invalid_rpc_response');
        }
        throw error('core_rejected', {
          definiteCoreRejection: true,
          coreCode: body.error.code,
          // Core errors are classified to public codes by the relay layer.
          message: body.error.message.slice(0, 2048),
        });
      }
      if (
        writing
          ? body.result !== 'Voted successfully'
          : !body.result ||
            typeof body.result !== 'object' ||
            Array.isArray(body.result)
      ) {
        throw error('invalid_rpc_result');
      }
      if (
        !writing &&
        Object.entries(body.result).some(
          ([hash, vote]) =>
            !/^[0-9a-f]{64}$/i.test(hash) || !parseVoteString(vote)
        )
      ) {
        throw error('invalid_rpc_result');
      }
      return body.result;
    } catch (cause) {
      if (cause?.definiteCoreRejection || cause?.notSubmitted) throw cause;
      if (writing && invoked)
        throw error('submission_unknown', { uncertain: true });
      throw error('governance_rpc_unavailable');
    } finally {
      clearTimeout(timer);
      if (rejectOnAbort)
        controller.signal.removeEventListener('abort', rejectOnAbort);
      externalSignal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
  return {
    voteRaw: (
      hash,
      index,
      proposal,
      signal,
      outcome,
      time,
      signature,
      options = {}
    ) =>
      call(
        'voteraw',
        [hash, index, proposal, signal, outcome, time, signature],
        options.signal
      ),
    getCurrentVotes: (proposal) => call('gobject_getcurrentvotes', [proposal]),
  };
}

module.exports = { createGovernanceRpc, RPC_TIMEOUT_MS };
