# Restaurant Sim

A deterministic, seeded restaurant-management decision benchmark for evaluating
agents over long-running, profitable operation. It is not an empirically calibrated
restaurant digital twin. Two to four independently authenticated agents compete in
the same seeded market; a public observer tracks profit and operations, and an
append-only export keeps every authenticated read and action attributable to its
actor.

## Packages

- `packages/sim`: pure seeded TypeScript economics engine.
- `apps/api`: Cloudflare Worker with one SQLite Durable Object per game.
- `apps/web`: React observer dashboard.
- `clients/python`: dependency-free client, CLI, and heuristic baseline.
- `docs/benchmark.md`: benchmark contract and release gates.
- `docs/realism.md`: realism expansion and multi-seed evaluation contract.
- `docs/decision-selector.md`: parallel plan generation and System One selection contract.
- `docs/experiments-2026-11.md`: first model and Clef selector experiment results.

## Install and verify

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
(cd clients/python && python -m unittest discover -s tests -v)
```

## Run locally

Start the Worker API:

```sh
pnpm dev:api
```

With no `apps/api/.dev.vars`, local create/control/export routes are deliberately
open. Create an episode and retain the one-time seat tokens from the response:

```sh
curl -X POST http://127.0.0.1:8787/api/games \
  -H 'Content-Type: application/json' \
  -d '{"seed":42,"maxTicks":240,"restaurants":[{"id":"alpha","name":"Alpha Kitchen"},{"id":"bravo","name":"Bravo Bistro"}]}'
```

Start the observer in live mode. Vite proxies `/api` to the local Worker:

```sh
VITE_USE_MOCK_API=false pnpm dev:web
```

Open the Vite URL with `?game=<game-id>`. Omit `VITE_USE_MOCK_API=false` to use
the deterministic dashboard fixture instead.

Install and run the Python baseline with one returned seat token:

```sh
python -m pip install -e clients/python
export RESTAURANT_SIM_URL=http://127.0.0.1:8787
export RESTAURANT_SIM_GAME=<game-id>
export RESTAURANT_SIM_TOKEN=<seat-token>
rsim baseline
```

Advance a paused episode with `POST /api/games/:id/control/step`, or start a
bounded alarm-driven run with `POST /api/games/:id/control/start`. See
`apps/api/README.md` for the full API and audit export contract.

## Deploy for restricted evaluation

Never deploy the API in its tokenless local-development mode. Set
`BENCHMARK_ADMIN_TOKEN` as a Worker secret, deploy `apps/api`, and distribute each
one-time seat token only to its assigned agent. The MVP is suitable for restricted
evaluation, not public seat issuance: public authentication, abuse controls, cost
limits, multi-seed orchestration, and the Workers AI harness remain release gates.
