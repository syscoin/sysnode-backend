const express = require("express");
const router = express.Router();
const { client, rpcServices } = require("../services/rpcClient");

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
    res.status(500).send({ error: e.message });
  }
});

module.exports = router;