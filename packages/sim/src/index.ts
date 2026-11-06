import type {
  ActionResult,
  ApplyActionResult,
  CalendarState,
  EquipmentAsset,
  EquipmentKind,
  ExogenousRandomState,
  EventCategory,
  EventEffectValue,
  EventSeverity,
  EventSource,
  GameConfig,
  GameState,
  InventoryLot,
  LeaderboardEntry,
  LocalEvent,
  Observation,
  PlayerAction,
  PublicGameEvent,
  PublicGameSnapshot,
  PublicRestaurantSnapshot,
  PublicSeriesPoint,
  PublicSeriesRestaurantPoint,
  PurchaseOrder,
  RandomState,
  RestaurantState,
  RestaurantRandomState,
  Season,
  StaffRole,
  StaffRoleState,
  Weather,
} from "./types.js";

export type * from "./types.js";

const BASIS_POINTS = 10_000;
const DEFAULT_MENU_PRICE_CENTS = 1_300;
const MIN_MENU_PRICE_CENTS = 500;
const MAX_MENU_PRICE_CENTS = 5_000;
const MAX_MARKETING_CENTS = 5_000;
const MAX_STAFF_PER_ROLE = 10;
const MAX_PURCHASE_UNITS = 500;
const MAX_INVESTMENT_LEVEL = 4;
const STARTING_INVENTORY_UNITS = 36;
const STARTING_INVENTORY_UNIT_COST_CENTS = 400;
const BASE_STORAGE_UNITS = 80;
const STORAGE_PER_CAPACITY_LEVEL = 40;
const STARTING_CASH_CENTS = 120_000;
const CREDIT_LIMIT_CENTS = 500_000;
const COOK_WAGE_CENTS = 420;
const SERVER_WAGE_CENTS = 320;
const RECENT_EVENT_LIMIT = 50;
const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
const SEASONS: readonly Season[] = ["winter", "spring", "summer", "autumn"];
const ROLES: readonly StaffRole[] = ["chef", "server"];
const EQUIPMENT_KINDS: readonly EquipmentKind[] = ["kitchen", "refrigeration"];

/**
 * Frozen seed-domain mapping for serialized replay compatibility. Existing
 * names and numeric keys are append-only; changing either requires a random
 * state version migration. Restaurant streams additionally mix in the stable
 * restaurant ID and therefore do not depend on restaurant ordering.
 */
export const RANDOM_DOMAIN_KEYS = Object.freeze({
  exogenous: Object.freeze({
    calendarWeather: 0x243f_6a88,
    calendarLocalEvent: 0x85a3_08d3,
    marketPrice: 0x1319_8a2e,
    marketDemand: 0x0370_7344,
  }),
  restaurant: Object.freeze({
    demand: 0xa409_3822,
    workforce: 0x299f_31d0,
    supply: 0x082e_fa98,
    equipment: 0xec4e_6c89,
  }),
});

interface RandomResult {
  state: number;
  value: number;
}

interface EventOptions {
  category: EventCategory;
  severity: EventSeverity;
  source: EventSource;
  message: string;
  effects?: Record<string, EventEffectValue>;
  restaurantId?: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isBoundedResourceId(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

function nextRandom(prngState: number): RandomResult {
  let next = prngState >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  next >>>= 0;
  return { state: next, value: next };
}

function keyedSeed(seed: number, domainKey: number, scope: string): number {
  let mixed = (seed ^ domainKey) >>> 0;
  for (let index = 0; index < scope.length; index += 1) {
    mixed ^= scope.charCodeAt(index);
    mixed = Math.imul(mixed, 0x0100_0193) >>> 0;
  }
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb_352d) >>> 0;
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846c_a68b) >>> 0;
  mixed ^= mixed >>> 16;
  return mixed === 0 ? 0x6d2b_79f5 : mixed;
}

function initialRandomState(seed: number, restaurantIds: readonly string[]): RandomState {
  const restaurants: Record<string, RestaurantRandomState> = Object.create(null) as Record<
    string,
    RestaurantRandomState
  >;
  for (const restaurantId of restaurantIds) {
    restaurants[restaurantId] = {
      demand: keyedSeed(seed, RANDOM_DOMAIN_KEYS.restaurant.demand, restaurantId),
      workforce: keyedSeed(seed, RANDOM_DOMAIN_KEYS.restaurant.workforce, restaurantId),
      supply: keyedSeed(seed, RANDOM_DOMAIN_KEYS.restaurant.supply, restaurantId),
      equipment: keyedSeed(seed, RANDOM_DOMAIN_KEYS.restaurant.equipment, restaurantId),
    };
  }
  return {
    version: 1,
    exogenous: {
      calendarWeather: keyedSeed(seed, RANDOM_DOMAIN_KEYS.exogenous.calendarWeather, ""),
      calendarLocalEvent: keyedSeed(seed, RANDOM_DOMAIN_KEYS.exogenous.calendarLocalEvent, ""),
      marketPrice: keyedSeed(seed, RANDOM_DOMAIN_KEYS.exogenous.marketPrice, ""),
      marketDemand: keyedSeed(seed, RANDOM_DOMAIN_KEYS.exogenous.marketDemand, ""),
    },
    restaurants,
  };
}

function randomExogenous(
  state: GameState,
  domain: keyof ExogenousRandomState,
  minimum: number,
  maximum: number,
): number {
  const random = nextRandom(state.prngState.exogenous[domain]);
  state.prngState.exogenous[domain] = random.state;
  return minimum + (random.value % (maximum - minimum + 1));
}

function randomRestaurant(
  state: GameState,
  restaurantId: string,
  domain: keyof RestaurantRandomState,
  minimum: number,
  maximum: number,
): number {
  const restaurantState = state.prngState.restaurants[restaurantId]!;
  const random = nextRandom(restaurantState[domain]);
  restaurantState[domain] = random.state;
  return minimum + (random.value % (maximum - minimum + 1));
}

function randomRestaurantChance(
  state: GameState,
  restaurantId: string,
  domain: keyof RestaurantRandomState,
  chanceBps: number,
): boolean {
  return randomRestaurant(state, restaurantId, domain, 1, BASIS_POINTS) <= clamp(chanceBps, 0, BASIS_POINTS);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function multiplyBps(value: number, factorBps: number): number {
  return Math.floor((value * factorBps) / BASIS_POINTS);
}

function appendEvent(state: GameState, options: EventOptions): PublicGameEvent {
  state.eventSequence += 1;
  const base = {
    id: `event-${String(state.eventSequence).padStart(8, "0")}`,
    type: options.category,
    category: options.category,
    severity: options.severity,
    source: options.source,
    tick: state.tick,
    message: options.message,
    effects: options.effects ?? {},
  };
  const event: PublicGameEvent =
    options.restaurantId === undefined
      ? base
      : { ...base, restaurantId: options.restaurantId };
  state.eventLedger.push(event);
  state.recentEvents.push(event);
  if (state.recentEvents.length > RECENT_EVENT_LIMIT) {
    state.recentEvents.splice(0, state.recentEvents.length - RECENT_EVENT_LIMIT);
  }
  return event;
}

function reject(message: string): ActionResult {
  return { accepted: false, message, costCents: 0 };
}

function accept(message: string, costCents = 0): ActionResult {
  return { accepted: true, message, costCents };
}

function charge(restaurant: RestaurantState, costCents: number): void {
  restaurant.cashCents -= costCents;
  restaurant.totalCostsCents += costCents;
  restaurant.cumulativeOperatingProfitCents -= costCents;
}

function canSpend(restaurant: RestaurantState, costCents: number): boolean {
  return restaurant.cashCents >= costCents;
}

function storageCapacity(capacityLevel: number): number {
  return BASE_STORAGE_UNITS + capacityLevel * STORAGE_PER_CAPACITY_LEVEL;
}

function coordinationBurden(capacityLevel: number): number {
  return capacityLevel * 550;
}

function investmentCost(kind: "capacity" | "quality", currentLevel: number): number {
  const baseCost = kind === "capacity" ? 22_000 : 18_000;
  return baseCost * (currentLevel + 1);
}

function maintenanceCost(assetId: EquipmentKind, capacityLevel: number): number {
  return (assetId === "kitchen" ? 1_800 : 1_500) + capacityLevel * 300;
}

function repairExpediteCost(assetId: EquipmentKind, capacityLevel: number): number {
  return (assetId === "kitchen" ? 2_800 : 2_200) + capacityLevel * 400;
}

function validateConfig(config: GameConfig): void {
  if (!isBoundedInteger(config.seed, 0, 0xffff_ffff)) {
    throw new RangeError("seed must be an integer from 0 to 4294967295");
  }
  if (!isBoundedInteger(config.maxTicks, 1, 10_000)) {
    throw new RangeError("maxTicks must be an integer from 1 to 10000");
  }
  if (!Array.isArray(config.restaurantIds) || config.restaurantIds.length < 1 || config.restaurantIds.length > 16) {
    throw new RangeError("restaurantIds must contain between 1 and 16 restaurants");
  }
  const uniqueIds = new Set(config.restaurantIds);
  if (uniqueIds.size !== config.restaurantIds.length) {
    throw new RangeError("restaurantIds must be unique");
  }
  for (const restaurantId of config.restaurantIds) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(restaurantId)) {
      throw new RangeError("restaurantIds must use 1-64 letters, numbers, underscores, or hyphens");
    }
  }
}

function startingStaffRole(): StaffRoleState {
  return {
    count: 2,
    targetCount: 2,
    absentCount: 0,
    averageSkillBps: 8_000,
    fatigueBps: 500,
    moraleBps: 7_500,
    pendingHireCount: 0,
    hiringTicksRemaining: 0,
    trainingTicksRemaining: 0,
    pendingSkillGainBps: 0,
    turnoverCount: 0,
  };
}

function startingEquipment(kind: EquipmentKind): EquipmentAsset {
  return {
    id: kind,
    kind,
    conditionBps: 9_000,
    status: "operational",
    downtimeTicks: 0,
    maintenanceBoostTicks: 0,
    totalBreakdowns: 0,
    totalMaintenance: 0,
    repairCostsCents: 0,
  };
}

function startingRestaurant(id: string): RestaurantState {
  return {
    id,
    menuPriceCents: DEFAULT_MENU_PRICE_CENTS,
    inventoryUnits: STARTING_INVENTORY_UNITS,
    storageCapacityUnits: BASE_STORAGE_UNITS,
    inventoryLots: [
      {
        id: `${id}-lot-0`,
        ingredientId: "staples",
        quantity: STARTING_INVENTORY_UNITS,
        unitCostCents: STARTING_INVENTORY_UNIT_COST_CENTS,
        ageTicks: 0,
        shelfLifeTicks: 6,
        receivedTick: 0,
      },
    ],
    purchaseOrders: [],
    nextOrderNumber: 1,
    cooks: 2,
    servers: 2,
    staffing: {
      chef: startingStaffRole(),
      server: startingStaffRole(),
    },
    marketingSpendPerTickCents: 0,
    capacityLevel: 0,
    qualityLevel: 0,
    coordinationBurdenBps: 0,
    equipment: {
      kitchen: startingEquipment("kitchen"),
      refrigeration: startingEquipment("refrigeration"),
    },
    reputationBps: 5_000,
    cashCents: STARTING_CASH_CENTS,
    inventoryAssetCents: STARTING_INVENTORY_UNITS * STARTING_INVENTORY_UNIT_COST_CENTS,
    debtCents: 0,
    creditLimitCents: CREDIT_LIMIT_CENTS,
    bankrupt: false,
    bankruptcyTick: null,
    totalBorrowedCents: 0,
    totalRepaidCents: 0,
    totalInterestCents: 0,
    cumulativeOperatingProfitCents: 0,
    totalRevenueCents: 0,
    totalCostsCents: 0,
    totalUnitsSold: 0,
    totalWasteUnits: 0,
    lastTick: null,
  };
}

function calendarForTick(state: GameState, tick: number): CalendarState {
  const dayOfWeek = tick % 7;
  const isWeekend = dayOfWeek >= 5;
  const seasonIndex = Math.floor(tick / 28) % SEASONS.length;
  const season = SEASONS[seasonIndex]!;
  const seasonDemandBps: Record<Season, number> = {
    winter: 9_500,
    spring: 10_500,
    summer: 11_500,
    autumn: 10_000,
  };

  const weatherRoll = randomExogenous(state, "calendarWeather", 1, 1_000);
  let weather: Weather;
  let weatherDemandBps: number;
  let supplyDisruptionBps: number;
  if (weatherRoll <= 35) {
    weather = "storm";
    weatherDemandBps = 6_500;
    supplyDisruptionBps = 5_500;
  } else if (weatherRoll <= 120) {
    weather = "heat";
    weatherDemandBps = 8_500;
    supplyDisruptionBps = 1_200;
  } else if (weatherRoll <= 300) {
    weather = "rain";
    weatherDemandBps = 9_000;
    supplyDisruptionBps = 1_800;
  } else {
    weather = "clear";
    weatherDemandBps = 10_000;
    supplyDisruptionBps = 350;
  }

  const eventRoll = randomExogenous(state, "calendarLocalEvent", 1, 1_000);
  let localEvent: LocalEvent;
  let localDemandBps: number;
  if (eventRoll <= 35) {
    localEvent = "festival";
    localDemandBps = 14_000;
  } else if (eventRoll <= 70) {
    localEvent = "sports";
    localDemandBps = 12_500;
  } else if (eventRoll <= 110) {
    localEvent = "construction";
    localDemandBps = 7_500;
    supplyDisruptionBps += 1_000;
  } else {
    localEvent = "none";
    localDemandBps = BASIS_POINTS;
  }

  const weekendDemandBps = isWeekend ? 12_500 : BASIS_POINTS;
  let demandRegimeBps = multiplyBps(weekendDemandBps, seasonDemandBps[season]);
  demandRegimeBps = multiplyBps(demandRegimeBps, weatherDemandBps);
  demandRegimeBps = multiplyBps(demandRegimeBps, localDemandBps);
  state.market.supplyDisruptionBps = clamp(supplyDisruptionBps, 0, 8_000);

  return {
    day: tick + 1,
    dayOfWeek,
    dayName: DAY_NAMES[dayOfWeek]!,
    isWeekend,
    season,
    seasonDemandBps: seasonDemandBps[season],
    weather,
    weatherDemandBps,
    localEvent,
    localDemandBps,
    demandRegimeBps,
  };
}

function logEnvironment(state: GameState): void {
  const unusual = state.calendar.weather !== "clear" || state.calendar.localEvent !== "none";
  appendEvent(state, {
    category: "environment",
    severity: state.calendar.weather === "storm" ? "warning" : "info",
    source: "environment",
    message: `${state.calendar.dayName} ${state.calendar.season}: ${state.calendar.weather} weather, ${state.calendar.localEvent} local event`,
    effects: {
      day: state.calendar.day,
      weekend: state.calendar.isWeekend,
      season: state.calendar.season,
      weather: state.calendar.weather,
      localEvent: state.calendar.localEvent,
      demandRegimeBps: state.calendar.demandRegimeBps,
      supplyDisruptionBps: state.market.supplyDisruptionBps,
      unusual,
    },
  });
}

function makeSeriesPoint(state: GameState): PublicSeriesPoint {
  const restaurants: Record<string, PublicSeriesRestaurantPoint> = Object.create(null) as Record<
    string,
    PublicSeriesRestaurantPoint
  >;
  for (const restaurantId of state.config.restaurantIds) {
    const restaurant = state.restaurants[restaurantId]!;
    restaurants[restaurantId] = {
      operatingProfitCents: restaurant.lastTick?.operatingProfitCents ?? 0,
      cumulativeOperatingProfitCents: restaurant.cumulativeOperatingProfitCents,
      revenueCents: restaurant.lastTick?.revenueCents ?? 0,
      cashCents: restaurant.cashCents,
      debtCents: restaurant.debtCents,
      bankrupt: restaurant.bankrupt,
    };
  }
  return { tick: state.tick, restaurants };
}

export function createGame(config: GameConfig): GameState {
  validateConfig(config);
  const restaurants: Record<string, RestaurantState> = Object.create(null) as Record<string, RestaurantState>;
  for (const restaurantId of config.restaurantIds) {
    restaurants[restaurantId] = startingRestaurant(restaurantId);
  }

  const state: GameState = {
    version: 2,
    config: {
      seed: config.seed,
      restaurantIds: [...config.restaurantIds],
      maxTicks: config.maxTicks,
    },
    tick: 0,
    prngState: initialRandomState(config.seed, config.restaurantIds),
    eventSequence: 0,
    market: {
      ingredientUnitCostCents: 0,
      demandIndexBps: 0,
      supplyDisruptionBps: 0,
    },
    calendar: {} as CalendarState,
    restaurants,
    eventLedger: [],
    recentEvents: [],
    series: [],
  };
  state.market.ingredientUnitCostCents = randomExogenous(state, "marketPrice", 320, 500);
  state.market.demandIndexBps = randomExogenous(state, "marketDemand", 8_500, 11_500);
  state.calendar = calendarForTick(state, 0);
  state.series.push(makeSeriesPoint(state));
  return state;
}

function actionEvent(
  state: GameState,
  restaurantId: string,
  message: string,
  effects: Record<string, EventEffectValue>,
  category: EventCategory = "action",
): void {
  appendEvent(state, {
    category,
    severity: "info",
    source: "agent",
    restaurantId,
    message,
    effects,
  });
}

function pendingOrderUnits(restaurant: RestaurantState): number {
  return restaurant.purchaseOrders.reduce(
    (total, order) => total + (order.status === "pending" ? order.quantity : 0),
    0,
  );
}

export function applyAction(
  state: GameState,
  restaurantId: string,
  action: PlayerAction,
): ApplyActionResult {
  const currentRestaurant = state.restaurants[restaurantId];
  if (currentRestaurant === undefined) {
    return { state, result: reject(`unknown restaurant: ${restaurantId}`) };
  }
  if (state.tick >= state.config.maxTicks) {
    return { state, result: reject("the game has finished") };
  }
  if (currentRestaurant.bankrupt) {
    return { state, result: reject("the restaurant is bankrupt") };
  }

  switch (action.type) {
    case "set_menu_price": {
      if (!isBoundedResourceId(action.dishId)) {
        return { state, result: reject("dishId must be a 1-64 character identifier") };
      }
      if (!isBoundedInteger(action.priceCents, MIN_MENU_PRICE_CENTS, MAX_MENU_PRICE_CENTS)) {
        return {
          state,
          result: reject(`priceCents must be an integer from ${MIN_MENU_PRICE_CENTS} to ${MAX_MENU_PRICE_CENTS}`),
        };
      }
      const next = clone(state);
      next.restaurants[restaurantId]!.menuPriceCents = action.priceCents;
      actionEvent(next, restaurantId, `priced ${action.dishId} at ${action.priceCents} cents`, {
        dishId: action.dishId,
        priceCents: action.priceCents,
      });
      return { state: next, result: accept("menu price updated") };
    }

    case "purchase_inventory": {
      if (!isBoundedResourceId(action.ingredientId)) {
        return { state, result: reject("ingredientId must be a 1-64 character identifier") };
      }
      if (!isBoundedInteger(action.quantity, 1, MAX_PURCHASE_UNITS)) {
        return { state, result: reject(`quantity must be an integer from 1 to ${MAX_PURCHASE_UNITS}`) };
      }
      if (
        currentRestaurant.inventoryUnits + pendingOrderUnits(currentRestaurant) + action.quantity >
        currentRestaurant.storageCapacityUnits
      ) {
        return { state, result: reject("purchase exceeds ingredient storage capacity") };
      }
      const costCents = action.quantity * state.market.ingredientUnitCostCents;
      if (!canSpend(currentRestaurant, costCents)) {
        return { state, result: reject("insufficient cash; borrow before placing this order") };
      }
      const next = clone(state);
      const restaurant = next.restaurants[restaurantId]!;
      const orderId = `${restaurantId}-order-${restaurant.nextOrderNumber}`;
      restaurant.nextOrderNumber += 1;
      const order: PurchaseOrder = {
        id: orderId,
        ingredientId: action.ingredientId,
        quantity: action.quantity,
        unitCostCents: next.market.ingredientUnitCostCents,
        orderedTick: next.tick,
        originalDueTick: next.tick + 2,
        dueTick: next.tick + 2,
        disruptionCount: 0,
        status: "pending",
        deliveredTick: null,
      };
      restaurant.purchaseOrders.push(order);
      restaurant.cashCents -= costCents;
      restaurant.inventoryAssetCents += costCents;
      actionEvent(next, restaurantId, `ordered ${action.quantity} ${action.ingredientId}`, {
        orderId,
        quantity: action.quantity,
        costCents,
        dueTick: order.dueTick,
        accounting: "prepaid inventory asset",
      });
      return { state: next, result: accept("ingredient order placed", costCents) };
    }

    case "set_staff": {
      if (action.role !== "chef" && action.role !== "server") {
        return { state, result: reject("role must be chef or server") };
      }
      if (!isBoundedInteger(action.count, 0, MAX_STAFF_PER_ROLE)) {
        return { state, result: reject(`count must be an integer from 0 to ${MAX_STAFF_PER_ROLE}`) };
      }
      const next = clone(state);
      next.restaurants[restaurantId]!.staffing[action.role].targetCount = action.count;
      actionEvent(next, restaurantId, `set ${action.role} staffing target to ${action.count}`, {
        role: action.role,
        targetCount: action.count,
      });
      return { state: next, result: accept("staffing target updated") };
    }

    case "set_marketing": {
      if (!isBoundedInteger(action.budgetCents, 0, MAX_MARKETING_CENTS)) {
        return { state, result: reject(`budgetCents must be an integer from 0 to ${MAX_MARKETING_CENTS}`) };
      }
      const next = clone(state);
      next.restaurants[restaurantId]!.marketingSpendPerTickCents = action.budgetCents;
      actionEvent(next, restaurantId, `set marketing budget to ${action.budgetCents} cents`, {
        budgetCents: action.budgetCents,
      });
      return { state: next, result: accept("marketing budget updated") };
    }

    case "invest": {
      if (action.kind !== "capacity" && action.kind !== "quality") {
        return { state, result: reject("investment area must be capacity or quality") };
      }
      const currentLevel =
        action.kind === "capacity" ? currentRestaurant.capacityLevel : currentRestaurant.qualityLevel;
      if (currentLevel >= MAX_INVESTMENT_LEVEL) {
        return { state, result: reject(`${action.kind} is already at its maximum level`) };
      }
      const costCents = investmentCost(action.kind, currentLevel);
      if (!canSpend(currentRestaurant, costCents)) {
        return { state, result: reject("insufficient cash; borrow before investing") };
      }
      const next = clone(state);
      const restaurant = next.restaurants[restaurantId]!;
      if (action.kind === "capacity") {
        restaurant.capacityLevel += 1;
        restaurant.storageCapacityUnits = storageCapacity(restaurant.capacityLevel);
        restaurant.coordinationBurdenBps = coordinationBurden(restaurant.capacityLevel);
      } else {
        restaurant.qualityLevel += 1;
      }
      charge(restaurant, costCents);
      actionEvent(next, restaurantId, `upgraded ${action.kind} to level ${currentLevel + 1}`, {
        kind: action.kind,
        level: currentLevel + 1,
        costCents,
      });
      return { state: next, result: accept(`${action.kind} upgraded`, costCents) };
    }

    case "borrow": {
      if (!isBoundedInteger(action.amountCents, 5_000, 100_000)) {
        return { state, result: reject("amountCents must be an integer from 5000 to 100000") };
      }
      if (currentRestaurant.debtCents + action.amountCents > currentRestaurant.creditLimitCents) {
        return { state, result: reject("borrowing would exceed the restaurant credit limit") };
      }
      const next = clone(state);
      const restaurant = next.restaurants[restaurantId]!;
      restaurant.cashCents += action.amountCents;
      restaurant.debtCents += action.amountCents;
      restaurant.totalBorrowedCents += action.amountCents;
      actionEvent(next, restaurantId, `borrowed ${action.amountCents} cents`, {
        amountCents: action.amountCents,
        debtCents: restaurant.debtCents,
      }, "finance");
      return { state: next, result: accept("loan funded") };
    }

    case "repay_loan": {
      if (!isBoundedInteger(action.amountCents, 1, 100_000)) {
        return { state, result: reject("amountCents must be an integer from 1 to 100000") };
      }
      if (action.amountCents > currentRestaurant.debtCents) {
        return { state, result: reject("repayment exceeds outstanding debt") };
      }
      if (!canSpend(currentRestaurant, action.amountCents)) {
        return { state, result: reject("insufficient cash for repayment") };
      }
      const next = clone(state);
      const restaurant = next.restaurants[restaurantId]!;
      restaurant.cashCents -= action.amountCents;
      restaurant.debtCents -= action.amountCents;
      restaurant.totalRepaidCents += action.amountCents;
      actionEvent(next, restaurantId, `repaid ${action.amountCents} cents of debt`, {
        amountCents: action.amountCents,
        debtCents: restaurant.debtCents,
      }, "finance");
      return { state: next, result: accept("loan repayment applied", action.amountCents) };
    }

    case "schedule_maintenance": {
      if (action.assetId !== "kitchen" && action.assetId !== "refrigeration") {
        return { state, result: reject("assetId must be kitchen or refrigeration") };
      }
      const asset = currentRestaurant.equipment[action.assetId];
      if (asset.status !== "operational") {
        return { state, result: reject("equipment must be operational before preventive maintenance") };
      }
      const costCents = maintenanceCost(action.assetId, currentRestaurant.capacityLevel);
      if (!canSpend(currentRestaurant, costCents)) {
        return { state, result: reject("insufficient cash for preventive maintenance") };
      }
      const next = clone(state);
      const restaurant = next.restaurants[restaurantId]!;
      const nextAsset = restaurant.equipment[action.assetId];
      charge(restaurant, costCents);
      nextAsset.conditionBps = clamp(nextAsset.conditionBps + 2_500, 0, BASIS_POINTS);
      nextAsset.status = "maintenance";
      nextAsset.downtimeTicks = 1;
      nextAsset.maintenanceBoostTicks = 10;
      nextAsset.totalMaintenance += 1;
      actionEvent(next, restaurantId, `scheduled preventive maintenance for ${action.assetId}`, {
        assetId: action.assetId,
        costCents,
        downtimeTicks: 1,
        conditionBps: nextAsset.conditionBps,
      }, "equipment");
      return { state: next, result: accept("preventive maintenance scheduled", costCents) };
    }

    case "repair_equipment": {
      if (action.assetId !== "kitchen" && action.assetId !== "refrigeration") {
        return { state, result: reject("assetId must be kitchen or refrigeration") };
      }
      const asset = currentRestaurant.equipment[action.assetId];
      if (asset.status !== "broken") {
        return { state, result: reject("equipment is not broken") };
      }
      const costCents = repairExpediteCost(action.assetId, currentRestaurant.capacityLevel);
      if (!canSpend(currentRestaurant, costCents)) {
        return { state, result: reject("insufficient cash to expedite repair") };
      }
      const next = clone(state);
      const restaurant = next.restaurants[restaurantId]!;
      const nextAsset = restaurant.equipment[action.assetId];
      charge(restaurant, costCents);
      nextAsset.repairCostsCents += costCents;
      nextAsset.downtimeTicks = 1;
      nextAsset.conditionBps = Math.max(nextAsset.conditionBps, 7_500);
      actionEvent(next, restaurantId, `expedited repair for ${action.assetId}`, {
        assetId: action.assetId,
        costCents,
        downtimeTicks: 1,
      }, "equipment");
      return { state: next, result: accept("repair expedited", costCents) };
    }

    case "train_staff": {
      if (action.role !== "chef" && action.role !== "server") {
        return { state, result: reject("role must be chef or server") };
      }
      if (!isBoundedInteger(action.budgetCents, 500, 5_000)) {
        return { state, result: reject("budgetCents must be an integer from 500 to 5000") };
      }
      const staff = currentRestaurant.staffing[action.role];
      if (staff.count === 0) {
        return { state, result: reject("cannot train a role with no current staff") };
      }
      if (staff.trainingTicksRemaining > 0) {
        return { state, result: reject("a training program is already active for this role") };
      }
      if (!canSpend(currentRestaurant, action.budgetCents)) {
        return { state, result: reject("insufficient cash for training") };
      }
      const next = clone(state);
      const restaurant = next.restaurants[restaurantId]!;
      const nextStaff = restaurant.staffing[action.role];
      charge(restaurant, action.budgetCents);
      nextStaff.trainingTicksRemaining = 2;
      nextStaff.pendingSkillGainBps = Math.floor(action.budgetCents / 2);
      actionEvent(next, restaurantId, `started ${action.role} training`, {
        role: action.role,
        budgetCents: action.budgetCents,
        durationTicks: 2,
      }, "workforce");
      return { state: next, result: accept("training started", action.budgetCents) };
    }

    case "expedite_delivery": {
      if (!isBoundedResourceId(action.orderId)) {
        return { state, result: reject("orderId must be a 1-64 character identifier") };
      }
      const order = currentRestaurant.purchaseOrders.find(
        (candidate) => candidate.id === action.orderId && candidate.status === "pending",
      );
      if (order === undefined) {
        return { state, result: reject("pending order not found") };
      }
      const costCents = 1_000 + order.quantity * 20;
      if (!canSpend(currentRestaurant, costCents)) {
        return { state, result: reject("insufficient cash to expedite delivery") };
      }
      const next = clone(state);
      const restaurant = next.restaurants[restaurantId]!;
      const nextOrder = restaurant.purchaseOrders.find((candidate) => candidate.id === action.orderId)!;
      charge(restaurant, costCents);
      nextOrder.dueTick = Math.max(next.tick + 1, nextOrder.dueTick - 2);
      actionEvent(next, restaurantId, `expedited ${action.orderId}`, {
        orderId: action.orderId,
        costCents,
        dueTick: nextOrder.dueTick,
      }, "supply");
      return { state: next, result: accept("delivery expedited", costCents) };
    }
  }

  return { state, result: reject("unknown action type") };
}

function averageCompetitorValue(
  state: GameState,
  restaurantId: string,
  select: (restaurant: RestaurantState) => number,
): number {
  let sum = 0;
  let count = 0;
  for (const id of state.config.restaurantIds) {
    if (id !== restaurantId) {
      sum += select(state.restaurants[id]!);
      count += 1;
    }
  }
  return count === 0 ? select(state.restaurants[restaurantId]!) : Math.floor(sum / count);
}

function averageMarketingSpend(state: GameState): number {
  const total = state.config.restaurantIds.reduce(
    (sum, restaurantId) => sum + state.restaurants[restaurantId]!.marketingSpendPerTickCents,
    0,
  );
  return Math.floor(total / state.config.restaurantIds.length);
}

function demandForRestaurant(state: GameState, restaurant: RestaurantState, marketGrowthBps: number): number {
  if (restaurant.bankrupt) {
    return 0;
  }
  const competitorPrice = averageCompetitorValue(state, restaurant.id, (other) => other.menuPriceCents);
  const competitorMarketing = averageCompetitorValue(
    state,
    restaurant.id,
    (other) => other.marketingSpendPerTickCents,
  );
  const absolutePriceBps = clamp(
    Math.floor((DEFAULT_MENU_PRICE_CENTS * BASIS_POINTS) / restaurant.menuPriceCents),
    4_500,
    17_000,
  );
  const relativePriceBps = clamp(
    BASIS_POINTS + (competitorPrice - restaurant.menuPriceCents) * 3,
    7_000,
    13_000,
  );
  const relativeMarketingBps = clamp(
    BASIS_POINTS + (restaurant.marketingSpendPerTickCents - competitorMarketing) * 2,
    7_000,
    16_000,
  );
  const qualityAndReputationBps = clamp(
    9_000 + restaurant.qualityLevel * 900 + Math.floor((restaurant.reputationBps - 5_000) / 4),
    8_000,
    15_000,
  );
  let demand = multiplyBps(14, state.market.demandIndexBps);
  demand = multiplyBps(demand, state.calendar.demandRegimeBps);
  demand = multiplyBps(demand, marketGrowthBps);
  demand = multiplyBps(demand, absolutePriceBps);
  demand = multiplyBps(demand, relativePriceBps);
  demand = multiplyBps(demand, relativeMarketingBps);
  demand = multiplyBps(demand, qualityAndReputationBps);
  return Math.max(0, demand + randomRestaurant(state, restaurant.id, "demand", -1, 1));
}

function syncStaffCounts(restaurant: RestaurantState): void {
  restaurant.cooks = restaurant.staffing.chef.count;
  restaurant.servers = restaurant.staffing.server.count;
}

function progressWorkforce(state: GameState, restaurant: RestaurantState): void {
  for (const role of ROLES) {
    const staff = restaurant.staffing[role];
    if (staff.pendingHireCount > 0) {
      staff.hiringTicksRemaining -= 1;
      if (staff.hiringTicksRemaining === 0) {
        const hired = Math.min(staff.pendingHireCount, MAX_STAFF_PER_ROLE - staff.count);
        const combinedSkill = staff.count * staff.averageSkillBps + hired * 6_500;
        staff.count += hired;
        staff.averageSkillBps = staff.count === 0 ? 6_500 : Math.floor(combinedSkill / staff.count);
        staff.pendingHireCount = 0;
        appendEvent(state, {
          category: "workforce",
          severity: "info",
          source: "operations",
          restaurantId: restaurant.id,
          message: `${hired} ${role}${hired === 1 ? "" : "s"} completed hiring and onboarding`,
          effects: { role, hired, count: staff.count, averageSkillBps: staff.averageSkillBps },
        });
      }
    } else if (staff.targetCount > staff.count) {
      staff.pendingHireCount = Math.min(2, staff.targetCount - staff.count);
      staff.hiringTicksRemaining = 2;
      appendEvent(state, {
        category: "workforce",
        severity: "info",
        source: "operations",
        restaurantId: restaurant.id,
        message: `recruiting ${staff.pendingHireCount} ${role}${staff.pendingHireCount === 1 ? "" : "s"}`,
        effects: { role, pendingHireCount: staff.pendingHireCount, hiringTicksRemaining: 2 },
      });
    } else if (staff.targetCount < staff.count) {
      staff.count -= 1;
      staff.absentCount = Math.min(staff.absentCount, staff.count);
      appendEvent(state, {
        category: "workforce",
        severity: "info",
        source: "operations",
        restaurantId: restaurant.id,
        message: `one ${role} departed under the lower staffing target`,
        effects: { role, count: staff.count, targetCount: staff.targetCount },
      });
    }

    if (staff.trainingTicksRemaining > 0) {
      staff.trainingTicksRemaining -= 1;
      if (staff.trainingTicksRemaining === 0) {
        staff.averageSkillBps = clamp(
          staff.averageSkillBps + staff.pendingSkillGainBps,
          5_000,
          BASIS_POINTS,
        );
        const skillGainBps = staff.pendingSkillGainBps;
        staff.pendingSkillGainBps = 0;
        appendEvent(state, {
          category: "workforce",
          severity: "info",
          source: "operations",
          restaurantId: restaurant.id,
          message: `${role} training completed`,
          effects: { role, skillGainBps, averageSkillBps: staff.averageSkillBps },
        });
      }
    }

    let absentCount = 0;
    let turnover = 0;
    const absenceChanceBps = clamp(
      80 + Math.floor(staff.fatigueBps / 25) + Math.floor(Math.max(0, 6_500 - staff.moraleBps) / 20),
      25,
      800,
    );
    const turnoverChanceBps = clamp(
      4 + Math.floor(Math.max(0, staff.fatigueBps - 4_000) / 100) +
        Math.floor(Math.max(0, 5_500 - staff.moraleBps) / 50),
      2,
      180,
    );
    for (let index = 0; index < staff.count; index += 1) {
      if (randomRestaurantChance(state, restaurant.id, "workforce", absenceChanceBps)) {
        absentCount += 1;
      }
      if (randomRestaurantChance(state, restaurant.id, "workforce", turnoverChanceBps)) {
        turnover += 1;
      }
    }
    if (turnover > 0) {
      turnover = Math.min(turnover, staff.count);
      staff.count -= turnover;
      staff.turnoverCount += turnover;
      appendEvent(state, {
        category: "workforce",
        severity: "warning",
        source: "operations",
        restaurantId: restaurant.id,
        message: `${turnover} ${role}${turnover === 1 ? "" : "s"} left due to fatigue or morale`,
        effects: { role, turnover, count: staff.count, fatigueBps: staff.fatigueBps, moraleBps: staff.moraleBps },
      });
    }
    staff.absentCount = Math.min(absentCount, staff.count);
    if (staff.absentCount > 0) {
      appendEvent(state, {
        category: "workforce",
        severity: "warning",
        source: "environment",
        restaurantId: restaurant.id,
        message: `${staff.absentCount} ${role}${staff.absentCount === 1 ? " is" : "s are"} absent`,
        effects: { role, absentCount: staff.absentCount },
      });
    }
  }
  syncStaffCounts(restaurant);
}

function processDeliveries(state: GameState, restaurant: RestaurantState): number {
  let deliveredUnits = 0;
  for (const order of restaurant.purchaseOrders) {
    if (order.status !== "pending" || order.dueTick > state.tick) {
      continue;
    }
    if (randomRestaurantChance(state, restaurant.id, "supply", state.market.supplyDisruptionBps)) {
      const delayTicks = randomRestaurant(state, restaurant.id, "supply", 1, 2);
      order.dueTick += delayTicks;
      order.disruptionCount += 1;
      appendEvent(state, {
        category: "supply",
        severity: "warning",
        source: "environment",
        restaurantId: restaurant.id,
        message: `${order.id} delayed by ${delayTicks} tick${delayTicks === 1 ? "" : "s"}`,
        effects: {
          orderId: order.id,
          delayTicks,
          dueTick: order.dueTick,
          disruptionCount: order.disruptionCount,
          weather: state.calendar.weather,
        },
      });
      continue;
    }
    order.status = "delivered";
    order.deliveredTick = state.tick;
    const lot: InventoryLot = {
      id: `${order.id}-lot`,
      ingredientId: order.ingredientId,
      quantity: order.quantity,
      unitCostCents: order.unitCostCents,
      ageTicks: 0,
      shelfLifeTicks: 6,
      receivedTick: state.tick,
    };
    restaurant.inventoryLots.push(lot);
    restaurant.inventoryUnits += order.quantity;
    deliveredUnits += order.quantity;
    appendEvent(state, {
      category: "supply",
      severity: "info",
      source: "operations",
      restaurantId: restaurant.id,
      message: `${order.id} delivered ${order.quantity} units`,
      effects: { orderId: order.id, quantity: order.quantity, deliveredTick: state.tick },
    });
  }
  return deliveredUnits;
}

function staffProductivityBps(restaurant: RestaurantState, role: StaffRole): number {
  const staff = restaurant.staffing[role];
  let productivity = staff.averageSkillBps;
  productivity = multiplyBps(productivity, clamp(staff.moraleBps + 2_000, 5_000, BASIS_POINTS));
  productivity = multiplyBps(productivity, clamp(BASIS_POINTS - Math.floor(staff.fatigueBps / 2), 5_000, BASIS_POINTS));
  productivity = multiplyBps(productivity, BASIS_POINTS - restaurant.coordinationBurdenBps);
  if (staff.trainingTicksRemaining > 0) {
    productivity = multiplyBps(productivity, 9_000);
  }
  return productivity;
}

function serviceCapacity(restaurant: RestaurantState): number {
  if (restaurant.bankrupt) {
    return 0;
  }
  const diningCapacity = 12 + restaurant.capacityLevel * 6;
  const availableCooks = Math.max(0, restaurant.staffing.chef.count - restaurant.staffing.chef.absentCount);
  const availableServers = Math.max(0, restaurant.staffing.server.count - restaurant.staffing.server.absentCount);
  let kitchenCapacity = multiplyBps(availableCooks * 7, staffProductivityBps(restaurant, "chef"));
  const serverCapacity = multiplyBps(availableServers * 6, staffProductivityBps(restaurant, "server"));
  if (restaurant.equipment.kitchen.status === "broken") {
    kitchenCapacity = multiplyBps(kitchenCapacity, 2_500);
  } else if (restaurant.equipment.kitchen.status === "maintenance") {
    kitchenCapacity = multiplyBps(kitchenCapacity, 5_000);
  }
  return Math.max(0, Math.min(diningCapacity, kitchenCapacity, serverCapacity));
}

function consumeInventory(restaurant: RestaurantState, units: number): number {
  let remaining = units;
  let costOfGoodsSoldCents = 0;
  restaurant.inventoryLots.sort((left, right) =>
    left.receivedTick - right.receivedTick || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const lot of restaurant.inventoryLots) {
    if (remaining === 0) {
      break;
    }
    const consumed = Math.min(remaining, lot.quantity);
    lot.quantity -= consumed;
    costOfGoodsSoldCents += consumed * lot.unitCostCents;
    remaining -= consumed;
  }
  restaurant.inventoryLots = restaurant.inventoryLots.filter((lot) => lot.quantity > 0);
  restaurant.inventoryUnits -= units;
  return costOfGoodsSoldCents;
}

function spoilInventory(restaurant: RestaurantState): { units: number; costCents: number } {
  const refrigeration = restaurant.equipment.refrigeration;
  const refrigerationAvailable = refrigeration.status === "operational";
  const ageIncrement = refrigerationAvailable ? 1 : 2;
  const spoilageBps = clamp(
    150 + Math.floor((BASIS_POINTS - refrigeration.conditionBps) / 5) + (refrigerationAvailable ? 0 : 1_800),
    100,
    4_000,
  );
  let wasteUnits = 0;
  let spoilageCostCents = 0;
  for (const lot of restaurant.inventoryLots) {
    lot.ageTicks += ageIncrement;
    if (lot.ageTicks >= lot.shelfLifeTicks) {
      wasteUnits += lot.quantity;
      spoilageCostCents += lot.quantity * lot.unitCostCents;
      lot.quantity = 0;
    } else {
      const spoiled = Math.min(lot.quantity, Math.floor((lot.quantity * spoilageBps) / BASIS_POINTS));
      lot.quantity -= spoiled;
      wasteUnits += spoiled;
      spoilageCostCents += spoiled * lot.unitCostCents;
    }
  }
  restaurant.inventoryLots = restaurant.inventoryLots.filter((lot) => lot.quantity > 0);
  restaurant.inventoryUnits = restaurant.inventoryLots.reduce((sum, lot) => sum + lot.quantity, 0);
  return { units: wasteUnits, costCents: spoilageCostCents };
}

function progressEquipment(state: GameState, restaurant: RestaurantState): number {
  let repairCostCents = 0;
  for (const kind of EQUIPMENT_KINDS) {
    const asset = restaurant.equipment[kind];
    const failureRoll = randomRestaurant(state, restaurant.id, "equipment", 1, BASIS_POINTS);
    if (asset.status !== "operational") {
      asset.downtimeTicks = Math.max(0, asset.downtimeTicks - 1);
      if (asset.downtimeTicks === 0) {
        const previousStatus = asset.status;
        asset.status = "operational";
        if (previousStatus === "broken") {
          asset.conditionBps = Math.max(asset.conditionBps, 6_500);
        }
        appendEvent(state, {
          category: "equipment",
          severity: "info",
          source: "operations",
          restaurantId: restaurant.id,
          message: `${kind} returned to service`,
          effects: { assetId: kind, conditionBps: asset.conditionBps },
        });
      }
      continue;
    }

    const baseWear = kind === "kitchen" ? 120 : 90;
    const scalingWear = restaurant.capacityLevel * 45;
    const wear = asset.maintenanceBoostTicks > 0
      ? Math.floor((baseWear + scalingWear) * 0.6)
      : baseWear + scalingWear;
    asset.conditionBps = clamp(asset.conditionBps - wear, 0, BASIS_POINTS);
    const baseFailureBps = kind === "kitchen" ? 70 : 50;
    let failureBps = baseFailureBps + Math.floor((BASIS_POINTS - asset.conditionBps) / 12) + restaurant.capacityLevel * 70;
    if (asset.maintenanceBoostTicks > 0) {
      failureBps = Math.floor(failureBps / 4);
      asset.maintenanceBoostTicks -= 1;
    }
    if (failureRoll <= failureBps) {
      const emergencyRepairCost = (kind === "kitchen" ? 5_500 : 4_200) + restaurant.capacityLevel * 700;
      asset.status = "broken";
      asset.downtimeTicks = 3 + Math.floor(restaurant.capacityLevel / 2);
      asset.conditionBps = Math.min(asset.conditionBps, 3_500);
      asset.totalBreakdowns += 1;
      asset.repairCostsCents += emergencyRepairCost;
      repairCostCents += emergencyRepairCost;
      appendEvent(state, {
        category: "equipment",
        severity: "critical",
        source: "operations",
        restaurantId: restaurant.id,
        message: `${kind} broke down`,
        effects: {
          assetId: kind,
          repairCostCents: emergencyRepairCost,
          downtimeTicks: asset.downtimeTicks,
          conditionBps: asset.conditionBps,
          capacityLevel: restaurant.capacityLevel,
        },
      });
    }
  }
  return repairCostCents;
}

function updatePeopleAfterService(
  restaurant: RestaurantState,
  potentialDemandUnits: number,
  serviceCapacityUnits: number,
  unitsSold: number,
): void {
  const utilizationBps = serviceCapacityUnits === 0
    ? 0
    : clamp(Math.floor((unitsSold * BASIS_POINTS) / serviceCapacityUnits), 0, BASIS_POINTS);
  const fulfillmentBps = potentialDemandUnits === 0
    ? BASIS_POINTS
    : clamp(Math.floor((unitsSold * BASIS_POINTS) / potentialDemandUnits), 0, BASIS_POINTS);
  for (const role of ROLES) {
    const staff = restaurant.staffing[role];
    const understaffed = staff.count < staff.targetCount;
    const fatigueDelta = utilizationBps >= 9_000 ? 300 : utilizationBps >= 6_500 ? 120 : -400;
    staff.fatigueBps = clamp(staff.fatigueBps + fatigueDelta + (understaffed ? 250 : 0), 0, BASIS_POINTS);
    const moraleDelta = fulfillmentBps >= 8_500 ? 80 : fulfillmentBps >= 6_000 ? 0 : -120;
    const fatiguePenalty = Math.floor(Math.max(0, staff.fatigueBps - 4_000) / 80);
    staff.moraleBps = clamp(
      staff.moraleBps + moraleDelta - fatiguePenalty + (understaffed ? -60 : 30),
      2_000,
      BASIS_POINTS,
    );
    staff.averageSkillBps = clamp(staff.averageSkillBps + (unitsSold > 0 ? 12 : 3), 5_000, BASIS_POINTS);
  }
}

function updateReputation(restaurant: RestaurantState, potentialDemandUnits: number, unitsSold: number): void {
  const fulfillmentBps = potentialDemandUnits === 0
    ? BASIS_POINTS
    : Math.floor((unitsSold * BASIS_POINTS) / potentialDemandUnits);
  const targetReputation = clamp(
    5_000 + restaurant.qualityLevel * 700 + Math.floor((fulfillmentBps - 8_000) / 2),
    1_000,
    9_500,
  );
  restaurant.reputationBps = clamp(
    Math.floor((restaurant.reputationBps * 85 + targetReputation * 15) / 100),
    1_000,
    9_500,
  );
}

function simulateRestaurant(
  state: GameState,
  restaurant: RestaurantState,
  potentialDemandUnits: number,
): void {
  if (restaurant.bankrupt) {
    restaurant.lastTick = {
      tick: state.tick,
      potentialDemandUnits: 0,
      serviceCapacityUnits: 0,
      unitsSold: 0,
      lostToCapacityUnits: 0,
      stockoutUnits: 0,
      wasteUnits: 0,
      deliveredUnits: 0,
      absentStaff: 0,
      kitchenDowntime: restaurant.equipment.kitchen.status !== "operational",
      refrigerationDowntime: restaurant.equipment.refrigeration.status !== "operational",
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
      cashCents: restaurant.cashCents,
    };
    return;
  }

  progressWorkforce(state, restaurant);
  const deliveredUnits = processDeliveries(state, restaurant);
  const kitchenDowntime = restaurant.equipment.kitchen.status !== "operational";
  const refrigerationDowntime = restaurant.equipment.refrigeration.status !== "operational";
  const serviceCapacityUnits = serviceCapacity(restaurant);
  const demandWithinCapacity = Math.min(potentialDemandUnits, serviceCapacityUnits);
  const unitsSold = Math.min(demandWithinCapacity, restaurant.inventoryUnits);
  const lostToCapacityUnits = potentialDemandUnits - demandWithinCapacity;
  const stockoutUnits = demandWithinCapacity - unitsSold;
  const costOfGoodsSoldCents = consumeInventory(restaurant, unitsSold);
  const spoilage = spoilInventory(restaurant);
  const wasteUnits = spoilage.units;
  const spoilageCostCents = spoilage.costCents;
  restaurant.inventoryAssetCents -= costOfGoodsSoldCents + spoilageCostCents;
  const repairCostCents = progressEquipment(state, restaurant);

  const revenueCents = unitsSold * restaurant.menuPriceCents;
  const wageCostCents = restaurant.cooks * COOK_WAGE_CENTS + restaurant.servers * SERVER_WAGE_CENTS;
  const marketingCostCents = restaurant.marketingSpendPerTickCents;
  const fixedCostCents = 700 + restaurant.capacityLevel * 350 + restaurant.qualityLevel * 100;
  const rentCostCents = (state.tick + 1) % 7 === 0 ? 4_200 + restaurant.capacityLevel * 1_800 : 0;
  const utilityCostCents = 350 + restaurant.capacityLevel * 150 +
    Math.floor((BASIS_POINTS - restaurant.equipment.refrigeration.conditionBps) / 20);
  const interestCostCents = restaurant.debtCents === 0
    ? 0
    : Math.max(1, Math.floor((restaurant.debtCents * 15) / BASIS_POINTS));
  const cashOperatingCosts = wageCostCents + marketingCostCents + fixedCostCents + rentCostCents +
    utilityCostCents + interestCostCents + repairCostCents;
  const totalTickCosts = cashOperatingCosts + costOfGoodsSoldCents + spoilageCostCents;
  const operatingProfitCents = revenueCents - totalTickCosts;
  const cashFlowCents = revenueCents - cashOperatingCosts;

  restaurant.cashCents += cashFlowCents;
  restaurant.totalRevenueCents += revenueCents;
  restaurant.totalCostsCents += totalTickCosts;
  restaurant.totalInterestCents += interestCostCents;
  restaurant.cumulativeOperatingProfitCents += operatingProfitCents;
  restaurant.totalUnitsSold += unitsSold;
  restaurant.totalWasteUnits += wasteUnits;
  const absentStaff = restaurant.staffing.chef.absentCount + restaurant.staffing.server.absentCount;
  restaurant.lastTick = {
    tick: state.tick,
    potentialDemandUnits,
    serviceCapacityUnits,
    unitsSold,
    lostToCapacityUnits,
    stockoutUnits,
    wasteUnits,
    deliveredUnits,
    absentStaff,
    kitchenDowntime,
    refrigerationDowntime,
    revenueCents,
    wageCostCents,
    marketingCostCents,
    fixedCostCents,
    rentCostCents,
    utilityCostCents,
    interestCostCents,
    repairCostCents,
    costOfGoodsSoldCents,
    spoilageCostCents,
    operatingProfitCents,
    cashFlowCents,
    cashCents: restaurant.cashCents,
  };
  updatePeopleAfterService(restaurant, potentialDemandUnits, serviceCapacityUnits, unitsSold);
  updateReputation(restaurant, potentialDemandUnits, unitsSold);

  if (wasteUnits > 0) {
    appendEvent(state, {
      category: "operations",
      severity: refrigerationDowntime ? "warning" : "info",
      source: "operations",
      restaurantId: restaurant.id,
      message: `${wasteUnits} inventory units spoiled`,
      effects: {
        wasteUnits,
        spoilageCostCents,
        refrigerationDowntime,
        refrigerationConditionBps: restaurant.equipment.refrigeration.conditionBps,
      },
    });
  }
  if (stockoutUnits > 0) {
    appendEvent(state, {
      category: "stockout",
      severity: "warning",
      source: "operations",
      restaurantId: restaurant.id,
      message: `${stockoutUnits} sales lost to stockout`,
      effects: { stockoutUnits, inventoryUnits: restaurant.inventoryUnits },
    });
  }
  if (lostToCapacityUnits > 0) {
    appendEvent(state, {
      category: "capacity",
      severity: "warning",
      source: "operations",
      restaurantId: restaurant.id,
      message: `${lostToCapacityUnits} sales lost to service capacity`,
      effects: { lostToCapacityUnits, serviceCapacityUnits, coordinationBurdenBps: restaurant.coordinationBurdenBps },
    });
  }
  if (restaurant.cashCents < 0) {
    restaurant.bankrupt = true;
    restaurant.bankruptcyTick = state.tick;
    appendEvent(state, {
      category: "bankruptcy",
      severity: "critical",
      source: "operations",
      restaurantId: restaurant.id,
      message: "restaurant declared bankruptcy after cash fell below zero",
      effects: { cashCents: restaurant.cashCents, debtCents: restaurant.debtCents },
    });
  }
}

function simulateTick(state: GameState): void {
  logEnvironment(state);
  const marketGrowthBps = clamp(BASIS_POINTS + Math.floor(averageMarketingSpend(state) / 5), 10_000, 11_000);
  const demandByRestaurant: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const restaurantId of state.config.restaurantIds) {
    demandByRestaurant[restaurantId] = demandForRestaurant(
      state,
      state.restaurants[restaurantId]!,
      marketGrowthBps,
    );
  }
  for (const restaurantId of state.config.restaurantIds) {
    simulateRestaurant(state, state.restaurants[restaurantId]!, demandByRestaurant[restaurantId]!);
  }

  state.tick += 1;
  if (state.tick < state.config.maxTicks) {
    state.market.ingredientUnitCostCents = clamp(
      state.market.ingredientUnitCostCents + randomExogenous(state, "marketPrice", -35, 35),
      250,
      650,
    );
    state.market.demandIndexBps = clamp(
      state.market.demandIndexBps + randomExogenous(state, "marketDemand", -500, 500),
      7_500,
      12_500,
    );
    state.calendar = calendarForTick(state, state.tick);
  }
  state.series.push(makeSeriesPoint(state));
}

export function advanceGame(state: GameState, ticks = 1): GameState {
  if (!isBoundedInteger(ticks, 1, 10_000)) {
    throw new RangeError("ticks must be an integer from 1 to 10000");
  }
  const next = clone(state);
  const targetTick = Math.min(next.config.maxTicks, next.tick + ticks);
  while (next.tick < targetTick) {
    simulateTick(next);
  }
  return next;
}

function toPublicRestaurant(restaurant: RestaurantState): PublicRestaurantSnapshot {
  return {
    id: restaurant.id,
    menuPriceCents: restaurant.menuPriceCents,
    inventoryUnits: restaurant.inventoryUnits,
    cooks: restaurant.cooks,
    servers: restaurant.servers,
    staffing: clone(restaurant.staffing),
    marketingSpendPerTickCents: restaurant.marketingSpendPerTickCents,
    capacityLevel: restaurant.capacityLevel,
    qualityLevel: restaurant.qualityLevel,
    coordinationBurdenBps: restaurant.coordinationBurdenBps,
    reputationBps: restaurant.reputationBps,
    cashCents: restaurant.cashCents,
    debtCents: restaurant.debtCents,
    bankrupt: restaurant.bankrupt,
    equipment: clone(restaurant.equipment),
    cumulativeOperatingProfitCents: restaurant.cumulativeOperatingProfitCents,
    lastTick: clone(restaurant.lastTick),
  };
}

function leaderboard(state: GameState): LeaderboardEntry[] {
  return state.config.restaurantIds
    .map((restaurantId) => state.restaurants[restaurantId]!)
    .sort(
      (left, right) =>
        Number(left.bankrupt) - Number(right.bankrupt) ||
        right.cumulativeOperatingProfitCents - left.cumulativeOperatingProfitCents ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .map((restaurant, index) => ({
      rank: index + 1,
      restaurantId: restaurant.id,
      cumulativeOperatingProfitCents: restaurant.cumulativeOperatingProfitCents,
      cashCents: restaurant.cashCents,
      debtCents: restaurant.debtCents,
      bankrupt: restaurant.bankrupt,
      totalRevenueCents: restaurant.totalRevenueCents,
      totalCostsCents: restaurant.totalCostsCents,
      totalUnitsSold: restaurant.totalUnitsSold,
      reputationBps: restaurant.reputationBps,
    }));
}

export function observe(state: GameState, restaurantId: string): Observation {
  const restaurant = state.restaurants[restaurantId];
  if (restaurant === undefined) {
    throw new RangeError(`unknown restaurant: ${restaurantId}`);
  }
  return {
    restaurantId,
    tick: state.tick,
    maxTicks: state.config.maxTicks,
    finished: state.tick >= state.config.maxTicks,
    market: { ...state.market },
    calendar: { ...state.calendar },
    restaurant: clone(restaurant),
    competitors: state.config.restaurantIds
      .filter((id) => id !== restaurantId)
      .map((id) => toPublicRestaurant(state.restaurants[id]!)),
    recentEvents: clone(state.recentEvents),
  };
}

export function publicSnapshot(state: GameState): PublicGameSnapshot {
  return {
    tick: state.tick,
    maxTicks: state.config.maxTicks,
    seed: state.config.seed,
    leaderboard: leaderboard(state),
    restaurants: state.config.restaurantIds.map((id) => toPublicRestaurant(state.restaurants[id]!)),
    market: { ...state.market },
    calendar: { ...state.calendar },
    recentEvents: clone(state.recentEvents),
    series: clone(state.series),
  };
}
