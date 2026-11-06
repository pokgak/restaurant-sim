# System One plan selection

The optional `clef` decision selector separates plan generation from plan choice.
The primary reasoning model proposes alternatives; Cloudflare Clef makes one typed
comparison; ordinary code decides whether the result is confident enough to execute.
Neither Clef nor the relay can invent or rewrite actions.

## Exact outcome

The selector asks one fixed `choice` question:

> Choose the candidate most likely to achieve the best benchmark result at tick 84.
> A restaurant that remains solvent through tick 84 ranks above every bankrupt
> restaurant. Among candidates with the same solvency outcome, higher cumulative
> operating profit at tick 84 is better.

Revenue, cash, reputation, survival duration, and action count are not substitute
objectives. They matter only when they improve this lexicographic terminal outcome.
This wording matches the simulator leaderboard instead of asking Clef to optimize an
undefined “better” result.

## Tick protocol

1. The primary model receives the normal private observation and neutral outcome
   feedback. It returns exactly the cohort's frozen count of 3, 5, or 10 distinct,
   non-empty candidate plans, each with at most five ordered actions.
2. The provider-neutral harness validates and previews every candidate independently.
   One structured correction is allowed. Clef is never asked to repair invalid plans.
3. The runner adds one `no_action` candidate so the selector can prefer waiting.
4. One Clef request compares the complete set in parallel. It returns a choice, the
   probability for every candidate, and confidence.
5. The chosen plan executes only when its probability is at least `0.5`. A lower
   probability routes to `no_action`. The threshold is fixed for a cohort and recorded
   in the contract hash.
6. A selector transport or contract failure aborts the run before any proposed action
   is submitted. It never silently changes a selected cohort into an ungated one.

The candidate count is part of the prompt and selector contract hashes. The primary
prompt, selector outcome, candidate IDs, threshold, and selector contract all have
hashes in the run summary. Checkpoints retain the observation, all proposed plans,
local previews, exact Clef request and response, probability distribution, route,
submitted actions, receipts, usage, latency, and estimated list cost. The same files
are uploaded with the engine and actor traces to the private R2 run archive.

Run this mode with the existing batch runner after deploying the relay route:

```sh
python clients/python/scripts/run_model_batch.py \
  --decision-selector clef \
  --candidate-count 5 \
  --decision-url https://your-worker.example/api/decision-select \
  --selection-min-probability 0.5 \
  ...
```

## Evaluation arms

The first comparison should use the same primary model, seeds, reasoning effort,
temperature, token policy, cadence, and simulator version:

- **single-plan reactive:** the existing model chooses one plan every decision tick;
- **parallel-plan reactive:** the model proposes a frozen count of plans and Clef
  selects one;
- **parallel-plan no-threshold analysis:** replay selector traces offline to measure how
  often the `0.5` fallback changed execution, without changing the scored cohort.

Report terminal profit and bankruptcy first, then selection probability, fallback
rate, proposed versus submitted actions, debt, waste, planner cost, selector cost, and
latency. Do not tune the threshold per model or seed.

The first paid count comparison uses GLM-5.3, the same seeds `4101001..4101005`, and
the same model settings for separate 5-plan and 10-plan cohorts. Both cohorts share
one conservative `$100` ceiling. The 3-plan mode remains available as the original
contract and is not silently mixed into either cohort.

## Plan-once follow-up

A separate experiment can isolate planning from repeated reasoning:

- **prethought policy:** the primary model writes one bounded strategy/playbook at tick
  zero; deterministic code generates its allowed branches and a System One model picks
  a branch from the live observation each tick;
- **open-loop schedule:** the primary model emits the complete action schedule at tick
  zero and receives no later state;
- **reactive:** the primary model replans from state every tick.

The prethought policy is the useful production design because it can react cheaply to
breakdowns, delayed orders, and demand changes. The open-loop schedule is still a useful
control: it measures forecast and strategy quality when adaptation is unavailable. It
should not replace the reactive benchmark because the three arms answer different
questions.

Other System One placements should remain separate ablations: routing easy states to a
cheaper planner, selecting which observations enter context, verifying action-plan
consistency, and classifying archived failure traces. Combining them in the first
selector cohort would make attribution impossible.
