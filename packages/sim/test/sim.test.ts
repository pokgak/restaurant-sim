import assert from "node:assert/strict";
import test from "node:test";

import {
  RANDOM_DOMAIN_KEYS,
  advanceGame,
  applyAction,
  createGame,
  observe,
  publicSnapshot,
  type EquipmentKind,
  type GameState,
  type PlayerAction,
} from "../src/index.ts";

function act(state: GameState, restaurantId: string, action: PlayerAction): GameState {
  const outcome = applyAction(state, restaurantId, action);
  assert.equal(outcome.result.accepted, true, outcome.result.message);
  return outcome.state;
}

function maybeAct(state: GameState, restaurantId: string, action: PlayerAction): GameState {
  const outcome = applyAction(state, restaurantId, action);
  return outcome.result.accepted ? outcome.state : state;
}

function replay(seed: number): GameState {
  let state = createGame({ seed, restaurantIds: ["north", "south"], maxTicks: 12 });
  state = act(state, "north", { type: "set_menu_price", dishId: "house", priceCents: 1_150 });
  state = act(state, "south", { type: "set_marketing", budgetCents: 300 });
  state = act(state, "north", { type: "purchase_inventory", ingredientId: "staples", quantity: 20 });
  state = act(state, "south", { type: "set_staff", role: "chef", count: 3 });
  state = advanceGame(state, 2);
  state = act(state, "north", { type: "invest", kind: "quality" });
  state = act(state, "south", { type: "train_staff", role: "server", budgetCents: 1_000 });
  return advanceGame(state, 4);
}

test("the same seed and actions replay to an identical serialized state", () => {
  const first = replay(123_456);
  const second = replay(123_456);

  assert.equal(first.version, 2);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

function exogenousPath(policy: "growth" | "contraction"): {
  path: Array<{ market: GameState["market"]; calendar: GameState["calendar"] }>;
  state: GameState;
} {
  let state = createGame({ seed: 808, restaurantIds: ["solo"], maxTicks: 10 });
  if (policy === "growth") {
    state = act(state, "solo", { type: "set_staff", role: "chef", count: 10 });
    state = act(state, "solo", { type: "set_staff", role: "server", count: 10 });
    state = act(state, "solo", { type: "set_marketing", budgetCents: 5_000 });
    state = act(state, "solo", { type: "purchase_inventory", ingredientId: "staples", quantity: 30 });
  } else {
    state = act(state, "solo", { type: "set_staff", role: "chef", count: 0 });
    state = act(state, "solo", { type: "set_staff", role: "server", count: 0 });
    state = act(state, "solo", { type: "schedule_maintenance", assetId: "refrigeration" });
  }
  const path: Array<{ market: GameState["market"]; calendar: GameState["calendar"] }> = [];
  for (let tick = 0; tick < 10; tick += 1) {
    path.push({ market: { ...state.market }, calendar: { ...state.calendar } });
    state = advanceGame(state);
  }
  return { path, state };
}

test("random domain mapping is frozen and materially different policies preserve the exogenous path", () => {
  assert.ok(Object.isFrozen(RANDOM_DOMAIN_KEYS));
  assert.ok(Object.isFrozen(RANDOM_DOMAIN_KEYS.exogenous));
  assert.ok(Object.isFrozen(RANDOM_DOMAIN_KEYS.restaurant));
  assert.deepEqual(RANDOM_DOMAIN_KEYS, {
    exogenous: {
      calendarWeather: 0x243f_6a88,
      calendarLocalEvent: 0x85a3_08d3,
      marketPrice: 0x1319_8a2e,
      marketDemand: 0x0370_7344,
    },
    restaurant: {
      demand: 0xa409_3822,
      workforce: 0x299f_31d0,
      supply: 0x082e_fa98,
      equipment: 0xec4e_6c89,
    },
  });
  const growth = exogenousPath("growth");
  const contraction = exogenousPath("contraction");
  assert.deepEqual(growth.path, contraction.path);
  assert.deepEqual(growth.state.prngState.exogenous, contraction.state.prngState.exogenous);
  assert.notDeepEqual(growth.state.restaurants.solo, contraction.state.restaurants.solo);
});

test("one restaurant's staffing and orders do not shift another restaurant's random draws", () => {
  function episode(activePolicy: boolean): GameState {
    let state = createGame({ seed: 919, restaurantIds: ["changed", "stable"], maxTicks: 8 });
    if (activePolicy) {
      state = act(state, "changed", { type: "set_staff", role: "chef", count: 10 });
      state = act(state, "changed", { type: "set_staff", role: "server", count: 10 });
      state = act(state, "changed", {
        type: "purchase_inventory",
        ingredientId: "staples",
        quantity: 30,
      });
    } else {
      state = act(state, "changed", { type: "set_staff", role: "chef", count: 0 });
      state = act(state, "changed", { type: "set_staff", role: "server", count: 0 });
    }
    return advanceGame(state, 8);
  }

  const active = episode(true);
  const inactive = episode(false);
  assert.deepEqual(active.prngState.restaurants.stable, inactive.prngState.restaurants.stable);
  assert.deepEqual(active.restaurants.stable, inactive.restaurants.stable);
  const stableEvents = (state: GameState) => state.eventLedger
    .filter((event) => event.restaurantId === "stable")
    .map(({ id: _id, ...event }) => event);
  assert.deepEqual(stableEvents(active), stableEvents(inactive));
  assert.notDeepEqual(active.prngState.restaurants.changed, inactive.prngState.restaurants.changed);
});

test("different seeds produce different weather, local shocks, and episodes", () => {
  const first = replay(111);
  const second = replay(222);
  const firstEnvironment = first.eventLedger
    .filter((event) => event.category === "environment")
    .map((event) => event.effects);
  const secondEnvironment = second.eventLedger
    .filter((event) => event.category === "environment")
    .map((event) => event.effects);

  assert.notDeepEqual(firstEnvironment, secondEnvironment);
  assert.notDeepEqual(first, second);
});

test("invalid actions preserve the exact input state", () => {
  const state = createGame({ seed: 7, restaurantIds: ["a", "b"], maxTicks: 5 });
  const before = JSON.stringify(state);
  const invalidPrice = applyAction(state, "a", {
    type: "set_menu_price",
    dishId: "house",
    priceCents: 499,
  });
  const oversizedPurchase = applyAction(state, "a", {
    type: "purchase_inventory",
    ingredientId: "staples",
    quantity: 100,
  });
  const invalidRepair = applyAction(state, "a", {
    type: "repair_equipment",
    assetId: "kitchen",
  });

  for (const outcome of [invalidPrice, oversizedPurchase, invalidRepair]) {
    assert.equal(outcome.result.accepted, false);
    assert.strictEqual(outcome.state, state);
  }
  assert.equal(JSON.stringify(state), before);
});

test("an attractive offer earns more demand than an expensive unmarketed competitor", () => {
  let state = createGame({ seed: 91, restaurantIds: ["value", "premium"], maxTicks: 3 });
  state = act(state, "value", { type: "set_menu_price", dishId: "house", priceCents: 800 });
  state = act(state, "value", { type: "set_marketing", budgetCents: 800 });
  state = act(state, "premium", { type: "set_menu_price", dishId: "house", priceCents: 2_200 });
  state = advanceGame(state);

  const valueDemand = state.restaurants.value!.lastTick!.potentialDemandUnits;
  const premiumDemand = state.restaurants.premium!.lastTick!.potentialDemandUnits;
  assert.ok(valueDemand >= premiumDemand + 10, `${valueDemand} should materially exceed ${premiumDemand}`);
});

test("marketing wins demand but remains a recurring cash expense", () => {
  let state = createGame({ seed: 31, restaurantIds: ["marketed", "plain"], maxTicks: 3 });
  state = act(state, "marketed", { type: "set_marketing", budgetCents: 1_000 });
  state = advanceGame(state);

  const marketed = state.restaurants.marketed!.lastTick!;
  const plain = state.restaurants.plain!.lastTick!;
  assert.ok(marketed.potentialDemandUnits > plain.potentialDemandUnits);
  assert.equal(marketed.marketingCostCents, 1_000);
  assert.equal(plain.marketingCostCents, 0);
  assert.equal(
    marketed.operatingProfitCents - plain.operatingProfitCents,
    marketed.revenueCents - plain.revenueCents - marketed.marketingCostCents,
  );
});

test("quality raises demand and reputation when capacity can serve it", () => {
  let state = createGame({ seed: 31, restaurantIds: ["quality", "plain"], maxTicks: 6 });
  state = act(state, "quality", { type: "borrow", amountCents: 100_000 });
  for (const restaurantId of ["quality", "plain"]) {
    state = act(state, restaurantId, { type: "invest", kind: "capacity" });
    state = act(state, restaurantId, { type: "set_staff", role: "chef", count: 4 });
    state = act(state, restaurantId, { type: "set_staff", role: "server", count: 4 });
  }
  for (let level = 0; level < 4; level += 1) {
    state = act(state, "quality", { type: "invest", kind: "quality" });
  }
  state = advanceGame(state, 3);

  const quality = state.restaurants.quality!;
  const plain = state.restaurants.plain!;
  assert.ok(quality.lastTick!.potentialDemandUnits > plain.lastTick!.potentialDemandUnits);
  assert.ok(quality.lastTick!.operatingProfitCents > plain.lastTick!.operatingProfitCents);
  assert.ok(quality.reputationBps > plain.reputationBps);
});

test("cash, fixed costs, borrowing, interest, repayment, and bankruptcy are enforced", () => {
  let state = createGame({ seed: 1, restaurantIds: ["solo"], maxTicks: 12 });
  const startingCash = state.restaurants.solo!.cashCents;
  state = act(state, "solo", { type: "borrow", amountCents: 20_000 });
  assert.equal(state.restaurants.solo!.cashCents, startingCash + 20_000);
  assert.equal(state.restaurants.solo!.debtCents, 20_000);

  state = advanceGame(state);
  assert.ok(state.restaurants.solo!.lastTick!.fixedCostCents > 0);
  assert.ok(state.restaurants.solo!.lastTick!.utilityCostCents > 0);
  assert.ok(state.restaurants.solo!.lastTick!.interestCostCents > 0);
  const debtBeforeRepayment = state.restaurants.solo!.debtCents;
  state = act(state, "solo", { type: "repay_loan", amountCents: 5_000 });
  assert.equal(state.restaurants.solo!.debtCents, debtBeforeRepayment - 5_000);
  state = advanceGame(state, 6);
  assert.ok(state.restaurants.solo!.lastTick!.rentCostCents > 0);

  let distressed = createGame({ seed: 1, restaurantIds: ["distressed"], maxTicks: 10 });
  for (let level = 0; level < 3; level += 1) {
    distressed = act(distressed, "distressed", { type: "invest", kind: "quality" });
  }
  distressed = act(distressed, "distressed", { type: "set_staff", role: "chef", count: 0 });
  distressed = act(distressed, "distressed", { type: "set_staff", role: "server", count: 0 });
  distressed = act(distressed, "distressed", { type: "set_marketing", budgetCents: 5_000 });
  distressed = advanceGame(distressed, 3);

  assert.equal(distressed.restaurants.distressed!.bankrupt, true);
  assert.ok(distressed.restaurants.distressed!.cashCents < 0);
  assert.ok(distressed.eventLedger.some((event) => event.category === "bankruptcy"));
  const rejected = applyAction(distressed, "distressed", {
    type: "set_marketing",
    budgetCents: 0,
  });
  assert.equal(rejected.result.accepted, false);
  assert.strictEqual(rejected.state, distressed);
});

test("prepaid inventory becomes cost of sales or spoilage without a second cash outflow", () => {
  const initial = createGame({ seed: 99, restaurantIds: ["solo"], maxTicks: 5 });
  const restaurantBefore = initial.restaurants.solo!;
  const unitCost = initial.market.ingredientUnitCostCents;
  const orderCostCents = unitCost * 20;
  const outcome = applyAction(initial, "solo", {
    type: "purchase_inventory",
    ingredientId: "staples",
    quantity: 20,
  });
  assert.equal(outcome.result.accepted, true);
  const ordered = outcome.state.restaurants.solo!;
  assert.equal(ordered.cashCents, restaurantBefore.cashCents - orderCostCents);
  assert.equal(ordered.inventoryAssetCents, restaurantBefore.inventoryAssetCents + orderCostCents);
  assert.equal(ordered.totalCostsCents, restaurantBefore.totalCostsCents);
  assert.equal(ordered.cumulativeOperatingProfitCents, restaurantBefore.cumulativeOperatingProfitCents);

  const cashAfterPrepayment = ordered.cashCents;
  const assetAfterPrepayment = ordered.inventoryAssetCents;
  const state = advanceGame(outcome.state);
  const restaurant = state.restaurants.solo!;
  const report = restaurant.lastTick!;
  const recognizedCosts = report.wageCostCents + report.marketingCostCents + report.fixedCostCents +
    report.rentCostCents + report.utilityCostCents + report.interestCostCents + report.repairCostCents +
    report.costOfGoodsSoldCents + report.spoilageCostCents;
  const cashCosts = recognizedCosts - report.costOfGoodsSoldCents - report.spoilageCostCents;

  assert.ok(report.costOfGoodsSoldCents > 0);
  assert.equal(report.operatingProfitCents, report.revenueCents - recognizedCosts);
  assert.equal(report.cashFlowCents, report.revenueCents - cashCosts);
  assert.equal(restaurant.cashCents, cashAfterPrepayment + report.cashFlowCents);
  assert.equal(restaurant.cumulativeOperatingProfitCents, report.operatingProfitCents);
  assert.equal(restaurant.totalCostsCents, recognizedCosts);
  assert.equal(
    restaurant.inventoryAssetCents,
    assetAfterPrepayment - report.costOfGoodsSoldCents - report.spoilageCostCents,
  );
});

test("calendar regimes drive weekday, weekend, seasonal, weather, and local demand", () => {
  let state = createGame({ seed: 5, restaurantIds: ["solo"], maxTicks: 35 });
  const firstWeek: Array<{ weekend: boolean; demand: number; regime: number }> = [];
  for (let day = 0; day < 7; day += 1) {
    const calendar = state.calendar;
    state = advanceGame(state);
    firstWeek.push({
      weekend: calendar.isWeekend,
      demand: state.restaurants.solo!.lastTick!.potentialDemandUnits,
      regime: calendar.demandRegimeBps,
    });
  }
  const weekdayDemand = Math.max(...firstWeek.filter((day) => !day.weekend).map((day) => day.demand));
  const weekendDemand = Math.min(...firstWeek.filter((day) => day.weekend).map((day) => day.demand));
  assert.ok(weekendDemand > weekdayDemand);
  assert.ok(firstWeek[5]!.regime > firstWeek[4]!.regime);

  state = advanceGame(state, 21);
  assert.equal(state.calendar.season, "spring");
  assert.equal(state.calendar.seasonDemandBps, 10_500);
  assert.ok(state.eventLedger.some((event) => event.effects.weather === "storm" || event.effects.localEvent !== "none"));
});

test("environment events are logged only when their day runs", () => {
  const initial = createGame({ seed: 42, restaurantIds: ["solo"], maxTicks: 3 });
  assert.equal(initial.eventLedger.some((event) => event.category === "environment"), false);
  const state = advanceGame(initial, 3);
  const environmentTicks = state.eventLedger
    .filter((event) => event.category === "environment")
    .map((event) => event.tick);

  assert.deepEqual(environmentTicks, [0, 1, 2]);
  assert.ok(state.eventLedger.every((event) => event.tick <= state.tick - 1));
  assert.equal(state.eventLedger.some((event) => event.tick === state.config.maxTicks), false);
});

test("staffing targets hire slowly and skill, fatigue, morale, absence, training, and turnover affect work", () => {
  let state = createGame({ seed: 7, restaurantIds: ["solo"], maxTicks: 30 });
  state = act(state, "solo", { type: "set_staff", role: "chef", count: 4 });
  assert.equal(state.restaurants.solo!.cooks, 2);
  state = advanceGame(state);
  assert.equal(state.restaurants.solo!.cooks, 2);
  assert.equal(state.restaurants.solo!.staffing.chef.pendingHireCount, 2);
  state = advanceGame(state, 2);
  assert.equal(state.restaurants.solo!.cooks, 4);
  assert.ok(state.restaurants.solo!.staffing.chef.averageSkillBps < 8_000);

  const skillBeforeTraining = state.restaurants.solo!.staffing.chef.averageSkillBps;
  state = act(state, "solo", { type: "train_staff", role: "chef", budgetCents: 2_000 });
  state = advanceGame(state, 2);
  assert.ok(state.restaurants.solo!.staffing.chef.averageSkillBps > skillBeforeTraining);
  assert.ok(state.restaurants.solo!.staffing.chef.fatigueBps > 0);
  assert.ok(state.restaurants.solo!.staffing.chef.moraleBps < 10_000);

  const absenceEpisode = advanceGame(createGame({ seed: 22, restaurantIds: ["a"], maxTicks: 2 }));
  assert.ok(absenceEpisode.restaurants.a!.lastTick!.absentStaff > 0);
  let turnoverEpisode = createGame({ seed: 2, restaurantIds: ["a"], maxTicks: 80 });
  for (let draw = 0; draw < 5; draw += 1) {
    turnoverEpisode = act(turnoverEpisode, "a", { type: "borrow", amountCents: 100_000 });
  }
  turnoverEpisode = advanceGame(turnoverEpisode, 80);
  const turnover = turnoverEpisode.restaurants.a!.staffing.chef.turnoverCount +
    turnoverEpisode.restaurants.a!.staffing.server.turnoverCount;
  assert.ok(turnover > 0);
  assert.equal(turnoverEpisode.restaurants.a!.bankrupt, false);
});

function equipmentEpisode(seed: number, maintain: boolean): GameState {
  let state = createGame({ seed, restaurantIds: ["solo"], maxTicks: 90 });
  state = act(state, "solo", { type: "borrow", amountCents: 100_000 });
  state = act(state, "solo", { type: "set_staff", role: "chef", count: 0 });
  state = act(state, "solo", { type: "set_staff", role: "server", count: 0 });
  for (let tick = 0; tick < 80; tick += 1) {
    if (maintain && tick % 8 === 0) {
      for (const assetId of ["kitchen", "refrigeration"] as const satisfies readonly EquipmentKind[]) {
        state = maybeAct(state, "solo", { type: "schedule_maintenance", assetId });
      }
    }
    state = advanceGame(state);
  }
  return state;
}

test("preventive maintenance lowers seeded breakdown risk while failures charge repairs and cause downtime", () => {
  const unmaintained = equipmentEpisode(1, false);
  const maintained = equipmentEpisode(1, true);
  const unmaintainedRestaurant = unmaintained.restaurants.solo!;
  const maintainedRestaurant = maintained.restaurants.solo!;
  const unmaintainedBreakdowns = unmaintainedRestaurant.equipment.kitchen.totalBreakdowns +
    unmaintainedRestaurant.equipment.refrigeration.totalBreakdowns;
  const maintainedBreakdowns = maintainedRestaurant.equipment.kitchen.totalBreakdowns +
    maintainedRestaurant.equipment.refrigeration.totalBreakdowns;

  assert.ok(unmaintainedBreakdowns > maintainedBreakdowns);
  assert.ok(unmaintainedRestaurant.equipment.kitchen.repairCostsCents > 0);
  const breakdown = unmaintained.eventLedger.find(
    (event) => event.category === "equipment" && event.severity === "critical",
  );
  assert.ok(breakdown);
  assert.ok(Number(breakdown.effects.repairCostCents) > 0);
  assert.ok(Number(breakdown.effects.downtimeTicks) > 0);
});

test("orders use observed prices, arrive after lead time, and seeded disruption delays delivery", () => {
  let state = createGame({ seed: 3, restaurantIds: ["solo"], maxTicks: 8 });
  const startingInventory = state.restaurants.solo!.inventoryUnits;
  const unitCost = state.market.ingredientUnitCostCents;
  const outcome = applyAction(state, "solo", {
    type: "purchase_inventory",
    ingredientId: "staples",
    quantity: 20,
  });
  assert.equal(outcome.result.accepted, true);
  assert.equal(outcome.result.costCents, unitCost * 20);
  assert.equal(outcome.state.restaurants.solo!.inventoryUnits, startingInventory);
  assert.equal(outcome.state.restaurants.solo!.purchaseOrders[0]!.dueTick, 2);

  state = advanceGame(outcome.state, 2);
  assert.equal(state.restaurants.solo!.purchaseOrders[0]!.status, "pending");
  state = advanceGame(state);
  assert.equal(state.restaurants.solo!.purchaseOrders[0]!.disruptionCount, 1);
  assert.equal(state.restaurants.solo!.purchaseOrders[0]!.dueTick, 3);
  state = advanceGame(state);
  assert.equal(state.restaurants.solo!.purchaseOrders[0]!.status, "delivered");
  assert.equal(state.restaurants.solo!.purchaseOrders[0]!.deliveredTick, 3);
  assert.equal(
    state.restaurants.solo!.inventoryLots.find((lot) => lot.id === "solo-order-1-lot")!.unitCostCents,
    unitCost,
  );
  assert.ok(state.eventLedger.some((event) => event.category === "supply" && event.source === "environment"));
});

test("refrigeration downtime accelerates shelf aging and spoilage", () => {
  const base = createGame({ seed: 55, restaurantIds: ["solo"], maxTicks: 3 });
  const refrigerated = advanceGame(base);
  const maintenance = act(base, "solo", {
    type: "schedule_maintenance",
    assetId: "refrigeration",
  });
  const offline = advanceGame(maintenance);

  assert.equal(refrigerated.restaurants.solo!.lastTick!.refrigerationDowntime, false);
  assert.equal(offline.restaurants.solo!.lastTick!.refrigerationDowntime, true);
  assert.ok(
    offline.restaurants.solo!.lastTick!.wasteUnits > refrigerated.restaurants.solo!.lastTick!.wasteUnits,
  );
  assert.ok(
    offline.restaurants.solo!.lastTick!.spoilageCostCents >
      refrigerated.restaurants.solo!.lastTick!.spoilageCostCents,
  );
  assert.equal(
    offline.restaurants.solo!.inventoryAssetCents,
    maintenance.restaurants.solo!.inventoryAssetCents -
      offline.restaurants.solo!.lastTick!.costOfGoodsSoldCents -
      offline.restaurants.solo!.lastTick!.spoilageCostCents,
  );
  assert.ok(offline.restaurants.solo!.inventoryLots[0]!.ageTicks > refrigerated.restaurants.solo!.inventoryLots[0]!.ageTicks);
});

test("stockouts lose sales while wages, utilities, and fixed costs continue", () => {
  const state = advanceGame(createGame({ seed: 77, restaurantIds: ["empty"], maxTicks: 8 }), 6);
  const report = state.restaurants.empty!.lastTick!;

  assert.equal(state.restaurants.empty!.inventoryUnits, 0);
  assert.ok(report.stockoutUnits > 0);
  assert.equal(report.unitsSold, 0);
  assert.ok(report.wageCostCents > 0);
  assert.ok(report.fixedCostCents > 0);
  assert.ok(report.utilityCostCents > 0);
  assert.ok(report.operatingProfitCents < 0);
});

test("scaling adds capacity and storage but increases cost, coordination, wear, and failure exposure", () => {
  let state = createGame({ seed: 1, restaurantIds: ["expanded", "plain"], maxTicks: 10 });
  state = act(state, "expanded", { type: "invest", kind: "capacity" });
  for (const restaurantId of ["expanded", "plain"]) {
    state = act(state, restaurantId, { type: "set_staff", role: "chef", count: 4 });
    state = act(state, restaurantId, { type: "set_staff", role: "server", count: 4 });
  }
  state = advanceGame(state, 3);
  for (const restaurantId of ["expanded", "plain"]) {
    state = act(state, restaurantId, { type: "train_staff", role: "chef", budgetCents: 5_000 });
    state = act(state, restaurantId, { type: "train_staff", role: "server", budgetCents: 5_000 });
  }
  state = advanceGame(state, 2);

  const expanded = state.restaurants.expanded!;
  const plain = state.restaurants.plain!;
  assert.ok(expanded.storageCapacityUnits > plain.storageCapacityUnits);
  assert.ok(expanded.lastTick!.serviceCapacityUnits > plain.lastTick!.serviceCapacityUnits);
  assert.ok(expanded.lastTick!.fixedCostCents > plain.lastTick!.fixedCostCents);
  assert.ok(expanded.lastTick!.utilityCostCents > plain.lastTick!.utilityCostCents);
  assert.ok(expanded.coordinationBurdenBps > plain.coordinationBurdenBps);
  assert.ok(expanded.equipment.kitchen.conditionBps < plain.equipment.kitchen.conditionBps);
});

test("a plausible stocked policy stays viable while public snapshots expose only bounded recent events", () => {
  let state = createGame({ seed: 1_001, restaurantIds: ["operator", "rival"], maxTicks: 8 });
  state = act(state, "operator", {
    type: "purchase_inventory",
    ingredientId: "staples",
    quantity: 20,
  });
  state = act(state, "operator", { type: "set_menu_price", dishId: "house", priceCents: 1_350 });
  state = advanceGame(state, 5);

  const operator = observe(state, "operator").restaurant;
  assert.ok(operator.totalRevenueCents > 0);
  assert.ok(operator.totalUnitsSold > 0);
  assert.ok(operator.cumulativeOperatingProfitCents > 0);
  assert.equal(operator.bankrupt, false);

  const snapshot = publicSnapshot(state);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  assert.deepEqual(Object.keys(snapshot), [
    "tick",
    "maxTicks",
    "seed",
    "leaderboard",
    "restaurants",
    "market",
    "calendar",
    "recentEvents",
    "series",
  ]);
  assert.equal("eventLedger" in snapshot, false);
  assert.equal(snapshot.restaurants.length, 2);
  assert.equal(snapshot.restaurants[0]!.equipment.kitchen.id, "kitchen");
  assert.equal(snapshot.restaurants[0]!.staffing.chef.targetCount, 2);
  assert.equal(new Set(state.eventLedger.map((event) => event.id)).size, state.eventLedger.length);
  assert.deepEqual(state.eventLedger.map((event) => event.id),
    state.eventLedger.map((_, index) => `event-${String(index + 1).padStart(8, "0")}`));
  assert.ok(state.eventLedger.some((event) => event.source === "agent"));
  assert.ok(state.eventLedger.some((event) => event.source === "environment"));
  assert.ok(state.eventLedger.every((event) => event.category === event.type));
  assert.equal(snapshot.leaderboard.length, 2);
  assert.equal(snapshot.series.length, 6);
});

test("the maximum tick and restaurant bounds remain practical and keep only a recent event window", () => {
  const restaurantIds = Array.from({ length: 16 }, (_, index) => `r${index}`);
  const state = advanceGame(createGame({ seed: 9, restaurantIds, maxTicks: 10_000 }), 10_000);

  assert.equal(state.tick, 10_000);
  assert.equal(state.series.length, 10_001);
  assert.ok(state.eventLedger.length > state.recentEvents.length);
  assert.equal(state.recentEvents.length, 50);
  assert.doesNotThrow(() => JSON.stringify(state));
});
