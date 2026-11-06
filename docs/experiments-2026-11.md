# November 2026 model experiments

This report records the first paid Restaurant Sim model experiments. It is an
engineering result, not a model leaderboard: each arm has only five episodes, early
bankruptcy shortens policy exposure, and the simulator is not an empirical restaurant
digital twin.

## Objective and controls

The scored objective is lexicographic:

1. remain solvent through tick 84; then
2. maximize cumulative operating profit at tick 84.

Revenue, cash, reputation, survival duration, and action count are diagnostics rather
than substitute objectives. Every comparable run used seeds `4101001..4101005`, high
reasoning effort, temperature `0.2`, no explicit completion-token limit, a decision
every three ticks, and the same prompt hash. Profit and heuristic gaps below are in
cents. Cost is estimated provider list cost in US dollars, not an invoice.

Each completed run retained its observation, model attempts, reasoning, corrections,
submitted actions, action receipts, usage, latency, final game export, and archive
verification. The raw archives remain private because they contain operational traces;
this repository publishes the contracts and aggregate findings.

## Reactive model comparison

| Model | Mean profit | Median profit | Profit range | Solvent | Mean heuristic gap | Total list cost |
|---|---:|---:|---:|---:|---:|---:|
| GLM-5.3 Flash | -264,573.0 | -245,019 | -405,301 to -167,131 | 0/5 | -391,095.4 | $0.20233513 |
| GLM-5.3 | -133,812.4 | -131,875 | -172,273 to -101,715 | 1/5 | -287,607.2 | $2.26336936 |
| DeepSeek V4.1 Flash | -382,427.2 | -374,932 | -630,331 to -209,519 | 2/5 | -584,144.0 | $1.80794141 |

| Seed | GLM-5.3 Flash | GLM-5.3 | DeepSeek V4.1 Flash |
|---:|---:|---:|---:|
| 4101001 | -174,490 | -101,715 | -315,916 |
| 4101002 | -245,019 | -135,428 | -209,519 |
| 4101003 | -167,131 | -127,771 | -374,932 |
| 4101004 | -405,301 | -172,273 | -630,331 |
| 4101005 | -330,924 | -131,875 | -381,438 |

GLM-5.3 had the least-negative profit in every matched seed and the smallest heuristic
gap in four of five. It also had the best operating discipline: less final debt and
waste than DeepSeek and more revenue than GLM Flash at nearly the same aggregate cost.
It was still not robust: four runs went bankrupt, commonly after budgeting to expected
sales without enough reserve for an equipment failure or delayed order.

DeepSeek V4.1 Flash produced the most sales and survived two runs, but aggressive
expansion, repeated control changes, waste, and borrowing overwhelmed the extra volume.
It ended with 1,482,000 cents of aggregate debt and never repaid a loan. GLM Flash was
the cheapest and had perfect first-attempt format validity, but all five runs went
bankrupt. Early bankruptcy can mechanically cap later losses, so mean profit alone is
not a sufficient quality measure.

DeepSeek V4 Pro has no comparable score. All five verified attempts failed with an
inference read timeout after approximately 3,774–3,776 seconds. Four submitted no
actions; one submitted a five-action tick-zero decision before timing out. Only that
partial attempt recorded usage: 13,207 tokens and $0.04548148 estimated list cost.

## Clef-gated parallel plans

GLM-5.3, the strongest reactive model above, then proposed exactly five or ten distinct
plans at every decision. Cloudflare Clef compared those plans plus `no_action` against
the same solvency-then-profit objective. Ordinary code executed Clef's choice only when
its assigned probability reached the frozen `0.5` threshold; otherwise it executed
`no_action`. See [the selector contract](decision-selector.md).

| Arm | Mean profit | Median profit | Profit range | Solvent | Mean heuristic gap | Executed decisions | Fallback rate | Actions | Total cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 plans + Clef | -139,929.4 | -137,929 | -156,477 to -123,461 | 0/5 | -209,536.8 | 10/70 | 85.7% | 40 | $1.52615860 |
| 10 plans + Clef | -152,555.6 | -137,055 | -216,457 to -135,624 | 0/5 | -330,742.2 | 1/82 | 98.8% | 5 | $2.20288172 |

| Seed | Ungated GLM-5.3 | 5 plans + Clef | Δ vs ungated | 10 plans + Clef | Δ vs ungated |
|---:|---:|---:|---:|---:|---:|
| 4101001 | -101,715 | -137,929 | -36,214 | -137,055 | -35,340 |
| 4101002 | -135,428 | -145,167 | -9,739 | -136,256 | -828 |
| 4101003 | -127,771 | -123,461 | +4,310 | -135,624 | -7,853 |
| 4101004 | -172,273 | -136,613 | +35,660 | -137,386 | +34,887 |
| 4101005 | -131,875 | -156,477 | -24,602 | -216,457 | -84,582 |

Five plans lost 6,117 cents on average versus ungated GLM and won two matched seeds.
Ten plans lost 18,743.2 cents on average and won one. Neither gated arm produced a
solvent episode. Across both cohorts all ten runs completed, all archives verified,
all 315 planner/selector requests succeeded, and uncertain reserved cost was zero. The
combined tracked exposure was $3.72904032 against the $100 ceiling.

All proposed action sequences were structurally distinct. That did not make selection
effective. The median chosen-plan probability fell from `0.3543` with five plans to
`0.2638` with ten, while the absolute acceptance threshold remained `0.5`. The ten-plan
arm therefore became an almost pure no-action policy. Its low waste—30 units versus 149
for five plans—mostly reflects inactivity, not better restaurant control.

Median planner latency was 17.24 seconds for five plans and 16.13 seconds for ten;
median Clef latency was 1.17 and 1.47 seconds respectively. Planner costs were
$1.36133188 and $1.96494692. Clef added $0.16482672 and $0.23793480.

## Conclusions and next ablation

The tested gate did not improve GLM-5.3. More candidates reduced action rather than
improving choice because a fixed absolute probability threshold is candidate-count
sensitive. The five-versus-ten result therefore measures both candidate count and a
different effective abstention rate.

A follow-up should preserve the same candidate traces and separate ranking from gating:

1. replay the recorded distributions with no threshold to measure how often pure
   top-choice routing differs, without pretending the divergent trajectory has a
   counterfactual profit score;
2. pre-register a candidate-count-aware abstention rule, such as a multiple of the
   uniform prior, before running another paid cohort; and
3. compare both with explicit `no_action` and ungated reactive controls.

Do not tune the rule per seed after seeing profit. With five episodes per arm, report
matched outcomes and traces rather than confidence intervals or significance claims.
The same seed also did not produce an identical realized heuristic trajectory in every
model episode, so matched-seed differences are paired identifiers, not proof of an
identical exogenous path.
