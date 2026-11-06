# Restaurant realism and evaluation contract

## Status and claim boundary

This document is the implementation and evaluation contract for the realism
expansion. The current MVP remains the behavior described in [the benchmark
contract](benchmark.md): a deterministic seeded market, a small action surface,
cumulative operating profit, actor audit logs, and a bounded recent-event window.

The expansion is intended to test whether an agent can notice changing conditions,
protect solvency, and adapt operations profitably. It remains a **seeded decision
benchmark**, not an empirically calibrated digital twin, a business forecast, or a
claim that the simulated distributions match real restaurants. Scenario parameters
are synthetic until they are separately calibrated and validated against appropriate
data.

Names for new state, actions, events, and metrics in this document are conceptual
unless the current MVP already defines them. This document freezes behavior and
evaluation requirements, not exact API field or action names. The engine and API
implementation must freeze versioned schemas, units, ranges, and ordering before a
realism release.

The following MVP invariants remain in force:

- two to four independently authenticated seats and one Durable Object per game;
- bounded typed commands with idempotent request IDs;
- a fixed episode horizon, request sizes, step sizes, and polling cadence;
- no arbitrary code execution or external fetch from the engine;
- admin-protected creation, control, and export outside deliberate local development;
  and
- restricted evaluation only. Public seat issuance remains gated on authentication,
  abuse, cost, reliability, and evaluation review.

## Time, decisions, and events

### One tick is one local calendar day

For the realism expansion, one tick means one simulated local calendar day, including
days on which a restaurant is closed, disrupted, or insolvent. It is the accounting
and operations settlement boundary, not a wall-clock duration. API alarm intervals
only control evaluation pacing and must not change economic outcomes.

At state tick `t`, all days before `t` have settled. The deterministic evaluation
cycle is:

1. every agent receives an observation from the same start-of-day boundary;
2. the harness collects actions without exposing another seat's same-day actions;
3. accepted actions are committed in a frozen canonical order;
4. exogenous conditions for day `t` are resolved;
5. restaurant operations, cash movements, and consequences are resolved;
6. reports and permanent event records are appended; and
7. the state advances to `t + 1`.

An action accepted before step 4 can affect day `t`, subject to documented lead times.
An action accepted after the boundary first affects a later day. The engine contract
must define whether each decision is immediate, scheduled, or cancellable; it must
not depend on request race timing. Closed days still advance the calendar and can
incur obligations, spoilage, repairs, or deliveries.

### Agent actions are not environment events

The implementation and export must keep three kinds of records distinct:

1. **Agent actions** are intentional authenticated commands, such as changing a
   price, placing an order, scheduling labor, authorizing maintenance, or approving
   expansion. Reads, rejected commands, retries, and accepted commands remain in the
   append-only actor audit log.
2. **Exogenous events** originate outside a restaurant's operation, such as a holiday,
   a demand-regime change, supplier disruption, market price shock, or area-wide
   outage. They are generated from the versioned scenario and seed, not inferred from
   an agent command.
3. **Operational events** are consequences inside a restaurant, such as a delivery,
   absence, equipment failure, repair completion, stockout, spoilage, overtime,
   missed payment, or closure. They can depend on prior actions and state as well as
   deterministic random draws.

A command can cause later operational events, but it must not be rewritten as one.
This separation lets reviewers answer what the agent knew, what it chose, what shock
occurred, and what operational consequence followed.

### Permanent structured environment-event ledger

The bounded recent-event list remains a UI convenience. It can project the latest
events but is not evidence that an episode history is complete. In addition to the
actor audit log, every episode must maintain an append-only, permanent, structured
environment-event ledger covering exogenous and operational events.

The exact schema is an implementation contract to freeze. Conceptually, each record
must identify a global sequence, simulation tick and phase, event category and
version, affected scope or restaurant, severity and duration where applicable,
public-versus-private visibility, deterministic provenance, structured causes or
links, economic or capacity effects, and a post-event state digest. Free-form text
may accompany a record for the UI but cannot be the only representation.

The full ledger must be included in the admin export in global order. Actor audit and
environment records need a common ordering or stable cross-reference so a reviewer
can reconstruct each decision boundary. Hidden events remain hidden from agents until
their visibility rule permits disclosure, but are available to authorized post-run
evaluation. Updates and deletes must be rejected just as they are for actor audit
records.

## Seeded replay and deterministic controls

A replay is defined by the engine and schema versions, scenario manifest and version,
episode configuration, initial state, episode seed, seat assignment, horizon, and the
ordered accepted commands at their original decision boundaries. Given those inputs,
replay must regenerate identical economic state, profit and cash series, and
environment-event records. Wall timestamps and request latency are audit metadata and
are excluded from deterministic state and digest comparisons.

Randomness must be specified rather than merely seeded. The implementation must
freeze the PRNG algorithm and draw mapping. Prefer stable random substreams keyed by
episode seed, domain, tick, and stable entity so adding an unrelated draw does not
silently move every later shock. The same exogenous substream must support paired
shock/no-shock and adaptive/frozen-policy comparisons. Policy-dependent operational
events may differ, but unrelated exogenous events must not drift because one policy
consumed a different number of random draws.

For a fixed replay input, the following are errors:

- dependence on wall time, network timing, locale, or iteration order;
- a missing, duplicated, or reordered actor or environment sequence;
- a terminal state, series, or event-ledger mismatch; or
- a state-changing outcome that cannot be traced to an accepted action, scheduled
  consequence, scenario rule, or deterministic draw.

The export is sufficient only when a verifier can replay it from the declared initial
state and commands, regenerate the event ledger, and match the terminal digest. The
ledger is durable evidence and a replay oracle; it is not a license to inject an
unversioned event sequence into a different engine.

## Realism domains in implementation order

Each domain must add an observable tradeoff, a deterministic state transition, an
economic consequence, structured events, and metrics. Extra detail that does not
change a decision is out of scope.

### 1. Cash and solvency

Cash is separate from profit. The current MVP permits cumulative profit to become
negative and charges purchases and investments directly to profit; that is not a
solvency model. The expansion must distinguish revenue and expense recognition from
cash receipts and payments, including inventory, payroll, fixed obligations,
maintenance, capital spending, and any explicitly available financing.

Every daily close must satisfy a cash reconciliation:

`closing cash = opening cash + cash receipts - cash payments + financing flows`

Inventory and capital purchases must not be counted again as expense merely because
cash moved. Any simplified cost recognition, payment delay, credit limit, interest,
or owner injection must be explicit in the scenario manifest and consistent across
policies.

An agent must be able to observe current liquidity, committed payments, due dates,
and available credit early enough to act. Spending beyond available liquidity is
rejected unless a documented credit facility covers it. Missed obligations have
deterministic consequences. The contract must define distress, default, temporary
closure, and terminal insolvency; an insolvent episode is never dropped from scoring.

Required diagnostics include opening, minimum, and terminal cash; net cash change;
profit; unpaid obligations; financing cost; days distressed; and whether and when
insolvency occurred. High average profit cannot hide frequent insolvency.

### 2. Calendar and demand regimes

The calendar gives each tick a weekday, week, and named seasonal or holiday context.
Demand should have persistent regimes and transitions rather than only independent
daily noise: for example steady, growth, slump, event surge, or recovery. Scenario
manifests define synthetic transition and duration rules and which calendar facts,
forecasts, or lagging signals are visible.

Agents may know published calendar rules and observe legitimate market signals, but
must not receive the held-out seed, future random draws, or undisclosed shock times.
Demand events record regime, scope, start, duration, signal status, and realized
effect conceptually; exact names remain to be frozen.

Evaluation must cover early, middle, and late transitions, temporary and persistent
changes, false or noisy signals where declared, and matched steady-demand controls.
Useful diagnostics include forecast error, unmet demand, utilization, price and labor
response latency, recovery time, and profit during and after the transition.

### 3. Equipment and maintenance

Capacity and quality investments become durable equipment or station capacity with
documented throughput, wear, reliability, maintenance, downtime, and repair
economics. Preventive maintenance trades current cash and planned downtime for lower
failure risk; deferred maintenance can improve short-run cash while increasing
expected disruption. Repairs and replacements have declared costs and lead times.

Failure draws must use stable equipment-specific substreams. Agents observe enough
condition or maintenance history to make a risk decision, not necessarily the next
failure draw. Events distinguish degradation, planned maintenance, failure, repair,
and return to service. Diagnostics include availability, planned and unplanned
downtime, maintenance cost, lost contribution, repeat failures, and avoided loss.

### 4. Human operations

Scheduled labor and labor actually available are separate. The smallest useful model
adds schedule lead time, role coverage, absence, overtime, fatigue or workload, and
training or experience effects on throughput and service. Hiring, reducing staff, and
cross-training need declared delays and cash consequences so staffing cannot change
costlessly after a shock is known.

This is a synthetic aggregate operations model, not a model of identifiable workers
or protected characteristics. Events distinguish agent scheduling decisions from
exogenous availability and resulting overtime, queueing, service, or closure effects.
Diagnostics include coverage, overtime, labor cost, absence impact, throughput,
service loss, and recovery time.

### 5. Supply chain

Purchasing becomes an order pipeline rather than instant inventory. Suppliers have
declared lead-time, price, availability, minimum-order, and reliability behavior;
ingredients retain storage limits and spoilage. Disruptions can delay, partially fill,
cancel, or make an order more expensive only according to rules visible in the
scenario contract. Expediting or substitution is useful only when its cost and quality
tradeoff is explicit.

Orders, acknowledgements, shipment changes, receipts, spoilage, substitutions, and
stockouts are structured events. Diagnostics include service level, lead-time error,
stockout and waste cost, expedite cost, days of supply, working capital in inventory,
and profit protected during disruptions.

### 6. Scaling pressure

Scaling must add pressure rather than grant a monotonic upgrade. Added capacity or a
new operating unit requires cash, ramp time, fixed cost, staffing, equipment, working
capital, and coordination. Demand may ramp more slowly than capacity, and utilization
or service can fall during transition. Expansion rules must preserve seat fairness and
must not require an agent to manage detail that observations cannot summarize.

Implement scaling only after cash, calendar, equipment, labor, and supply transitions
pass their gates. Diagnostics include payback, utilization, fixed-cost coverage,
ramp losses, service consistency, liquidity headroom, and incremental profit. A
larger footprint that grows revenue while destroying cash or profit is not success.

## Evaluation protocol

### Scenario coverage

A scored suite contains the following versioned scenario families:

| Family | Required comparison | Capability under test |
| --- | --- | --- |
| Steady control | low-volatility, no material shock | basic profitable operation and regression control |
| Cash squeeze | matched normal payment timing | liquidity planning without inventing revenue |
| Demand transition | matched steady regime | detecting and adapting price, inventory, and labor |
| Equipment disruption | matched no-failure or maintained case | prevention, contingency, and repair choices |
| Human disruption | matched full-availability case | schedule resilience and profitable coverage |
| Supply disruption | matched reliable-supply case | ordering, buffers, substitution, and recovery |
| Scaling stress | matched hold-steady case | selecting and surviving profitable expansion |
| Compound stress | component scenarios already passed | prioritization when constraints interact |

Every family declares its horizon, initial state, observable signals, hidden
information, shock windows, severity distribution, affected scope, and reference
control before evaluation. At least one case in each shock family must require a
change from the steady-state policy; otherwise the family does not measure adaptation.
Compound scenarios are a final gate, not a substitute for diagnosing each domain.

Scenarios include both shared shocks and asymmetric restaurant-specific shocks.
Asymmetric shocks target a stable seat or role, never a policy name. Policies rotate
through every seat, opponent order, and shock role equally, or use complementary runs
that provide the same balance. This preserves realistic idiosyncratic failures without
turning seat assignment into luck.

### Seed sets and run controls

Development seeds and scenario examples are public. Scored seeds are disjoint,
held out, and fixed before candidate evaluation. The release score uses at least 20
held-out seeds per required scenario family. A variance study on non-evaluation seeds
may require more; it must set the final count before candidates run, not stop when a
preferred result becomes significant. The three-seed MVP review remains only a smoke
test.

Each shock run has a matched no-shock or reference run using common random numbers.
Each candidate uses the same seed blocks, horizon, initial entitlements, opponent
roster, seat rotations, observation cadence, maximum actions per decision, and
compute or time budget. The harness freezes engine build, schema version, scenario
version, client behavior, and retry policy. Failed and rejected actions remain in the
trace and evaluation; evaluators do not repair a candidate's output by hand.

Scored episodes use a paused observe/collect/commit/step cycle or an equivalent
deterministic controller. All seats observe the same boundary before any seat's
same-day action is exposed. Commands are then applied in a declared canonical order.
Alarm pacing and network latency cannot award extra economic turns. No episode is
rerun because its outcome is inconvenient, and no best-of-attempt selection is
permitted.

### Episode and shock metrics

Per episode, retain at least:

- cumulative economic profit, total revenue and costs, terminal and minimum cash,
  net cash change, solvency outcome, and insolvency tick;
- customers served, unmet demand, stockouts, waste, service capacity, and reputation;
- labor coverage and cost, equipment availability and cost, and supply service level
  when those domains are enabled; and
- action acceptance, observation and action cadence, response latency, and events
  linked to the response window.

For each matched seed and seat role, calculate conceptually:

- **paired profit delta:** candidate profit minus the named reference policy's profit
  under the same scenario block;
- **shock cost:** candidate profit in the shock run minus its profit in the matched
  no-shock run;
- **adaptation value:** candidate profit from shock onset through the horizon minus a
  deterministic counterfactual that holds its controllable pre-shock settings fixed
  over that window; and
- **recovery time:** days from shock onset until the declared operational and economic
  recovery conditions are both met, or censored at the horizon.

The frozen-settings counterfactual uses the same exogenous substreams and opponent
policy schedule. It is a diagnostic, not privileged information available to the
agent. A response counts as profitable adaptation only when it improves economic
outcome over the counterfactual without merely shifting the loss into insolvency,
tail risk, unpaid obligations, or a later window. Action count or a visible reaction
alone is not adaptation evidence.

### Multi-seed reporting and scorecard

Report every candidate by scenario family and in aggregate. Reports include seed and
episode counts, engine and scenario versions, opponent roster, seat balance, failures,
and missing data. For profit, paired profit delta, shock cost, and adaptation value,
report the per-seed values plus mean, median, standard deviation, 10th percentile,
worst seed, and a 95% confidence interval. Report solvency and head-to-head win rates
with confidence intervals, and recovery-time median plus censored count.

Confidence intervals resample whole seed blocks so matched scenarios, seats, and
opponents remain correlated. Scenario families receive equal aggregate weight rather
than more weight because one family happened to contain more runs. Insolvent,
timed-out, errored, and rejected-action episodes remain in denominators under a
predeclared failure rule; they cannot be discarded as outliers.

Before held-out evaluation, the release manifest sets a solvency qualification floor
and any failure penalty. A candidate below that floor is reported as unqualified even
if its mean profit is high. Among qualified candidates, the primary economic comparison
is the scenario-balanced mean paired profit delta. Absolute mean and median profit,
tail result, adaptation value, win rate, and every family result remain adjacent on
the scorecard. No single leaderboard number may hide those components.

Claims must match the evidence. Positive mean profit on one seed supports no
adaptation claim. A profitable-response claim requires positive paired adaptation
value across the relevant held-out family, a confidence interval reported without
cherry-picking, acceptable solvency and tail outcomes, and event-ledger evidence that
the response followed information actually visible to the agent.

## Review gates

The expansion does not enter scored restricted evaluation until all applicable gates
pass:

1. **Contract freeze:** engine and API owners version exact schemas, units, action
   timing, tick phases, accounting recognition, insolvency, event visibility, PRNG
   mapping, scenario manifests, and migration behavior.
2. **Accounting and invariants:** property and scenario tests reconcile cash,
   inventory, obligations, revenue, expenses, and terminal outcomes; actions cannot
   create cash, erase liabilities, or spend unavailable funds outside declared credit.
3. **Determinism and replay:** repeated runs and exported replays match state, series,
   actor ordering, environment ordering, and terminal digest. Changes to unrelated
   random domains do not shift frozen exogenous streams.
4. **Trace completeness:** every state-changing cause has a structured permanent
   record; actor logs, the environment ledger, and the recent UI projection remain
   distinct; sequence gaps, updates, and deletes fail validation.
5. **Decision validity:** observations expose actionable constraints and legitimate
   shock signals without future leakage. Frozen, heuristic, and deliberately adaptive
   controls produce distinguishable outcomes for the intended reasons.
6. **Evaluation validity:** seed count, held-out split, scenario weights, asymmetric
   seat rotations, budgets, solvency floor, failure rule, and confidence-interval
   method are frozen before candidate scoring.
7. **Restricted-release safety:** authentication, limits, cost bounds, export access,
   and abuse review preserve the existing restriction envelope. Public issuance and
   deployment remain separate approvals.
8. **Claim review:** documentation and score reports continue to call this a synthetic
   seeded benchmark. Any claim of empirical or production realism requires separate
   calibration, external validation, and explicit review.

Passing these gates establishes a reproducible decision benchmark for adaptive
restaurant operation. It does not establish that the simulator predicts a real
restaurant.
