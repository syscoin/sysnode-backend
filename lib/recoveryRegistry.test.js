const {
  ZK_TANENBAUM,
  configuredRecoveryChains,
} = require('./recoveryRegistry');

test('only enabled zkTanenbaum receives the scoped sparse-block observation policy', () => {
  expect(configuredRecoveryChains({ enabled: 'false' })).toEqual([]);
  const [chain] = configuredRecoveryChains({ enabled: 'true' });
  expect(chain).toMatchObject({
    chainId: 57057,
    confirmations: 0,
    maxBlockAgeMs: 420000,
  });
  expect(Object.isFrozen(ZK_TANENBAUM)).toBe(true);
  expect(configuredRecoveryChains({ enabled: 'true' })).toHaveLength(1);
});
