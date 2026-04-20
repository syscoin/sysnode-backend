const express = require("express");
const router = express.Router();
const { client, rpcServices } = require("../services/rpcClient");

router.get("/mnList", async (req, res) => {
  try {
    const masternodes = await rpcServices(client.callRpc).masternode_list().call();
    res.status(200).json(masternodes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
