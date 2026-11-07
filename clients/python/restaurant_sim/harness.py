"""Strict, feedback-oriented decision harness for model-backed agents."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections.abc import Callable, Mapping, Sequence
from copy import deepcopy
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any, Literal


DEFAULT_CASH_RESERVE_CENTS = 0
DEFAULT_MAX_ACTIONS = 5
SUPPORTED_CANDIDATE_COUNTS = (3, 5, 10)
RESOURCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

SYSTEM_PROMPT = """You operate one restaurant in a deterministic management benchmark.
Your objective is maximum cumulative operating profit at the horizon without bankruptcy.
One tick is one local calendar day. Return one JSON object only:
{"actions":[{"type":"...","params":{...}}],"note":"brief plan and arithmetic"}
Use at most 5 actions. Put every action parameter inside params. Do not emit markdown.
Actions are processed in array order. An empty actions array is a valid decision.

Exact action contract:
- set_menu_price: {dishId:"house", priceCents: integer 500..5000}
- purchase_inventory: {ingredientId:"staples", quantity: integer 1..500}
- set_staff: {role:"chef"|"server", count: integer 0..10}
- set_marketing: {budgetCents: integer 0..5000}
- invest: {kind:"capacity"|"quality"}
- borrow: {amountCents: integer 5000..100000}
- repay_loan: {amountCents: integer 1..100000}
- schedule_maintenance: {assetId:"kitchen"|"refrigeration"}
- repair_equipment: {assetId:"kitchen"|"refrigeration"}
- train_staff: {role:"chef"|"server", budgetCents: integer 500..5000}
- expedite_delivery: {orderId: an existing pending order ID}

Operational rules and costs:
- Inventory orders are prepaid at quantity * current ingredientUnitCostCents and normally
  arrive after 2 ticks. current inventory + all pending units + the new quantity must not
  exceed storageCapacityUnits. A newly generated order ID cannot be expedited in the same
  decision because its ID is not known before the purchase is accepted.
- Capacity investment from current level L costs 22000*(L+1) cents. Each level adds 6
  dining capacity, 40 storage units, 550 bps coordination burden, 350 fixed cost per tick,
  150 utilities per tick, 1800 weekly rent, and additional wear. Quality investment costs
  18000*(L+1) and adds 100 fixed cost per tick. Both have maximum level 4.
- Chef wages are 420 cents and server wages 320 cents per active worker per tick. Staffing
  reductions remove one worker per tick. Increases recruit at most two workers at a time,
  followed by two ticks of hiring and onboarding.
- Preventive maintenance is only for operational equipment. It costs 1800 kitchen or 1500
  refrigeration plus 300 per capacity level and causes 1 tick downtime. repair_equipment
  is valid only when status is broken; expedited repair costs 2800 kitchen or 2200
  refrigeration plus 400 per capacity level.
- Training requires current staff and no active program for that role, costs the stated
  budget immediately, and takes 2 ticks.
- Expediting a pending order costs 1000 + 20*quantity. Borrowing is limited by
  creditLimitCents. Interest is 15 bps per tick.
- Cash below zero after settlement causes irreversible bankruptcy. Tick settlement includes
  wages, marketing, fixed cost, weekly rent, utilities, interest, and emergency repairs.

Feedback contract:
- Preflight feedback reports schema and immediate execution feasibility only. It does not
  recommend a strategy or estimate an action's future value.
- Outcome feedback reports observed deltas, action receipts, events, and pending commitments.
  It does not claim that one prior action caused an observed result.
- Preserve enough completion budget to emit the final JSON even when reasoning is enabled.
"""

PLAN_REVIEW_SYSTEM_PROMPT = SYSTEM_PROMPT + """

Plan review protocol:
- You receive the current observation, the original decision, its deterministic preflight,
  and a semantic verifier result. Reassess the original decision against that evidence.
- The verifier does not know hidden future events and cannot calculate costs or feasibility.
  Treat its probability as a review signal, not as an instruction or a forecast.
- If revisionRequired is false, you may retain or revise the original actions. If it is
  true, correct every material state misread you can identify before returning the plan.
- Return one complete decision JSON object in the normal action contract. Do not describe
  the review outside the JSON note.
"""


def candidate_system_prompt(candidate_count: int = 3) -> str:
    if candidate_count not in SUPPORTED_CANDIDATE_COUNTS:
        raise ValueError(
            "candidate_count must be one of "
            + ", ".join(str(count) for count in SUPPORTED_CANDIDATE_COUNTS)
        )
    return SYSTEM_PROMPT.replace(
        """One tick is one local calendar day. Return one JSON object only:
{"actions":[{"type":"...","params":{...}}],"note":"brief plan and arithmetic"}
Use at most 5 actions. Put every action parameter inside params. Do not emit markdown.
Actions are processed in array order. An empty actions array is a valid decision.
""",
        f"""One tick is one local calendar day. Return one JSON object only:
{{"candidates":[{{"actions":[{{"type":"...","params":{{...}}}}],"note":"brief plan and arithmetic"}}]}}
Return exactly {candidate_count} distinct, non-empty candidate plans. Each candidate may use at most 5
actions. Put every action parameter inside params. Do not emit markdown. Actions within a
candidate are processed in array order. Make the candidates materially different responses
to the current state; do not rank them or choose a winner. A separate decision model compares
the candidates, and the harness always adds a no-action candidate before selection.
""",
    )


CANDIDATE_SYSTEM_PROMPT = candidate_system_prompt()


Stage = Literal["parse", "envelope", "schema", "feasibility", "policy"]


@dataclass(frozen=True)
class ValidationIssue:
    stage: Stage
    code: str
    message: str
    blocking: bool
    action_index: int | None = None
    action_type: str | None = None


@dataclass(frozen=True)
class ActionPreview:
    action_index: int
    action_type: str
    estimated_cost_cents: int
    cash_before_cents: int
    cash_after_cents: int
    details: dict[str, Any]


@dataclass(frozen=True)
class DecisionReview:
    actions: tuple[dict[str, Any], ...]
    previews: tuple[ActionPreview, ...]
    issues: tuple[ValidationIssue, ...]
    projected: dict[str, Any]

    @property
    def submittable(self) -> bool:
        return not any(issue.blocking for issue in self.issues)

    def feedback(self) -> dict[str, Any]:
        return {
            "submittable": self.submittable,
            "validatedActions": list(self.actions) if self.submittable else [],
            "issues": [asdict(issue) for issue in self.issues],
            "previews": [asdict(preview) for preview in self.previews],
            "projected": self.projected,
        }


@dataclass(frozen=True)
class DecisionAttempt:
    raw_response: Any
    content: str
    reasoning: str | None
    finish_reason: str | None
    usage: Any
    parsed: Any
    review: DecisionReview


@dataclass(frozen=True)
class HarnessDecision:
    actions: tuple[dict[str, Any], ...]
    attempts: tuple[DecisionAttempt, ...]
    correction_used: bool
    metrics: dict[str, Any]


@dataclass(frozen=True)
class CandidatePlan:
    candidate_id: str
    actions: tuple[dict[str, Any], ...]
    note: str
    review: DecisionReview


@dataclass(frozen=True)
class CandidateAttempt:
    raw_response: Any
    content: str
    reasoning: str | None
    finish_reason: str | None
    usage: Any
    parsed: Any
    candidates: tuple[CandidatePlan, ...]
    issues: tuple[ValidationIssue, ...]
    candidate_count: int

    @property
    def submittable(self) -> bool:
        return (
            len(self.candidates) == self.candidate_count
            and not any(issue.blocking for issue in self.issues)
            and all(candidate.review.submittable for candidate in self.candidates)
        )

    def feedback(self) -> dict[str, Any]:
        return {
            "submittable": self.submittable,
            "issues": [asdict(issue) for issue in self.issues],
            "candidates": [
                {
                    "candidateId": candidate.candidate_id,
                    "review": candidate.review.feedback(),
                }
                for candidate in self.candidates
            ],
        }


@dataclass(frozen=True)
class CandidateDecision:
    candidates: tuple[CandidatePlan, ...]
    attempts: tuple[CandidateAttempt, ...]
    correction_used: bool
    metrics: dict[str, Any]


InferenceCallable = Callable[[list[dict[str, str]]], Any]


def system_prompt_sha256() -> str:
    return hashlib.sha256(SYSTEM_PROMPT.encode("utf-8")).hexdigest()


def plan_review_system_prompt_sha256() -> str:
    return hashlib.sha256(PLAN_REVIEW_SYSTEM_PROMPT.encode("utf-8")).hexdigest()


def candidate_system_prompt_sha256(candidate_count: int = 3) -> str:
    return hashlib.sha256(
        candidate_system_prompt(candidate_count).encode("utf-8")
    ).hexdigest()


def review_decision(
    value: Any,
    observation: Mapping[str, Any],
    *,
    max_actions: int = DEFAULT_MAX_ACTIONS,
    cash_reserve_cents: int = DEFAULT_CASH_RESERVE_CENTS,
) -> DecisionReview:
    """Validate one parsed response and preview actions in submission order."""

    if max_actions < 1:
        raise ValueError("max_actions must be greater than zero")
    if cash_reserve_cents < 0:
        raise ValueError("cash_reserve_cents must not be negative")

    issues: list[ValidationIssue] = []
    if not isinstance(value, Mapping):
        issues.append(
            ValidationIssue(
                "envelope",
                "decision_must_be_object",
                "Decision must be a JSON object",
                True,
            )
        )
        return _empty_review(observation, issues)

    unexpected_envelope = set(value) - {"actions", "note"}
    if unexpected_envelope:
        issues.append(
            ValidationIssue(
                "envelope",
                "unexpected_decision_fields",
                "Unexpected decision field(s): "
                + ", ".join(sorted(str(key) for key in unexpected_envelope)),
                True,
            )
        )
    if "note" in value and not isinstance(value["note"], str):
        issues.append(
            ValidationIssue(
                "envelope",
                "note_must_be_string",
                "note must be a string when present",
                True,
            )
        )
    raw_actions = value.get("actions")
    if not isinstance(raw_actions, list):
        issues.append(
            ValidationIssue(
                "envelope",
                "actions_must_be_array",
                "actions must be an array",
                True,
            )
        )
        return _empty_review(observation, issues)
    if len(raw_actions) > max_actions:
        issues.append(
            ValidationIssue(
                "envelope",
                "too_many_actions",
                f"actions contains {len(raw_actions)} entries; maximum is {max_actions}",
                True,
            )
        )

    state = _PreviewState.from_observation(observation)
    valid_actions: list[dict[str, Any]] = []
    previews: list[ActionPreview] = []
    for index, raw_action in enumerate(raw_actions):
        action, action_issues = _validate_action(raw_action, index)
        issues.extend(action_issues)
        if action is None:
            continue
        preview, action_issues = state.preview(
            action,
            index=index,
            cash_reserve_cents=cash_reserve_cents,
        )
        issues.extend(action_issues)
        if any(issue.blocking for issue in action_issues):
            continue
        valid_actions.append(action)
        previews.append(preview)

    projected = state.as_dict()
    projected["cashReserveCents"] = cash_reserve_cents
    projected["immediateCostCents"] = sum(
        preview.estimated_cost_cents for preview in previews
    )
    projected["blockingIssueCount"] = sum(issue.blocking for issue in issues)
    projected["policyWarningCount"] = sum(
        issue.stage == "policy" and not issue.blocking for issue in issues
    )
    return DecisionReview(
        tuple(valid_actions), tuple(previews), tuple(issues), projected
    )


class DecisionHarness:
    """Run an inference call with one structured correction opportunity."""

    def __init__(
        self,
        *,
        max_actions: int = DEFAULT_MAX_ACTIONS,
        cash_reserve_cents: int = DEFAULT_CASH_RESERVE_CENTS,
        correction_attempts: int = 1,
        retry_on_policy_warnings: bool = False,
    ) -> None:
        if max_actions < 1:
            raise ValueError("max_actions must be greater than zero")
        if cash_reserve_cents < 0:
            raise ValueError("cash_reserve_cents must not be negative")
        if correction_attempts not in {0, 1}:
            raise ValueError("correction_attempts must be 0 or 1")
        self.max_actions = max_actions
        self.cash_reserve_cents = cash_reserve_cents
        self.correction_attempts = correction_attempts
        self.retry_on_policy_warnings = retry_on_policy_warnings

    def decide(
        self,
        observation: Mapping[str, Any],
        infer: InferenceCallable,
        *,
        outcome_feedback: Mapping[str, Any] | None = None,
    ) -> HarnessDecision:
        user_payload: dict[str, Any] = {"observation": observation}
        if outcome_feedback is not None:
            user_payload["outcomeFeedback"] = outcome_feedback
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(user_payload, separators=(",", ":")),
            },
        ]
        return self._run(messages, observation, infer)

    def review(
        self,
        observation: Mapping[str, Any],
        infer: InferenceCallable,
        *,
        original_decision: HarnessDecision,
        verification: Mapping[str, Any] | None,
        revision_required: bool,
        outcome_feedback: Mapping[str, Any] | None = None,
    ) -> HarnessDecision:
        """Ask the planner to reconsider one valid plan against verifier evidence."""

        if not original_decision.attempts:
            raise ValueError("original_decision must contain at least one attempt")
        original_attempt = original_decision.attempts[-1]
        if not original_attempt.review.submittable:
            raise ValueError("original_decision must be submittable")
        parsed = original_attempt.parsed
        note = parsed.get("note", "") if isinstance(parsed, Mapping) else ""
        original_payload = {
            "actions": list(original_attempt.review.actions),
            "note": note if isinstance(note, str) else "",
        }
        user_payload: dict[str, Any] = {
            "observation": observation,
            "reviewRequest": {
                "instruction": (
                    "Return a complete reviewed decision. Correct material factual "
                    "misreads before deciding whether each action should execute now."
                ),
                "revisionRequired": revision_required,
                "originalDecision": original_payload,
                "deterministicReview": original_attempt.review.feedback(),
                "verification": dict(verification) if verification is not None else None,
            },
        }
        if outcome_feedback is not None:
            user_payload["outcomeFeedback"] = outcome_feedback
        messages = [
            {"role": "system", "content": PLAN_REVIEW_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": json.dumps(user_payload, separators=(",", ":")),
            },
        ]
        return self._run(messages, observation, infer)

    def _run(
        self,
        messages: list[dict[str, str]],
        observation: Mapping[str, Any],
        infer: InferenceCallable,
    ) -> HarnessDecision:
        attempts: list[DecisionAttempt] = []
        correction_used = False
        for attempt_index in range(self.correction_attempts + 1):
            attempt = self._attempt(infer(messages), observation)
            attempts.append(attempt)
            has_policy_warnings = any(
                issue.stage == "policy" and not issue.blocking
                for issue in attempt.review.issues
            )
            needs_correction = not attempt.review.submittable or (
                self.retry_on_policy_warnings and has_policy_warnings
            )
            if not needs_correction or attempt_index == self.correction_attempts:
                break
            correction_used = True
            if attempt.content:
                messages.append({"role": "assistant", "content": attempt.content})
            messages.append(
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "correctionRequired": True,
                            "instruction": (
                                "Return a complete corrected decision JSON object only. "
                                "Do not repeat invalid or infeasible actions."
                            ),
                            "validationFeedback": attempt.review.feedback(),
                        },
                        separators=(",", ":"),
                    ),
                }
            )

        final = attempts[-1]
        actions = final.review.actions if final.review.submittable else ()
        metrics = _attempt_metrics(attempts, correction_used)
        return HarnessDecision(actions, tuple(attempts), correction_used, metrics)

    def _attempt(
        self, raw_response: Any, observation: Mapping[str, Any]
    ) -> DecisionAttempt:
        content, reasoning, finish_reason, usage = _provider_fields(raw_response)
        parsed: Any = None
        parse_issues: list[ValidationIssue] = []
        if not content.strip():
            parse_issues.append(
                ValidationIssue(
                    "parse",
                    "empty_model_content",
                    "Model response contained no decision content",
                    True,
                )
            )
        else:
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError as error:
                parse_issues.append(
                    ValidationIssue(
                        "parse",
                        "invalid_model_json",
                        f"Model response is not valid JSON: {error.msg}",
                        True,
                    )
                )
        if parse_issues:
            review = _empty_review(observation, parse_issues)
        else:
            review = review_decision(
                parsed,
                observation,
                max_actions=self.max_actions,
                cash_reserve_cents=self.cash_reserve_cents,
            )
        return DecisionAttempt(
            raw_response,
            content,
            reasoning,
            finish_reason,
            usage,
            parsed,
            review,
        )


class CandidateDecisionHarness:
    """Ask a planner for feasible alternatives without choosing among them."""

    def __init__(
        self,
        *,
        candidate_count: int = 3,
        max_actions: int = DEFAULT_MAX_ACTIONS,
        cash_reserve_cents: int = DEFAULT_CASH_RESERVE_CENTS,
        correction_attempts: int = 1,
    ) -> None:
        if candidate_count not in SUPPORTED_CANDIDATE_COUNTS:
            raise ValueError(
                "candidate_count must be one of "
                + ", ".join(str(count) for count in SUPPORTED_CANDIDATE_COUNTS)
            )
        if max_actions < 1:
            raise ValueError("max_actions must be greater than zero")
        if cash_reserve_cents < 0:
            raise ValueError("cash_reserve_cents must not be negative")
        if correction_attempts not in {0, 1}:
            raise ValueError("correction_attempts must be 0 or 1")
        self.candidate_count = candidate_count
        self.max_actions = max_actions
        self.cash_reserve_cents = cash_reserve_cents
        self.correction_attempts = correction_attempts
        self.system_prompt = candidate_system_prompt(candidate_count)

    def decide(
        self,
        observation: Mapping[str, Any],
        infer: InferenceCallable,
        *,
        outcome_feedback: Mapping[str, Any] | None = None,
    ) -> CandidateDecision:
        user_payload: dict[str, Any] = {"observation": observation}
        if outcome_feedback is not None:
            user_payload["outcomeFeedback"] = outcome_feedback
        messages = [
            {"role": "system", "content": self.system_prompt},
            {
                "role": "user",
                "content": json.dumps(user_payload, separators=(",", ":")),
            },
        ]
        attempts: list[CandidateAttempt] = []
        correction_used = False
        for attempt_index in range(self.correction_attempts + 1):
            attempt = self._attempt(infer(messages), observation)
            attempts.append(attempt)
            if attempt.submittable or attempt_index == self.correction_attempts:
                break
            correction_used = True
            if attempt.content:
                messages.append({"role": "assistant", "content": attempt.content})
            messages.append(
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "correctionRequired": True,
                            "instruction": (
                                "Return a complete corrected candidate JSON object only. "
                                f"Return exactly {self.candidate_count} distinct, non-empty "
                                "candidates and do not repeat invalid or infeasible actions."
                            ),
                            "validationFeedback": attempt.feedback(),
                        },
                        separators=(",", ":"),
                    ),
                }
            )

        final = attempts[-1]
        candidates = final.candidates if final.submittable else ()
        return CandidateDecision(
            candidates,
            tuple(attempts),
            correction_used,
            _candidate_attempt_metrics(attempts, correction_used),
        )

    def _attempt(
        self, raw_response: Any, observation: Mapping[str, Any]
    ) -> CandidateAttempt:
        content, reasoning, finish_reason, usage = _provider_fields(raw_response)
        parsed: Any = None
        issues: list[ValidationIssue] = []
        candidates: list[CandidatePlan] = []
        if not content.strip():
            issues.append(
                ValidationIssue(
                    "parse",
                    "empty_model_content",
                    "Model response contained no candidate content",
                    True,
                )
            )
        else:
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError as error:
                issues.append(
                    ValidationIssue(
                        "parse",
                        "invalid_model_json",
                        f"Model response is not valid JSON: {error.msg}",
                        True,
                    )
                )
        if not issues:
            candidates, issues = self._review_candidates(parsed, observation)
        return CandidateAttempt(
            raw_response,
            content,
            reasoning,
            finish_reason,
            usage,
            parsed,
            tuple(candidates),
            tuple(issues),
            self.candidate_count,
        )

    def _review_candidates(
        self, value: Any, observation: Mapping[str, Any]
    ) -> tuple[list[CandidatePlan], list[ValidationIssue]]:
        issues: list[ValidationIssue] = []
        if not isinstance(value, Mapping):
            return [], [
                ValidationIssue(
                    "envelope",
                    "candidate_set_must_be_object",
                    "Candidate set must be a JSON object",
                    True,
                )
            ]
        unexpected = set(value) - {"candidates"}
        if unexpected:
            issues.append(
                ValidationIssue(
                    "envelope",
                    "unexpected_candidate_set_fields",
                    "Unexpected candidate-set field(s): "
                    + ", ".join(sorted(str(key) for key in unexpected)),
                    True,
                )
            )
        raw_candidates = value.get("candidates")
        if not isinstance(raw_candidates, list):
            issues.append(
                ValidationIssue(
                    "envelope",
                    "candidates_must_be_array",
                    "candidates must be an array",
                    True,
                )
            )
            return [], issues
        if len(raw_candidates) != self.candidate_count:
            issues.append(
                ValidationIssue(
                    "envelope",
                    "wrong_candidate_count",
                    f"candidates must contain exactly {self.candidate_count} plans",
                    True,
                )
            )

        candidates: list[CandidatePlan] = []
        fingerprints: set[str] = set()
        for index, raw_candidate in enumerate(raw_candidates):
            candidate_id = f"plan_{index}"
            if not isinstance(raw_candidate, Mapping):
                issues.append(
                    ValidationIssue(
                        "envelope",
                        "candidate_must_be_object",
                        f"{candidate_id} must be an object",
                        True,
                    )
                )
                continue
            unexpected_candidate = set(raw_candidate) - {"actions", "note"}
            if unexpected_candidate:
                issues.append(
                    ValidationIssue(
                        "envelope",
                        "unexpected_candidate_fields",
                        f"{candidate_id} has unexpected field(s): "
                        + ", ".join(
                            sorted(str(key) for key in unexpected_candidate)
                        ),
                        True,
                    )
                )
            note = raw_candidate.get("note", "")
            if not isinstance(note, str):
                issues.append(
                    ValidationIssue(
                        "envelope",
                        "candidate_note_must_be_string",
                        f"{candidate_id}.note must be a string",
                        True,
                    )
                )
                note = ""
            review = review_decision(
                {"actions": raw_candidate.get("actions"), "note": note},
                observation,
                max_actions=self.max_actions,
                cash_reserve_cents=self.cash_reserve_cents,
            )
            if not review.actions and review.submittable:
                issues.append(
                    ValidationIssue(
                        "envelope",
                        "candidate_must_not_be_empty",
                        f"{candidate_id} must contain at least one action",
                        True,
                    )
                )
            fingerprint = json.dumps(
                list(review.actions), separators=(",", ":"), sort_keys=True
            )
            if review.submittable and review.actions:
                if fingerprint in fingerprints:
                    issues.append(
                        ValidationIssue(
                            "envelope",
                            "duplicate_candidate",
                            f"{candidate_id} duplicates an earlier action plan",
                            True,
                        )
                    )
                fingerprints.add(fingerprint)
            candidates.append(
                CandidatePlan(candidate_id, review.actions, note, review)
            )
        return candidates, issues


def build_outcome_feedback(
    previous_observation: Mapping[str, Any],
    current_observation: Mapping[str, Any],
    submitted_results: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Describe receipts and observed changes without prescribing a next action."""

    previous = _restaurant(previous_observation)
    current = _restaurant(current_observation)
    fields = (
        "cashCents",
        "debtCents",
        "cumulativeOperatingProfitCents",
        "totalRevenueCents",
        "totalCostsCents",
        "totalUnitsSold",
        "totalWasteUnits",
        "inventoryUnits",
        "reputationBps",
    )
    deltas: dict[str, int] = {}
    for field in fields:
        before = _integer(previous.get(field))
        after = _integer(current.get(field))
        if before is not None and after is not None:
            deltas[field] = after - before

    last_tick = current.get("lastTick")
    report = dict(last_tick) if isinstance(last_tick, Mapping) else None
    alerts: list[str] = []
    if report is not None:
        if _positive_integer(report.get("stockoutUnits")):
            alerts.append("stockout")
        if _positive_integer(report.get("lostToCapacityUnits")):
            alerts.append("capacity_constraint")
        if (_integer(report.get("operatingProfitCents")) or 0) < 0:
            alerts.append("negative_operating_profit")
        if report.get("kitchenDowntime") is True:
            alerts.append("kitchen_downtime")
        if report.get("refrigerationDowntime") is True:
            alerts.append("refrigeration_downtime")
    if current.get("bankrupt") is True:
        alerts.append("bankrupt")

    from_tick = _integer(previous_observation.get("tick"))
    to_tick = _integer(current_observation.get("tick"))
    elapsed_ticks = (
        to_tick - from_tick
        if from_tick is not None and to_tick is not None
        else None
    )
    observed_events: list[dict[str, Any]] = []
    recent_events = current_observation.get("recentEvents")
    if isinstance(recent_events, list):
        for event in recent_events:
            if not isinstance(event, Mapping):
                continue
            event_tick = _integer(event.get("tick"))
            if from_tick is not None and event_tick is not None:
                if event_tick < from_tick:
                    continue
                if to_tick is not None and event_tick >= to_tick:
                    continue
            observed_events.append(dict(event))

    action_summary = _summarize_action_results(submitted_results)
    if action_summary["rejectedCount"]:
        alerts.append("action_rejected")

    limitations = [
        "Observed changes can combine prior actions, exogenous events, and operations.",
        "recentEvents is a bounded window and may omit events from a long interval.",
    ]
    if elapsed_ticks is not None and elapsed_ticks > 1:
        limitations.append(
            "latestTickReport describes only the final tick in this interval."
        )

    return {
        "interpretation": (
            "Observed after the prior decision. No next action is recommended, "
            "and these observations do not establish causation."
        ),
        "fromTick": from_tick,
        "toTick": to_tick,
        "elapsedTicks": elapsed_ticks,
        "submittedActions": [dict(result) for result in submitted_results],
        "actionResultSummary": action_summary,
        "restaurantDeltas": deltas,
        "latestTickReport": report,
        "observedEvents": observed_events,
        "pendingCommitments": _pending_commitments(current),
        "alerts": alerts,
        "limitations": limitations,
    }


@dataclass
class _PreviewState:
    cash_cents: int
    debt_cents: int
    credit_limit_cents: int
    inventory_units: int
    pending_units: int
    storage_capacity_units: int
    ingredient_unit_cost_cents: int
    capacity_level: int
    quality_level: int
    marketing_cents: int
    menu_price_cents: int
    staff_count: dict[str, int]
    staff_target: dict[str, int]
    staff_training: dict[str, int]
    equipment_status: dict[str, str]
    pending_orders: dict[str, int]
    tick: int
    max_ticks: int

    @classmethod
    def from_observation(cls, observation: Mapping[str, Any]) -> _PreviewState:
        restaurant = _restaurant(observation)
        staffing = restaurant.get("staffing")
        staffing = staffing if isinstance(staffing, Mapping) else {}
        equipment = restaurant.get("equipment")
        equipment = equipment if isinstance(equipment, Mapping) else {}
        orders = restaurant.get("purchaseOrders")
        orders = orders if isinstance(orders, list) else []
        pending_orders: dict[str, int] = {}
        for order in orders:
            if not isinstance(order, Mapping) or order.get("status") != "pending":
                continue
            order_id = order.get("id")
            quantity = _integer(order.get("quantity"))
            if isinstance(order_id, str) and quantity is not None:
                pending_orders[order_id] = quantity
        pending_units = sum(pending_orders.values())

        def role_value(role: str, field: str, fallback: int) -> int:
            value = staffing.get(role)
            if isinstance(value, Mapping):
                parsed = _integer(value.get(field))
                if parsed is not None:
                    return parsed
            return fallback

        def asset_value(asset: str, field: str, fallback: Any) -> Any:
            value = equipment.get(asset)
            return value.get(field, fallback) if isinstance(value, Mapping) else fallback

        return cls(
            cash_cents=_integer(restaurant.get("cashCents")) or 0,
            debt_cents=_integer(restaurant.get("debtCents")) or 0,
            credit_limit_cents=(
                _integer(restaurant.get("creditLimitCents")) or 500_000
            ),
            inventory_units=_integer(restaurant.get("inventoryUnits")) or 0,
            pending_units=pending_units,
            storage_capacity_units=(
                _integer(restaurant.get("storageCapacityUnits")) or 80
            ),
            ingredient_unit_cost_cents=(
                _integer(_market(observation).get("ingredientUnitCostCents")) or 0
            ),
            capacity_level=_integer(restaurant.get("capacityLevel")) or 0,
            quality_level=_integer(restaurant.get("qualityLevel")) or 0,
            marketing_cents=(
                _integer(restaurant.get("marketingSpendPerTickCents")) or 0
            ),
            menu_price_cents=_integer(restaurant.get("menuPriceCents")) or 0,
            staff_count={
                "chef": role_value(
                    "chef", "count", _integer(restaurant.get("cooks")) or 0
                ),
                "server": role_value(
                    "server", "count", _integer(restaurant.get("servers")) or 0
                ),
            },
            staff_target={
                "chef": role_value(
                    "chef", "targetCount", _integer(restaurant.get("cooks")) or 0
                ),
                "server": role_value(
                    "server", "targetCount", _integer(restaurant.get("servers")) or 0
                ),
            },
            staff_training={
                "chef": role_value("chef", "trainingTicksRemaining", 0),
                "server": role_value("server", "trainingTicksRemaining", 0),
            },
            equipment_status={
                "kitchen": str(asset_value("kitchen", "status", "operational")),
                "refrigeration": str(
                    asset_value("refrigeration", "status", "operational")
                ),
            },
            pending_orders=pending_orders,
            tick=_integer(observation.get("tick")) or 0,
            max_ticks=_integer(observation.get("maxTicks")) or 0,
        )

    def preview(
        self,
        action: dict[str, Any],
        *,
        index: int,
        cash_reserve_cents: int,
    ) -> tuple[ActionPreview, list[ValidationIssue]]:
        action_type = action["type"]
        params = action["params"]
        before = self.cash_cents
        candidate = deepcopy(self)
        cost = 0
        details: dict[str, Any] = {}
        issues: list[ValidationIssue] = []

        def issue(
            stage: Stage, code: str, message: str, *, blocking: bool = True
        ) -> None:
            issues.append(
                ValidationIssue(
                    stage, code, message, blocking, index, action_type
                )
            )

        if action_type == "set_menu_price":
            if params["priceCents"] == candidate.menu_price_cents:
                issue(
                    "policy",
                    "unchanged_menu_price",
                    "Menu price already has the requested value",
                    blocking=False,
                )
            candidate.menu_price_cents = params["priceCents"]
        elif action_type == "purchase_inventory":
            quantity = params["quantity"]
            stock_after = (
                candidate.inventory_units + candidate.pending_units + quantity
            )
            details["stockPositionBeforeUnits"] = (
                candidate.inventory_units + candidate.pending_units
            )
            details["stockPositionAfterUnits"] = stock_after
            details["storageCapacityUnits"] = candidate.storage_capacity_units
            if stock_after > candidate.storage_capacity_units:
                issue(
                    "feasibility",
                    "storage_capacity_exceeded",
                    f"Stock position {stock_after} exceeds storage capacity "
                    f"{candidate.storage_capacity_units}",
                )
            cost = quantity * candidate.ingredient_unit_cost_cents
            if not any(item.blocking for item in issues):
                candidate.pending_units += quantity
        elif action_type == "set_staff":
            role = params["role"]
            if params["count"] == candidate.staff_target[role]:
                issue(
                    "policy",
                    "unchanged_staff_target",
                    f"{role} target already equals {params['count']}",
                    blocking=False,
                )
            candidate.staff_target[role] = params["count"]
        elif action_type == "set_marketing":
            if params["budgetCents"] == candidate.marketing_cents:
                issue(
                    "policy",
                    "unchanged_marketing_budget",
                    "Marketing budget already has the requested value",
                    blocking=False,
                )
            candidate.marketing_cents = params["budgetCents"]
        elif action_type == "invest":
            kind = params["kind"]
            level = (
                candidate.capacity_level
                if kind == "capacity"
                else candidate.quality_level
            )
            if level >= 4:
                issue(
                    "feasibility",
                    "investment_at_maximum",
                    f"{kind} is already at maximum level 4",
                )
            cost = (22_000 if kind == "capacity" else 18_000) * (level + 1)
            details["levelBefore"] = level
            details["levelAfter"] = level + 1
            if not any(item.blocking for item in issues):
                if kind == "capacity":
                    candidate.capacity_level += 1
                    candidate.storage_capacity_units = (
                        80 + candidate.capacity_level * 40
                    )
                    details["addedFixedCostPerTickCents"] = 350
                    details["addedUtilityCostPerTickCents"] = 150
                    details["addedWeeklyRentCents"] = 1_800
                    details["addedCoordinationBurdenBps"] = 550
                else:
                    candidate.quality_level += 1
                    details["addedFixedCostPerTickCents"] = 100
        elif action_type == "borrow":
            amount = params["amountCents"]
            if candidate.debt_cents + amount > candidate.credit_limit_cents:
                issue(
                    "feasibility",
                    "credit_limit_exceeded",
                    "Borrowing would exceed creditLimitCents",
                )
            if not any(item.blocking for item in issues):
                candidate.cash_cents += amount
                candidate.debt_cents += amount
        elif action_type == "repay_loan":
            amount = params["amountCents"]
            if amount > candidate.debt_cents:
                issue(
                    "feasibility",
                    "repayment_exceeds_debt",
                    "Repayment exceeds outstanding debt",
                )
            cost = amount
            if not any(item.blocking for item in issues):
                candidate.debt_cents -= amount
        elif action_type == "schedule_maintenance":
            asset = params["assetId"]
            if candidate.equipment_status[asset] != "operational":
                issue(
                    "feasibility",
                    "maintenance_requires_operational_equipment",
                    f"{asset} status is "
                    f"{candidate.equipment_status[asset]}, not operational",
                )
            cost = (1_800 if asset == "kitchen" else 1_500) + (
                candidate.capacity_level * 300
            )
            if not any(item.blocking for item in issues):
                candidate.equipment_status[asset] = "maintenance"
        elif action_type == "repair_equipment":
            asset = params["assetId"]
            if candidate.equipment_status[asset] != "broken":
                issue(
                    "feasibility",
                    "repair_requires_broken_equipment",
                    f"{asset} status is {candidate.equipment_status[asset]}, not broken",
                )
            cost = (2_800 if asset == "kitchen" else 2_200) + (
                candidate.capacity_level * 400
            )
        elif action_type == "train_staff":
            role = params["role"]
            if candidate.staff_count[role] == 0:
                issue(
                    "feasibility",
                    "training_requires_current_staff",
                    f"Cannot train {role} with no current staff",
                )
            if candidate.staff_training[role] > 0:
                issue(
                    "feasibility",
                    "training_already_active",
                    f"A {role} training program is already active",
                )
            cost = params["budgetCents"]
            if not any(item.blocking for item in issues):
                candidate.staff_training[role] = 2
        elif action_type == "expedite_delivery":
            order_id = params["orderId"]
            if order_id not in candidate.pending_orders:
                issue(
                    "feasibility",
                    "pending_order_not_found",
                    f"No pending order has ID {order_id}",
                )
            else:
                cost = 1_000 + candidate.pending_orders[order_id] * 20

        if cost > candidate.cash_cents:
            issue(
                "feasibility",
                "insufficient_cash",
                f"Action costs {cost} cents but projected cash is "
                f"{candidate.cash_cents}",
            )
        if not any(item.blocking for item in issues):
            candidate.cash_cents -= cost
            if cost > 0 and candidate.cash_cents < cash_reserve_cents:
                issue(
                    "policy",
                    "cash_reserve_breach",
                    f"Projected cash {candidate.cash_cents} is below configured reserve "
                    f"{cash_reserve_cents}",
                    blocking=False,
                )
            for state_field in fields(self):
                setattr(self, state_field.name, getattr(candidate, state_field.name))

        if action_type in {"borrow", "repay_loan"}:
            details["debtAfterCents"] = self.debt_cents

        return (
            ActionPreview(index, action_type, cost, before, self.cash_cents, details),
            issues,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "cashCents": self.cash_cents,
            "debtCents": self.debt_cents,
            "inventoryUnits": self.inventory_units,
            "pendingUnits": self.pending_units,
            "stockPositionUnits": self.inventory_units + self.pending_units,
            "storageCapacityUnits": self.storage_capacity_units,
            "capacityLevel": self.capacity_level,
            "qualityLevel": self.quality_level,
            "staffTargets": dict(self.staff_target),
            "equipmentStatus": dict(self.equipment_status),
            "remainingTicks": max(0, self.max_ticks - self.tick),
        }


_ACTION_FIELDS: dict[str, dict[str, tuple[str, Any]]] = {
    "set_menu_price": {
        "dishId": ("resource", None),
        "priceCents": ("integer", (500, 5_000)),
    },
    "purchase_inventory": {
        "ingredientId": ("resource", None),
        "quantity": ("integer", (1, 500)),
    },
    "set_staff": {
        "role": ("enum", ("chef", "server")),
        "count": ("integer", (0, 10)),
    },
    "set_marketing": {"budgetCents": ("integer", (0, 5_000))},
    "invest": {"kind": ("enum", ("capacity", "quality"))},
    "borrow": {"amountCents": ("integer", (5_000, 100_000))},
    "repay_loan": {"amountCents": ("integer", (1, 100_000))},
    "schedule_maintenance": {
        "assetId": ("enum", ("kitchen", "refrigeration"))
    },
    "repair_equipment": {
        "assetId": ("enum", ("kitchen", "refrigeration"))
    },
    "train_staff": {
        "role": ("enum", ("chef", "server")),
        "budgetCents": ("integer", (500, 5_000)),
    },
    "expedite_delivery": {"orderId": ("resource", None)},
}


def _validate_action(
    value: Any, index: int
) -> tuple[dict[str, Any] | None, list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    if not isinstance(value, Mapping):
        return None, [
            ValidationIssue(
                "schema",
                "action_must_be_object",
                "Action must be an object",
                True,
                index,
            )
        ]
    action_type = value.get("type")
    if not isinstance(action_type, str) or action_type not in _ACTION_FIELDS:
        return None, [
            ValidationIssue(
                "schema",
                "unknown_action_type",
                f"Unknown action type: {action_type!r}",
                True,
                index,
                action_type if isinstance(action_type, str) else None,
            )
        ]
    unexpected = set(value) - {"type", "params"}
    if unexpected:
        issues.append(
            ValidationIssue(
                "schema",
                "parameters_outside_params",
                "Action fields must be inside params; unexpected field(s): "
                + ", ".join(sorted(str(key) for key in unexpected)),
                True,
                index,
                action_type,
            )
        )
    params = value.get("params")
    if not isinstance(params, Mapping):
        issues.append(
            ValidationIssue(
                "schema",
                "params_must_be_object",
                "params must be an object",
                True,
                index,
                action_type,
            )
        )
        return None, issues
    expected = _ACTION_FIELDS[action_type]
    missing = set(expected) - set(params)
    extra = set(params) - set(expected)
    if missing:
        issues.append(
            ValidationIssue(
                "schema",
                "missing_action_parameters",
                "Missing parameter(s): "
                + ", ".join(sorted(str(key) for key in missing)),
                True,
                index,
                action_type,
            )
        )
    if extra:
        issues.append(
            ValidationIssue(
                "schema",
                "unexpected_action_parameters",
                "Unexpected parameter(s): "
                + ", ".join(sorted(str(key) for key in extra)),
                True,
                index,
                action_type,
            )
        )
    for name, (kind, constraint) in expected.items():
        if name not in params:
            continue
        item = params[name]
        valid = True
        detail = ""
        if kind == "integer":
            minimum, maximum = constraint
            valid = _integer(item) is not None and minimum <= item <= maximum
            detail = f"an integer from {minimum} to {maximum}"
        elif kind == "resource":
            valid = isinstance(item, str) and RESOURCE_ID.fullmatch(item) is not None
            detail = "a 1-64 character identifier"
        elif kind == "enum":
            valid = item in constraint
            detail = "one of " + ", ".join(constraint)
        if not valid:
            issues.append(
                ValidationIssue(
                    "schema",
                    "invalid_action_parameter",
                    f"{name} must be {detail}",
                    True,
                    index,
                    action_type,
                )
            )
    if issues:
        return None, issues
    return {"type": action_type, "params": dict(params)}, []


def _provider_fields(raw: Any) -> tuple[str, str | None, str | None, Any]:
    if isinstance(raw, str):
        return raw, None, None, None
    if not isinstance(raw, Mapping):
        return "", None, None, None
    choices = raw.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices else {}
    choice = choice if isinstance(choice, Mapping) else {}
    message = choice.get("message")
    message = message if isinstance(message, Mapping) else {}
    content = message.get("content")
    reasoning = message.get("reasoning_content", message.get("reasoning"))
    return (
        content if isinstance(content, str) else "",
        reasoning if isinstance(reasoning, str) else None,
        choice.get("finish_reason")
        if isinstance(choice.get("finish_reason"), str)
        else None,
        raw.get("usage"),
    )


def _summarize_action_results(
    submitted_results: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    accepted = 0
    rejected = 0
    unknown = 0
    accepted_cost_cents = 0
    rejections: list[dict[str, Any]] = []
    for index, submitted in enumerate(submitted_results):
        receipt: Mapping[str, Any] = submitted
        outer_result = submitted.get("result")
        if isinstance(outer_result, Mapping):
            receipt = outer_result
            inner_result = outer_result.get("result")
            if isinstance(inner_result, Mapping):
                receipt = inner_result
        if receipt.get("accepted") is True:
            accepted += 1
            accepted_cost_cents += _integer(receipt.get("costCents")) or 0
        elif receipt.get("accepted") is False:
            rejected += 1
            rejection: dict[str, Any] = {"actionIndex": index}
            message = receipt.get("message")
            if isinstance(message, str):
                rejection["message"] = message
            rejections.append(rejection)
        else:
            unknown += 1
    return {
        "submittedCount": len(submitted_results),
        "acceptedCount": accepted,
        "rejectedCount": rejected,
        "unknownCount": unknown,
        "acceptedImmediateCostCents": accepted_cost_cents,
        "rejections": rejections,
    }


def _pending_commitments(restaurant: Mapping[str, Any]) -> dict[str, Any]:
    pending_orders: list[dict[str, Any]] = []
    orders = restaurant.get("purchaseOrders")
    if isinstance(orders, list):
        order_fields = (
            "id",
            "ingredientId",
            "quantity",
            "unitCostCents",
            "orderedTick",
            "originalDueTick",
            "dueTick",
            "disruptionCount",
            "status",
        )
        for order in orders:
            if not isinstance(order, Mapping) or order.get("status") != "pending":
                continue
            pending_orders.append(
                {name: order[name] for name in order_fields if name in order}
            )

    staffing_commitments: dict[str, dict[str, Any]] = {}
    staffing = restaurant.get("staffing")
    if isinstance(staffing, Mapping):
        for role in ("chef", "server"):
            role_state = staffing.get(role)
            if not isinstance(role_state, Mapping):
                continue
            count = _integer(role_state.get("count")) or 0
            target = _integer(role_state.get("targetCount")) or 0
            pending_hires = _integer(role_state.get("pendingHireCount")) or 0
            hiring_ticks = _integer(role_state.get("hiringTicksRemaining")) or 0
            training_ticks = (
                _integer(role_state.get("trainingTicksRemaining")) or 0
            )
            if (
                count != target
                or pending_hires > 0
                or hiring_ticks > 0
                or training_ticks > 0
            ):
                staffing_commitments[role] = {
                    "count": count,
                    "targetCount": target,
                    "pendingHireCount": pending_hires,
                    "hiringTicksRemaining": hiring_ticks,
                    "trainingTicksRemaining": training_ticks,
                    "pendingSkillGainBps": (
                        _integer(role_state.get("pendingSkillGainBps")) or 0
                    ),
                }

    equipment_commitments: dict[str, dict[str, Any]] = {}
    equipment = restaurant.get("equipment")
    if isinstance(equipment, Mapping):
        for asset in ("kitchen", "refrigeration"):
            asset_state = equipment.get(asset)
            if not isinstance(asset_state, Mapping):
                continue
            status = asset_state.get("status")
            downtime = _integer(asset_state.get("downtimeTicks")) or 0
            if status != "operational" or downtime > 0:
                equipment_commitments[asset] = {
                    "status": status,
                    "downtimeTicks": downtime,
                    "conditionBps": asset_state.get("conditionBps"),
                }

    return {
        "pendingOrders": pending_orders,
        "staffing": staffing_commitments,
        "equipment": equipment_commitments,
    }


def _attempt_metrics(
    attempts: Sequence[DecisionAttempt],
    correction_used: bool,
) -> dict[str, Any]:
    final = attempts[-1]

    def valid_through(attempt: DecisionAttempt, stages: set[Stage]) -> bool:
        return not any(
            issue.stage in stages and issue.blocking
            for issue in attempt.review.issues
        )

    return {
        "inferenceAttempts": len(attempts),
        "correctionUsed": correction_used,
        "correctionSucceeded": correction_used and final.review.submittable,
        "lengthLimitedAttempts": sum(
            attempt.finish_reason == "length" for attempt in attempts
        ),
        "parseValidAttempts": sum(
            valid_through(attempt, {"parse"}) for attempt in attempts
        ),
        "envelopeValidAttempts": sum(
            valid_through(attempt, {"parse", "envelope"})
            for attempt in attempts
        ),
        "schemaValidAttempts": sum(
            valid_through(attempt, {"parse", "envelope", "schema"})
            for attempt in attempts
        ),
        "feasibleAttempts": sum(
            valid_through(
                attempt,
                {"parse", "envelope", "schema", "feasibility"},
            )
            for attempt in attempts
        ),
        "policyWarningCount": sum(
            issue.stage == "policy" and not issue.blocking
            for attempt in attempts
            for issue in attempt.review.issues
        ),
        "decisionSubmittable": final.review.submittable,
        "submittedActionCount": (
            len(final.review.actions) if final.review.submittable else 0
        ),
    }


def _candidate_attempt_metrics(
    attempts: Sequence[CandidateAttempt],
    correction_used: bool,
) -> dict[str, Any]:
    final = attempts[-1]

    def all_issues(attempt: CandidateAttempt) -> list[ValidationIssue]:
        return list(attempt.issues) + [
            issue
            for candidate in attempt.candidates
            for issue in candidate.review.issues
        ]

    def valid_through(attempt: CandidateAttempt, stages: set[Stage]) -> bool:
        return not any(
            issue.stage in stages and issue.blocking for issue in all_issues(attempt)
        )

    return {
        "inferenceAttempts": len(attempts),
        "correctionUsed": correction_used,
        "correctionSucceeded": correction_used and final.submittable,
        "lengthLimitedAttempts": sum(
            attempt.finish_reason == "length" for attempt in attempts
        ),
        "parseValidAttempts": sum(
            valid_through(attempt, {"parse"}) for attempt in attempts
        ),
        "envelopeValidAttempts": sum(
            valid_through(attempt, {"parse", "envelope"})
            for attempt in attempts
        ),
        "schemaValidAttempts": sum(
            valid_through(attempt, {"parse", "envelope", "schema"})
            for attempt in attempts
        ),
        "feasibleAttempts": sum(
            valid_through(
                attempt,
                {"parse", "envelope", "schema", "feasibility"},
            )
            for attempt in attempts
        ),
        "policyWarningCount": sum(
            issue.stage == "policy" and not issue.blocking
            for attempt in attempts
            for issue in all_issues(attempt)
        ),
        "candidateSetSubmittable": final.submittable,
        "candidateCount": len(final.candidates) if final.submittable else 0,
        "candidateActionCount": (
            sum(len(candidate.actions) for candidate in final.candidates)
            if final.submittable
            else 0
        ),
    }


def _empty_review(
    observation: Mapping[str, Any], issues: Sequence[ValidationIssue]
) -> DecisionReview:
    projected = _PreviewState.from_observation(observation).as_dict()
    projected["blockingIssueCount"] = sum(issue.blocking for issue in issues)
    projected["policyWarningCount"] = 0
    return DecisionReview((), (), tuple(issues), projected)


def _restaurant(observation: Mapping[str, Any]) -> Mapping[str, Any]:
    restaurant = observation.get("restaurant")
    return restaurant if isinstance(restaurant, Mapping) else observation


def _market(observation: Mapping[str, Any]) -> Mapping[str, Any]:
    market = observation.get("market")
    return market if isinstance(market, Mapping) else {}


def _integer(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _positive_integer(value: Any) -> bool:
    parsed = _integer(value)
    return parsed is not None and parsed > 0


def _load_json(path: str) -> Any:
    if path == "-":
        return json.load(__import__("sys").stdin)
    with Path(path).open(encoding="utf-8") as source:
        return json.load(source)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate and preflight one Restaurant Sim model decision"
    )
    parser.add_argument("--observation", required=True, metavar="FILE")
    parser.add_argument("--decision", required=True, metavar="FILE")
    parser.add_argument(
        "--cash-reserve", type=int, default=DEFAULT_CASH_RESERVE_CENTS
    )
    args = parser.parse_args(argv)
    review = review_decision(
        _load_json(args.decision),
        _load_json(args.observation),
        cash_reserve_cents=args.cash_reserve,
    )
    print(json.dumps(review.feedback(), indent=2, sort_keys=True))
    return 0 if review.submittable else 1


if __name__ == "__main__":
    raise SystemExit(main())
