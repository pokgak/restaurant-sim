# Clef plan verifier holdout

Status: **prepared, not run**. No paid calls have been made for this holdout.

## Hypothesis and boundary

The first selector experiment asked Clef to predict which of many plans would maximize
a tick-84 outcome. Its separate confidence threshold then replaced Clef's choice with
`no_action` 141 of 152 times, even though Clef itself chose `no_action` zero times.

This holdout tests a narrower System One role: detect whether one GLM-5.3 plan relies on
a factual assumption contradicted by the current observation or deterministic
preflight. Clef does not predict profit, choose among plans, calculate mechanics, or
judge uncertainty about hidden future events.

The frozen tick protocol is:

1. GLM-5.3 returns one plan under the existing decision prompt.
2. Deterministic preflight validates and projects its ordered actions.
3. In the treatment arm, Clef answers one Noul question about a material state misread.
4. Ordinary code routes the result: below `0.3` executes the original plan; `0.3` to
   below `0.7` asks GLM to review and permits retaining it; `0.7` or above requires GLM
   to change its action list. An unchanged required revision fails rather than executing.
5. The reviewed decision passes the same deterministic preflight before execution.

A Clef transport or response-contract failure routes to GLM review, never to
`no_action`. Budget exhaustion stops the episode.

## Frozen contract

- Verifier version: `restaurant-sim-plan-verifier-v1`
- Question ID: `material_state_misread`
- Question: `Does proposedPlan rely on a factual assumption contradicted by observation or deterministicReview, where that contradiction could materially change whether its actions should execute now?`
- True criterion: contradictions about liquidity, recurring cost, inventory or
  delivery timing, equipment, staffing pipeline, capacity, or action ordering.
- False criterion: no supported material contradiction; hidden-future or tick-84
  uncertainty alone does not count.
- Review prompt SHA-256:
  `0db7eba77f1de5dc035b7724e825b4cc2e7c444cf581dff43e42865db08656bc`
- Verifier contract SHA-256:
  `94e1c79e90171567bda3c9952cd2265dfc487e1da99c51ef1ef1bbd066240940`

The runner refuses an arm if either hash drifts. The API validates the complete request
and relays it to `@cf/cloudflare/clef` as model `clef` without changing state or the
question.

## Preregistered arms

Use GLM-5.3 and holdout seeds `4101006,4101007,4101008,4101009,4101010` in every arm:

| Arm | Runner mode | Purpose |
|---|---|---|
| baseline | `--plan-verifier none` | First valid GLM plan executes |
| active control | `--plan-verifier always` | Every first plan receives one GLM review |
| treatment | `--plan-verifier clef` | Clef routes whether GLM review is needed |

Freeze all other settings: 84 ticks, decisions every three ticks, reasoning effort
`high`, temperature `0.2`, no explicit completion-token limit, and the same deployed
simulator, inference relay, primary prompt, model version, and archive verifier.

Do not reuse development seeds `4101001..4101005`, tune thresholds after observing a
holdout result, replace failed seeds, or mix selector traces into this analysis. Pin
the implementation commit and deployed Worker version before the first paid call.

## Outcomes and claim rule

The primary outcome is lexicographic per seed: solvent through tick 84 first, then
higher cumulative operating profit. Report solvent count, seed-matched treatment wins,
median seed-matched profit delta, and every per-seed result. Matching seeds controls the
simulator's exogenous path but does not couple stochastic GLM samples at temperature
`0.2`; treat this small holdout as exploratory and make no causal or statistical
significance claim.

Treat the result as a promising practical signal only if the treatment:

1. has no fewer solvent episodes than baseline;
2. beats baseline on the lexicographic outcome in at least three of five paired seeds;
3. has a positive median paired operating-profit delta; and
4. uses fewer GLM review calls than the always-review control.

Also report initial and reviewed action plans, Noul probabilities, route counts,
changed-plan rate, verifier failures, deterministic corrections, simulator acceptance,
bankruptcy ticks, debt, waste, token usage, list cost, and latency. An incomplete or
unverified archive, frozen-contract mismatch, or exhausted budget makes the affected
arm inconclusive rather than eligible for replacement.

## Budget and run commands

The three arms share one `$100` conservative ceiling. Run them sequentially and carry
both tracked cost and uncertain reserve forward; do not give each arm a fresh ceiling.
The examples use placeholders deliberately because the implementation commit, deployed
Worker URL, token path, and start-time budget ledger must be recorded immediately before
execution.

Baseline:

```sh
python clients/python/scripts/run_model_batch.py \
  --batch-id "$EXPERIMENT_ID-baseline" \
  --models glm \
  --seeds 4101006,4101007,4101008,4101009,4101010 \
  --plan-verifier none \
  --base-url "$WORKER_URL" \
  --inference-url "$WORKER_URL/api/inference" \
  --token-file "$ADMIN_TOKEN_FILE" \
  --output-dir "$OUTPUT_ROOT/$EXPERIMENT_ID-baseline" \
  --workers 5 \
  --initial-cost-usd "$INITIAL_COST_USD" \
  --initial-uncertain-cost-usd "$INITIAL_UNCERTAIN_COST_USD" \
  --budget-usd 100
```

Always-review active control, using the final aggregate budget values from baseline:

```sh
python clients/python/scripts/run_model_batch.py \
  --batch-id "$EXPERIMENT_ID-always" \
  --models glm \
  --seeds 4101006,4101007,4101008,4101009,4101010 \
  --plan-verifier always \
  --base-url "$WORKER_URL" \
  --inference-url "$WORKER_URL/api/inference" \
  --token-file "$ADMIN_TOKEN_FILE" \
  --output-dir "$OUTPUT_ROOT/$EXPERIMENT_ID-always" \
  --workers 5 \
  --initial-cost-usd "$BASELINE_FINAL_COST_USD" \
  --initial-uncertain-cost-usd "$BASELINE_FINAL_UNCERTAIN_COST_USD" \
  --budget-usd 100
```

Clef treatment, using the final aggregate budget values from the active control:

```sh
python clients/python/scripts/run_model_batch.py \
  --batch-id "$EXPERIMENT_ID-clef" \
  --models glm \
  --seeds 4101006,4101007,4101008,4101009,4101010 \
  --plan-verifier clef \
  --verifier-url "$WORKER_URL/api/plan-verify" \
  --base-url "$WORKER_URL" \
  --inference-url "$WORKER_URL/api/inference" \
  --token-file "$ADMIN_TOKEN_FILE" \
  --output-dir "$OUTPUT_ROOT/$EXPERIMENT_ID-clef" \
  --workers 5 \
  --canary-first \
  --initial-cost-usd "$CONTROL_FINAL_COST_USD" \
  --initial-uncertain-cost-usd "$CONTROL_FINAL_UNCERTAIN_COST_USD" \
  --budget-usd 100
```

Before launching, verify that the implementation commit contains this preregistration,
the deployed API exposes `/api/plan-verify`, all local checks pass, and the starting
cost values include every earlier request charged to this holdout.
