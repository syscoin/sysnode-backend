const numeral = require("numeral");
const ms = require("pretty-ms");
const data = require("../data/dataStore");
const { hasStatsValue } = require("../lib/statsSnapshot");

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numeric(group, key, { integer = false, signed = false } = {}) {
  const value = data[key];
  return hasStatsValue(group) &&
    finite(value) &&
    (signed || value >= 0) &&
    (!integer || Number.isSafeInteger(value))
    ? value
    : null;
}

function text(group, key) {
  const value = data[key];
  return hasStatsValue(group) &&
    typeof value === "string" &&
    value.trim() &&
    !/^(?:invalid date|nan|[-+]?infinity)$/i.test(value.trim())
    ? value
    : null;
}

function formatted(value, pattern) {
  if (!finite(value)) return null;
  // numeral can itself produce "NaN" for finite but extreme exponents.
  const result = numeral(value).format(pattern);
  return /NaN|Infinity/.test(result) ? null : result;
}

function fixed(value, places, prefix = "", suffix = "") {
  return finite(value) ? prefix + value.toFixed(places) + suffix : null;
}

function duration(value) {
  return finite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? ms(value)
    : null;
}

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
  const usd = numeric("market", "sysUsd");
  const btc = numeric("market", "sysBtc");
  const supply = numeric("market", "circulatingSupply");
  const total = numeric("node", "mnTotal", { integer: true });
  const enabled = numeric("node", "mnEnabled", { integer: true });
  const locked = total === null ? null : total * reqCoin;
  const annualTotalRewards = rewardPerBlock * 24 * 24 * 365;
  // Zero nodes is a valid observed count, not a valid reward denominator.
  const yearly =
    enabled !== null && enabled > 0 ? annualTotalRewards / enabled : null;
  const yearlyOne =
    enabled !== null && enabled > 0
      ? (rewardPerBlock * oneYearIncreaseSen * 24 * 24 * 365) / enabled
      : null;
  const yearlyTwo =
    enabled !== null && enabled > 0
      ? (rewardPerBlock * twoYearIncreaseSen * 24 * 24 * 365) / enabled
      : null;

  function incomeStats(yearlyReward) {
    const income = (price, divisor, places, prefix, suffix) =>
      yearlyReward === null || price === null
        ? null
        : fixed((yearlyReward / divisor) * price, places, prefix, suffix);
    return {
      usd: {
        daily: income(usd, oneDay, 2, "$", ""),
        weekly: income(usd, oneWeek, 2, "$", ""),
        monthly: income(usd, oneMonth, 2, "$", ""),
        yearly: income(usd, 1, 2, "$", ""),
      },
      btc: {
        daily: income(btc, oneDay, 8, "", " BTC"),
        weekly: income(btc, oneWeek, 8, "", " BTC"),
        monthly: income(btc, oneMonth, 8, "", " BTC"),
        yearly: income(btc, 1, 8, "", " BTC"),
      },
      sys: {
        daily: income(1, oneDay, 2, "", " SYS"),
        weekly: income(1, oneWeek, 2, "", " SYS"),
        monthly: income(1, oneMonth, 2, "", " SYS"),
        yearly: income(1, 1, 2, "", " SYS"),
      },
    };
  }
  function blockLabel(key) {
    const block = numeric("governance", key, { integer: true });
    return block === null ? null : "SB" + block / sbTotal + " - " + block;
  }
  function budget(key) {
    const value = numeric("governance", key);
    return value !== null
      ? value
      : hasStatsValue("governance") && data[key] === "To be determined"
      ? data[key]
      : null;
  }
  const governanceDate = (key) =>
    hasStatsValue("chain") ? text("governance", key) : null;
  const epoch = hasStatsValue("chain")
    ? numeric("governance", "superBlockNextEpochSec", { integer: true })
    : null;
  const subVersion = text("chain", "subVersion");
  const priceChange = numeric("market", "priceChange", { signed: true });
  return {
    mn_stats: {
      total: formatted(total, "0,0"),
      enabled: formatted(enabled, "0,0"),
      pose_banned: formatted(
        numeric("node", "poseBanned", { integer: true }),
        "0,0"
      ),
      total_locked: formatted(locked, "0,0.00"),
      coins_percent_locked:
        locked !== null && supply !== null && supply > 0
          ? fixed((locked / supply) * 100, 2, "", "%")
          : null,
      current_supply: formatted(supply, "0,0.00"),
      collateral_req: numeral(reqCoin).format("0,0"),
      masternode_price_usd: formatted(
        usd === null ? null : reqCoin * usd,
        "0,0.00"
      ),
      masternode_price_btc: formatted(
        btc === null ? null : reqCoin * btc,
        "0,0.00000000"
      ),
      payout_frequency:
        enabled !== null && enabled > 0
          ? duration((enabled / 24) * days)
          : null,
      roi: yearly === null ? null : fixed((yearly / reqCoin) * 100, 2, "", "%"),
      roi_one:
        yearly === null
          ? null
          : fixed((yearly / reqCoin) * oneYearIncreaseSen * 100, 2, "", "%"),
      roi_two:
        yearly === null
          ? null
          : fixed((yearly / reqCoin) * twoYearIncreaseSen * 100, 2, "", "%"),
    },
    price_stats: {
      price_usd: formatted(usd, "0,0.0000"),
      price_btc: formatted(btc, "0,0.00000000"),
      circulating_supply: formatted(supply, "0,0.00"),
      total_supply: formatted(numeric("market", "totalSupply"), "0,0.00"),
      volume_usd: formatted(numeric("market", "volume"), "0,0.00"),
      volume_btc: formatted(numeric("market", "volumeBtc"), "0,0.00"),
      price_change: fixed(priceChange, 4, "", "%"),
      market_cap_usd: formatted(numeric("market", "marketCap"), "0,0.00"),
      market_cap_btc: formatted(numeric("market", "marketCapBtc"), "0,0.00"),
    },
    blockchain_stats: {
      version: numeric("chain", "version", { integer: true }),
      sub_version: subVersion === null ? null : subVersion.replace(/\//g, ""),
      protocol: numeric("chain", "protocol", { integer: true }),
      connections: formatted(
        numeric("chain", "currentBlock", { integer: true }),
        "0,0"
      ),
      genesis: text("chain", "date"),
      avg_block: duration(numeric("chain", "avgBlockTime")),
    },
    superblock_stats: {
      last_superblock: numeric("governance", "lastSuperBlock", {
        integer: true,
      }),
      next_superblock: blockLabel("nextSuperBlock"),
      proposal_fee: numeric("governance", "proposalFee"),
      budget: budget("budget"),
      superblock_date: governanceDate("superBlockNextDate"),
      superblock_next_epoch_sec: epoch !== null && epoch > 0 ? epoch : null,
      voting_deadline: governanceDate("votingDeadlineDate"),
      sb1: blockLabel("sb1"),
      sb2: blockLabel("sb2"),
      sb3: blockLabel("sb3"),
      sb4: blockLabel("sb4"),
      sb5: blockLabel("sb5"),
      sb1Budget: budget("sb1Budget"),
      sb2Budget: budget("sb2Budget"),
      sb3Budget: budget("sb3Budget"),
      sb4Budget: budget("sb4Budget"),
      sb5Budget: budget("sb5Budget"),
      sb1Date: governanceDate("sb1EstDate"),
      sb2Date: governanceDate("sb2EstDate"),
      sb3Date: governanceDate("sb3EstDate"),
      sb4Date: governanceDate("sb4EstDate"),
      sb5Date: governanceDate("sb5EstDate"),
    },
    income_stats: incomeStats(yearly),
    income_stats_seniority_one_year: incomeStats(yearlyOne),
    income_stats_seniority_two_year: incomeStats(yearlyTwo),
  };
}
module.exports = calculations;
