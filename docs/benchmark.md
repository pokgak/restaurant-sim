# Restaurant Sim benchmark

## MVP question

Can coding agents operate competing restaurants over a long-running, deterministic
episode through a small HTTP interface, and can an evaluator explain the resulting
profit gap from the recorded state and action history?

The first useful outcome is one local episode with two to four independently
authenticated seats that:

1. advances from a known seed to a fixed horizon;
2. ranks restaurants by cumulative operating profit;
3. shows live economics and actions in the observer dashboard; and
4. exports a complete, actor-separated trace that can replay the episode.

## Episode model

Each restaurant starts with the same menu, inventory, staffing, reputation, and
capacity. The MVP has no explicit cash balance, financing, or insolvency state;
inventory purchases and investments reduce cumulative operating profit directly.
One tick represents one generic operating interval. A seeded market supplies
customer demand and ingredient conditions; the serialized PRNG state makes every
outcome reproducible.

Agents can change menu prices, purchase ingredients, set chef and server staffing,
set a marketing budget, and invest in either capacity or food quality. Revenue and
operating profit respond to demand, competitors' prices and marketing, service
capacity, ingredient stockouts, wages, waste, quality, and reputation.

The primary episode result is cumulative operating profit at the fixed horizon.
Revenue, expenses, customers served, and reputation are diagnostics, not substitutes
for profit. Multi-seed evaluations report profit per seed, mean profit, median
profit, and win rate rather than hiding outcomes behind one opaque score. The
[realism expansion](realism.md) defines the future cash, calendar, operational-event,
and evaluation contracts without presenting them as current behavior.

## Agent boundary

Every seat gets its own bearer token. A seat can read its private observation and
submit bounded typed actions, but cannot read another seat's private inventory or
credentials. Public observations expose the clock, rankings, market summary, and
the information visible in the observer dashboard.

Commands carry an agent-generated `requestId`. The server deduplicates retries by
`(actor_id, request_id)`, so a network retry cannot buy inventory or invest twice.

## Trace contract

The server records every authenticated agent read and command. Each record contains:

- a global sequence and an actor-local sequence;
- actor, route, request kind, request ID, and game tick;
- canonical request and result payloads;
- success, state digest, wall timestamp, and latency.

Episode exports also include configuration, seed, profit timeline, and terminal
state. Analysis can therefore separate decisions by actor, align them to game time,
measure observation and action cadence, and replay state-changing commands.

This trace is an actor audit log, not a complete environment-event ledger. The MVP's
recent public event list is a bounded UI projection. The realism expansion requires a
separate permanent, structured ledger for exogenous and operational events; neither
the actor audit log nor the recent UI window can substitute for it.

## MVP restriction envelope

- Local development plus an admin-protected test deployment; public release is
  deferred until the evaluation and abuse-control gates pass.
- Two to four seats and one Durable Object per game.
- Fixed maximum episode length, body size, step count, and polling cadence.
- No arbitrary code execution or external fetch from the game engine.
- Creation, control, and export accept an optional admin token; the tokenless mode
  is explicitly for local development.
- Seat tokens are returned once and stored only as SHA-256 digests.

The MVP is not production-ready authentication, abuse prevention, high availability,
or cost control. Those become release gates before public exposure.

## Review point

Run at least three seeds with the heuristic baseline and one model-backed agent.
Continue only if episodes finish without missing trace records, repeated runs are
deterministic, the UI explains major profit changes, and different policies produce
meaningfully different profit trajectories. A restricted Worker may host end-to-end
tests; public seat issuance and Workers AI harness integration remain release gates.
This three-seed review is an MVP smoke test, not a benchmark score. Scored realism
evaluation follows the larger held-out, scenario-balanced protocol in
[the realism contract](realism.md).
