'use strict';

const geoip = require('geoip-country');
const countries = require('i18n-iso-countries');

const HEX64 = /^[0-9a-fA-F]{64}$/;

// Parse the outer dict key that Syscoin's `masternode_list` returns
// for each MN. Core serialises it as `COutPoint::ToStringShort()` =
// `"<txid>-<n>"`. Split on the last dash for future-proofing even
// though txids are currently fixed 64-hex strings.
function parseOutpointKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.lastIndexOf('-');
  if (i <= 0 || i === key.length - 1) return null;
  const hash = key.slice(0, i);
  const n = Number(key.slice(i + 1));
  if (!HEX64.test(hash)) return null;
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
  return { collateralHash: hash.toLowerCase(), collateralIndex: n };
}

function endpointHost(value) {
  const text = String(value || '');
  if (!text) return '';

  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end > 0) return text.slice(1, end);
  }

  const firstColon = text.indexOf(':');
  const lastColon = text.lastIndexOf(':');
  if (firstColon === -1) return text;

  const tail = text.slice(lastColon + 1);
  if (firstColon === lastColon) {
    return /^\d+$/.test(tail) ? text.slice(0, lastColon) : text;
  }

  return /^\d+$/.test(tail) ? text.slice(0, lastColon) : text;
}

function countryAlpha3ForHost(host, lookupCountry = geoip.lookup) {
  if (!host || typeof lookupCountry !== 'function') return null;
  const geo = lookupCountry(host);
  const iso = geo && geo.country;
  if (!iso) return null;
  try {
    return countries.alpha2ToAlpha3(iso);
  } catch {
    return null;
  }
}

function buildMasternodeSnapshot(masternodes, { lookupCountry = geoip.lookup } = {}) {
  const masternodesArr = [];
  const mapData = {};

  for (const key of Object.keys(masternodes || {})) {
    const node = { ...masternodes[key] };
    const outpoint = parseOutpointKey(key);
    if (outpoint) {
      node.collateralHash = outpoint.collateralHash;
      node.collateralIndex = outpoint.collateralIndex;
    }
    masternodesArr.push(node);

    if (node.status !== 'ENABLED') continue;

    const alpha3 = countryAlpha3ForHost(endpointHost(node.address), lookupCountry);
    if (!alpha3) continue;

    if (mapData[alpha3] === undefined) {
      mapData[alpha3] = { masternodes: 1 };
    } else {
      mapData[alpha3].masternodes += 1;
    }
  }

  masternodesArr.sort((a, b) => b.lastpaidtime - a.lastpaidtime);
  const highestMN = Object.values(mapData).reduce(
    (max, entry) => Math.max(max, entry.masternodes || 0),
    0
  );

  return { masternodesArr, mapData, highestMN };
}

module.exports = {
  buildMasternodeSnapshot,
  countryAlpha3ForHost,
  endpointHost,
  parseOutpointKey,
};
