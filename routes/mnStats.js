const express = require("express");
const router = express.Router();
const calculations = require("../services/calculations");
const data = require("../data/dataStore");
const { getStatsMetadata } = require("../lib/statsSnapshot");

router.get("/mnstats", (req, res) => {
  res.status(200).send({
    stats: calculations(),
    stats_meta: getStatsMetadata(),
    mapData: data.mapData,
    mapFills: data.mapFills
  });
});

module.exports = router;
