const express = require("express");
const fs = require("fs");
const Papa = require("papaparse");
const router = express.Router();

router.get("/mnCount", (req, res) => {
  fs.readFile("/root/sysnode/data.csv", "utf8", (err, data) => {
    if (err) return res.status(500).send(err);

    const cleaned = data.replace(/\r\n/g, "\n");
    Papa.parse(cleaned, {
      delimiter: ";",
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim().toLowerCase().replace(/\W/g, "_"),
      complete: results => {
        const transformed = results.data
          .filter(row => row.timestamp && row.amount)
          .map(row => ({
            date: new Date(parseInt(row.timestamp)).toISOString().split("T")[0],
            users: parseInt(row.amount)
          }));
        res.json(transformed);
      }
    });
  });
});

module.exports = router;