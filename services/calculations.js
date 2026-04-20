const numeral = require("numeral");
const ms = require("pretty-ms");
const data = require("../data/dataStore");

function calculations() {
  const reqCoin = 100000;
  const oneDay = 365;
  const oneWeek = 52;
  const oneMonth = 12;
  const rewardPerBlock = 52.91745294;
  const oneYearIncreaseSen = 1.35;
  const twoYearIncreaseSen = 2;
  const sbTotal = 17520;
  const days = 3600000;

  const mnUsd = reqCoin * data.sysUsd;
  const mnBtc = reqCoin * data.sysBtc;
  const coinsLocked = data.mnTotal * reqCoin;
  const coinsLockedPercent = coinsLocked / data.circulatingSupply;
  const avgPayoutFrequency = data.mnEnabled / 24;

  const annualTotalRewards = rewardPerBlock * 24 * 24 * 365;
  const avgRewardYearly = annualTotalRewards / data.mnEnabled;

  const oneSenReward = rewardPerBlock * oneYearIncreaseSen;
  const oneAvgRewardYearlySen = (oneSenReward * 24 * 24 * 365) / data.mnEnabled;

  const twoSenReward = rewardPerBlock * twoYearIncreaseSen;
  const twoAvgRewardYearlySen = (twoSenReward * 24 * 24 * 365) / data.mnEnabled;

  function incomeStats(yearlyReward) {
    return {
      usd: {
        daily: "$" + (yearlyReward / oneDay * data.sysUsd).toFixed(2),
        weekly: "$" + (yearlyReward / oneWeek * data.sysUsd).toFixed(2),
        monthly: "$" + (yearlyReward / oneMonth * data.sysUsd).toFixed(2),
        yearly: "$" + (yearlyReward * data.sysUsd).toFixed(2)
      },
      btc: {
        daily: (yearlyReward / oneDay * data.sysBtc).toFixed(8) + " BTC",
        weekly: (yearlyReward / oneWeek * data.sysBtc).toFixed(8) + " BTC",
        monthly: (yearlyReward / oneMonth * data.sysBtc).toFixed(8) + " BTC",
        yearly: (yearlyReward * data.sysBtc).toFixed(8) + " BTC"
      },
      sys: {
        daily: (yearlyReward / oneDay).toFixed(2) + " SYS",
        weekly: (yearlyReward / oneWeek).toFixed(2) + " SYS",
        monthly: (yearlyReward / oneMonth).toFixed(2) + " SYS",
        yearly: yearlyReward.toFixed(2) + " SYS"
      }
    };
  }

  return {
    mn_stats: {
      total: numeral(data.mnTotal).format("0,0"),
      enabled: numeral(data.mnEnabled).format("0,0"),
      pose_banned: numeral(data.poseBanned).format("0,0"),
      total_locked: numeral(coinsLocked).format("0,0.00"),
      coins_percent_locked: (coinsLockedPercent * 100).toFixed(2) + "%",
      current_supply: numeral(data.circulatingSupply).format("0,0.00"),
      collateral_req: numeral(reqCoin).format("0,0"),
      masternode_price_usd: numeral(mnUsd).format("0,0.00"),
      masternode_price_btc: numeral(mnBtc).format("0,0.00000000"),
      payout_frequency: ms(avgPayoutFrequency * days),
      roi: (avgRewardYearly / reqCoin * 100).toFixed(2) + "%",
      roi_one: ((avgRewardYearly / reqCoin) * oneYearIncreaseSen * 100).toFixed(2) + "%",
      roi_two: ((avgRewardYearly / reqCoin) * twoYearIncreaseSen * 100).toFixed(2) + "%"
    },

    price_stats: {
      price_usd: numeral(data.sysUsd).format("0,0.0000"),
      price_btc: numeral(data.sysBtc).format("0,0.00000000"),
      circulating_supply: numeral(data.circulatingSupply).format("0,0.00"),
      total_supply: numeral(data.totalSupply).format("0,0.00"),
      volume_usd: numeral(data.volume).format("0,0.00"),
      volume_btc: numeral(data.volumeBtc).format("0,0.00"),
      price_change: data.priceChange.toFixed(4) + "%",
      market_cap_usd: numeral(data.marketCap).format("0,0.00"),
      market_cap_btc: numeral(data.marketCapBtc).format("0,0.00")
    },

    blockchain_stats: {
      version: data.version,
      sub_version: String(data.subVersion).replace(/\//g, ""),
      protocol: data.protocol,
      connections: numeral(data.currentBlock).format("0,0"),
      genesis: data.date,
      avg_block: ms(data.avgBlockTime)
    },

    superblock_stats: {
      last_superblock: data.lastSuperBlock,
      next_superblock: "SB" + data.nextSuperBlock / sbTotal + " - " + data.nextSuperBlock,
      proposal_fee: data.proposalFee,
      budget: data.budget,
      superblock_date: data.superBlockNextDate,
      voting_deadline: data.votingDeadlineDate,
      sb1: "SB" + data.sb1 / sbTotal + " - " + data.sb1,
      sb2: "SB" + data.sb2 / sbTotal + " - " + data.sb2,
      sb3: "SB" + data.sb3 / sbTotal + " - " + data.sb3,
      sb4: "SB" + data.sb4 / sbTotal + " - " + data.sb4,
      sb5: "SB" + data.sb5 / sbTotal + " - " + data.sb5,
      sb1Budget: data.sb1Budget,
      sb2Budget: data.sb2Budget,
      sb3Budget: data.sb3Budget,
      sb4Budget: data.sb4Budget,
      sb5Budget: data.sb5Budget,
      sb1Date: data.sb1EstDate,
      sb2Date: data.sb2EstDate,
      sb3Date: data.sb3EstDate,
      sb4Date: data.sb4EstDate,
      sb5Date: data.sb5EstDate
    },

    income_stats: incomeStats(avgRewardYearly),
    income_stats_seniority_one_year: incomeStats(oneAvgRewardYearlySen),
    income_stats_seniority_two_year: incomeStats(twoAvgRewardYearlySen)
  };
}

module.exports = calculations;