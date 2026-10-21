const {
  getStatsMetadata,
  hasStatsValue,
  markStatsFailure,
  markStatsSuccess,
  resetStatsMetadata,
  MAX_STATS_AGE_MS,
} = require('../lib/statsSnapshot');

beforeEach(resetStatsMetadata);

test('cold and failed-before-success groups remain unavailable', () => {
  markStatsFailure(['market', 'chain']);
  expect(hasStatsValue('market')).toBe(false);
  expect(getStatsMetadata().groups.market).toEqual({ status: 'unavailable', updated_at: null });
});

test('source failures preserve the last successful time and make only their own groups stale', () => {
  markStatsSuccess(['chain', 'node', 'governance'], 1_700_000_000_000);
  markStatsSuccess(['market'], 1_700_000_010_000);
  markStatsFailure(['market']);
  const groups = getStatsMetadata(1_700_000_020_000).groups;
  expect(groups.market).toEqual({ status: 'stale', updated_at: 1_700_000_010_000 });
  expect(groups.chain.status).toBe('ready');
  expect(hasStatsValue('market')).toBe(true);
});

test('a successful but no-longer-refreshed observation ages to stale without changing its time', () => {
  const at = 1_700_000_000_000;
  markStatsSuccess(['chain'], at);
  expect(getStatsMetadata(at + MAX_STATS_AGE_MS).groups.chain.status).toBe('ready');
  expect(getStatsMetadata(at + MAX_STATS_AGE_MS + 1).groups.chain).toEqual({ status: 'stale', updated_at: at });
  expect(hasStatsValue('chain')).toBe(true);
});

test('response objects are detached from internal freshness state', () => {
  const at = 1_700_000_000_000;
  markStatsSuccess(['node'], at);
  const groups = getStatsMetadata(at).groups;
  groups.node.updated_at = 0;
  groups.node.status = 'unavailable';
  expect(getStatsMetadata(at).groups.node).toEqual({ status: 'ready', updated_at: at });
});
