import type {
  EquipmentAsset,
  GameStatus,
  PublicGame,
  RawEquipmentAsset,
  RawGameStatus,
  RawPublicGame,
  RawStaffRoleState,
  StaffRoleState,
} from "../types";

function adaptStatus(status: RawGameStatus): GameStatus {
  return status === "running" ? "live" : status;
}

function percentFromBps(value: number): number {
  return value / 100;
}

function adaptStaffing(staff: RawStaffRoleState): StaffRoleState {
  return {
    count: staff.count,
    targetCount: staff.targetCount,
    absentCount: staff.absentCount,
    averageSkillPercent: percentFromBps(staff.averageSkillBps),
    fatiguePercent: percentFromBps(staff.fatigueBps),
    moralePercent: percentFromBps(staff.moraleBps),
    pendingHireCount: staff.pendingHireCount,
    hiringTicksRemaining: staff.hiringTicksRemaining,
    trainingTicksRemaining: staff.trainingTicksRemaining,
    pendingSkillGainPercent: percentFromBps(staff.pendingSkillGainBps),
    turnoverCount: staff.turnoverCount,
  };
}

function adaptEquipment(asset: RawEquipmentAsset): EquipmentAsset {
  return {
    id: asset.id,
    kind: asset.kind,
    conditionPercent: percentFromBps(asset.conditionBps),
    status: asset.status,
    downtimeTicks: asset.downtimeTicks,
    maintenanceBoostTicks: asset.maintenanceBoostTicks,
    totalBreakdowns: asset.totalBreakdowns,
    totalMaintenance: asset.totalMaintenance,
    repairCostsCents: asset.repairCostsCents,
  };
}

export function adaptPublicGame(raw: RawPublicGame): PublicGame {
  const names = new Map(
    raw.leaderboard.map((entry) => [
      entry.restaurantId,
      entry.name?.trim() || entry.restaurantId,
    ]),
  );

  return {
    id: raw.id,
    status: adaptStatus(raw.status),
    tick: raw.tick,
    maxTicks: raw.maxTicks,
    seed: raw.seed,
    leaderboard: raw.leaderboard.map((entry) => ({
      restaurantId: entry.restaurantId,
      name: names.get(entry.restaurantId) ?? entry.restaurantId,
      rank: entry.rank,
      operatingProfitCents: entry.cumulativeOperatingProfitCents,
      cashCents: entry.cashCents,
      debtCents: entry.debtCents,
      bankrupt: entry.bankrupt,
      revenueCents: entry.totalRevenueCents,
      expensesCents: entry.totalCostsCents,
      unitsSold: entry.totalUnitsSold,
      reputationPercent: percentFromBps(entry.reputationBps),
    })),
    restaurants: raw.restaurants.map((restaurant) => ({
      id: restaurant.id,
      name: names.get(restaurant.id) ?? restaurant.id,
      menuPriceCents: restaurant.menuPriceCents,
      inventoryUnits: restaurant.inventoryUnits,
      cooks: restaurant.cooks,
      servers: restaurant.servers,
      staffing: {
        chef: adaptStaffing(restaurant.staffing.chef),
        server: adaptStaffing(restaurant.staffing.server),
      },
      marketingSpendPerTickCents: restaurant.marketingSpendPerTickCents,
      capacityLevel: restaurant.capacityLevel,
      qualityLevel: restaurant.qualityLevel,
      coordinationBurdenPercent: percentFromBps(restaurant.coordinationBurdenBps),
      reputationPercent: percentFromBps(restaurant.reputationBps),
      cashCents: restaurant.cashCents,
      debtCents: restaurant.debtCents,
      bankrupt: restaurant.bankrupt,
      equipment: {
        kitchen: adaptEquipment(restaurant.equipment.kitchen),
        refrigeration: adaptEquipment(restaurant.equipment.refrigeration),
      },
      cumulativeOperatingProfitCents: restaurant.cumulativeOperatingProfitCents,
      lastTick: restaurant.lastTick ? { ...restaurant.lastTick } : null,
    })),
    market: {
      ingredientUnitCostCents: raw.market.ingredientUnitCostCents,
      demandIndexPercent: percentFromBps(raw.market.demandIndexBps),
      supplyDisruptionPercent: percentFromBps(raw.market.supplyDisruptionBps),
    },
    calendar: {
      day: raw.calendar.day,
      dayOfWeek: raw.calendar.dayOfWeek,
      dayName: raw.calendar.dayName,
      isWeekend: raw.calendar.isWeekend,
      season: raw.calendar.season,
      seasonDemandPercent: percentFromBps(raw.calendar.seasonDemandBps),
      weather: raw.calendar.weather,
      weatherDemandPercent: percentFromBps(raw.calendar.weatherDemandBps),
      localEvent: raw.calendar.localEvent,
      localDemandPercent: percentFromBps(raw.calendar.localDemandBps),
      demandRegimePercent: percentFromBps(raw.calendar.demandRegimeBps),
    },
    recentEvents: raw.recentEvents.map((event) => ({
      ...event,
      effects: { ...event.effects },
    })),
    series: raw.series.map((point) => ({
      tick: point.tick,
      restaurants: Object.entries(point.restaurants).map(([restaurantId, value]) => ({
        restaurantId,
        operatingProfitCents: value.operatingProfitCents,
        cumulativeOperatingProfitCents: value.cumulativeOperatingProfitCents,
        revenueCents: value.revenueCents,
        cashCents: value.cashCents,
        debtCents: value.debtCents,
        bankrupt: value.bankrupt,
      })),
    })),
  };
}
