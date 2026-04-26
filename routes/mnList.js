const express = require("express");
const router = express.Router();
const { client, rpcServices } = require("../services/rpcClient");
const securityLog = require("../lib/securityLog");

router.get("/mnlist", async (req, res) => {
  try {
    const masternodes = await rpcServices(client.callRpc).masternode_list().call();
    res.status(200).json(masternodes);
  } catch (err) {
    // Mirror routes/governance.js (govlist.rpc_failed). An RPC failure
    // can leak internal hostnames/ports/stack-adjacent detail (e.g.
    // "ECONNREFUSED 127.0.0.1:8370") via err.message, so log full
    // detail server-side and return an opaque 500 to the client to
    // match the error-shape used by the rest of the API.
    securityLog.event('mnList.rpc_failed', {
      req,
      message: err && err.message,
    });
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
