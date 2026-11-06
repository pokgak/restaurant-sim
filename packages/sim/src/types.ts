export type StaffRole = "chef" | "server";
export type EquipmentKind = "kitchen" | "refrigeration";
export type Season = "winter" | "spring" | "summer" | "autumn";
export type Weather = "clear" | "rain" | "heat" | "storm";
export type LocalEvent = "none" | "festival" | "sports" | "construction";

/**
 * Versioned, append-only random stream names. A stream may never be renamed or
 * repurposed without incrementing RandomState.version and migrating saved games.
 */
export interface ExogenousRandomState {
  calendarWeather: number;
  calendarLocalEvent: number;
  marketPrice: number;
  marketDemand: number;
}

/** Restaurant streams are keyed by restaurant ID, so another restaurant's policy cannot consume them. */
export interface RestaurantRandomState {
  demand: number;
  workforce: number;
  supply: number;
  equipment: number;
}

export interface RandomState {
  version: 1;
  exogenous: ExogenousRandomState;
  restaurants: Record<string, RestaurantRandomState>;
}

export interface GameConfig {
  seed: number;
  restaurantIds: string[];
  maxTicks: number;
}

export interface MarketState {
  ingredientUnitCostCents: number;
  demandIndexBps: number;
  supplyDisruptionBps: number;
}

export interface CalendarState {
  day: number;
  dayOfWeek: number;
  dayName: "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";
  isWeekend: boolean;
  season: Season;
  seasonDemandBps: number;
  weather: Weather;
  weatherDemandBps: number;
  localEvent: LocalEvent;
  localDemandBps: number;
  demandRegimeBps: number;
}

export interface TickReport {
  tick: number;
  potentialDemandUnits: number;
  serviceCapacityUnits: number;
  unitsSold: number;
  lostToCapacityUnits: number;
  stockoutUnits: number;
  wasteUnits: number;
  deliveredUnits: number;
  absentStaff: number;
  kitchenDowntime: boolean;
  refrigerationDowntime: boolean;
  revenueCents: number;
  wageCostCents: number;
  marketingCostCents: number;
  fixedCostCents: number;
  rentCostCents: number;
  utilityCostCents: number;
  interestCostCents: number;
  repairCostCents: number;
  costOfGoodsSoldCents: number;
  spoilageCostCents: number;
  operatingProfitCents: number;
  cashFlowCents: number;
  cashCents: number;
}

export interface InventoryLot {
  id: string;
  ingredientId: string;
  quantity: number;
  unitCostCents: number;
  ageTicks: number;
  shelfLifeTicks: number;
  receivedTick: number;
}

export interface PurchaseOrder {
  id: string;
  ingredientId: string;
  quantity: number;
  unitCostCents: number;
  orderedTick: number;
  originalDueTick: number;
  dueTick: number;
  disruptionCount: number;
  status: "pending" | "delivered";
  deliveredTick: number | null;
}

export interface EquipmentAsset {
  id: EquipmentKind;
  kind: EquipmentKind;
  conditionBps: number;
  status: "operational" | "maintenance" | "broken";
  downtimeTicks: number;
  maintenanceBoostTicks: number;
  totalBreakdowns: number;
  totalMaintenance: number;
  repairCostsCents: number;
}

export interface StaffRoleState {
  count: number;
  targetCount: number;
  absentCount: number;
  averageSkillBps: number;
  fatigueBps: number;
  moraleBps: number;
  pendingHireCount: number;
  hiringTicksRemaining: number;
  trainingTicksRemaining: number;
  pendingSkillGainBps: number;
  turnoverCount: number;
}

export interface RestaurantState {
  id: string;
  menuPriceCents: number;
  inventoryUnits: number;
  storageCapacityUnits: number;
  inventoryLots: InventoryLot[];
  purchaseOrders: PurchaseOrder[];
  nextOrderNumber: number;
  cooks: number;
  servers: number;
  staffing: Record<StaffRole, StaffRoleState>;
  marketingSpendPerTickCents: number;
  capacityLevel: number;
  qualityLevel: number;
  coordinationBurdenBps: number;
  equipment: Record<EquipmentKind, EquipmentAsset>;
  reputationBps: number;
  cashCents: number;
  inventoryAssetCents: number;
  debtCents: number;
  creditLimitCents: number;
  bankrupt: boolean;
  bankruptcyTick: number | null;
  totalBorrowedCents: number;
  totalRepaidCents: number;
  totalInterestCents: number;
  cumulativeOperatingProfitCents: number;
  totalRevenueCents: number;
  totalCostsCents: number;
  totalUnitsSold: number;
  totalWasteUnits: number;
  lastTick: TickReport | null;
}

export type EventCategory =
  | "action"
  | "environment"
  | "finance"
  | "equipment"
  | "workforce"
  | "supply"
  | "capacity"
  | "stockout"
  | "operations"
  | "bankruptcy";

export type EventSeverity = "info" | "warning" | "critical";
export type EventSource = "agent" | "environment" | "operations";
export type EventEffectValue = string | number | boolean;

export interface PublicGameEvent {
  id: string;
  type: EventCategory;
  category: EventCategory;
  severity: EventSeverity;
  source: EventSource;
  tick: number;
  restaurantId?: string;
  message: string;
  effects: Record<string, EventEffectValue>;
}

export interface GameState {
  version: 2;
  config: GameConfig;
  tick: number;
  prngState: RandomState;
  eventSequence: number;
  market: MarketState;
  calendar: CalendarState;
  restaurants: Record<string, RestaurantState>;
  eventLedger: PublicGameEvent[];
  recentEvents: PublicGameEvent[];
  series: PublicSeriesPoint[];
}

export type PlayerAction =
  | { type: "set_menu_price"; dishId: string; priceCents: number }
  | { type: "purchase_inventory"; ingredientId: string; quantity: number }
  | { type: "set_staff"; role: StaffRole; count: number }
  | { type: "set_marketing"; budgetCents: number }
  | { type: "invest"; kind: "capacity" | "quality" }
  | { type: "borrow"; amountCents: number }
  | { type: "repay_loan"; amountCents: number }
  | { type: "schedule_maintenance"; assetId: EquipmentKind }
  | { type: "repair_equipment"; assetId: EquipmentKind }
  | { type: "train_staff"; role: StaffRole; budgetCents: number }
  | { type: "expedite_delivery"; orderId: string };

export interface ActionResult {
  accepted: boolean;
  message: string;
  costCents: number;
}

export interface ApplyActionResult {
  state: GameState;
  result: ActionResult;
}

export interface PublicRestaurantSnapshot {
  id: string;
  menuPriceCents: number;
  inventoryUnits: number;
  cooks: number;
  servers: number;
  staffing: Record<StaffRole, StaffRoleState>;
  marketingSpendPerTickCents: number;
  capacityLevel: number;
  qualityLevel: number;
  coordinationBurdenBps: number;
  reputationBps: number;
  cashCents: number;
  debtCents: number;
  bankrupt: boolean;
  equipment: Record<EquipmentKind, EquipmentAsset>;
  cumulativeOperatingProfitCents: number;
  lastTick: TickReport | null;
}

export interface LeaderboardEntry {
  rank: number;
  restaurantId: string;
  cumulativeOperatingProfitCents: number;
  cashCents: number;
  debtCents: number;
  bankrupt: boolean;
  totalRevenueCents: number;
  totalCostsCents: number;
  totalUnitsSold: number;
  reputationBps: number;
}

export interface PublicSeriesRestaurantPoint {
  operatingProfitCents: number;
  cumulativeOperatingProfitCents: number;
  revenueCents: number;
  cashCents: number;
  debtCents: number;
  bankrupt: boolean;
}

export interface PublicSeriesPoint {
  tick: number;
  restaurants: Record<string, PublicSeriesRestaurantPoint>;
}

export interface PublicGameSnapshot {
  tick: number;
  maxTicks: number;
  seed: number;
  leaderboard: LeaderboardEntry[];
  restaurants: PublicRestaurantSnapshot[];
  market: MarketState;
  calendar: CalendarState;
  recentEvents: PublicGameEvent[];
  series: PublicSeriesPoint[];
}

export interface Observation {
  restaurantId: string;
  tick: number;
  maxTicks: number;
  finished: boolean;
  market: MarketState;
  calendar: CalendarState;
  restaurant: RestaurantState;
  competitors: PublicRestaurantSnapshot[];
  recentEvents: PublicGameEvent[];
}
