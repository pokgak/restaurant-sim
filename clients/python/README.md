# Restaurant Sim Python client

A Python 3.10+ client and adaptive heuristic baseline with no third-party
runtime dependencies.

## Install and configure

```sh
python -m pip install -e clients/python
export RESTAURANT_SIM_URL='https://restaurant.example'
export RESTAURANT_SIM_GAME='game-id'
export RESTAURANT_SIM_TOKEN='seat-token'
```

Keep credentials in the environment rather than scripts or command history.

## CLI

```sh
rsim state
rsim public
rsim act set_menu_price --param dishId=burger --param priceCents=1299
rsim act purchase_inventory --params '{"ingredientId":"flour","quantity":20}'
rsim wait 12 --poll-interval 2 --timeout 60
rsim baseline --decision-interval 3 --cash-reserve 20000 --poll-interval 2
```

`act` passes unknown action types and parameters through unchanged. Values in
`--param KEY=VALUE` are parsed as JSON when possible and otherwise remain
strings. Use `--request-id` to retry the exact same action safely.

Every `state`, `public`, and `wait` poll is expected to be audit-logged by the
server. `wait` performs one immediate public read, then uses the visible
`--poll-interval` until `--timeout`. The baseline performs one private read per
decision and exposes both its decision interval and public polling interval.

## Python API

```python
from restaurant_sim import Client

client = Client.from_env()
observation = client.state()
public = client.public_state()

request_id = client.new_request_id()
try:
    result = client.act(
        "set_staff", request_id=request_id, role="server", count=3
    )
except Exception:
    # If delivery was uncertain, retry this same action with request_id.
    raise

next_snapshot = client.wait_for_tick(
    public["tick"] + 1, poll_interval=2.0, timeout=30.0
)
```

Convenience methods cover `set_menu_price`, `purchase_inventory`, `set_staff`,
`set_marketing`, `invest`, `borrow`, `repay_loan`, `schedule_maintenance`,
`repair_equipment`, `train_staff`, and `expedite_delivery`. Every method accepts
an optional `request_id`; `act()` remains the forward-compatible escape hatch.
`APIError`, `TransportError`, `ProtocolError`, and `WaitTimeout` expose fields and
`as_dict()` for programmatic handling. Transport and API errors from actions
retain the action's `request_id`.

There is no `events()` method because the frozen API has no event route;
`recentEvents` in the public snapshot is not treated as an equivalent API.

## Model decision harness

`restaurant_sim.harness` provides a provider-neutral validation and feedback
loop. It does not call a model or choose a restaurant strategy. The system
prompt states the objective, action contract, and simulator mechanics without
recommending prices, staffing, inventory levels, investments, or timing.

```python
from restaurant_sim.harness import DecisionHarness, build_outcome_feedback

harness = DecisionHarness()
decision = harness.decide(observation, infer, outcome_feedback=prior_feedback)

results = [
    client.act(action["type"], **action["params"])
    for action in decision.actions
]
prior_feedback = build_outcome_feedback(observation, next_observation, results)
```

`infer(messages)` receives OpenAI-compatible system/user messages and may return
either response text or an OpenAI-compatible response mapping. The harness
preserves every raw response, visible content, `reasoning_content` or
`reasoning`, finish reason, usage, parsed value, validation issue, and preflight
projection for trace archival. `system_prompt_sha256()` identifies the exact
prompt used by a run.

The default loop makes at most one correction call for malformed or immediately
infeasible output. It checks actions sequentially, so an accepted borrow can
fund a later purchase, while a rejected action cannot alter the preview for a
later action. A valid `actions: []` remains a valid decision. Optional cash
reserve warnings are disabled by default and never trigger correction unless
`retry_on_policy_warnings=True` is set explicitly.

Validity and execution are intentionally separate:

- `parseValidAttempts` counts valid JSON responses.
- `envelopeValidAttempts` also requires the top-level decision shape.
- `schemaValidAttempts` also requires exact action names and `params` fields.
- `feasibleAttempts` also requires immediate affordability, storage headroom,
  equipment status, pending order, debt, and training constraints.
- Simulator acceptance remains authoritative and is recorded separately in
  `build_outcome_feedback(...)["actionResultSummary"]`.

Outcome feedback contains exact action receipts, observed state deltas, the
latest tick report, relevant bounded events, and still-pending orders, staffing,
training, or equipment work. It labels the observation window and its data
limits, and does not attribute outcomes to one action or recommend the next
action. Counterfactual coaching is deliberately excluded.

`CandidateDecisionHarness` is the opt-in parallel-plan variant. It asks the same
planner for exactly 3, 5, or 10 distinct feasible plans without choosing among them.
The batch runner's `--decision-selector clef` mode adds a no-action candidate and
sends the complete set to one typed Clef `choice` question. The selector targets the
exact terminal leaderboard outcome and records its complete probability distribution;
see [`docs/decision-selector.md`](../../docs/decision-selector.md). This mode is kept
for reproduction of the completed selector ablation; it is not the current Clef
integration.

`DecisionHarness.review(...)` asks the original planner to return one complete revised
decision after seeing its first decision, deterministic preflight, and a semantic
verification result. The batch runner exposes three mutually exclusive verifier arms:

- `--plan-verifier none`: execute the first valid plan;
- `--plan-verifier always`: always pay for one GLM review (the active control);
- `--plan-verifier clef`: ask one frozen Clef Noul question about a material state
  misread, execute below `0.3`, request optional review from `0.3` to below `0.7`, and
  require a changed reviewed action plan at or above `0.7`.

Clef does not forecast the terminal score or calculate simulator mechanics. A Clef
transport or response-contract error routes to GLM review rather than silently
becoming `no_action`; budget exhaustion still stops the run. Original plans, verifier
requests and probabilities, review plans, routes, changed actions, usage, and costs are
archived independently. See the frozen design and prepared holdout in
[`docs/clef-plan-verifier.md`](../../docs/clef-plan-verifier.md).

Validate saved JSON without invoking a model:

```sh
python -m restaurant_sim.harness \
  --observation observation.json \
  --decision decision.json
```

The baseline reads the canonical private restaurant state and keeps support for
older scalar and nested aliases. Inventory decisions include pending orders,
storage capacity, and delivery lead time. Staffing decisions wait for current
targets, hiring pipelines, and temporary absences instead of repeatedly raising
targets. A configurable cash reserve defaults to 20,000 cents: required repairs
and inventory can trigger bounded borrowing at or below 80% credit utilization,
surplus cash repays debt, and liquidity pressure reduces marketing. The policy
also expedites only disrupted late orders that threaten stock, schedules one
preventive maintenance action at a time, repairs broken assets, and trains one
covered low-skill role only with service and financial headroom.

All actions stay inside simulator bounds, each decision is capped at five
actions by default, and no decision repeats before the configured cadence. Run
`python -m restaurant_sim.baseline --help` for the standalone module entry
point. `examples/agent.py` shows read-only suggestions and requires `--apply`
before it submits actions.

## Test

From `clients/python`:

```sh
python -m unittest discover -s tests -v
```
