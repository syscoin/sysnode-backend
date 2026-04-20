const moment = require("moment");
const axios = require("axios");
const { client, rpcServices } = require("../services/rpcClient");
const data = require("../data/dataStore");

setInterval(async function sysMain() {
  try {
    const gecko = await axios.get("https://api.coingecko.com/api/v3/coins/syscoin?tickers=true&market_data=true");
    const m = gecko.data.market_data;
    data.sysUsd = m.current_price.usd;
    data.sysBtc = m.current_price.btc;
    data.circulatingSupply = m.circulating_supply;
    data.totalSupply = m.total_supply;
    data.marketCap = m.market_cap.usd;
    data.marketCapBtc = m.market_cap.btc;
    data.volume = m.total_volume.usd;
    data.volumeBtc = m.total_volume.btc;
    data.priceChange = m.price_change_percentage_24h;

    const network = await rpcServices(client.callRpc).getNetworkInfo().call();
    data.version = network.version;
    data.subVersion = network.subversion;
    data.protocol = network.protocolversion;

    const genesisHash = "00000c255f9999002258ddd4d4c86a4b758a5e2ec07e7d69b3e8e7f3fbd44b92";
    const genesis = await rpcServices(client.callRpc).getBlock(genesisHash).call();
    data.date = moment(genesis.time * 1000).format("MMMM Do YYYY, h:mm:ss a");

    const blockCount = await rpcServices(client.callRpc).getBlockCount().call();
    let block = blockCount;
    let blockHash;

    while (block > 0) {
      try {
        blockHash = await rpcServices(client.callRpc).getBlockHash(block - 1).call();
        block--;
        break;
      } catch { block--; }
    }

    const blockData = await rpcServices(client.callRpc).getBlock(blockHash).call();
    const nowTime = blockData.time;
    data.currentBlock = block;

    const oneDayAgoBlock = block - 576;
    let hashOneDayAgo;

    while (block > 0) {
      try {
        hashOneDayAgo = await rpcServices(client.callRpc).getBlockHash(oneDayAgoBlock).call();
        break;
      } catch { block--; }
    }

    const blockOneDayAgo = await rpcServices(client.callRpc).getBlock(hashOneDayAgo).call();
    const diff = nowTime - blockOneDayAgo.time;
    data.avgBlockTime = (diff * 1000) / 576;

    const gov = await rpcServices(client.callRpc).getGovernanceInfo().call();
    data.lastSuperBlock = gov.lastsuperblock;
    data.nextSuperBlock = gov.nextsuperblock;
    data.proposalFee = gov.proposalfee;

    try {
      data.budget = await rpcServices(client.callRpc).getSuperblockBudget().call();
    } catch {
      data.budget = "To be determined";
    }

    const diffBlock = data.nextSuperBlock - data.currentBlock;
    const sbDate = Date.now() + diffBlock * data.avgBlockTime;
    data.superBlockNextDate = moment(sbDate).format("MMMM Do YYYY, h:mm:ss a");

    const voteDeadlineBlock = data.nextSuperBlock - 1728;
    const voteDeadlineDate = Date.now() + (voteDeadlineBlock - data.currentBlock) * data.avgBlockTime;
    data.votingDeadlineDate = moment(voteDeadlineDate).format("MMMM Do YYYY, h:mm:ss a");

    const interval = 17520;
    const sbNow = data.nextSuperBlock;

    [1, 2, 3, 4, 5].forEach((n, i) => {
      data[`sb${n}`] = sbNow + interval * n;
      data[`sb${n}EstDate`] = moment(Date.now() + ((data[`sb${n}`] - data.currentBlock) * data.avgBlockTime)).format("MMMM Do YYYY");
      rpcServices(client.callRpc).getSuperblockBudget(data[`sb${n}`]).call()
        .then(budget => data[`sb${n}Budget`] = budget)
        .catch(() => data[`sb${n}Budget`] = "To be determined");
    });

    const mnCount = await rpcServices(client.callRpc).masternode_count().call();
    data.mnTotal = mnCount.total;
    data.mnEnabled = mnCount.enabled;
    data.poseBanned = mnCount.total - mnCount.enabled;
  } catch (err) {
    console.error("[sysMain]", err.message);
  }
}, 20000);