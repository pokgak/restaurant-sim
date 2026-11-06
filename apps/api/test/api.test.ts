import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

interface SeatCredential {
  restaurantId: string;
  name: string;
  token: string;
}

interface CreatedGame {
  id: string;
  status: string;
  seats: SeatCredential[];
}

interface AgentState {
  restaurantId: string;
  restaurant: {
    marketingSpendPerTickCents: number;
    qualityLevel: number;
  };
}

interface AuditRow {
  seq: number;
  actorSeq: number;
  actorId: string;
  requestId: string | null;
  kind: string;
  ok: boolean;
}

interface EnvironmentEventRow {
  sequence: number;
  engineEventId: string;
  tick: number;
  category: string;
  source: string;
  severity: string;
  restaurantId: string | null;
  event: {
    id: string;
    tick: number;
    category: string;
    source: string;
    severity: string;
  };
  stateDigest: string;
}

interface GameExport {
  metadata: { id: string };
  results: {
    leaderboard: Array<{ restaurantId: string; name: string }>;
  };
  profitTimeline: unknown;
  environmentEvents: EnvironmentEventRow[];
  logs: AuditRow[];
  actorLogs: Record<string, AuditRow[]>;
}

interface PublicGame extends Record<string, unknown> {
  calendar: Record<string, unknown>;
  leaderboard: Array<{ restaurantId: string; name: string }>;
  recentEvents: unknown[];
  restaurants: Array<{ id: string; cashCents: number }>;
}

const worker = exports.default;
const ADMIN_TOKEN = "test-admin-token";

async function api(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://api.test${path}`, init));
}

async function createGame(maxTicks = 250): Promise<CreatedGame> {
  const response = await api("/api/games", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      seed: 42,
      maxTicks,
      restaurants: [
        { id: "alpha", name: "Alpha Kitchen" },
        { id: "bravo", name: "Bravo Bistro" },
      ],
    }),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("X-Admin-Auth")).toBeNull();
  return response.json() as Promise<CreatedGame>;
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function decisionSelectBody(candidateCount = 3): Record<string, unknown> {
  const selectionOutcome =
    "Choose the candidate most likely to achieve the best benchmark result at tick 84. " +
    "A restaurant that remains solvent through tick 84 ranks above every bankrupt " +
    "restaurant. Among candidates with the same solvency outcome, higher cumulative " +
    "operating profit at tick 84 is better. Do not optimize revenue, cash, reputation, " +
    "survival duration, or action count except insofar as they improve this exact " +
    "lexicographic outcome.";
  const instructions =
    "Which candidate is most likely to produce the best selectionOutcome? Compare each " +
    "complete ordered plan, including no_action. Use only the observable state. Treat " +
    "planner notes as unverified hypotheses. Account for immediate and recurring costs, " +
    "pending commitments, remaining ticks, and uncertainty without assuming hidden future " +
    "events.";
  const candidateIds = [
    ...Array.from({ length: candidateCount }, (_, index) => `plan_${index}`),
    "no_action",
  ];
  const candidates = candidateIds.map((candidateId) => ({
    candidateId,
    actions:
      candidateId === "no_action"
        ? []
        : [
            {
              type: "set_marketing",
              params: { budgetCents: Number(candidateId.at(-1)) * 100 },
            },
          ],
    note: candidateId,
    previews: candidateId === "no_action" ? [] : [{}],
    projected: {},
  }));
  return {
    model: "@cf/cloudflare/clef",
    state: {
      contractVersion: "restaurant-sim-plan-selector-v1",
      candidateCount,
      selectionOutcome,
      observation: { tick: 0, maxTicks: 84 },
      outcomeFeedback: null,
      candidates,
    },
    questions: {
      terminal_outcome: {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(
          candidates.map((candidate) => [
            candidate.candidateId,
            `The complete ordered ${candidate.candidateId} plan in state.candidates. ` +
              "Judge the plan as a whole, not merely its first action.",
          ]),
        ),
      },
    },
  };
}

async function command(
  game: CreatedGame,
  seat: SeatCredential,
  requestId: string,
  type: string,
  params: Record<string, unknown>,
  legacy = false,
): Promise<Response> {
  return api(`/api/games/${game.id}/agent/actions`, {
    method: "POST",
    headers: {
      ...bearer(seat.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      legacy
        ? { requestId, action: { type, ...params } }
        : { requestId, type, params },
    ),
  });
}

async function exportGame(game: CreatedGame): Promise<GameExport> {
  const response = await api(`/api/games/${game.id}/export`, {
    headers: bearer(ADMIN_TOKEN),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<GameExport>;
}

async function expectErrorCode(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

async function sha256(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("restaurant simulation API", () => {
  it("locks the private inference relay to the matched batch contract", async () => {
    const missingToken = await api("/api/inference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await expectErrorCode(missingToken, 401, "admin_unauthorized");

    const unsupportedModel = await api("/api/inference", {
      method: "POST",
      headers: {
        ...bearer(ADMIN_TOKEN),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "@cf/example/unsupported",
        messages: [{ role: "user", content: "test" }],
        reasoning_effort: "high",
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    await expectErrorCode(unsupportedModel, 400, "invalid_inference");

    const tokenCap = await api("/api/inference", {
      method: "POST",
      headers: {
        ...bearer(ADMIN_TOKEN),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "@cf/zai-org/glm-5.3-flash",
        messages: [{ role: "user", content: "test" }],
        reasoning_effort: "high",
        temperature: 0.2,
        response_format: { type: "json_object" },
        max_completion_tokens: 10_000,
      }),
    });
    await expectErrorCode(tokenCap, 400, "invalid_inference");
  });

  it("locks decision selection to the Clef plan-selector contract", async () => {
    const missingToken = await api("/api/decision-select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decisionSelectBody()),
    });
    await expectErrorCode(missingToken, 401, "admin_unauthorized");

    const wrongModel = decisionSelectBody();
    wrongModel.model = "@cf/cloudflare/clef-flash";
    const unsupportedModel = await api("/api/decision-select", {
      method: "POST",
      headers: {
        ...bearer(ADMIN_TOKEN),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(wrongModel),
    });
    await expectErrorCode(unsupportedModel, 400, "invalid_decision_select");

    const malformed = decisionSelectBody();
    malformed.questions = {
      terminal_outcome: {
        type: "noul",
        instructions: "Should anything execute?",
      },
    };
    const malformedQuestion = await api("/api/decision-select", {
      method: "POST",
      headers: {
        ...bearer(ADMIN_TOKEN),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(malformed),
    });
    await expectErrorCode(malformedQuestion, 400, "invalid_decision_select");

    const unsupportedCount = await api("/api/decision-select", {
      method: "POST",
      headers: {
        ...bearer(ADMIN_TOKEN),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(decisionSelectBody(4)),
    });
    await expectErrorCode(unsupportedCount, 400, "invalid_decision_select");

    const wrongOrder = decisionSelectBody(5);
    const wrongOrderCandidates = (
      wrongOrder.state as { candidates: unknown[] }
    ).candidates;
    [wrongOrderCandidates[0], wrongOrderCandidates[1]] = [
      wrongOrderCandidates[1],
      wrongOrderCandidates[0],
    ];
    const reorderedCandidates = await api("/api/decision-select", {
      method: "POST",
      headers: {
        ...bearer(ADMIN_TOKEN),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(wrongOrder),
    });
    await expectErrorCode(reorderedCandidates, 400, "invalid_decision_select");
  });

  it("relays the supported plan-selection choices to Clef", async () => {
    const ai = env.AI as unknown as {
      run(model: string, input: unknown): Promise<unknown>;
    };
    const run = vi.spyOn(ai, "run").mockImplementation(async (_model, input) => {
      const criteria = (
        input as {
          questions: { terminal_outcome: { criteria: Record<string, unknown> } };
        }
      ).questions.terminal_outcome.criteria;
      const candidateIds = Object.keys(criteria);
      const probability = 1 / candidateIds.length;
      return {
        model: "clef",
        answers: {
          terminal_outcome: {
            type: "choice",
            choice: candidateIds[0],
            confidence: 0.6,
            probabilities: Object.fromEntries(
              candidateIds.map((candidateId) => [candidateId, probability]),
            ),
          },
        },
        usage: { input_tokens: 400, output_tokens: 20 },
      };
    });

    for (const candidateCount of [3, 5, 10]) {
      const requestBody = decisionSelectBody(candidateCount);
      if (candidateCount === 10) {
        const candidates = (
          requestBody.state as { candidates: Array<{ note: string }> }
        ).candidates;
        for (const candidate of candidates) {
          candidate.note = "x".repeat(7_000);
        }
        expect(JSON.stringify(requestBody).length).toBeGreaterThan(64 * 1024);
      }
      const selected = await api("/api/decision-select", {
        method: "POST",
        headers: {
          ...bearer(ADMIN_TOKEN),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      expect(selected.status).toBe(200);
      const response = (await selected.json()) as {
        answers: { terminal_outcome: { probabilities: Record<string, number> } };
      };
      expect(Object.keys(response.answers.terminal_outcome.probabilities)).toHaveLength(
        candidateCount + 1,
      );
    }
    expect(run).toHaveBeenCalledTimes(3);
    for (const candidateCount of [3, 5, 10]) {
      expect(run).toHaveBeenCalledWith(
        "@cf/cloudflare/clef",
        expect.objectContaining({
          model: "clef",
          state: expect.objectContaining({ candidateCount }),
        }),
      );
    }
    run.mockRestore();
  });

  it("uses v2 state and keeps the full event ledger out of public polling", async () => {
    const game = await createGame();
    const [alpha, bravo] = game.seats;

    const alphaResponse = await api(`/api/games/${game.id}/agent/state`, {
      headers: bearer(alpha.token),
    });
    const bravoResponse = await api(`/api/games/${game.id}/agent/state`, {
      headers: bearer(bravo.token),
    });
    const invalidResponse = await api(`/api/games/${game.id}/agent/state`, {
      headers: bearer("not-a-seat-token"),
    });

    expect(alphaResponse.status).toBe(200);
    expect(bravoResponse.status).toBe(200);
    expect(invalidResponse.status).toBe(401);
    expect(await alphaResponse.json()).toMatchObject({ restaurantId: "alpha" });
    expect(await bravoResponse.json()).toMatchObject({ restaurantId: "bravo" });

    const publicResponse = await api(`/api/games/${game.id}/public`);
    expect(publicResponse.status).toBe(200);
    const publicGame = (await publicResponse.json()) as PublicGame;
    expect(publicGame).not.toHaveProperty("eventLedger");
    expect(publicGame.recentEvents).toEqual([]);
    expect(publicGame.calendar).toMatchObject({ day: 1, dayName: "Monday" });
    expect(publicGame.restaurants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "alpha", cashCents: expect.any(Number) }),
        expect.objectContaining({ id: "bravo", cashCents: expect.any(Number) }),
      ]),
    );
    expect(publicGame.leaderboard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ restaurantId: "alpha", name: "Alpha Kitchen" }),
        expect.objectContaining({ restaurantId: "bravo", name: "Bravo Bistro" }),
      ]),
    );

    const stub = env.GAME_ROOMS.getByName(game.id);
    const stored = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          "SELECT state_json FROM game_state WHERE singleton = 1",
        )
        .one();
      return JSON.parse(row.state_json) as {
        version: number;
        eventLedger: unknown[];
      };
    });
    expect(stored.version).toBe(2);
    expect(stored.eventLedger).toEqual([]);

    const step = await api(`/api/games/${game.id}/control/step`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({ ticks: 60 }),
    });
    expect(step.status).toBe(200);
    const laterPublic = (await (
      await api(`/api/games/${game.id}/public`)
    ).json()) as PublicGame;
    expect(laterPublic).not.toHaveProperty("eventLedger");
    expect(laterPublic.recentEvents.length).toBeLessThanOrEqual(50);
    const ledgerLength = await runInDurableObject(stub, (_instance, state) => {
      const stateJson = state.storage.sql
        .exec<{ state_json: string }>(
          "SELECT state_json FROM game_state WHERE singleton = 1",
        )
        .one().state_json;
      return (JSON.parse(stateJson) as { eventLedger: unknown[] }).eventLedger.length;
    });
    expect(ledgerLength).toBeGreaterThan(laterPublic.recentEvents.length);
  });

  it("deduplicates actor request IDs without reapplying an agent action", async () => {
    const game = await createGame();
    const alpha = game.seats[0];
    const first = await command(
      game,
      alpha,
      "same-request",
      "set_marketing",
      { budgetCents: 500 },
    );
    const replay = await command(
      game,
      alpha,
      "same-request",
      "invest",
      { kind: "quality" },
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());

    const stateResponse = await api(`/api/games/${game.id}/agent/state`, {
      headers: bearer(alpha.token),
    });
    const state = (await stateResponse.json()) as AgentState;
    expect(state.restaurant.marketingSpendPerTickCents).toBe(500);
    expect(state.restaurant.qualityLevel).toBe(0);

    const exported = await exportGame(game);
    expect(
      exported.actorLogs.alpha
        .filter((row) => row.requestId === "same-request")
        .map((row) => row.kind),
    ).toEqual(["agent.command", "agent.command_replay"]);
    expect(exported.environmentEvents).toEqual([]);
  });

  it("validates every new action family in canonical and legacy envelopes", async () => {
    const game = await createGame();
    const alpha = game.seats[0];
    const invalidActions = [
      ["borrow", { amountCents: 4_999 }],
      ["borrow", { amountCents: 100_001 }],
      ["repay_loan", { amountCents: 0 }],
      ["repay_loan", { amountCents: 100_001 }],
      ["schedule_maintenance", { assetId: "dishwasher" }],
      ["repair_equipment", { assetId: "freezer" }],
      ["train_staff", { role: "chef", budgetCents: 499 }],
      ["train_staff", { role: "server", budgetCents: 5_001 }],
      ["expedite_delivery", { orderId: "bad order id" }],
      ["expedite_delivery", { orderId: "a".repeat(65) }],
    ] as const;

    for (const legacy of [false, true]) {
      for (const [index, [type, params]] of invalidActions.entries()) {
        await expectErrorCode(
          await command(
            game,
            alpha,
            `invalid-${legacy}-${index}`,
            type,
            params,
            legacy,
          ),
          400,
          "invalid_action",
        );
      }
    }

    expect(
      (
        await command(game, alpha, "order", "purchase_inventory", {
          ingredientId: "rice",
          quantity: 1,
        })
      ).status,
    ).toBe(200);
    const validActions = [
      ["borrow", { amountCents: 5_000 }, false],
      ["borrow", { amountCents: 100_000 }, true],
      ["repay_loan", { amountCents: 1 }, false],
      ["repay_loan", { amountCents: 100_000 }, true],
      ["schedule_maintenance", { assetId: "kitchen" }, false],
      ["schedule_maintenance", { assetId: "refrigeration" }, true],
      ["repair_equipment", { assetId: "kitchen" }, false],
      ["repair_equipment", { assetId: "refrigeration" }, true],
      ["train_staff", { role: "chef", budgetCents: 500 }, false],
      ["train_staff", { role: "server", budgetCents: 5_000 }, true],
      ["expedite_delivery", { orderId: "alpha-order-1" }, false],
      ["expedite_delivery", { orderId: "alpha-order-1" }, true],
    ] as const;

    for (const [index, [type, params, legacy]] of validActions.entries()) {
      const response = await command(
        game,
        alpha,
        `valid-${index}`,
        type,
        params,
        legacy,
      );
      expect(response.status, `${type} (${legacy ? "legacy" : "canonical"})`).toBe(
        200,
      );
    }
  });

  it("keeps simulator rejections in actor audit as not ok", async () => {
    const game = await createGame();
    const alpha = game.seats[0];
    const response = await command(
      game,
      alpha,
      "repay-without-debt",
      "repay_loan",
      { amountCents: 1 },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: "repay-without-debt",
      result: {
        accepted: false,
        message: "repayment exceeds outstanding debt",
        costCents: 0,
      },
    });

    const exported = await exportGame(game);
    expect(
      exported.actorLogs.alpha.find(
        (row) => row.requestId === "repay-without-debt",
      )?.ok,
    ).toBe(false);
  });

  it("enforces the original simulator action bounds", async () => {
    const game = await createGame();
    const alpha = game.seats[0];
    const invalidCommands = [
      ["set_menu_price", { dishId: "rice", priceCents: 499 }],
      ["purchase_inventory", { ingredientId: "rice", quantity: 501 }],
      ["set_staff", { role: "chef", count: 11 }],
      ["set_marketing", { budgetCents: 5_001 }],
      ["invest", { kind: "ambience" }],
    ] as const;

    for (const [index, [type, params]] of invalidCommands.entries()) {
      await expectErrorCode(
        await command(game, alpha, `invalid-original-${index}`, type, params),
        400,
        "invalid_action",
      );
    }
  });

  it("appends engine environment events across manual and alarm transitions", async () => {
    const game = await createGame(20);
    const alpha = game.seats[0];
    const stub = env.GAME_ROOMS.getByName(game.id);

    const step = await api(`/api/games/${game.id}/control/step`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({ ticks: 2 }),
    });
    expect(step.status).toBe(200);
    const afterStep = await exportGame(game);
    expect(afterStep.environmentEvents.length).toBeGreaterThanOrEqual(2);

    const action = await command(
      game,
      alpha,
      "agent-only-event",
      "set_marketing",
      { budgetCents: 250 },
    );
    expect(action.status).toBe(200);
    const afterAction = await exportGame(game);
    expect(afterAction.environmentEvents).toHaveLength(
      afterStep.environmentEvents.length,
    );

    const start = await api(`/api/games/${game.id}/control/start`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({ ticks: 2, intervalMs: 100 }),
    });
    expect(start.status).toBe(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(false);

    const exported = await exportGame(game);
    expect(exported.environmentEvents.length).toBeGreaterThan(
      afterAction.environmentEvents.length,
    );
    expect(exported.environmentEvents.map((event) => event.sequence)).toEqual(
      exported.environmentEvents.map((_, index) => index + 1),
    );
    expect(
      new Set(exported.environmentEvents.map((event) => event.engineEventId)).size,
    ).toBe(exported.environmentEvents.length);
    for (const row of exported.environmentEvents) {
      expect(row.source).not.toBe("agent");
      expect(row.engineEventId).toBe(row.event.id);
      expect(row.tick).toBe(row.event.tick);
      expect(row.category).toBe(row.event.category);
      expect(row.severity).toBe(row.event.severity);
      expect(row.stateDigest).toMatch(/^fnv1a64:[a-f0-9]{16}$/);
    }

    const persisted = await runInDurableObject(stub, (_instance, state) => {
      const stateJson = state.storage.sql
        .exec<{ state_json: string }>(
          "SELECT state_json FROM game_state WHERE singleton = 1",
        )
        .one().state_json;
      const gameState = JSON.parse(stateJson) as {
        eventLedger: Array<{ id: string; source: string }>;
      };
      const rows = state.storage.sql
        .exec<{ engine_event_id: string }>(
          "SELECT engine_event_id FROM environment_event ORDER BY sequence",
        )
        .toArray();
      const triggers = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND tbl_name = 'environment_event'
           ORDER BY name`,
        )
        .toArray();
      return {
        ledgerIds: gameState.eventLedger
          .filter((event) => event.source !== "agent")
          .map((event) => event.id),
        rowIds: rows.map((row) => row.engine_event_id),
        triggerNames: triggers.map((trigger) => trigger.name),
      };
    });
    expect(persisted.rowIds).toEqual(persisted.ledgerIds);
    expect(persisted.triggerNames).toEqual([
      "environment_event_no_delete",
      "environment_event_no_update",
    ]);

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec(
          "UPDATE environment_event SET severity = 'info' WHERE sequence = 1",
        ),
      ),
    ).rejects.toThrow(/environment_event is append-only/);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec(
          "DELETE FROM environment_event WHERE sequence = 1",
        ),
      ),
    ).rejects.toThrow(/environment_event is append-only/);

    const jsonlResponse = await api(`/api/games/${game.id}/export?format=jsonl`, {
      headers: bearer(ADMIN_TOKEN),
    });
    expect(jsonlResponse.headers.get("Content-Type")).toContain(
      "application/x-ndjson",
    );
    const lines = new TextDecoder()
      .decode(await jsonlResponse.arrayBuffer())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; data: unknown });
    expect(lines.slice(0, 3).map((line) => line.type)).toEqual([
      "metadata",
      "results",
      "profit_timeline",
    ]);
    expect(lines.filter((line) => line.type === "environment_event")).toHaveLength(
      exported.environmentEvents.length,
    );
    expect(lines.filter((line) => line.type === "agent_log")).toHaveLength(
      exported.logs.length,
    );
    expect(lines.findIndex((line) => line.type === "agent_log")).toBeGreaterThan(
      lines.findLastIndex((line) => line.type === "environment_event"),
    );
  });

  it("keeps actor-local audit sequences gap-free", async () => {
    const game = await createGame();
    const [alpha, bravo] = game.seats;
    const reads = [
      [alpha, "alpha-1"],
      [bravo, "bravo-1"],
      [alpha, "alpha-2"],
    ] as const;

    for (const [seat, requestId] of reads) {
      const response = await api(`/api/games/${game.id}/agent/state`, {
        headers: {
          ...bearer(seat.token),
          "X-Request-Id": requestId,
        },
      });
      expect(response.status).toBe(200);
    }

    const exported = await exportGame(game);
    expect(exported.logs.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(exported.actorLogs.alpha.map((row) => row.actorSeq)).toEqual([1, 2]);
    expect(exported.actorLogs.bravo.map((row) => row.actorSeq)).toEqual([1]);
    expect(exported.metadata.id).toBe(game.id);
    expect(exported.results.leaderboard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ restaurantId: "alpha", name: "Alpha Kitchen" }),
      ]),
    );
    expect(exported.profitTimeline).toBeDefined();
  });

  it("archives terminal engine traces immutably and repairs partial retries", async () => {
    const game = await createGame(2);
    const alpha = game.seats[0];
    expect(
      (
        await api(`/api/games/${game.id}/agent/state`, {
          headers: { ...bearer(alpha.token), "X-Request-Id": "before-terminal" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await command(game, alpha, "initial-order", "purchase_inventory", {
          ingredientId: "staples",
          quantity: 4,
        })
      ).status,
    ).toBe(200);

    const step = await api(`/api/games/${game.id}/control/step`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({ ticks: 2 }),
    });
    expect(step.status).toBe(200);
    expect(await step.json()).toMatchObject({ status: "completed", tick: 2 });

    const prefix = `runs/${game.id}/`;
    const firstList = await env.RUN_ARCHIVES.list({
      prefix,
      include: ["httpMetadata", "customMetadata"],
    });
    expect(firstList.objects.map((object) => object.key)).toEqual(
      expect.arrayContaining([
        `${prefix}engine/latest.json`,
        `${prefix}manifest.json`,
      ]),
    );
    const latest = await env.RUN_ARCHIVES.get(`${prefix}engine/latest.json`);
    expect(latest).not.toBeNull();
    const latestBody = (await latest!.json()) as {
      snapshotId: string;
      status: string;
      tick: number;
      manifest: { key: string };
    };
    expect(latestBody).toMatchObject({ status: "completed", tick: 2 });
    const snapshotPrefix = `${prefix}engine/snapshots/${latestBody.snapshotId}/`;
    const jsonObject = await env.RUN_ARCHIVES.get(`${snapshotPrefix}game-export.json`);
    expect(jsonObject).not.toBeNull();
    const jsonBytes = await jsonObject!.arrayBuffer();
    expect(await sha256(jsonBytes)).toBe(jsonObject!.customMetadata?.sha256);
    const archived = JSON.parse(new TextDecoder().decode(jsonBytes)) as GameExport;
    expect(archived.metadata.id).toBe(game.id);
    expect(archived.logs).toHaveLength(2);
    expect(archived.environmentEvents.length).toBeGreaterThan(0);
    expect(archived.results.leaderboard).toHaveLength(2);

    const immutableEtags = new Map(
      firstList.objects
        .filter((object) => object.key.includes("/snapshots/"))
        .map((object) => [object.key, object.etag]),
    );
    const retry = await api(`/api/games/${game.id}/archive`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ snapshotId: latestBody.snapshotId });
    for (const [key, etag] of immutableEtags) {
      expect((await env.RUN_ARCHIVES.head(key))?.etag).toBe(etag);
    }

    const missingKey = `${snapshotPrefix}game-export.jsonl`;
    await env.RUN_ARCHIVES.delete(missingKey);
    expect(await env.RUN_ARCHIVES.head(missingKey)).toBeNull();
    const repair = await api(`/api/games/${game.id}/archive`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
    });
    expect(repair.status).toBe(200);
    expect(await env.RUN_ARCHIVES.head(missingKey)).not.toBeNull();
    expect((await env.RUN_ARCHIVES.head(latestBody.manifest.key))?.etag).toBe(
      immutableEtags.get(latestBody.manifest.key),
    );

    const publicGame = (await (
      await api(`/api/games/${game.id}/public`)
    ).json()) as Record<string, unknown>;
    expect(publicGame).not.toHaveProperty("eventLedger");
    expect(publicGame).not.toHaveProperty("archive");
  });

  it("stores raw agent artifacts idempotently without exposing them publicly", async () => {
    const game = await createGame(3);
    const artifact = JSON.stringify({
      summary: { gameId: game.id, model: "test-model", status: "completed" },
      systemPrompt: "same prompt for every model",
      decisions: [{ tick: 0, rawAIResult: { response: "raw output" } }],
    });
    const path = `/api/games/${game.id}/artifacts/model-run.json`;
    const upload = await api(path, {
      method: "PUT",
      headers: bearer(ADMIN_TOKEN),
      body: artifact,
    });
    expect(upload.status).toBe(201);
    const uploaded = (await upload.json()) as {
      artifact: { key: string; bytes: number; sha256: string };
    };
    expect(uploaded.artifact.key).toBe(`runs/${game.id}/agent/model-run.json`);
    expect(uploaded.artifact.bytes).toBe(new TextEncoder().encode(artifact).byteLength);

    const replay = await api(path, {
      method: "PUT",
      headers: bearer(ADMIN_TOKEN),
      body: artifact,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expectErrorCode(
      await api(path, {
        method: "PUT",
        headers: bearer(ADMIN_TOKEN),
        body: artifact.replace("raw output", "different output"),
      }),
      409,
      "immutable_artifact_exists",
    );
    await expectErrorCode(
      await api(`/api/games/${game.id}/artifacts/wrong.json`, {
        method: "PUT",
        headers: bearer(ADMIN_TOKEN),
        body: JSON.stringify({ summary: { gameId: "another-game" } }),
      }),
      400,
      "artifact_game_mismatch",
    );
    await expectErrorCode(await api(`/api/games/${game.id}/archive`), 401, "admin_unauthorized");

    const snapshot = await api(`/api/games/${game.id}/archive`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
    });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ status: "paused", tick: 0 });
    const inventory = await api(`/api/games/${game.id}/archive`, {
      headers: bearer(ADMIN_TOKEN),
    });
    const inventoryBody = (await inventory.json()) as {
      objects: Array<{ key: string; sha256: string | null }>;
    };
    expect(inventoryBody.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: `runs/${game.id}/agent/model-run.json`,
          sha256: uploaded.artifact.sha256,
        }),
        expect.objectContaining({ key: `runs/${game.id}/engine/latest.json` }),
        expect.objectContaining({ key: `runs/${game.id}/manifest.json` }),
      ]),
    );
    const publicBody = (await (
      await api(`/api/games/${game.id}/public`)
    ).json()) as Record<string, unknown>;
    expect(publicBody).not.toHaveProperty("systemPrompt");
    expect(publicBody).not.toHaveProperty("decisions");
  });

  it("rejects unbounded controls and advances a bounded manual step", async () => {
    const game = await createGame();
    const tooManySteps = await api(`/api/games/${game.id}/control/step`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({ ticks: 101 }),
    });
    const tooLongRun = await api(`/api/games/${game.id}/control/start`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({ ticks: 1_001 }),
    });
    const step = await api(`/api/games/${game.id}/control/step`, {
      method: "POST",
      headers: bearer(ADMIN_TOKEN),
      body: JSON.stringify({ ticks: 2 }),
    });

    expect(tooManySteps.status).toBe(400);
    expect(tooLongRun.status).toBe(400);
    expect(step.status).toBe(200);
    expect(await step.json()).toMatchObject({ status: "paused", tick: 2 });
  });

  it("rejects stored MVP v1 state without coercing or mutating it", async () => {
    const game = await createGame();
    const alpha = game.seats[0];
    const stub = env.GAME_ROOMS.getByName(game.id);
    const v1StateJson = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state_json: string }>(
          "SELECT state_json FROM game_state WHERE singleton = 1",
        )
        .one();
      const stored = JSON.parse(row.state_json) as Record<string, unknown>;
      stored.version = 1;
      const json = JSON.stringify(stored);
      state.storage.sql.exec(
        "UPDATE game_state SET state_json = ? WHERE singleton = 1",
        json,
      );
      return json;
    });

    const requests: Array<Promise<Response>> = [
      api(`/api/games/${game.id}/public`),
      api(`/api/games/${game.id}/agent/state`, {
        headers: bearer(alpha.token),
      }),
      command(game, alpha, "v1-action", "borrow", { amountCents: 5_000 }),
      api(`/api/games/${game.id}/control/step`, {
        method: "POST",
        headers: bearer(ADMIN_TOKEN),
        body: JSON.stringify({ ticks: 1 }),
      }),
      api(`/api/games/${game.id}/control/start`, {
        method: "POST",
        headers: bearer(ADMIN_TOKEN),
        body: JSON.stringify({ ticks: 1, intervalMs: 100 }),
      }),
      api(`/api/games/${game.id}/control/pause`, {
        method: "POST",
        headers: bearer(ADMIN_TOKEN),
      }),
      api(`/api/games/${game.id}/export`, {
        headers: bearer(ADMIN_TOKEN),
      }),
      api(`/api/games/${game.id}/archive`, {
        method: "POST",
        headers: bearer(ADMIN_TOKEN),
      }),
    ];
    for (const response of await Promise.all(requests)) {
      await expectErrorCode(response, 409, "unsupported_game_version");
    }

    const storedAfter = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ state_json: string }>(
          "SELECT state_json FROM game_state WHERE singleton = 1",
        )
        .one().state_json,
    );
    expect(storedAfter).toBe(v1StateJson);
  });
});
