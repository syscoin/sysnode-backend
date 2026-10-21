'use strict';

// Observation time belongs to the successful source read, not the HTTP request.
// Stale values may be useful, but cold defaults must never look like real data.
const GROUPS = ['chain', 'node', 'governance', 'market'];
const MAX_STATS_AGE_MS = 120_000;
const state = Object.fromEntries(GROUPS.map((group) => [group, {
  status: 'unavailable',
  updated_at: null,
}]));

function markStatsSuccess(groups, now = Date.now()) {
  for (const group of groups) {
    state[group] = { status: 'ready', updated_at: now };
  }
}

function markStatsFailure(groups) {
  for (const group of groups) {
    state[group] = {
      status: hasStatsValue(group) ? 'stale' : 'unavailable',
      updated_at: state[group].updated_at,
    };
  }
}

function hasStatsValue(group) {
  return Number.isFinite(state[group]?.updated_at) && state[group].updated_at > 0;
}

function getStatsMetadata(now = Date.now()) {
  return {
    groups: Object.fromEntries(GROUPS.map((group) => {
      const value = state[group];
      return [group, {
        ...value,
        status: value.status === 'ready' && now - value.updated_at > MAX_STATS_AGE_MS
          ? 'stale'
          : value.status,
      }];
    })),
  };
}

function resetStatsMetadata() {
  for (const group of GROUPS) state[group] = { status: 'unavailable', updated_at: null };
}

module.exports = {
  getStatsMetadata,
  hasStatsValue,
  markStatsFailure,
  markStatsSuccess,
  resetStatsMetadata,
  MAX_STATS_AGE_MS,
};
