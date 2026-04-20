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

setInterval(() => {
  rpcServices(client.callRpc).masternode_list().call().then(masternodes => {

    data.masternodesArr = [];
    data.mapData = {};

    for (let key in masternodes) {
      const node = masternodes[key];
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
