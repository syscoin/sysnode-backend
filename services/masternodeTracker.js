const { client, rpcServices } = require("../services/rpcClient");
const data = require("../data/dataStore");
const { buildMasternodeSnapshot } = require("../lib/masternodeSnapshot");

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
    const snapshot = buildMasternodeSnapshot(masternodes);
    data.masternodesArr = snapshot.masternodesArr;
    data.mapData = snapshot.mapData;
    data.masternodesUpdatedAt = Date.now();
    data.highestMN = snapshot.highestMN;

    for (let country in data.mapData) {
      const intensity = data.highestMN > 0
        ? Math.round((255 * data.mapData[country].masternodes) / data.highestMN)
        : 0;
      data.mapData[country].fillKey = "heat" + intensity;
    }

    console.log("[masternodeTracker] Map data updated at", new Date().toISOString());
  }).catch(err => {
    console.error("Failed to fetch masternode list:", err.message);
  });
}, 10000);
