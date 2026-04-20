const express = require("express");
const moment = require("moment");
const router = express.Router();
const { masternodesArr } = require("../data/dataStore");

router.post("/mnSearch", (req, res) => {
  const { page = 1, sortBy = "", sortDesc = false } = req.body;
  const perPage = req.body.perPage > 0 && req.body.perPage <= 90 ? req.body.perPage : 30;
  const search = (req.body.search || "").replace(/ /g, "");

  const query = search.includes(":") ? search.split(":")[0] : search;

  const filtered = masternodesArr
    .filter(mn =>
      mn.address.split(":")[0].includes(query) ||
      mn.payee.toUpperCase().includes(query.toUpperCase())
    )
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