const express = require("express");
const moment = require("moment");
const router = express.Router();

// IMPORTANT: do NOT destructure `masternodesArr` at require time. The
// masternode tracker REASSIGNS `dataStore.masternodesArr = []` every
// 10 seconds (see services/masternodeTracker.js) and pushes into the
// fresh array, so a captured reference would forever see the original
// empty `[]` from data/dataStore.js. Read the property on every call
// to pick up whatever the tracker most recently published. The same
// reasoning is documented at server.js (`masternodesProvider`), which
// uses an arrow function for exactly this reason.
const dataStore = require("../data/dataStore");

function endpointHost(value, { stripUnbracketedIpv6Port = false } = {}) {
  const text = String(value || "");
  if (!text) return "";

  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end > 0) return text.slice(1, end);
  }

  const firstColon = text.indexOf(":");
  const lastColon = text.lastIndexOf(":");
  if (firstColon === -1) return text;

  const tail = text.slice(lastColon + 1);
  if (firstColon === lastColon) {
    return /^\d+$/.test(tail) ? text.slice(0, lastColon) : text;
  }

  if (stripUnbracketedIpv6Port && /^\d+$/.test(tail)) {
    return text.slice(0, lastColon);
  }

  return text;
}

function searchHostCandidates(search) {
  const base = endpointHost(search);
  const stripped = endpointHost(search, { stripUnbracketedIpv6Port: true });
  return [...new Set([base, stripped].filter(Boolean))];
}

router.post("/mnsearch", (req, res) => {
  const { page = 1, sortBy = "", sortDesc = false } = req.body;
  const perPage = req.body.perPage > 0 && req.body.perPage <= 90 ? req.body.perPage : 30;
  const search = (req.body.search || "").replace(/ /g, "");

  const query = endpointHost(search);
  const queryHosts = searchHostCandidates(search);
  const isIpv6Query = queryHosts.some(candidate => candidate.includes(":"));

  const masternodesArr = Array.isArray(dataStore.masternodesArr)
    ? dataStore.masternodesArr
    : [];

  const filtered = masternodesArr
    .filter(mn => {
      const addressHost = endpointHost(mn.address, {
        stripUnbracketedIpv6Port: true,
      });
      const addressMatch = isIpv6Query
        ? queryHosts.includes(addressHost)
        : addressHost.includes(query);
      return (
        addressMatch ||
        String(mn.payee || "").toUpperCase().includes(query.toUpperCase())
      );
    })
    .map(mn => {
      const clone = { ...mn };
      clone.lastpaidtimeS = clone.lastpaidtime || -Infinity;
      clone.lastpaidtime = clone.lastpaidtime === 0 ? "Never Paid" : moment.unix(clone.lastpaidtime).fromNow();
      clone.lastseenS = clone.lastseen;
      clone.lastseen = moment.unix(clone.lastseen).fromNow();
      return clone;
    });

  if (sortBy === "lastSeen") {
    filtered.sort((a, b) => a.lastseenS - b.lastseenS);
  } else if (sortBy === "lastPayment") {
    filtered.sort((a, b) => a.lastpaidtimeS - b.lastpaidtimeS);
  } else if (sortBy) {
    filtered.sort((a, b) => (a[sortBy] < b[sortBy] ? -1 : a[sortBy] > b[sortBy] ? 1 : 0));
  }

  if (sortDesc) filtered.reverse();

  const paginated = filtered.slice((page - 1) * perPage, page * perPage);

  res.status(200).send({ returnArr: paginated, mnNumb: filtered.length });
});

module.exports = router;
module.exports.endpointHost = endpointHost;
