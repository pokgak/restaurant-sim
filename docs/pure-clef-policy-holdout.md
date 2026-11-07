# Pure Clef policy-controller holdout

Status: **deployed and preregistered; fresh holdout not run**. The development-only
policy sweep is complete. No paid calls or confirmatory runs have been made on the
fresh seeds in this document.

## Frozen hypothesis and protocol

This holdout removes the generative planner from the experimental restaurant. At every
three-tick decision point, deterministic code runs complete continuation rules against
the current observation. Each rule keeps its own cadence state and remains the rule for
all later decisions through tick 84. Every current action list must pass
`review_decision`; one invalid candidate fails the episode rather than being dropped or
replaced.

The policy order is frozen:

1. `balanced`
2. `cash_guard`
3. `maintenance_first`
4. `lean_operator`
5. `moderate_growth`
6. `inventory_buffer`
7. `price_power`
8. `workforce_quality`
9. `debt_averse`
10. `growth_credit`

The 5-policy arm uses the first five and the 10-policy arm uses all ten. Their explicit
descriptions and serialized `BaselineConfig` parameters are versioned as
`restaurant-sim-policy-v1`. The frozen library SHA-256 is
`8e357a03fb3e5a54defb5a10f411bec4e13944aa038b4235f88c1c4c614178ca`.

The fixed arm uses **`maintenance_first`**. It was selected before this holdout by
running every frozen policy on the earlier development seeds `4101001..4101010`, then
ranking policies by solvent episodes first and total cumulative operating profit
second. All 100 replacement-adjusted episodes remained solvent; `maintenance_first`
led with `1,586,217` cents total profit, ahead of `balanced` at `1,480,628` cents.

| Development rank | Policy | Solvent | Total profit (cents) |
|---:|---|---:|---:|
| 1 | `maintenance_first` | 10/10 | 1,586,217 |
| 2 | `balanced` | 10/10 | 1,480,628 |
| 3 | `moderate_growth` | 10/10 | 1,387,222 |
| 4 | `debt_averse` | 10/10 | 1,309,712 |
| 5 | `cash_guard` | 10/10 | 859,081 |
| 6 | `price_power` | 10/10 | 855,536 |
| 7 | `workforce_quality` | 10/10 | 732,716 |
| 8 | `growth_credit` | 10/10 | 697,802 |
| 9 | `lean_operator` | 10/10 | 663,241 |
| 10 | `inventory_buffer` | 10/10 | 642,176 |

The first `lean_operator` seed-4101010 attempt hit a Cloudflare-side HTTP 503 while the
new Worker version was being deployed. Its verified failed archive was retained and
excluded; one labeled development-only replacement completed at `80,530` cents and is
included above. No other development episode was replaced. The selected policy must
not change after any result from the fresh seeds is observed. The fresh seeds must not
be used for policy selection, parameter tuning, prompt tuning, or arm removal.

## Clef evaluator contract

Clef predicts outcomes only; it cannot create, edit, omit, or reorder actions. There is
no `no_action` candidate and no confidence fallback. Ordinary deterministic code picks
the highest tuple `(solvency probability, profit score, -canonical index)`.

- Route: `/api/policy-evaluate` (derived from the inference URL unless explicitly set)
- Evaluator contract: `restaurant-sim-policy-evaluator-v1`
- Policy contract: `restaurant-sim-policy-v1`
- Terminal tick: `84`
- 5-policy contract SHA-256:
  `32cc1fa2dd3789fc49605f147a4e93fafa0e157cc124c51b1fffa15fa454cbf3`
- 10-policy contract SHA-256:
  `805a1cf9bc7c32136cd38519af6df2a70e1ed926b9c1f6c041ae8258ce460bac`

The benchmark objective is frozen exactly:

> Evaluate each candidate policy as a complete deterministic continuation from the
> current observation through tick 84. First estimate whether the restaurant remains
> solvent through tick 84. Separately estimate its final cumulative operating profit
> band at tick 84. Do not optimize revenue, cash, reputation, survival duration, or
> action count except insofar as they improve solvency and cumulative operating profit.

Clef receives exactly two questions per policy: a Noul probability that the policy
keeps the restaurant solvent through tick 84, and a score over these ordered terminal
cumulative-operating-profit bands:

1. `Below -500000 cents`
2. `-500000 to -300001 cents`
3. `-300000 to -200001 cents`
4. `-200000 to -100001 cents`
5. `-100000 to -1 cents`
6. `0 to 99999 cents`
7. `At least 100000 cents`

The run trace retains every candidate description, parameter set, action, preflight
preview and projection; every raw Noul and score answer; score probabilities,
confidence, and reverse-cumulative threshold probabilities; the selected policy and
actions; submission receipts; Clef request, response, usage, cost, and budget state;
and export/archive hashes. A response-contract error or budget stop fails the episode.
Successful runs still require verified R2 archives.

## Preregistered fresh-seed arms

Use exactly `4101011,4101012,4101013,4101014,4101015` for every arm:

| Arm | Frozen mode | Generative calls |
|---|---|---|
| development-selected fixed policy | `fixed`, `maintenance_first` | none |
| Clef 5 | `clef`, first 5 policies | only `/api/policy-evaluate` |
| Clef 10 | `clef`, all 10 policies | only `/api/policy-evaluate` |

All arms use the honest `policy` pseudo-model identity. Freeze the same simulator and
archive deployment, 84-tick horizon, three-tick cadence, seed order, concurrency, and
budget accounting. Do not replace failures, rerun selectively, or tune on these seeds.
Report per-seed solvency and cumulative operating profit first, then matched arm deltas,
selected-policy counts, action and acceptance counts, evaluator probabilities, costs,
failures, and archive verification. An unverified archive is not a successful run.

## Prepared commands (do not run during implementation)

The examples share one conservative budget ledger. Carry the final tracked and
uncertain values from each command into the next command.

Fixed policy (zero model/evaluator calls):

```sh
python clients/python/scripts/run_model_batch.py \
  --batch-id "$EXPERIMENT_ID-fixed-maintenance-first" \
  --models policy \
  --seeds 4101011,4101012,4101013,4101014,4101015 \
  --policy-controller fixed \
  --fixed-policy-id maintenance_first \
  --base-url "$WORKER_URL" \
  --inference-url "$WORKER_URL/api/inference" \
  --token-file "$ADMIN_TOKEN_FILE" \
  --output-dir "$OUTPUT_ROOT/$EXPERIMENT_ID-fixed-maintenance-first" \
  --workers 5 --canary-first \
  --initial-cost-usd "$INITIAL_COST_USD" \
  --initial-uncertain-cost-usd "$INITIAL_UNCERTAIN_COST_USD" \
  --budget-usd 100
```

Clef 5, carrying the fixed arm's final ledger:

```sh
python clients/python/scripts/run_model_batch.py \
  --batch-id "$EXPERIMENT_ID-clef-5" \
  --models policy \
  --seeds 4101011,4101012,4101013,4101014,4101015 \
  --policy-controller clef \
  --policy-candidate-count 5 \
  --policy-evaluator-url "$WORKER_URL/api/policy-evaluate" \
  --base-url "$WORKER_URL" \
  --inference-url "$WORKER_URL/api/inference" \
  --token-file "$ADMIN_TOKEN_FILE" \
  --output-dir "$OUTPUT_ROOT/$EXPERIMENT_ID-clef-5" \
  --workers 5 --canary-first \
  --initial-cost-usd "$FIXED_FINAL_COST_USD" \
  --initial-uncertain-cost-usd "$FIXED_FINAL_UNCERTAIN_COST_USD" \
  --budget-usd 100
```

Clef 10, carrying the Clef-5 arm's final ledger:

```sh
python clients/python/scripts/run_model_batch.py \
  --batch-id "$EXPERIMENT_ID-clef-10" \
  --models policy \
  --seeds 4101011,4101012,4101013,4101014,4101015 \
  --policy-controller clef \
  --policy-candidate-count 10 \
  --policy-evaluator-url "$WORKER_URL/api/policy-evaluate" \
  --base-url "$WORKER_URL" \
  --inference-url "$WORKER_URL/api/inference" \
  --token-file "$ADMIN_TOKEN_FILE" \
  --output-dir "$OUTPUT_ROOT/$EXPERIMENT_ID-clef-10" \
  --workers 5 --canary-first \
  --initial-cost-usd "$CLEF5_FINAL_COST_USD" \
  --initial-uncertain-cost-usd "$CLEF5_FINAL_UNCERTAIN_COST_USD" \
  --budget-usd 100
```

Before the first paid call, pin the implementation and deployment revisions, verify the
two frozen hashes and policy-library hash, run the complete Python test suite, and
record the starting aggregate budget ledger. This document is a preregistration, not a
report of confirmatory results.
