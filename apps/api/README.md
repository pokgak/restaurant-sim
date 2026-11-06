# Restaurant simulation API

Cloudflare Worker API backed by one SQLite Durable Object (`GameRoom`) per game. The Worker always resolves a game with `GAME_ROOMS.getByName(gameId)`. It does not deploy from this package automatically.

## Local development

Install the repository workspace, then from `apps/api` run:

```sh
npm run types
npm run typecheck
npm test
npm run dev
```

The production import resolves the workspace's `@restaurant-sim/sim` package. API tests alias that import through `test/fixtures/sim.ts`, which re-exports the real workspace package so integration tests and production compile against the same frozen engine contract.

`BENCHMARK_ADMIN_TOKEN` is optional for local development. When it is absent, create, control, and export routes are deliberately open and return `X-Admin-Auth: local-dev-open`. **This is local-dev behavior, not production authentication. Do not deploy without setting the secret.** Set it locally in an untracked `.dev.vars` file or with Wrangler secret management. When present, send it as `Authorization: Bearer <token>`; comparison hashes both values and uses constant-time Web Crypto comparison.

Seat tokens are separate from the admin token. They are returned only by game creation, stored only as SHA-256 digests, and compared as fixed-size digests. Losing a seat token requires creating a new game in this MVP.

## Create a game

`POST /api/games`

```json
{
  "seed": 42,
  "maxTicks": 500,
  "restaurants": [
    { "id": "red", "name": "Red Wok" },
    { "id": "blue", "name": "Blue Spoon" }
  ]
}
```

`restaurants` must contain 2-4 entries. IDs are unique stable simulator seat IDs (1-64 letters, digits, `_`, or `-`); names contain 1-80 characters. `seed` is a safe integer and `maxTicks` is 1-10,000. The response is `201`:

```json
{
  "id": "8cfbce44-4803-4d59-aa9e-862cba3031e3",
  "status": "paused",
  "seats": [
    { "restaurantId": "red", "name": "Red Wok", "token": "returned-once" },
    { "restaurantId": "blue", "name": "Blue Spoon", "token": "returned-once" }
  ]
}
```

The Worker passes `{ seed, restaurantIds, maxTicks }` to `createGame`. Display names stay in Durable Object metadata.

## Public and agent APIs

- `GET /api/games/:id/public` needs no authentication. It returns `{ id, status, ...publicSnapshot(state) }`: `tick`, `maxTicks`, `seed`, `leaderboard`, public `restaurants`, `market`, `calendar`, bounded `recentEvents`, and `series`. It never returns the complete engine `eventLedger`.
- `GET /api/games/:id/agent/state` requires a seat bearer token. It returns `{ id, status, ...observe(state, restaurantId) }`, so the frozen private observation fields are at the response top level. An optional `X-Request-Id` (1-128 characters) is recorded in the audit log.
- `POST /api/games/:id/agent/actions` requires a seat bearer token and the canonical command body `{ requestId, type, params }`:

```json
{
  "requestId": "agent-turn-0001",
  "type": "set_marketing",
  "params": { "budgetCents": 5000 }
}
```

The API converts `type` plus `params` to the simulator's `PlayerAction`. The older `{ requestId, action }` envelope remains accepted for compatibility. `requestId` is required and scoped to the authenticated actor. The first command result is stored under unique `(actor_id, request_id)`. A retry returns the original status and JSON, adds `Idempotency-Replayed: true`, does not apply the second action, and is itself appended to the audit log as `agent.command_replay`. Simulator results use `{ accepted, message, costCents }`; the audit `ok` flag equals `accepted`.

Supported actions are `set_menu_price`, `purchase_inventory`, `set_staff`, `set_marketing`, `invest`, `borrow`, `repay_loan`, `schedule_maintenance`, `repair_equipment`, `train_staff`, and `expedite_delivery`. Canonical and legacy envelopes use the same validation.

Agent request bodies are limited to 64 KiB. Action identifiers are at most 64 characters. Menu prices are 500-5,000 cents, inventory quantities 1-500, staff counts 0-10, and marketing budgets 0-5,000 cents. Borrowing is 5,000-100,000 cents, repayments are 1-100,000 cents, and staff training is 500-5,000 cents. Equipment assets are `kitchen` or `refrigeration`; training roles are `chef` or `server`. The Worker makes no external fetches and accepts no executable code.

## Episode control

These routes use the optional admin bearer token described above:

- `POST /api/games/:id/control/step` with `{ "ticks": 1 }` advances immediately while paused. Range: 1-100.
- `POST /api/games/:id/control/start` with `{ "ticks": 100, "intervalMs": 1000 }` schedules one tick per Durable Object alarm. `ticks` is 1-1,000; `intervalMs` is 100-60,000. Defaults are 100 and 1,000.
- `POST /api/games/:id/control/pause` cancels the alarm and clears the remaining run budget.

Runs stop when the requested budget is exhausted or the simulator reaches `maxTicks`. Manual stepping while running returns `409`. Control bodies are limited to 64 KiB.

## Export

`GET /api/games/:id/export` uses admin authentication. The default, or `?format=json`, returns:

```json
{
  "metadata": {
    "id": "game-id",
    "config": {},
    "restaurants": [],
    "status": "paused",
    "tick": 0,
    "maxTicks": 500,
    "stateDigest": "fnv1a64:...",
    "createdAt": 0,
    "exportedAt": 0
  },
  "results": {
    "leaderboard": [],
    "restaurants": [],
    "market": {},
    "calendar": {}
  },
  "profitTimeline": [],
  "environmentEvents": [],
  "logs": [],
  "actorLogs": {}
}
```

`results` captures the leaderboard, restaurant financial/operating state, market, and calendar at export time. `profitTimeline` is the simulator public snapshot's `series`. `environmentEvents` is the durable, gap-free engine-event stream in environment sequence order. It contains only newly generated events whose engine `source` is not `agent`; each row carries the unique engine event ID, tick, category, source, severity, optional restaurant, canonical event object, and the post-transition state digest. `logs` is complete actor-audit order; `actorLogs` contains those same actor records grouped by seat.

`?format=jsonl` (or `Accept: application/x-ndjson`) emits one `metadata` line, one `results` line, one `profit_timeline` line, all `environment_event` lines in sequence order, then all `agent_log` lines. Environment events and actor logs are separate in both formats.

Every successfully authenticated agent read and command, including malformed commands and idempotent replays, appends a record with:

- global `seq` and gap-free `actorSeq`
- actor ID and optional request ID
- route, kind, and game tick
- canonical request and result JSON
- `ok`, state digest, wall timestamp, and latency

SQLite triggers reject updates and deletes from both `audit_log` and `environment_event`. Manual steps and alarm ticks write state plus newly generated non-agent engine events in one synchronous SQLite transaction. Commands write state, dedupe result, and actor audit in one synchronous transaction; agent-sourced engine events are not duplicated into `environment_event`. The object keeps no in-memory state cache, so eviction cannot lose critical state.

## R2 run archives

The private `RUN_ARCHIVES` R2 binding points to `restaurant-sim-traces`. Reaching `maxTicks` through a manual step or alarm automatically writes an engine snapshot. Admins can also snapshot a paused, failed, or completed run with `POST /api/games/:id/archive`; benchmark runners should call this once more after the final model response so the latest actor reads are included. `GET /api/games/:id/archive` returns the private object inventory, sizes, ETags, and SHA-256 digests without returning object bodies.

Each snapshot is content-addressed and immutable:

```text
runs/<game-id>/
  manifest.json
  engine/latest.json
  engine/snapshots/<export-sha256>/
    manifest.json
    game-export.json
    game-export.jsonl
  agent/<uploaded-artifact>
```

Snapshot JSON contains run configuration, final results, every profit point, the complete environment-event ledger projection, and all actor audit rows. `engine/latest.json` and the top-level `manifest.json` are mutable indexes; prior snapshot objects are never overwritten. A retry verifies an existing object's size and SHA-256, fills any missing objects, and rejects different content at an existing immutable key. The snapshot manifest is written after both export formats, so a partial upload is never presented as complete.

The game API cannot observe raw model inference. The benchmark runner must upload its exact model-side trace with `PUT /api/games/:id/artifacts/:name` before the final archive call. Artifact names are single safe path segments and bodies are limited to 16 MiB. JSON and NDJSON are validated, including any embedded game ID. Existing content is idempotent; different content under the same name returns `409 immutable_artifact_exists`. Keep at least one `run.json` containing the exact prompt and hash, provider/model/settings, every observation, raw inference response, parsed decision, submitted action/result, token or neuron usage and estimated cost, terminal result, and verification outcome. Checkpoint NDJSON and original downloaded exports can be uploaded beside it.

The included uploader sends artifacts, requests the final engine snapshot, then verifies every local SHA-256 against the R2 inventory without printing the admin token:

```sh
npm run archive-run -- \
  --base-url https://your-worker.example \
  --game-id <game-id> \
  --token-file /secure/path/admin-token \
  run.json checkpoint.ndjson game-export.json game-export.jsonl
```

The bucket has no public domain or CORS policy. Public polling still exposes only bounded `recentEvents`; neither engine archives nor raw model traces are available without admin authorization.

## Private decision selector

`POST /api/decision-select` is an admin-protected relay locked to
`@cf/cloudflare/clef` and the `restaurant-sim-plan-selector-v1` contract. It accepts
exactly 3, 5, or 10 validated planner candidates plus `no_action` and one `choice`
question named `terminal_outcome`. The Worker adds Clef's required `model: "clef"`
field and returns the typed answer and usage. It rejects every other model, question,
candidate count, or candidate ordering. The benchmark runner validates the response
and archives the exact request, probabilities, route, latency, and cost.

## Saved game compatibility

New games are created as `GameState.version: 2`, including the versioned, keyed random state and complete private engine event ledger. Stored MVP `GameState.version: 1` values are incompatible and are never inferred, coerced, or migrated. Public/private observations, commands, controls, and admin export return `409 unsupported_game_version` with instructions to create a new game. Create new games instead of reusing v1 Durable Object state.

## Limits and status codes

- Create bodies: 32 KiB; all other JSON bodies: 64 KiB.
- Seats: 2-4; game ticks: 1-10,000; manual step: at most 100; scheduled run: at most 1,000 ticks.
- `400` invalid input, `401` missing/invalid bearer token, `404` missing game/route, `409` invalid game control state or unsupported stored game version, `413` oversized body.
