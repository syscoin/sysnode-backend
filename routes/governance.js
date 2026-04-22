const express = require("express");
const router = express.Router();
const { client, rpcServices } = require("../services/rpcClient");
const securityLog = require("../lib/securityLog");

router.post("/govlist", async (req, res) => {
  try {
    const gobj = await rpcServices(client.callRpc).gObject_list().call();
    const list = Object.keys(gobj).map(key => {
      const entry = gobj[key];
      const dataString = JSON.parse(entry.DataString);
      return {
        Key: key,
        Hash: entry.Hash,
        ColHash: entry.CollateralHash,
        ObectType: entry.ObjectType,
        CreationTime: entry.CreationTime,
        AbsoluteYesCount: entry.AbsoluteYesCount,
        YesCount: entry.YesCount,
        NoCount: entry.NoCount,
        AbstainCount: entry.AbstainCount,
        fBlockchainValidity: entry.fBlockchainValidity,
        IsValidReason: entry.IsValidReason,
        fCachedValid: entry.fCachedValid,
        fCachedFunding: entry.fCachedFunding,
        fCachedDelete: entry.fCachedDelete,
        fCachedEndorsed: entry.fCachedEndorsed,
        ...dataString
      };
    });

    list.sort((a, b) => b.AbsoluteYesCount - a.AbsoluteYesCount);
    res.send(list);
  } catch (e) {
    // F2 mini-audit fix: do NOT surface `e.message` to the client — an
    // RPC failure can leak internal hostnames, ports, or stack-adjacent
    // detail (e.g. "ECONNREFUSED 127.0.0.1:8370"). Log the full error
    // server-side for operator debugging and return a generic opaque
    // 500 to match the error-shape used by the rest of the API
    // (lib/appFactory.js).
    securityLog.event('govlist.rpc_failed', {
      req,
      message: e && e.message,
    });
    res.status(500).send({ error: 'internal' });
  }
});

module.exports = router;