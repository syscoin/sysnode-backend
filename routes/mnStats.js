const express = require("express");
const router = express.Router();
const calculations = require("../services/calculations");
const data = require("../data/dataStore");

router.get("/mnstats", (req, res) => {
  res.status(200).send({
    stats: calculations(),
    mapData: data.mapData,
    mapFills: data.mapFills
  });
});

module.exports = router;