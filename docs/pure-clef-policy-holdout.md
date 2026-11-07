# Pure Clef policy-controller holdout

Status: **holdout complete**. The development-only policy sweep and all three frozen
fresh-seed arms have run. No failed fresh-seed episode was replaced or rerun.

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

## Holdout results

The fixed policy won. Every completed restaurant remained solvent, but Clef's policy
switching reduced cumulative operating profit. The Clef-5 arm also lost one episode to
a Cloudflare-side HTTP 503 while reading game state after nine decisions. Its partial
`68,877`-cent profit is retained in the verified failure archive but excluded from
completed-run aggregates.

| Seed | Fixed `maintenance_first` | Clef-5 | Clef-5 delta | Clef-10 | Clef-10 delta |
|---:|---:|---:|---:|---:|---:|
| 4101011 | 143,652 | 192,704 | +49,052 | 108,934 | -34,718 |
| 4101012 | 212,545 | 87,745 | -124,800 | 76,055 | -136,490 |
| 4101013 | 263,578 | failed (HTTP 503) | not comparable | 259,627 | -3,951 |
| 4101014 | 270,430 | 165,092 | -105,338 | 166,484 | -103,946 |
| 4101015 | 153,588 | 129,694 | -23,894 | 24,282 | -129,306 |

All numeric results in the table are solvent, completed, and R2-verified.

| Arm | Completed | Solvent | Completed profit total | Mean profit | Clef calls | Incremental cost |
|---|---:|---:|---:|---:|---:|---:|
| Fixed `maintenance_first` | 5/5 | 5/5 | 1,043,793 | 208,758.60 | 0 | $0 |
| Clef-5 | 4/5 | 4/4 completed | 575,235 | 143,808.75 | 121 | $0.35046048 |
| Clef-10 | 5/5 | 5/5 | 635,382 | 127,076.40 | 140 | $0.55027152 |

On the four completed matched Clef-5 seeds, Clef-5 lost `204,980` cents in total,
or `51,245` cents per seed, and beat fixed on one of four. Clef-10 lost `408,411`
cents in total, or `81,682.20` cents per seed, and beat fixed on zero of five. Clef-10
also lost `199,480` cents to Clef-5 on their four jointly completed seeds.

All 15 episode archives verified, including the Clef-5 infrastructure failure. Across
the three arms, deterministic policies submitted 933 actions and the simulator accepted
all 933 without rejection. No policy episode made a generative-model call.

### What Clef selected

| Arm | Decisions | `balanced` | `cash_guard` | `maintenance_first` | `moderate_growth` | `debt_averse` | Policy switches |
|---|---:|---:|---:|---:|---:|---:|---:|
| Clef-5 | 121 | 100 | 8 | 10 | 3 | 0 | 33 |
| Clef-10 | 140 | 94 | 19 | 7 | 0 | 20 | 60 |

The other six 10-policy candidates were never selected. Clef-5 switched at 33 of 116
eligible decision boundaries (28.4%); Clef-10 switched at 60 of 135 (44.4%). Mean
top-versus-runner-up solvency margins were only `0.01425` and `0.01109`, respectively.
One Clef-10 choice required the frozen profit-score tie-break; every other choice was
decided by solvency probability alone.

Clef systematically preferred `balanced` over the development winner. Mean predicted
solvency was `0.9365` for `balanced` versus `0.9152` for `maintenance_first` in Clef-5,
and `0.9398` versus `0.9171` in Clef-10. Because the objective is lexicographic, these
small solvency differences overrode profit estimates even though all ten policies had
been solvent on all replacement-adjusted development runs.

The operational traces are consistent with under-maintenance, without proving that it
alone caused the profit gap. Fixed scheduled 8.8 maintenance actions and suffered 1.6
breakdowns per completed run. Clef-5 scheduled 5.25 and suffered 2.75; Clef-10 scheduled
4.8 and suffered 2.8. Clef-10 also finished with 7.6 total staff on average versus 11.4
for fixed, which reduced mean units sold from 596.8 to 511.6.

There is also a contract-execution mismatch to address before another confirmatory run:
Clef predicts each candidate as a complete continuation through tick 84, but the runner
executes only that candidate's current actions and asks Clef to choose again three ticks
later. Frequent switching therefore creates a hybrid trajectory that no scored
continuation describes. A follow-up should either commit to the selected policy for the
episode or score a frozen finite commitment window that matches what is executed.

The two Clef arms used 3,753,050 input tokens and cost `$0.900732` in total. Including
the earlier experiment ledger, tracked spend ended at `$13.547696` of the `$100` ceiling,
with no uncertain reserve. The production run used Worker version
`9668c547-7e20-4777-8014-b31f530764ec` at 100% traffic. These are five-seed results;
they support a directional comparison, not a significance claim.

## Reproduction commands

The executed arms shared one conservative budget ledger. Carry the final tracked and
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
