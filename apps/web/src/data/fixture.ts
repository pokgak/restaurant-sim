import { adaptPublicGame } from "../lib/adapter";
import type {
  FixtureScenario,
  PublicGame,
  RawEquipmentAsset,
  RawGameEvent,
  RawLeaderboardEntry,
  RawProfitPoint,
  RawPublicGame,
  RawRestaurantSnapshot,
  RawStaffRoleState,
  RawTickReport,
} from "../types";

const restaurantIds = ["rest-noodle", "rest-juniper", "rest-lantern", "rest-pasta"];
const restaurantNames = [
  "Night Market Noodles",
  "Juniper Grill",
  "Red Lantern Kitchen",
  "Pasta Lab",
];
const totalRevenue = [241_600, 229_800, 198_400, 104_200];
const debts = [14_000, 25_000, 0, 120_000];

function staffing(
  count: number,
  targetCount: number,
  absentCount: number,
  skillBps: number,
  fatigueBps: number,
  moraleBps: number,
): RawStaffRoleState {
  return {
    count,
    targetCount,
    absentCount,
    averageSkillBps: skillBps,
    fatigueBps,
    moraleBps,
    pendingHireCount: 0,
    hiringTicksRemaining: 0,
    trainingTicksRemaining: 0,
    pendingSkillGainBps: 0,
    turnoverCount: 0,
  };
}

function equipment(
  kind: RawEquipmentAsset["kind"],
  conditionBps: number,
  status: RawEquipmentAsset["status"] = "operational",
  downtimeTicks = 0,
): RawEquipmentAsset {
  return {
    id: kind,
    kind,
    conditionBps,
    status,
    downtimeTicks,
    maintenanceBoostTicks: 0,
    totalBreakdowns: status === "broken" ? 1 : 0,
    totalMaintenance: kind === "refrigeration" ? 1 : 0,
    repairCostsCents: status === "broken" ? 6_200 : 0,
  };
}

function tickReport(index: number, tick: number, cashCents: number, bankrupt: boolean): RawTickReport {
  if (bankrupt) {
    return {
      tick,
      potentialDemandUnits: 0,
      serviceCapacityUnits: 0,
      unitsSold: 0,
      lostToCapacityUnits: 0,
      stockoutUnits: 0,
      wasteUnits: 0,
      deliveredUnits: 0,
      absentStaff: 0,
      kitchenDowntime: true,
      refrigerationDowntime: false,
      revenueCents: 0,
      wageCostCents: 0,
      marketingCostCents: 0,
      fixedCostCents: 0,
      rentCostCents: 0,
      utilityCostCents: 0,
      interestCostCents: 0,
      repairCostCents: 0,
      costOfGoodsSoldCents: 0,
      spoilageCostCents: 0,
      operatingProfitCents: 0,
      cashFlowCents: 0,
      cashCents,
    };
  }

  const reports = [
    {
      potentialDemandUnits: 38,
      serviceCapacityUnits: 35,
      unitsSold: 32,
      lostToCapacityUnits: 3,
      stockoutUnits: 0,
      wasteUnits: 2,
      deliveredUnits: 20,
      absentStaff: 1,
      kitchenDowntime: false,
      refrigerationDowntime: false,
      revenueCents: 35_200,
      wageCostCents: 7_200,
      marketingCostCents: 900,
      fixedCostCents: 1_400,
      rentCostCents: 0,
      utilityCostCents: 590,
      interestCostCents: 210,
      repairCostCents: 0,
      costOfGoodsSoldCents: 7_800,
      spoilageCostCents: 420,
      operatingProfitCents: 16_680,
      cashFlowCents: 24_900,
    },
    {
      potentialDemandUnits: 36,
      serviceCapacityUnits: 24,
      unitsSold: 24,
      lostToCapacityUnits: 12,
      stockoutUnits: 0,
      wasteUnits: 0,
      deliveredUnits: 0,
      absentStaff: 1,
      kitchenDowntime: true,
      refrigerationDowntime: false,
      revenueCents: 30_600,
      wageCostCents: 6_900,
      marketingCostCents: 1_200,
      fixedCostCents: 1_750,
      rentCostCents: 0,
      utilityCostCents: 720,
      interestCostCents: 380,
      repairCostCents: 6_200,
      costOfGoodsSoldCents: 7_100,
      spoilageCostCents: 0,
      operatingProfitCents: 6_350,
      cashFlowCents: 13_450,
    },
    {
      potentialDemandUnits: 31,
      serviceCapacityUnits: 30,
      unitsSold: 25,
      lostToCapacityUnits: 1,
      stockoutUnits: 5,
      wasteUnits: 3,
      deliveredUnits: 0,
      absentStaff: 0,
      kitchenDowntime: false,
      refrigerationDowntime: false,
      revenueCents: 25_900,
      wageCostCents: 6_100,
      marketingCostCents: 600,
      fixedCostCents: 1_400,
      rentCostCents: 0,
      utilityCostCents: 510,
      interestCostCents: 0,
      repairCostCents: 0,
      costOfGoodsSoldCents: 6_200,
      spoilageCostCents: 900,
      operatingProfitCents: 10_190,
      cashFlowCents: 17_290,
    },
  ] as const;
  return { tick, ...reports[index]!, cashCents };
}

function cumulativeProfit(index: number, tick: number): number {
  const bankruptcyTick = index === 3 ? 110 : tick;
  const activeTick = Math.min(tick, bankruptcyTick);
  const slopes = [646, 527, 379, -185];
  const wobble = Math.sin(activeTick / (8 + index * 2)) * (900 + index * 180);
  const earlyCost = activeTick < 30 ? (30 - activeTick) * (180 + index * 30) : 0;
  return Math.round(activeTick * slopes[index]! + wobble - earlyCost);
}

function seriesRestaurant(index: number, tick: number) {
  const bankrupt = index === 3 && tick >= 110;
  const cumulativeOperatingProfitCents = cumulativeProfit(index, tick);
  const cashCents = bankrupt
    ? -12_400
    : Math.round(58_000 + index * 8_000 + tick * (310 - index * 35));
  return {
    operatingProfitCents: bankrupt
      ? 0
      : Math.round([1_420, 980, 760, -540][index]! + Math.cos(tick / 9) * 220),
    cumulativeOperatingProfitCents,
    revenueCents: bankrupt ? 0 : Math.round([35_200, 30_600, 25_900, 12_500][index]!),
    cashCents,
    debtCents: debts[index]!,
    bankrupt,
  };
}

function buildSeries(tick: number): RawProfitPoint[] {
  const interval = 10;
  const ticks = Array.from({ length: Math.floor(tick / interval) + 1 }, (_, i) => i * interval);
  if (ticks[ticks.length - 1] !== tick) ticks.push(tick);
  return ticks.map((pointTick) => ({
    tick: pointTick,
    restaurants: Object.fromEntries(
      restaurantIds.map((restaurantId, index) => [
        restaurantId,
        seriesRestaurant(index, pointTick),
      ]),
    ),
  }));
}

function buildRestaurants(tick: number, series: RawProfitPoint[]): RawRestaurantSnapshot[] {
  const final = series[series.length - 1]!;
  return restaurantIds.map((id, index) => {
    const point = final.restaurants[id]!;
    const bankrupt = point.bankrupt;
    return {
      id,
      menuPriceCents: [1_100, 1_275, 1_035, 1_250][index]!,
      inventoryUnits: [74, 31, 4, 0][index]!,
      cooks: [3, 3, 2, 0][index]!,
      servers: [3, 2, 3, 0][index]!,
      staffing: {
        chef: [
          staffing(3, 3, 1, 8_400, 6_800, 7_600),
          staffing(3, 4, 1, 7_800, 7_900, 6_100),
          staffing(2, 2, 0, 8_100, 4_800, 7_900),
          staffing(0, 2, 0, 6_900, 0, 2_000),
        ][index]!,
        server: [
          staffing(3, 3, 0, 8_800, 5_200, 8_300),
          staffing(2, 3, 0, 7_200, 7_400, 6_400),
          staffing(3, 3, 0, 8_600, 4_200, 8_100),
          staffing(0, 2, 0, 6_700, 0, 2_000),
        ][index]!,
      },
      marketingSpendPerTickCents: [900, 1_200, 600, 0][index]!,
      capacityLevel: [2, 3, 2, 1][index]!,
      qualityLevel: [3, 2, 3, 1][index]!,
      coordinationBurdenBps: [1_250, 2_400, 1_400, 800][index]!,
      reputationBps: [9_200, 8_800, 8_100, 4_100][index]!,
      cashCents: point.cashCents,
      debtCents: point.debtCents,
      bankrupt,
      equipment: {
        kitchen:
          index === 1
            ? equipment("kitchen", 3_200, "broken", 3)
            : index === 3
              ? equipment("kitchen", 2_100, "broken", 2)
              : equipment("kitchen", [7_800, 3_200, 6_900][index]!),
        refrigeration: equipment(
          "refrigeration",
          [8_400, 6_700, 5_800, 7_200][index]!,
        ),
      },
      cumulativeOperatingProfitCents: point.cumulativeOperatingProfitCents,
      lastTick: tickReport(index, tick, point.cashCents, bankrupt),
    };
  });
}

const eventTemplates: RawGameEvent[] = [
  {
    id: "event-00000128",
    tick: 128,
    category: "action",
    type: "action",
    severity: "info",
    source: "agent",
    restaurantId: "rest-noodle",
    message: "raised dinner price on spicy miso bowls",
    effects: { priceCents: 1_100 },
  },
  {
    id: "event-00000129",
    tick: 129,
    category: "environment",
    type: "environment",
    severity: "warning",
    source: "environment",
    message: "Saturday autumn: storm weather, construction local event",
    effects: { weather: "storm", localEvent: "construction", demandRegimeBps: 7_200 },
  },
  {
    id: "event-00000130",
    tick: 130,
    category: "supply",
    type: "supply",
    severity: "warning",
    source: "environment",
    restaurantId: "rest-juniper",
    message: "staples delivery delayed by supply disruption",
    effects: { delayTicks: 2, supplyDisruptionBps: 3_600 },
  },
  {
    id: "event-00000131",
    tick: 131,
    category: "workforce",
    type: "workforce",
    severity: "warning",
    source: "operations",
    restaurantId: "rest-noodle",
    message: "one chef absent for service",
    effects: { absentCount: 1 },
  },
  {
    id: "event-00000132",
    tick: 132,
    category: "capacity",
    type: "capacity",
    severity: "warning",
    source: "operations",
    restaurantId: "rest-juniper",
    message: "12 sales lost to service capacity",
    effects: { lostToCapacityUnits: 12, serviceCapacityUnits: 24 },
  },
  {
    id: "event-00000133",
    tick: 133,
    category: "finance",
    type: "finance",
    severity: "info",
    source: "agent",
    restaurantId: "rest-juniper",
    message: "repaid part of outstanding loan",
    effects: { debtCents: 25_000 },
  },
  {
    id: "event-00000134",
    tick: 134,
    category: "operations",
    type: "operations",
    severity: "warning",
    source: "operations",
    restaurantId: "rest-lantern",
    message: "3 inventory units spoiled",
    effects: { wasteUnits: 3, spoilageCostCents: 900 },
  },
  {
    id: "event-00000135",
    tick: 135,
    category: "equipment",
    type: "equipment",
    severity: "critical",
    source: "operations",
    restaurantId: "rest-juniper",
    message: "kitchen broke down",
    effects: { assetId: "kitchen", downtimeTicks: 3, conditionBps: 3_200 },
  },
  {
    id: "event-00000136",
    tick: 136,
    category: "stockout",
    type: "stockout",
    severity: "warning",
    source: "operations",
    restaurantId: "rest-lantern",
    message: "5 sales lost to stockout",
    effects: { stockoutUnits: 5, inventoryUnits: 4 },
  },
  {
    id: "event-00000137",
    tick: 137,
    category: "action",
    type: "action",
    severity: "info",
    source: "agent",
    restaurantId: "rest-noodle",
    message: "ordered 20 units of staples inventory",
    effects: { quantity: 20 },
  },
  {
    id: "event-00000138",
    tick: 137,
    category: "bankruptcy",
    type: "bankruptcy",
    severity: "critical",
    source: "operations",
    restaurantId: "rest-pasta",
    message: "restaurant declared bankruptcy after cash fell below zero",
    effects: { cashCents: -12_400, debtCents: 120_000 },
  },
];

export function makeRawFixture(
  scenario: FixtureScenario = "live",
  tickOverride?: number,
): RawPublicGame {
  const status = scenario === "paused" || scenario === "completed" ? scenario : "running";
  const tick = tickOverride ?? (status === "completed" ? 240 : status === "paused" ? 154 : 137);
  const series = buildSeries(tick);
  const restaurants = buildRestaurants(tick, series);
  const leaderboard: RawLeaderboardEntry[] = restaurants.map((restaurant, index) => ({
    restaurantId: restaurant.id,
    name: restaurantNames[index],
    rank: index + 1,
    cumulativeOperatingProfitCents: restaurant.cumulativeOperatingProfitCents,
    cashCents: restaurant.cashCents,
    debtCents: restaurant.debtCents,
    bankrupt: restaurant.bankrupt,
    totalRevenueCents: totalRevenue[index]!,
    totalCostsCents: totalRevenue[index]! - restaurant.cumulativeOperatingProfitCents,
    totalUnitsSold: [392, 345, 328, 148][index]!,
    reputationBps: restaurant.reputationBps,
  }));

  return {
    id: "game-7F3A",
    status,
    tick,
    maxTicks: 240,
    seed: 924_771,
    leaderboard,
    restaurants,
    market: {
      ingredientUnitCostCents: status === "completed" ? 372 : 418,
      demandIndexBps: status === "completed" ? 7_100 : 8_600,
      supplyDisruptionBps: status === "completed" ? 800 : 3_600,
    },
    calendar: {
      day: 20,
      dayOfWeek: 5,
      dayName: "Saturday",
      isWeekend: true,
      season: "autumn",
      seasonDemandBps: 9_800,
      weather: "storm",
      weatherDemandBps: 7_800,
      localEvent: "construction",
      localDemandBps: 9_400,
      demandRegimeBps: 7_200,
    },
    recentEvents: eventTemplates
      .filter((event) => event.tick <= tick)
      .map((event) => ({ ...event, effects: { ...event.effects } })),
    series,
  };
}

export function makeFixture(scenario: FixtureScenario = "live", tickOverride?: number): PublicGame {
  return adaptPublicGame(makeRawFixture(scenario, tickOverride));
}
