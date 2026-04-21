const geoip = require("geoip-country");
const countries = require("i18n-iso-countries");
const { client, rpcServices } = require("../services/rpcClient");
const data = require("../data/dataStore");

function componentToHex(c) {
  const hex = c.toString(16);
  return hex.length === 1 ? "0" + hex : hex;
}

function rgbToHex(r, g, b) {
  return "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
}

// Populate heat color map
for (let i = 255; i >= 0; i--) {
  data.mapFills["heat" + i] = rgbToHex(0, 255 - i, 255);
}

// Parse the outer dict key that Syscoin's `masternode_list` returns
// for each MN. Core serialises it as `COutPoint::ToStringShort()` =
// `"<txid>-<n>"` (see src/primitives/transaction.cpp). We split on
// the LAST dash so a hypothetical future change that embeds a dash
// inside the hash half still round-trips; txid is always 64 hex
// chars today, so this is belt-and-braces.
function parseOutpointKey(key) {
  if (typeof key !== "string") return null;
  const i = key.lastIndexOf("-");
  if (i <= 0 || i === key.length - 1) return null;
  const hash = key.slice(0, i);
  const n = Number(key.slice(i + 1));
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return null;
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
  return { collateralHash: hash.toLowerCase(), collateralIndex: n };
}

setInterval(() => {
  rpcServices(client.callRpc).masternode_list().call().then(masternodes => {

    data.masternodesArr = [];
    data.mapData = {};

    for (let key in masternodes) {
      const node = masternodes[key];
      // Additive enrichment: Syscoin Core's `masternode_list` values
      // don't carry `collateralHash`/`collateralIndex` directly, but
      // the object's outer key IS the outpoint (COutPoint::ToStringShort
      // => "<txid>-<n>"). Preserving that here lets the /gov endpoints
      // relay votes without a second round-trip per MN. No existing
      // consumer (mnSearch, mnList, mnStats) reads these fields, so
      // adding them is strictly additive.
      const outpoint = parseOutpointKey(key);
      if (outpoint) {
        node.collateralHash = outpoint.collateralHash;
        node.collateralIndex = outpoint.collateralIndex;
      }
      data.masternodesArr.push(node);

      if (geoip.lookup(node.address.split(':')[0]) != null) {
        let iso = geoip.lookup(node.address.split(':')[0]).country;
        let alpha3;
        try {
          alpha3 = countries.alpha2ToAlpha3(iso);
        } catch {
          continue;
        }

        if (data.mapData[alpha3] === undefined) {
          data.mapData[alpha3] = { masternodes: 1 };
        } else {
          data.mapData[alpha3].masternodes++;
        }
      }
    }

    data.masternodesArr.sort((a, b) => b.lastpaidtime - a.lastpaidtime);

    data.highestMN = Math.max(...Object.values(data.mapData).map(e => e.masternodes || 0));

    for (let country in data.mapData) {
      const intensity = Math.round((255 * data.mapData[country].masternodes) / data.highestMN);
      data.mapData[country].fillKey = "heat" + intensity;
    }

    console.log("[masternodeTracker] Map data updated at", new Date().toISOString());
  }).catch(err => {
    console.error("Failed to fetch masternode list:", err.message);
  });
}, 10000);
