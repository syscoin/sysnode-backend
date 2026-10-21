const data = require("../data/dataStore");
const calculations = require("../services/calculations");
const {
  markStatsSuccess,
  markStatsFailure,
  resetStatsMetadata,
} = require("../lib/statsSnapshot");
const initial = { ...data };
const groups = ["chain", "node", "governance", "market"];
const happy = {
  sysUsd: 0.12,
  sysBtc: 0.0000018,
  circulatingSupply: 700000000,
  totalSupply: 888000000,
  marketCap: 84000000,
  marketCapBtc: 1260,
  volume: 1000000,
  volumeBtc: 15,
  priceChange: -1.23,
  version: 5080200,
  subVersion: "/Syscoin Core:5.0.8.2/",
  protocol: 70022,
  currentBlock: 1999999,
  date: "March 1st 2016",
  avgBlockTime: 150000,
  mnTotal: 1500,
  mnEnabled: 1450,
  poseBanned: 50,
  lastSuperBlock: 2036160,
  nextSuperBlock: 2053680,
  proposalFee: 50,
  budget: 927712,
  superBlockNextDate: "November 1st 2026",
  superBlockNextEpochSec: 1793520000,
  votingDeadlineDate: "October 31st 2026",
};
for (let n = 1; n <= 5; n++) {
  happy[`sb${n}`] = happy.nextSuperBlock + 17520 * n;
  happy[`sb${n}Budget`] = 900000 + n;
  happy[`sb${n}EstDate`] = `Projected date ${n}`;
}
function prime(available = groups) {
  Object.assign(data, happy);
  markStatsSuccess(available, 1790000000000);
}
function leaves(value) {
  return value && typeof value === "object"
    ? Object.values(value).flatMap(leaves)
    : [value];
}
function safe(result) {
  expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity|undefined/);
  expect(
    leaves(result).every(
      (value) => typeof value !== "number" || Number.isFinite(value)
    )
  ).toBe(true);
}
beforeEach(() => {
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, initial);
  resetStatsMetadata();
});
afterAll(() => {
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, initial);
  resetStatsMetadata();
});

test("cold host fixture returns unknown, not fabricated zero prices/counts or infinite rewards", () => {
  const result = calculations();
  for (const [key, value] of Object.entries(result.mn_stats)) {
    expect(value).toBe(key === "collateral_req" ? "100,000" : null);
  }
  for (const group of [
    result.price_stats,
    result.blockchain_stats,
    result.superblock_stats,
    result.income_stats,
    result.income_stats_seniority_one_year,
    result.income_stats_seniority_two_year,
  ]) {
    expect(leaves(group).every((value) => value === null)).toBe(true);
  }
  safe(result);
});

test("valid happy-path amounts and reward formulas remain unchanged", () => {
  prime();
  const result = calculations();
  const reward = (52.91745294 * 24 * 24 * 365) / 1450;
  const expectedIncome = (yearly) => ({
    usd: Object.fromEntries(
      [
        ["daily", 365],
        ["weekly", 52],
        ["monthly", 12],
        ["yearly", 1],
      ].map(([k, d]) => [k, "$" + ((yearly / d) * 0.12).toFixed(2)])
    ),
    btc: Object.fromEntries(
      [
        ["daily", 365],
        ["weekly", 52],
        ["monthly", 12],
        ["yearly", 1],
      ].map(([k, d]) => [k, ((yearly / d) * 0.0000018).toFixed(8) + " BTC"])
    ),
    sys: Object.fromEntries(
      [
        ["daily", 365],
        ["weekly", 52],
        ["monthly", 12],
        ["yearly", 1],
      ].map(([k, d]) => [k, (yearly / d).toFixed(2) + " SYS"])
    ),
  });
  expect(result.mn_stats).toEqual({
    total: "1,500",
    enabled: "1,450",
    pose_banned: "50",
    total_locked: "150,000,000.00",
    coins_percent_locked: "21.43%",
    current_supply: "700,000,000.00",
    collateral_req: "100,000",
    masternode_price_usd: "12,000.00",
    masternode_price_btc: "0.18000000",
    payout_frequency: "2d 12h 25m",
    roi: ((reward / 100000) * 100).toFixed(2) + "%",
    roi_one: ((reward / 100000) * 1.35 * 100).toFixed(2) + "%",
    roi_two: ((reward / 100000) * 2 * 100).toFixed(2) + "%",
  });
  expect(result.income_stats).toEqual(expectedIncome(reward));
  expect(result.income_stats_seniority_one_year).toEqual(
    expectedIncome((52.91745294 * 1.35 * 24 * 24 * 365) / 1450)
  );
  expect(result.income_stats_seniority_two_year).toEqual(
    expectedIncome((52.91745294 * 2 * 24 * 24 * 365) / 1450)
  );
  expect(result.price_stats.price_change).toBe("-1.2300%");
  expect(result.blockchain_stats).toEqual({
    version: 5080200,
    sub_version: "Syscoin Core:5.0.8.2",
    protocol: 70022,
    connections: "1,999,999",
    genesis: "March 1st 2016",
    avg_block: "2m 30s",
  });
  expect(result.superblock_stats.superblock_next_epoch_sec).toBe(
    happy.superBlockNextEpochSec
  );
  safe(result);
});

test("market cold failure leaves valid Core data and native rewards usable", () => {
  prime(["chain", "node", "governance"]);
  const result = calculations();
  expect(result.mn_stats.total).toBe("1,500");
  expect(result.mn_stats.roi).not.toBeNull();
  expect(result.mn_stats.coins_percent_locked).toBeNull();
  expect(result.mn_stats.masternode_price_usd).toBeNull();
  expect(result.blockchain_stats.connections).toBe("1,999,999");
  expect(result.superblock_stats.next_superblock).not.toBeNull();
  expect(leaves(result.price_stats).every((value) => value === null)).toBe(
    true
  );
  expect(leaves(result.income_stats.usd).every((value) => value === null)).toBe(
    true
  );
  expect(result.income_stats.sys.daily).not.toBeNull();
  safe(result);
});

test("last-good stale market retains its known values", () => {
  prime();
  const before = calculations();
  markStatsFailure(["market"]);
  expect(calculations()).toEqual(before);
});

test("known zero enabled nodes retains zero counts but has no payout/ROI/income", () => {
  prime();
  Object.assign(data, { mnTotal: 0, mnEnabled: 0, poseBanned: 0 });
  const result = calculations();
  expect(result.mn_stats).toMatchObject({
    total: "0",
    enabled: "0",
    pose_banned: "0",
    total_locked: "0.00",
    coins_percent_locked: "0.00%",
    payout_frequency: null,
    roi: null,
    roi_one: null,
    roi_two: null,
  });
  expect(leaves(result.income_stats).every((value) => value === null)).toBe(
    true
  );
  safe(result);
});

const invalid = [
  null,
  undefined,
  NaN,
  Infinity,
  -Infinity,
  -1,
  "1450",
  {},
  [],
  false,
  true,
  1n,
  0.5,
];
test.each(invalid.map((value) => [String(value), value]))(
  "invalid enabled-node denominator %s never produces an estimate",
  (_name, value) => {
    prime();
    data.mnEnabled = value;
    const result = calculations();
    expect(result.mn_stats.enabled).toBeNull();
    expect(result.mn_stats.roi).toBeNull();
    expect(result.mn_stats.payout_frequency).toBeNull();
    expect(leaves(result.income_stats).every((v) => v === null)).toBe(true);
    safe(result);
  }
);

test.each(
  [0, ...invalid.filter((value) => value !== 0.5)].map((value) => [
    String(value),
    value,
  ])
)(
  "invalid circulating supply denominator %s never produces a locked percentage",
  (_name, value) => {
    prime();
    data.circulatingSupply = value;
    const result = calculations();
    expect(result.mn_stats.coins_percent_locked).toBeNull();
    safe(result);
  }
);

test.each(
  invalid
    .filter((value) => value !== 0.5)
    .map((value) => [String(value), value])
)("invalid USD price %s does not fabricate USD income", (_name, value) => {
  prime();
  data.sysUsd = value;
  const result = calculations();
  expect(result.price_stats.price_usd).toBeNull();
  expect(result.mn_stats.masternode_price_usd).toBeNull();
  expect(leaves(result.income_stats.usd).every((v) => v === null)).toBe(true);
  expect(result.income_stats.btc.daily).not.toBeNull();
  expect(result.income_stats.sys.daily).not.toBeNull();
  safe(result);
});

test("a known genuine zero price is distinct from a missing price", () => {
  prime();
  Object.assign(data, { sysUsd: 0, sysBtc: 0 });
  const result = calculations();
  expect(result.price_stats.price_usd).toBe("0.0000");
  expect(result.income_stats.usd.daily).toBe("$0.00");
  safe(result);
});

test("extreme finite values cannot leak formatter NaN or overflow income", () => {
  prime();
  Object.assign(data, {
    sysUsd: Number.MAX_VALUE,
    sysBtc: Number.MIN_VALUE,
    avgBlockTime: Infinity,
  });
  const result = calculations();
  expect(result.mn_stats.masternode_price_usd).toBeNull();
  expect(result.income_stats.usd.yearly).toBeNull();
  expect(result.blockchain_stats.avg_block).toBeNull();
  safe(result);
});

test("unavailable group metadata wins over retained-looking payloads", () => {
  Object.assign(data, happy);
  markStatsSuccess(["market"], 1790000000000);
  const result = calculations();
  expect(result.mn_stats.total).toBeNull();
  expect(result.mn_stats.roi).toBeNull();
  expect(leaves(result.blockchain_stats).every((v) => v === null)).toBe(true);
  expect(leaves(result.superblock_stats).every((v) => v === null)).toBe(true);
  safe(result);
});

test("known projected-budget fallback remains available without inventing numeric budgets", () => {
  prime();
  data.sb1Budget = "To be determined";
  data.sb2Budget = "123";
  data.sb3Budget = NaN;
  data.sb4Budget = -1;
  data.sb5Budget = Infinity;
  const result = calculations();
  expect(result.superblock_stats.sb1Budget).toBe("To be determined");
  for (const n of [2, 3, 4, 5])
    expect(result.superblock_stats[`sb${n}Budget`]).toBeNull();
  safe(result);
});

test("invalid chain dates and duration do not become plausible epoch values", () => {
  prime();
  Object.assign(data, {
    date: 0,
    subVersion: null,
    avgBlockTime: -1,
    superBlockNextDate: "Invalid date",
    superBlockNextEpochSec: 0,
  });
  const result = calculations();
  expect(result.blockchain_stats.genesis).toBeNull();
  expect(result.blockchain_stats.sub_version).toBeNull();
  expect(result.blockchain_stats.avg_block).toBeNull();
  expect(result.superblock_stats.superblock_date).toBeNull();
  expect(result.superblock_stats.superblock_next_epoch_sec).toBeNull();
  safe(result);
});
