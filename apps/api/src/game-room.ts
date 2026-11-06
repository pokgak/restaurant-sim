import { DurableObject } from "cloudflare:workers";
import {
  advanceGame,
  applyAction,
  createGame,
  observe,
  publicSnapshot,
  type GameState,
  type PlayerAction,
  type PublicGameEvent,
} from "@restaurant-sim/sim";
import {
  ARCHIVE_SCHEMA_VERSION,
  jsonLines,
  putImmutable,
  refreshRunManifest,
  sha256,
  type ArchiveObjectDescriptor,
} from "./archive";
import {
  MAX_INTERVAL_MS,
  MAX_REQUEST_ID_LENGTH,
  MAX_START_TICKS,
  MAX_STEP_TICKS,
  MAX_TOKEN_LENGTH,
  MIN_INTERVAL_MS,
} from "./limits";
import {
  canonicalJson,
  parseJson,
  stateDigest,
  toJsonValue,
  type JsonValue,
} from "./json";
import type {
  AuditExportRow,
  EnvironmentEventExportRow,
  InitializeInput,
  RpcResult,
  StartInput,
  StepInput,
  ValidActionRequest,
} from "./types";

const AGENT_STATE_ROUTE = "/api/games/:id/agent/state";
const AGENT_ACTION_ROUTE = "/api/games/:id/agent/actions";

type SqlRow<T> = T & Record<string, SqlStorageValue>;

type GameRow = SqlRow<{
  game_id: string;
  config_json: string;
  created_at: number;
}>;

type StateRow = SqlRow<{
  state_json: string;
  status: string;
  run_remaining: number;
  interval_ms: number;
  version: number;
  updated_at: number;
}>;

type SeatRow = SqlRow<{
  actor_id: string;
  display_name: string;
  token_digest: string;
  seat_index: number;
}>;

type DedupeRow = SqlRow<{
  result_json: string;
  http_status: number;
  ok: number;
}>;

type AuditRow = SqlRow<{
  seq: number;
  actor_seq: number;
  actor_id: string;
  request_id: string | null;
  route: string;
  kind: string;
  game_tick: number;
  request_json: string;
  result_json: string;
  ok: number;
  state_digest: string;
  wall_timestamp: number;
  latency_ms: number;
}>;

type EnvironmentEventRow = SqlRow<{
  sequence: number;
  engine_event_id: string;
  game_tick: number;
  category: string;
  source: string;
  severity: string;
  restaurant_id: string | null;
  event_json: string;
  state_digest: string;
}>;

interface ActionValidation {
  action?: PlayerAction;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGameStateV2(value: unknown): value is GameState {
  return isRecord(value) && value.version === 2;
}

function storedTick(value: unknown): number {
  return isRecord(value) && Number.isInteger(value.tick) ? (value.tick as number) : 0;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
  );
}

function validateAction(value: unknown): ActionValidation {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { error: "action must be an object with a supported type" };
  }

  switch (value.type) {
    case "set_menu_price":
      if (!boundedId(value.dishId)) {
        return { error: "dishId must be a valid identifier" };
      }
      if (!boundedInteger(value.priceCents, 500, 5_000)) {
        return { error: "priceCents must be an integer from 500 to 5000" };
      }
      return {
        action: {
          type: "set_menu_price",
          dishId: value.dishId,
          priceCents: value.priceCents,
        },
      };
    case "purchase_inventory":
      if (!boundedId(value.ingredientId)) {
        return { error: "ingredientId must be a valid identifier" };
      }
      if (!boundedInteger(value.quantity, 1, 500)) {
        return { error: "quantity must be an integer from 1 to 500" };
      }
      return {
        action: {
          type: "purchase_inventory",
          ingredientId: value.ingredientId,
          quantity: value.quantity,
        },
      };
    case "set_staff":
      if (value.role !== "chef" && value.role !== "server") {
        return { error: "role must be chef or server" };
      }
      if (!boundedInteger(value.count, 0, 10)) {
        return { error: "count must be an integer from 0 to 10" };
      }
      return {
        action: { type: "set_staff", role: value.role, count: value.count },
      };
    case "set_marketing":
      if (!boundedInteger(value.budgetCents, 0, 5_000)) {
        return {
          error: "budgetCents must be an integer from 0 to 5000",
        };
      }
      return {
        action: { type: "set_marketing", budgetCents: value.budgetCents },
      };
    case "invest":
      if (value.kind !== "capacity" && value.kind !== "quality") {
        return { error: "kind must be capacity or quality" };
      }
      return { action: { type: "invest", kind: value.kind } };
    case "borrow":
      if (!boundedInteger(value.amountCents, 5_000, 100_000)) {
        return {
          error: "amountCents must be an integer from 5000 to 100000",
        };
      }
      return { action: { type: "borrow", amountCents: value.amountCents } };
    case "repay_loan":
      if (!boundedInteger(value.amountCents, 1, 100_000)) {
        return {
          error: "amountCents must be an integer from 1 to 100000",
        };
      }
      return {
        action: { type: "repay_loan", amountCents: value.amountCents },
      };
    case "schedule_maintenance":
      if (value.assetId !== "kitchen" && value.assetId !== "refrigeration") {
        return { error: "assetId must be kitchen or refrigeration" };
      }
      return {
        action: { type: "schedule_maintenance", assetId: value.assetId },
      };
    case "repair_equipment":
      if (value.assetId !== "kitchen" && value.assetId !== "refrigeration") {
        return { error: "assetId must be kitchen or refrigeration" };
      }
      return {
        action: { type: "repair_equipment", assetId: value.assetId },
      };
    case "train_staff":
      if (value.role !== "chef" && value.role !== "server") {
        return { error: "role must be chef or server" };
      }
      if (!boundedInteger(value.budgetCents, 500, 5_000)) {
        return {
          error: "budgetCents must be an integer from 500 to 5000",
        };
      }
      return {
        action: {
          type: "train_staff",
          role: value.role,
          budgetCents: value.budgetCents,
        },
      };
    case "expedite_delivery":
      if (!boundedId(value.orderId)) {
        return { error: "orderId must be a valid identifier" };
      }
      return {
        action: { type: "expedite_delivery", orderId: value.orderId },
      };
    default:
      return { error: `unsupported action type: ${value.type}` };
  }
}

function validateCommandAction(command: Record<string, unknown>): ActionValidation {
  if ("type" in command || "params" in command) {
    if (typeof command.type !== "string" || !isRecord(command.params)) {
      return { error: "command requires a string type and object params" };
    }
    return validateAction({ ...command.params, type: command.type });
  }

  return validateAction(command.action);
}

function decodeHexDigest(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    return null;
  }

  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function errorBody(code: string, message: string): JsonValue {
  return { error: { code, message } };
}

function unsupportedGameVersionBody(state: unknown): JsonValue {
  const version = isRecord(state) ? state.version : undefined;
  const label = typeof version === "number" ? String(version) : "unknown";
  return errorBody(
    "unsupported_game_version",
    `Stored GameState.version ${label} is unsupported; create a new game`,
  );
}

function resultStatus(result: RpcResult): string | null {
  return isRecord(result.body) && typeof result.body.status === "string"
    ? result.body.status
    : null;
}

function archiveDescriptor(
  object: ArchiveObjectDescriptor & { replayed: boolean },
): ArchiveObjectDescriptor {
  const { replayed: _replayed, ...descriptor } = object;
  return descriptor;
}

export class GameRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS games (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          game_id TEXT NOT NULL UNIQUE,
          config_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS game_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('paused', 'running', 'completed')),
          run_remaining INTEGER NOT NULL DEFAULT 0 CHECK (run_remaining >= 0),
          interval_ms INTEGER NOT NULL DEFAULT 1000,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS seats (
          actor_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64),
          seat_index INTEGER NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS command_dedup (
          actor_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          request_json TEXT NOT NULL,
          result_json TEXT NOT NULL,
          http_status INTEGER NOT NULL,
          ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
          state_digest TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (actor_id, request_id),
          FOREIGN KEY (actor_id) REFERENCES seats(actor_id)
        ) WITHOUT ROWID;

        CREATE TABLE IF NOT EXISTS audit_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_seq INTEGER NOT NULL,
          actor_id TEXT NOT NULL,
          request_id TEXT,
          route TEXT NOT NULL,
          kind TEXT NOT NULL,
          game_tick INTEGER NOT NULL,
          request_json TEXT NOT NULL,
          result_json TEXT NOT NULL,
          ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
          state_digest TEXT NOT NULL,
          wall_timestamp INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
          UNIQUE (actor_id, actor_seq),
          FOREIGN KEY (actor_id) REFERENCES seats(actor_id)
        );

        CREATE INDEX IF NOT EXISTS audit_actor_seq
          ON audit_log(actor_id, actor_seq);

        CREATE TABLE IF NOT EXISTS environment_event (
          sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
          engine_event_id TEXT NOT NULL UNIQUE,
          game_tick INTEGER NOT NULL CHECK (game_tick >= 0),
          category TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source <> 'agent'),
          severity TEXT NOT NULL,
          restaurant_id TEXT,
          event_json TEXT NOT NULL,
          state_digest TEXT NOT NULL
        );

        CREATE TRIGGER IF NOT EXISTS audit_log_no_update
        BEFORE UPDATE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'audit_log is append-only');
        END;

        CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
        BEFORE DELETE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'audit_log is append-only');
        END;

        CREATE TRIGGER IF NOT EXISTS environment_event_no_update
        BEFORE UPDATE ON environment_event
        BEGIN
          SELECT RAISE(ABORT, 'environment_event is append-only');
        END;

        CREATE TRIGGER IF NOT EXISTS environment_event_no_delete
        BEFORE DELETE ON environment_event
        BEGIN
          SELECT RAISE(ABORT, 'environment_event is append-only');
        END;
      `);
    });
  }

  initialize(input: InitializeInput): RpcResult {
    if (this.readGame()) {
      return {
        status: 409,
        body: errorBody("game_exists", "This game has already been initialized"),
      };
    }

    let initialState: GameState;
    try {
      initialState = createGame(input.config);
    } catch (error) {
      return {
        status: 400,
        body: errorBody(
          "invalid_game_config",
          error instanceof Error ? error.message : "Simulator rejected game config",
        ),
      };
    }
    if (!isGameStateV2(initialState)) {
      return {
        status: 500,
        body: errorBody(
          "unsupported_engine_contract",
          "createGame must produce GameState.version 2",
        ),
      };
    }

    const now = Date.now();
    const stateJson = canonicalJson(initialState);
    const snapshot = publicSnapshot(initialState);
    const status = snapshot.tick >= snapshot.maxTicks ? "completed" : "paused";

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO games (singleton, game_id, config_json, created_at) VALUES (1, ?, ?, ?)",
        input.gameId,
        canonicalJson(input.config),
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO game_state
          (singleton, state_json, status, run_remaining, interval_ms, version, updated_at)
         VALUES (1, ?, ?, 0, 1000, 1, ?)`,
        stateJson,
        status,
        now,
      );
      input.seats.forEach((seat, seatIndex) => {
        this.ctx.storage.sql.exec(
          `INSERT INTO seats (actor_id, display_name, token_digest, seat_index)
           VALUES (?, ?, ?, ?)`,
          seat.actorId,
          seat.displayName,
          seat.tokenDigest,
          seatIndex,
        );
      });
    });

    return {
      status: 201,
      body: toJsonValue({ id: input.gameId, status, ...snapshot }),
    };
  }

  publicView(): RpcResult {
    const game = this.readGame();
    const stateRow = this.readStateRow();
    if (!game || !stateRow) {
      return { status: 404, body: errorBody("not_found", "Game not found") };
    }

    const state = this.parseState(stateRow.state_json);
    if (!isGameStateV2(state)) {
      return { status: 409, body: unsupportedGameVersionBody(state) };
    }
    const snapshot = publicSnapshot(state);
    const names = new Map(
      this.ctx.storage.sql
        .exec<SeatRow>(
          "SELECT actor_id, display_name, token_digest, seat_index FROM seats",
        )
        .toArray()
        .map((seat) => [seat.actor_id, seat.display_name]),
    );
    return {
      status: 200,
      body: toJsonValue({
        id: game.game_id,
        status: stateRow.status,
        ...snapshot,
        leaderboard: snapshot.leaderboard.map((entry) => ({
          ...entry,
          name: names.get(entry.restaurantId) ?? entry.restaurantId,
        })),
      }),
    };
  }

  async agentState(token: string, requestId: string | null): Promise<RpcResult> {
    const startedAt = performance.now();
    const actor = await this.authenticate(token);
    if (!actor) {
      return {
        status: 401,
        body: errorBody("invalid_token", "Seat token is invalid"),
      };
    }

    return this.ctx.storage.transactionSync(() => {
      const stateRow = this.requireStateRow();
      const state = this.parseState(stateRow.state_json);
      const requestJson = canonicalJson({ requestId });
      if (!isGameStateV2(state)) {
        const body = unsupportedGameVersionBody(state);
        this.insertAudit({
          actorId: actor.actor_id,
          requestId,
          route: AGENT_STATE_ROUTE,
          kind: "agent.read",
          gameTick: storedTick(state),
          requestJson,
          resultJson: canonicalJson(body),
          ok: false,
          stateDigest: stateDigest(stateRow.state_json),
          startedAt,
        });
        return { status: 409, body };
      }
      const snapshot = publicSnapshot(state);
      const digest = stateDigest(stateRow.state_json);

      if (
        requestId !== null &&
        (requestId.length < 1 || requestId.length > MAX_REQUEST_ID_LENGTH)
      ) {
        const body = errorBody(
          "invalid_request_id",
          `X-Request-Id must contain 1-${MAX_REQUEST_ID_LENGTH} characters`,
        );
        this.insertAudit({
          actorId: actor.actor_id,
          requestId,
          route: AGENT_STATE_ROUTE,
          kind: "agent.read",
          gameTick: snapshot.tick,
          requestJson,
          resultJson: canonicalJson(body),
          ok: false,
          stateDigest: digest,
          startedAt,
        });
        return { status: 400, body };
      }

      try {
        const observation = observe(state, actor.actor_id);
        const body = toJsonValue(
          Object.assign(
            { id: this.requireGame().game_id, status: stateRow.status },
            observation,
          ),
        );
        this.insertAudit({
          actorId: actor.actor_id,
          requestId,
          route: AGENT_STATE_ROUTE,
          kind: "agent.read",
          gameTick: snapshot.tick,
          requestJson,
          resultJson: canonicalJson(body),
          ok: true,
          stateDigest: digest,
          startedAt,
        });
        return { status: 200, body };
      } catch (error) {
        const body = errorBody(
          "observation_failed",
          error instanceof Error ? error.message : "Could not observe game state",
        );
        this.insertAudit({
          actorId: actor.actor_id,
          requestId,
          route: AGENT_STATE_ROUTE,
          kind: "agent.read",
          gameTick: snapshot.tick,
          requestJson,
          resultJson: canonicalJson(body),
          ok: false,
          stateDigest: digest,
          startedAt,
        });
        return { status: 500, body };
      }
    });
  }

  async agentAction(token: string, rawBody: string): Promise<RpcResult> {
    const startedAt = performance.now();
    const actor = await this.authenticate(token);
    if (!actor) {
      return {
        status: 401,
        body: errorBody("invalid_token", "Seat token is invalid"),
      };
    }

    return this.ctx.storage.transactionSync(() => {
      const stateRow = this.requireStateRow();
      const state = this.parseState(stateRow.state_json);
      if (!isGameStateV2(state)) {
        let requestId: string | null = null;
        let requestJson = canonicalJson({ raw: rawBody });
        try {
          const request = JSON.parse(rawBody) as unknown;
          requestJson = canonicalJson(request);
          if (isRecord(request) && typeof request.requestId === "string") {
            requestId = request.requestId;
          }
        } catch {
          // Preserve the raw body in the audit record when it cannot be parsed.
        }
        return this.finishCommandFailure({
          actorId: actor.actor_id,
          requestId,
          requestJson,
          body: unsupportedGameVersionBody(state),
          status: 409,
          tick: storedTick(state),
          stateDigest: stateDigest(stateRow.state_json),
          startedAt,
        });
      }
      const snapshot = publicSnapshot(state);
      const currentDigest = stateDigest(stateRow.state_json);
      let parsed: unknown;

      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return this.finishCommandFailure({
          actorId: actor.actor_id,
          requestId: null,
          requestJson: canonicalJson({ raw: rawBody }),
          body: errorBody("invalid_json", "Request body must be valid JSON"),
          status: 400,
          tick: snapshot.tick,
          stateDigest: currentDigest,
          startedAt,
        });
      }

      const requestJson = canonicalJson(parsed);
      if (!isRecord(parsed) || typeof parsed.requestId !== "string") {
        return this.finishCommandFailure({
          actorId: actor.actor_id,
          requestId: null,
          requestJson,
          body: errorBody("invalid_request_id", "requestId is required"),
          status: 400,
          tick: snapshot.tick,
          stateDigest: currentDigest,
          startedAt,
        });
      }

      const requestId = parsed.requestId;
      if (
        requestId.length < 1 ||
        requestId.length > MAX_REQUEST_ID_LENGTH
      ) {
        return this.finishCommandFailure({
          actorId: actor.actor_id,
          requestId,
          requestJson,
          body: errorBody(
            "invalid_request_id",
            `requestId must contain 1-${MAX_REQUEST_ID_LENGTH} characters`,
          ),
          status: 400,
          tick: snapshot.tick,
          stateDigest: currentDigest,
          startedAt,
        });
      }

      const duplicate = this.ctx.storage.sql
        .exec<DedupeRow>(
          `SELECT result_json, http_status, ok
           FROM command_dedup WHERE actor_id = ? AND request_id = ?`,
          actor.actor_id,
          requestId,
        )
        .toArray()[0];

      if (duplicate) {
        this.insertAudit({
          actorId: actor.actor_id,
          requestId,
          route: AGENT_ACTION_ROUTE,
          kind: "agent.command_replay",
          gameTick: snapshot.tick,
          requestJson,
          resultJson: duplicate.result_json,
          ok: duplicate.ok === 1,
          stateDigest: currentDigest,
          startedAt,
        });
        return {
          status: duplicate.http_status,
          body: parseJson(duplicate.result_json),
          replayed: true,
        };
      }

      const validation = validateCommandAction(parsed);
      if (!validation.action) {
        return this.finishCommandFailure({
          actorId: actor.actor_id,
          requestId,
          requestJson,
          body: errorBody(
            "invalid_action",
            validation.error ?? "Action is invalid",
          ),
          status: 400,
          tick: snapshot.tick,
          stateDigest: currentDigest,
          startedAt,
          dedupe: true,
        });
      }

      const validRequest: ValidActionRequest = {
        requestId,
        action: validation.action,
      };

      try {
        const applied = applyAction(state, actor.actor_id, validRequest.action);
        const nextStateJson = canonicalJson(applied.state);
        const nextSnapshot = publicSnapshot(applied.state);
        const nextDigest = stateDigest(nextStateJson);
        const now = Date.now();
        const body = toJsonValue({
          requestId,
          tick: nextSnapshot.tick,
          result: applied.result,
        });
        const resultJson = canonicalJson(body);

        this.ctx.storage.sql.exec(
          `UPDATE game_state
           SET state_json = ?, version = version + 1, updated_at = ?
           WHERE singleton = 1`,
          nextStateJson,
          now,
        );
        this.insertEnvironmentEvents(state, applied.state, nextDigest);
        this.insertDedupe({
          actorId: actor.actor_id,
          requestId,
          requestJson,
          resultJson,
          status: 200,
          ok: applied.result.accepted,
          stateDigest: nextDigest,
          createdAt: now,
        });
        this.insertAudit({
          actorId: actor.actor_id,
          requestId,
          route: AGENT_ACTION_ROUTE,
          kind: "agent.command",
          gameTick: nextSnapshot.tick,
          requestJson,
          resultJson,
          ok: applied.result.accepted,
          stateDigest: nextDigest,
          startedAt,
        });
        return { status: 200, body };
      } catch (error) {
        return this.finishCommandFailure({
          actorId: actor.actor_id,
          requestId,
          requestJson,
          body: errorBody(
            "action_failed",
            error instanceof Error ? error.message : "Simulator rejected action",
          ),
          status: 400,
          tick: snapshot.tick,
          stateDigest: currentDigest,
          startedAt,
          dedupe: true,
        });
      }
    });
  }

  async controlStart(input: StartInput): Promise<RpcResult> {
    if (
      !Number.isInteger(input.ticks) ||
      input.ticks < 1 ||
      input.ticks > MAX_START_TICKS ||
      !Number.isInteger(input.intervalMs) ||
      input.intervalMs < MIN_INTERVAL_MS ||
      input.intervalMs > MAX_INTERVAL_MS
    ) {
      return {
        status: 400,
        body: errorBody("invalid_control", "Start control values are out of bounds"),
      };
    }

    const result = this.ctx.storage.transactionSync(() => {
      const game = this.readGame();
      const stateRow = this.readStateRow();
      if (!game || !stateRow) {
        return {
          status: 404,
          body: errorBody("not_found", "Game not found"),
        } satisfies RpcResult;
      }
      const state = this.parseState(stateRow.state_json);
      if (!isGameStateV2(state)) {
        return {
          status: 409,
          body: unsupportedGameVersionBody(state),
        } satisfies RpcResult;
      }
      const snapshot = publicSnapshot(state);
      if (snapshot.tick >= snapshot.maxTicks || stateRow.status === "completed") {
        return {
          status: 409,
          body: errorBody("game_completed", "Game has reached maxTicks"),
        } satisfies RpcResult;
      }

      const remaining = Math.min(input.ticks, snapshot.maxTicks - snapshot.tick);
      this.ctx.storage.sql.exec(
        `UPDATE game_state
         SET status = 'running', run_remaining = ?, interval_ms = ?, updated_at = ?
         WHERE singleton = 1`,
        remaining,
        input.intervalMs,
        Date.now(),
      );
      return {
        status: 200,
        body: toJsonValue({
          id: game.game_id,
          status: "running",
          tick: snapshot.tick,
          scheduledTicks: remaining,
          intervalMs: input.intervalMs,
        }),
      } satisfies RpcResult;
    });

    if (result.status === 200) {
      try {
        await this.ctx.storage.setAlarm(Date.now() + input.intervalMs);
      } catch (error) {
        this.ctx.storage.sql.exec(
          `UPDATE game_state
           SET status = 'paused', run_remaining = 0, updated_at = ?
           WHERE singleton = 1`,
          Date.now(),
        );
        throw error;
      }
    }
    return result;
  }

  async controlPause(): Promise<RpcResult> {
    const result = this.ctx.storage.transactionSync(() => {
      const game = this.readGame();
      const stateRow = this.readStateRow();
      if (!game || !stateRow) {
        return {
          status: 404,
          body: errorBody("not_found", "Game not found"),
        } satisfies RpcResult;
      }
      const state = this.parseState(stateRow.state_json);
      if (!isGameStateV2(state)) {
        return {
          status: 409,
          body: unsupportedGameVersionBody(state),
        } satisfies RpcResult;
      }
      const snapshot = publicSnapshot(state);
      const status =
        snapshot.tick >= snapshot.maxTicks ? "completed" : "paused";
      this.ctx.storage.sql.exec(
        `UPDATE game_state
         SET status = ?, run_remaining = 0, updated_at = ?
         WHERE singleton = 1`,
        status,
        Date.now(),
      );
      return {
        status: 200,
        body: toJsonValue({
          id: game.game_id,
          status,
          tick: snapshot.tick,
        }),
      } satisfies RpcResult;
    });

    if (result.status === 200) {
      await this.ctx.storage.deleteAlarm();
      if (resultStatus(result) === "completed") {
        await this.archiveSnapshot();
      }
    }
    return result;
  }

  async controlStep(input: StepInput): Promise<RpcResult> {
    if (
      !Number.isInteger(input.ticks) ||
      input.ticks < 1 ||
      input.ticks > MAX_STEP_TICKS
    ) {
      return {
        status: 400,
        body: errorBody("invalid_control", "Step ticks are out of bounds"),
      };
    }

    const result = this.ctx.storage.transactionSync(() => {
      const game = this.readGame();
      const stateRow = this.readStateRow();
      if (!game || !stateRow) {
        return {
          status: 404,
          body: errorBody("not_found", "Game not found"),
        };
      }
      if (stateRow.status === "running") {
        return {
          status: 409,
          body: errorBody("game_running", "Pause the game before stepping"),
        };
      }

      const state = this.parseState(stateRow.state_json);
      if (!isGameStateV2(state)) {
        return { status: 409, body: unsupportedGameVersionBody(state) };
      }
      const current = publicSnapshot(state);
      if (current.tick >= current.maxTicks || stateRow.status === "completed") {
        return {
          status: 409,
          body: errorBody("game_completed", "Game has reached maxTicks"),
        };
      }

      const ticks = Math.min(input.ticks, current.maxTicks - current.tick);
      const nextState = advanceGame(state, ticks);
      const nextStateJson = canonicalJson(nextState);
      const snapshot = publicSnapshot(nextState);
      const status = snapshot.tick >= snapshot.maxTicks ? "completed" : "paused";
      this.ctx.storage.sql.exec(
        `UPDATE game_state
         SET state_json = ?, status = ?, version = version + 1, updated_at = ?
         WHERE singleton = 1`,
        nextStateJson,
        status,
        Date.now(),
      );
      this.insertEnvironmentEvents(
        state,
        nextState,
        stateDigest(nextStateJson),
      );
      return {
        status: 200,
        body: toJsonValue({
          id: game.game_id,
          status,
          tick: snapshot.tick,
          advancedTicks: ticks,
        }),
      };
    });
    if (result.status === 200 && resultStatus(result) === "completed") {
      await this.archiveSnapshot();
    }
    return result;
  }

  exportData(): RpcResult {
    const game = this.readGame();
    const stateRow = this.readStateRow();
    if (!game || !stateRow) {
      return { status: 404, body: errorBody("not_found", "Game not found") };
    }

    const state = this.parseState(stateRow.state_json);
    if (!isGameStateV2(state)) {
      return { status: 409, body: unsupportedGameVersionBody(state) };
    }
    return { status: 200, body: this.buildExport(Date.now()) };
  }

  async archiveSnapshot(): Promise<RpcResult> {
    const game = this.readGame();
    const stateRow = this.readStateRow();
    if (!game || !stateRow) {
      return { status: 404, body: errorBody("not_found", "Game not found") };
    }

    const state = this.parseState(stateRow.state_json);
    if (!isGameStateV2(state)) {
      return { status: 409, body: unsupportedGameVersionBody(state) };
    }

    const lastAuditTimestamp = this.ctx.storage.sql
      .exec<{ last_timestamp: number | null }>(
        "SELECT MAX(wall_timestamp) AS last_timestamp FROM audit_log",
      )
      .one().last_timestamp;
    const snapshotAt = Math.max(
      game.created_at,
      stateRow.updated_at,
      lastAuditTimestamp ?? 0,
    );
    const exportBody = this.buildExport(snapshotAt);
    const json = canonicalJson(exportBody);
    const jsonl = jsonLines(exportBody);
    const snapshotId = (await sha256(json)).hex;
    const prefix = `runs/${game.game_id}/engine/snapshots/${snapshotId}`;
    const metadata = {
      category: "engine-snapshot",
      gameId: game.game_id,
      snapshotId,
      stateDigest: stateDigest(stateRow.state_json),
      status: stateRow.status,
    };
    const jsonObject = archiveDescriptor(
      await putImmutable(this.env.RUN_ARCHIVES, {
        key: `${prefix}/game-export.json`,
        value: json,
        contentType: "application/json; charset=utf-8",
        customMetadata: { ...metadata, format: "json" },
      }),
    );
    const jsonlObject = archiveDescriptor(
      await putImmutable(this.env.RUN_ARCHIVES, {
        key: `${prefix}/game-export.jsonl`,
        value: jsonl,
        contentType: "application/x-ndjson; charset=utf-8",
        customMetadata: { ...metadata, format: "jsonl" },
      }),
    );
    const exportRecord = exportBody as Record<string, JsonValue>;
    const logs = exportRecord.logs as JsonValue[];
    const environmentEvents = exportRecord.environmentEvents as JsonValue[];
    const profitTimeline = exportRecord.profitTimeline as JsonValue[];
    const manifest = toJsonValue({
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      gameId: game.game_id,
      snapshotId,
      snapshotAt,
      engineStateVersion: state.version,
      status: stateRow.status,
      tick: publicSnapshot(state).tick,
      stateDigest: stateDigest(stateRow.state_json),
      counts: {
        profitTimeline: profitTimeline.length,
        environmentEvents: environmentEvents.length,
        agentLogs: logs.length,
      },
      results: exportRecord.results,
      objects: [jsonObject, jsonlObject],
    });
    const manifestObject = archiveDescriptor(
      await putImmutable(this.env.RUN_ARCHIVES, {
        key: `${prefix}/manifest.json`,
        value: canonicalJson(manifest),
        contentType: "application/json; charset=utf-8",
        customMetadata: { ...metadata, category: "engine-manifest" },
      }),
    );
    const latest = canonicalJson({
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      gameId: game.game_id,
      snapshotId,
      snapshotAt,
      status: stateRow.status,
      tick: publicSnapshot(state).tick,
      manifest: manifestObject,
    });
    const latestDigest = await sha256(latest);
    await this.env.RUN_ARCHIVES.put(
      `runs/${game.game_id}/engine/latest.json`,
      latest,
      {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: {
          archiveSchemaVersion: String(ARCHIVE_SCHEMA_VERSION),
          category: "engine-latest",
          gameId: game.game_id,
          sha256: latestDigest.hex,
          snapshotId,
        },
        sha256: latestDigest.bytes,
      },
    );
    const runManifest = await refreshRunManifest(
      this.env.RUN_ARCHIVES,
      game.game_id,
    );

    return {
      status: 200,
      body: toJsonValue({
        gameId: game.game_id,
        snapshotId,
        snapshotAt,
        status: stateRow.status,
        tick: publicSnapshot(state).tick,
        manifest: manifestObject,
        runManifest,
      }),
    };
  }

  private buildExport(exportedAt: number): JsonValue {
    const game = this.requireGame();
    const stateRow = this.requireStateRow();
    const state = this.parseState(stateRow.state_json);
    if (!isGameStateV2(state)) {
      throw new Error("Cannot export an unsupported game state");
    }
    const snapshot = publicSnapshot(state);
    const seats = this.ctx.storage.sql
      .exec<SeatRow>(
        `SELECT actor_id, display_name, token_digest, seat_index
         FROM seats ORDER BY seat_index`,
      )
      .toArray();
    const logs = this.ctx.storage.sql
      .exec<AuditRow>(
        `SELECT seq, actor_seq, actor_id, request_id, route, kind, game_tick,
                request_json, result_json, ok, state_digest, wall_timestamp,
                latency_ms
         FROM audit_log ORDER BY seq`,
      )
      .toArray()
      .map((row) => this.exportAuditRow(row));
    const environmentEvents = this.ctx.storage.sql
      .exec<EnvironmentEventRow>(
        `SELECT sequence, engine_event_id, game_tick, category, source,
                severity, restaurant_id, event_json, state_digest
         FROM environment_event ORDER BY sequence`,
      )
      .toArray()
      .map((row) => this.exportEnvironmentEventRow(row));
    const actorLogs: Record<string, AuditExportRow[]> = {};
    for (const seat of seats) {
      actorLogs[seat.actor_id] = [];
    }
    for (const row of logs) {
      (actorLogs[row.actorId] ??= []).push(row);
    }
    const names = new Map(
      seats.map((seat) => [seat.actor_id, seat.display_name]),
    );

    return toJsonValue({
      metadata: toJsonValue({
        id: game.game_id,
        createdAt: game.created_at,
        exportedAt,
        config: parseJson(game.config_json),
        restaurants: seats.map((seat) => ({
          id: seat.actor_id,
          name: seat.display_name,
        })),
        status: stateRow.status,
        tick: snapshot.tick,
        maxTicks: snapshot.maxTicks,
        stateDigest: stateDigest(stateRow.state_json),
      }),
      results: {
        leaderboard: snapshot.leaderboard.map((entry) => ({
          ...entry,
          name: names.get(entry.restaurantId) ?? entry.restaurantId,
        })),
        restaurants: snapshot.restaurants,
        market: snapshot.market,
        calendar: snapshot.calendar,
      },
      profitTimeline: toJsonValue(snapshot.series),
      environmentEvents,
      logs,
      actorLogs,
    });
  }

  async alarm(): Promise<void> {
    const outcome = this.ctx.storage.transactionSync(() => {
      const stateRow = this.readStateRow();
      if (!stateRow) {
        return { nextAlarm: null, archive: false };
      }
      if (stateRow.status === "completed") {
        return { nextAlarm: null, archive: true };
      }
      if (stateRow.status !== "running") {
        return { nextAlarm: null, archive: false };
      }

      const state = this.parseState(stateRow.state_json);
      if (!isGameStateV2(state)) {
        return { nextAlarm: null, archive: false };
      }
      const current = publicSnapshot(state);
      if (stateRow.run_remaining <= 0 || current.tick >= current.maxTicks) {
        const status = current.tick >= current.maxTicks ? "completed" : "paused";
        this.ctx.storage.sql.exec(
          `UPDATE game_state
           SET status = ?, run_remaining = 0, updated_at = ?
           WHERE singleton = 1`,
          status,
          Date.now(),
        );
        return { nextAlarm: null, archive: status === "completed" };
      }

      const nextState = advanceGame(state, 1);
      const nextStateJson = canonicalJson(nextState);
      const snapshot = publicSnapshot(nextState);
      const remaining = stateRow.run_remaining - 1;
      const running = remaining > 0 && snapshot.tick < snapshot.maxTicks;
      const status = running
        ? "running"
        : snapshot.tick >= snapshot.maxTicks
          ? "completed"
          : "paused";
      this.ctx.storage.sql.exec(
        `UPDATE game_state
         SET state_json = ?, status = ?, run_remaining = ?,
             version = version + 1, updated_at = ?
         WHERE singleton = 1`,
        nextStateJson,
        status,
        remaining,
        Date.now(),
      );
      this.insertEnvironmentEvents(
        state,
        nextState,
        stateDigest(nextStateJson),
      );
      return {
        nextAlarm: running ? Date.now() + stateRow.interval_ms : null,
        archive: status === "completed",
      };
    });

    if (outcome.archive) {
      await this.archiveSnapshot();
    }
    if (outcome.nextAlarm !== null) {
      await this.ctx.storage.setAlarm(outcome.nextAlarm);
    }
  }

  private readGame(): GameRow | undefined {
    return this.ctx.storage.sql
      .exec<GameRow>(
        "SELECT game_id, config_json, created_at FROM games WHERE singleton = 1",
      )
      .toArray()[0];
  }

  private requireGame(): GameRow {
    const game = this.readGame();
    if (!game) {
      throw new Error("Game is not initialized");
    }
    return game;
  }

  private readStateRow(): StateRow | undefined {
    return this.ctx.storage.sql
      .exec<StateRow>(
        `SELECT state_json, status, run_remaining, interval_ms, version, updated_at
         FROM game_state WHERE singleton = 1`,
      )
      .toArray()[0];
  }

  private requireStateRow(): StateRow {
    const state = this.readStateRow();
    if (!state) {
      throw new Error("Game is not initialized");
    }
    return state;
  }

  private parseState(value: string): unknown {
    return JSON.parse(value) as unknown;
  }

  private async authenticate(token: string): Promise<SeatRow | null> {
    if (token.length < 1 || token.length > MAX_TOKEN_LENGTH) {
      return null;
    }

    const candidate = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    const seats = this.ctx.storage.sql
      .exec<SeatRow>(
        `SELECT actor_id, display_name, token_digest, seat_index
         FROM seats ORDER BY seat_index`,
      )
      .toArray();
    let match: SeatRow | null = null;

    for (const seat of seats) {
      const stored = decodeHexDigest(seat.token_digest);
      if (stored && crypto.subtle.timingSafeEqual(candidate, stored)) {
        match = seat;
      }
    }

    return match;
  }

  private finishCommandFailure(input: {
    actorId: string;
    requestId: string | null;
    requestJson: string;
    body: JsonValue;
    status: number;
    tick: number;
    stateDigest: string;
    startedAt: number;
    dedupe?: boolean;
  }): RpcResult {
    const resultJson = canonicalJson(input.body);
    if (input.dedupe && input.requestId !== null) {
      this.insertDedupe({
        actorId: input.actorId,
        requestId: input.requestId,
        requestJson: input.requestJson,
        resultJson,
        status: input.status,
        ok: false,
        stateDigest: input.stateDigest,
        createdAt: Date.now(),
      });
    }
    this.insertAudit({
      actorId: input.actorId,
      requestId: input.requestId,
      route: AGENT_ACTION_ROUTE,
      kind: "agent.command",
      gameTick: input.tick,
      requestJson: input.requestJson,
      resultJson,
      ok: false,
      stateDigest: input.stateDigest,
      startedAt: input.startedAt,
    });
    return { status: input.status, body: input.body };
  }

  private insertDedupe(input: {
    actorId: string;
    requestId: string;
    requestJson: string;
    resultJson: string;
    status: number;
    ok: boolean;
    stateDigest: string;
    createdAt: number;
  }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO command_dedup
        (actor_id, request_id, request_json, result_json, http_status, ok,
         state_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.actorId,
      input.requestId,
      input.requestJson,
      input.resultJson,
      input.status,
      input.ok ? 1 : 0,
      input.stateDigest,
      input.createdAt,
    );
  }

  private insertAudit(input: {
    actorId: string;
    requestId: string | null;
    route: string;
    kind: string;
    gameTick: number;
    requestJson: string;
    resultJson: string;
    ok: boolean;
    stateDigest: string;
    startedAt: number;
  }): void {
    const actorSeq = this.ctx.storage.sql
      .exec<{ next_seq: number }>(
        `SELECT COALESCE(MAX(actor_seq), 0) + 1 AS next_seq
         FROM audit_log WHERE actor_id = ?`,
        input.actorId,
      )
      .one().next_seq;
    const latencyMs = Math.max(0, Math.round(performance.now() - input.startedAt));
    this.ctx.storage.sql.exec(
      `INSERT INTO audit_log
        (actor_seq, actor_id, request_id, route, kind, game_tick,
         request_json, result_json, ok, state_digest, wall_timestamp, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      actorSeq,
      input.actorId,
      input.requestId,
      input.route,
      input.kind,
      input.gameTick,
      input.requestJson,
      input.resultJson,
      input.ok ? 1 : 0,
      input.stateDigest,
      Date.now(),
      latencyMs,
    );
  }

  private insertEnvironmentEvents(
    previousState: GameState,
    nextState: GameState,
    nextStateDigest: string,
  ): void {
    if (nextState.eventLedger.length < previousState.eventLedger.length) {
      throw new Error("Engine event ledger cannot shrink during a transition");
    }
    const events = nextState.eventLedger
      .slice(previousState.eventLedger.length)
      .filter((event): event is PublicGameEvent => event.source !== "agent");
    if (events.length === 0) {
      return;
    }

    let sequence = this.ctx.storage.sql
      .exec<{ next_sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM environment_event",
      )
      .one().next_sequence;
    for (const event of events) {
      this.ctx.storage.sql.exec(
        `INSERT INTO environment_event
          (sequence, engine_event_id, game_tick, category, source, severity,
           restaurant_id, event_json, state_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sequence,
        event.id,
        event.tick,
        event.category,
        event.source,
        event.severity,
        event.restaurantId ?? null,
        canonicalJson(event),
        nextStateDigest,
      );
      sequence += 1;
    }
  }

  private exportAuditRow(row: AuditRow): AuditExportRow {
    return {
      seq: row.seq,
      actorSeq: row.actor_seq,
      actorId: row.actor_id,
      requestId: row.request_id,
      route: row.route,
      kind: row.kind,
      gameTick: row.game_tick,
      request: parseJson(row.request_json),
      result: parseJson(row.result_json),
      ok: row.ok === 1,
      stateDigest: row.state_digest,
      wallTimestamp: row.wall_timestamp,
      latencyMs: row.latency_ms,
    };
  }

  private exportEnvironmentEventRow(
    row: EnvironmentEventRow,
  ): EnvironmentEventExportRow {
    return {
      sequence: row.sequence,
      engineEventId: row.engine_event_id,
      tick: row.game_tick,
      category: row.category,
      source: row.source,
      severity: row.severity,
      restaurantId: row.restaurant_id,
      event: parseJson(row.event_json),
      stateDigest: row.state_digest,
    };
  }
}
