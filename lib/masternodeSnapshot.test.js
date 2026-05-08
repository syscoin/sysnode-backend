'use strict';

const {
  buildMasternodeSnapshot,
  endpointHost,
  parseOutpointKey,
} = require('./masternodeSnapshot');

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

function lookupCountry(host) {
  const countries = {
    '203.0.113.1': { country: 'DE' },
    '203.0.113.2': { country: 'US' },
    '2001:db8::1': { country: 'GB' },
  };
  return countries[host] || null;
}

describe('parseOutpointKey', () => {
  test('extracts collateral hash/index from Core masternode_list keys', () => {
    expect(parseOutpointKey(`${H1}-7`)).toEqual({
      collateralHash: H1,
      collateralIndex: 7,
    });
  });

  test('rejects malformed outpoint keys', () => {
    expect(parseOutpointKey('not-an-outpoint')).toBe(null);
    expect(parseOutpointKey(`${H1}-nope`)).toBe(null);
  });
});

describe('endpointHost', () => {
  test('normalises IPv4, bracketed IPv6, and unbracketed IPv6 endpoints', () => {
    expect(endpointHost('203.0.113.1:8369')).toBe('203.0.113.1');
    expect(endpointHost('[2001:db8::1]:8369')).toBe('2001:db8::1');
    expect(endpointHost('2001:db8::1:8369')).toBe('2001:db8::1');
  });
});

describe('buildMasternodeSnapshot', () => {
  test('enriches all masternodes but counts only ENABLED nodes in mapData', () => {
    const out = buildMasternodeSnapshot(
      {
        [`${H1}-0`]: {
          status: 'ENABLED',
          address: '203.0.113.1:8369',
          lastpaidtime: 10,
        },
        [`${H2}-1`]: {
          status: 'POSE_BANNED',
          address: '203.0.113.2:8369',
          lastpaidtime: 20,
        },
        [`${H3}-2`]: {
          status: 'ENABLED',
          address: '[2001:db8::1]:8369',
          lastpaidtime: 30,
        },
      },
      { lookupCountry }
    );

    expect(out.masternodesArr).toHaveLength(3);
    expect(out.masternodesArr[0]).toMatchObject({
      collateralHash: H3,
      collateralIndex: 2,
    });
    expect(out.mapData).toEqual({
      DEU: { masternodes: 1 },
      GBR: { masternodes: 1 },
    });
    expect(out.highestMN).toBe(1);
  });

  test('returns an empty map when no enabled nodes have a known country', () => {
    const out = buildMasternodeSnapshot(
      {
        [`${H1}-0`]: {
          status: 'POSE_BANNED',
          address: '203.0.113.2:8369',
        },
      },
      { lookupCountry }
    );

    expect(out.mapData).toEqual({});
    expect(out.highestMN).toBe(0);
  });
});
