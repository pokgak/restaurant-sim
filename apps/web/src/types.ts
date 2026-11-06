export type GameStatus = "live" | "paused" | "completed";
export type RawGameStatus = "running" | "paused" | "completed";
export type StaffRole = "chef" | "server";
export type EquipmentKind = "kitchen" | "refrigeration";
export type EquipmentStatus = "operational" | "maintenance" | "broken";
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

export interface RawLeaderboardEntry {
  restaurantId: string;
  name?: string;
  rank: number;
  cumulativeOperatingProfitCents: number;
  cashCents: number;
  debtCents: number;
  bankrupt: boolean;
  totalRevenueCents: number;
  totalCostsCents: number;
  totalUnitsSold: number;
  reputationBps: number;
}

export interface RawMarketSnapshot {
  ingredientUnitCostCents: number;
  demandIndexBps: number;
  supplyDisruptionBps: number;
}

export interface RawCalendarSnapshot {
  day: number;
  dayOfWeek: number;
  dayName: "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";
  isWeekend: boolean;
  season: "winter" | "spring" | "summer" | "autumn";
  seasonDemandBps: number;
  weather: "clear" | "rain" | "heat" | "storm";
  weatherDemandBps: number;
  localEvent: "none" | "festival" | "sports" | "construction";
  localDemandBps: number;
  demandRegimeBps: number;
}

export interface RawStaffRoleState {
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

export interface RawEquipmentAsset {
  id: EquipmentKind;
  kind: EquipmentKind;
  conditionBps: number;
  status: EquipmentStatus;
  downtimeTicks: number;
  maintenanceBoostTicks: number;
  totalBreakdowns: number;
  totalMaintenance: number;
  repairCostsCents: number;
}

export interface RawTickReport {
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

export interface RawRestaurantSnapshot {
  id: string;
  menuPriceCents: number;
  inventoryUnits: number;
  cooks: number;
  servers: number;
  staffing: Record<StaffRole, RawStaffRoleState>;
  marketingSpendPerTickCents: number;
  capacityLevel: number;
  qualityLevel: number;
  coordinationBurdenBps: number;
  reputationBps: number;
  cashCents: number;
  debtCents: number;
  bankrupt: boolean;
  equipment: Record<EquipmentKind, RawEquipmentAsset>;
  cumulativeOperatingProfitCents: number;
  lastTick: RawTickReport | null;
}

export interface RawGameEvent {
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

export interface RawProfitPoint {
  tick: number;
  restaurants: Record<
    string,
    {
      operatingProfitCents: number;
      cumulativeOperatingProfitCents: number;
      revenueCents: number;
      cashCents: number;
      debtCents: number;
      bankrupt: boolean;
    }
  >;
}

export interface RawPublicGame {
  id: string;
  status: RawGameStatus;
  tick: number;
  maxTicks: number;
  seed: number;
  leaderboard: RawLeaderboardEntry[];
  restaurants: RawRestaurantSnapshot[];
  market: RawMarketSnapshot;
  calendar: RawCalendarSnapshot;
  recentEvents: RawGameEvent[];
  series: RawProfitPoint[];
}

export interface LeaderboardEntry {
  restaurantId: string;
  name: string;
  rank: number;
  operatingProfitCents: number;
  cashCents: number;
  debtCents: number;
  bankrupt: boolean;
  revenueCents: number;
  expensesCents: number;
  unitsSold: number;
  reputationPercent: number;
}

export interface MarketSnapshot {
  ingredientUnitCostCents: number;
  demandIndexPercent: number;
  supplyDisruptionPercent: number;
}

export interface CalendarSnapshot {
  day: number;
  dayOfWeek: number;
  dayName: RawCalendarSnapshot["dayName"];
  isWeekend: boolean;
  season: RawCalendarSnapshot["season"];
  seasonDemandPercent: number;
  weather: RawCalendarSnapshot["weather"];
  weatherDemandPercent: number;
  localEvent: RawCalendarSnapshot["localEvent"];
  localDemandPercent: number;
  demandRegimePercent: number;
}

export interface StaffRoleState {
  count: number;
  targetCount: number;
  absentCount: number;
  averageSkillPercent: number;
  fatiguePercent: number;
  moralePercent: number;
  pendingHireCount: number;
  hiringTicksRemaining: number;
  trainingTicksRemaining: number;
  pendingSkillGainPercent: number;
  turnoverCount: number;
}

export interface EquipmentAsset {
  id: EquipmentKind;
  kind: EquipmentKind;
  conditionPercent: number;
  status: EquipmentStatus;
  downtimeTicks: number;
  maintenanceBoostTicks: number;
  totalBreakdowns: number;
  totalMaintenance: number;
  repairCostsCents: number;
}

export type TickReport = RawTickReport;

export interface RestaurantSnapshot {
  id: string;
  name: string;
  menuPriceCents: number;
  inventoryUnits: number;
  cooks: number;
  servers: number;
  staffing: Record<StaffRole, StaffRoleState>;
  marketingSpendPerTickCents: number;
  capacityLevel: number;
  qualityLevel: number;
  coordinationBurdenPercent: number;
  reputationPercent: number;
  cashCents: number;
  debtCents: number;
  bankrupt: boolean;
  equipment: Record<EquipmentKind, EquipmentAsset>;
  cumulativeOperatingProfitCents: number;
  lastTick: TickReport | null;
}

export type GameEvent = RawGameEvent;

export interface ProfitPoint {
  tick: number;
  restaurants: Array<{
    restaurantId: string;
    operatingProfitCents: number;
    cumulativeOperatingProfitCents: number;
    revenueCents: number;
    cashCents: number;
    debtCents: number;
    bankrupt: boolean;
  }>;
}

export interface PublicGame {
  id: string;
  status: GameStatus;
  tick: number;
  maxTicks: number;
  seed: number;
  leaderboard: LeaderboardEntry[];
  restaurants: RestaurantSnapshot[];
  market: MarketSnapshot;
  calendar: CalendarSnapshot;
  recentEvents: GameEvent[];
  series: ProfitPoint[];
}

export type FixtureScenario = GameStatus | "loading" | "error";
