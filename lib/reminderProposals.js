'use strict';

// A notification/presentation limit, not a new Core consensus rule. Never
// reinterpret a millisecond-looking on-chain value as seconds.
const MAX_PRESENTATION_EPOCH = 253402300799; // 9999-12-31T23:59:59Z

function supportedProposalWindow(start, end) {
  return (
    Number.isSafeInteger(start) &&
    start >= 0 &&
    Number.isSafeInteger(end) &&
    end > start &&
    end <= MAX_PRESENTATION_EPOCH
  );
}

function parseReminderProposals(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  for (const [key, entry] of Object.entries(raw)) {
    if (
      !/^[0-9a-f]{64}$/i.test(key) ||
      /^0+$/.test(key) ||
      !entry ||
      entry.ObjectType !== 1 ||
      entry.fBlockchainValidity !== true ||
      entry.fCachedValid !== true ||
      entry.fCachedDelete !== false
    )
      continue;
    let data;
    try {
      data = JSON.parse(entry.DataString);
    } catch {
      continue;
    }
    if (!data || !supportedProposalWindow(data.start_epoch, data.end_epoch))
      continue;
    // Core's map key is GetHash(), the governance object/voting identity.
    // entry.Hash is GetDataHash() and must not be used to match vote receipts.
    out.push({
      hash: key.toLowerCase(),
      startEpoch: data.start_epoch,
      endEpoch: data.end_epoch,
    });
  }
  return out;
}
module.exports = {
  parseReminderProposals,
  supportedProposalWindow,
  MAX_PRESENTATION_EPOCH,
};
