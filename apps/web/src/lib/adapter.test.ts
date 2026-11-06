import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRawFixture } from "../data/fixture";
import type { RawPublicGame } from "../types";
import { adaptPublicGame } from "./adapter";
import { createGameApi } from "./api";

const rawGame: RawPublicGame = makeRawFixture();

describe("adaptPublicGame", () => {
  it("maps the exact frozen public response shape without a private event ledger", () => {
    expect(Object.keys(rawGame)).toEqual([
      "id",
      "status",
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
    expect("eventLedger" in rawGame).toBe(false);
    expect(Object.keys(rawGame.leaderboard[0]!)).toEqual([
      "restaurantId",
      "name",
      "rank",
      "cumulativeOperatingProfitCents",
      "cashCents",
      "debtCents",
      "bankrupt",
      "totalRevenueCents",
      "totalCostsCents",
      "totalUnitsSold",
      "reputationBps",
    ]);
    expect(Object.keys(rawGame.restaurants[0]!)).toEqual([
      "id",
      "menuPriceCents",
      "inventoryUnits",
      "cooks",
      "servers",
      "staffing",
      "marketingSpendPerTickCents",
      "capacityLevel",
      "qualityLevel",
      "coordinationBurdenBps",
      "reputationBps",
      "cashCents",
      "debtCents",
      "bankrupt",
      "equipment",
      "cumulativeOperatingProfitCents",
      "lastTick",
    ]);
    expect(Object.keys(rawGame.calendar)).toEqual([
      "day",
      "dayOfWeek",
      "dayName",
      "isWeekend",
      "season",
      "seasonDemandBps",
      "weather",
      "weatherDemandBps",
      "localEvent",
      "localDemandBps",
      "demandRegimeBps",
    ]);
    expect(Object.keys(rawGame.recentEvents[0]!)).toEqual([
      "id",
      "tick",
      "category",
      "type",
      "severity",
      "source",
      "restaurantId",
      "message",
      "effects",
    ]);
    expect(Object.keys(rawGame.series[0]!.restaurants["rest-noodle"]!)).toEqual([
      "operatingProfitCents",
      "cumulativeOperatingProfitCents",
      "revenueCents",
      "cashCents",
      "debtCents",
      "bankrupt",
    ]);

    const game = adaptPublicGame(rawGame);
    const firstRaw = rawGame.leaderboard[0]!;
    const firstRestaurantRaw = rawGame.restaurants[0]!;

    expect(game.status).toBe("live");
    expect(game.leaderboard[0]).toEqual({
      restaurantId: firstRaw.restaurantId,
      name: firstRaw.name,
      rank: firstRaw.rank,
      operatingProfitCents: firstRaw.cumulativeOperatingProfitCents,
      cashCents: firstRaw.cashCents,
      debtCents: firstRaw.debtCents,
      bankrupt: firstRaw.bankrupt,
      revenueCents: firstRaw.totalRevenueCents,
      expensesCents: firstRaw.totalCostsCents,
      unitsSold: firstRaw.totalUnitsSold,
      reputationPercent: firstRaw.reputationBps / 100,
    });
    expect(game.restaurants[0]).toMatchObject({
      id: firstRestaurantRaw.id,
      name: firstRaw.name,
      inventoryUnits: firstRestaurantRaw.inventoryUnits,
      cashCents: firstRestaurantRaw.cashCents,
      debtCents: firstRestaurantRaw.debtCents,
      bankrupt: firstRestaurantRaw.bankrupt,
      coordinationBurdenPercent: firstRestaurantRaw.coordinationBurdenBps / 100,
      lastTick: firstRestaurantRaw.lastTick,
    });
    expect(game.restaurants[0]!.staffing.chef).toMatchObject({
      count: firstRestaurantRaw.staffing.chef.count,
      targetCount: firstRestaurantRaw.staffing.chef.targetCount,
      absentCount: firstRestaurantRaw.staffing.chef.absentCount,
      averageSkillPercent: firstRestaurantRaw.staffing.chef.averageSkillBps / 100,
      fatiguePercent: firstRestaurantRaw.staffing.chef.fatigueBps / 100,
      moralePercent: firstRestaurantRaw.staffing.chef.moraleBps / 100,
    });
    expect(game.restaurants[1]!.equipment.kitchen).toMatchObject({
      status: "broken",
      conditionPercent: 32,
      downtimeTicks: 3,
    });
  });

  it("uses the restaurant ID when a public display name is missing or blank", () => {
    const leaderboard = rawGame.leaderboard.map((entry, index) =>
      index === 0 ? { ...entry, name: "  " } : entry,
    );
    const game = adaptPublicGame({ ...rawGame, leaderboard });

    expect(game.leaderboard[0]!.name).toBe("rest-noodle");
    expect(game.restaurants[0]!.name).toBe("rest-noodle");
  });

  it("maps cash, debt, bankruptcy, calendar, market, events, and series values", () => {
    const game = adaptPublicGame(rawGame);
    const bankrupt = game.leaderboard.find((entry) => entry.restaurantId === "rest-pasta");

    expect(bankrupt).toMatchObject({ cashCents: -12_400, debtCents: 120_000, bankrupt: true });
    expect(game.market).toEqual({
      ingredientUnitCostCents: 418,
      demandIndexPercent: 86,
      supplyDisruptionPercent: 36,
    });
    expect(game.calendar).toMatchObject({
      day: 20,
      dayName: "Saturday",
      isWeekend: true,
      season: "autumn",
      weather: "storm",
      localEvent: "construction",
      demandRegimePercent: 72,
    });
    expect(game.recentEvents).toEqual(rawGame.recentEvents);
    expect(game.recentEvents.some((event) => event.category === "operations")).toBe(true);
    expect(game.recentEvents.some((event) => event.source === "environment")).toBe(true);
    expect(game.recentEvents.some((event) => event.severity === "critical")).toBe(true);
    expect(
      game.series[game.series.length - 1]!.restaurants.find(
        (entry) => entry.restaurantId === "rest-pasta",
      ),
    ).toMatchObject({ cashCents: -12_400, debtCents: 120_000, bankrupt: true });
  });

  it.each([
    ["paused", "paused"],
    ["completed", "completed"],
  ] as const)("preserves the %s status", (rawStatus, expectedStatus) => {
    expect(adaptPublicGame({ ...rawGame, status: rawStatus }).status).toBe(expectedStatus);
  });
});

describe("public API and trace export", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adapts the accepted shape returned by the live public endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rawGame), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createGameApi({ mock: false, scenario: "live" });

    const game = await api.getPublicGame("game/a", new AbortController().signal);

    expect(game.restaurants[1]!.equipment.kitchen.status).toBe("broken");
    expect(game.calendar.weather).toBe("storm");
    expect(fetchMock).toHaveBeenCalledWith("/api/games/game%2Fa/public", {
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
  });

  it("uses the export route and reports protected deployments", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createGameApi({ mock: false, scenario: "live" });

    await expect(api.downloadTrace("game/a")).rejects.toThrow(
      "Trace export requires authorization for this deployment.",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/games/game%2Fa/export", {
      headers: { Accept: "application/json" },
    });
  });
});
