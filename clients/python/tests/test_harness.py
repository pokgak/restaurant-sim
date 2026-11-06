from __future__ import annotations

from copy import deepcopy
import json
import unittest
from typing import Any

from restaurant_sim.harness import (
    SYSTEM_PROMPT,
    CandidateDecisionHarness,
    DecisionHarness,
    build_outcome_feedback,
    candidate_system_prompt,
    review_decision,
)


def observation() -> dict[str, Any]:
    staff = {
        "count": 2,
        "targetCount": 2,
        "pendingHireCount": 0,
        "hiringTicksRemaining": 0,
        "trainingTicksRemaining": 0,
        "pendingSkillGainBps": 0,
    }
    equipment = {
        "conditionBps": 7_500,
        "status": "operational",
        "downtimeTicks": 0,
    }
    return {
        "restaurantId": "model",
        "tick": 10,
        "maxTicks": 84,
        "market": {"ingredientUnitCostCents": 400},
        "restaurant": {
            "menuPriceCents": 1_300,
            "inventoryUnits": 10,
            "storageCapacityUnits": 80,
            "purchaseOrders": [],
            "cooks": 2,
            "servers": 2,
            "staffing": {
                "chef": deepcopy(staff),
                "server": deepcopy(staff),
            },
            "marketingSpendPerTickCents": 500,
            "capacityLevel": 0,
            "qualityLevel": 0,
            "equipment": {
                "kitchen": deepcopy(equipment),
                "refrigeration": deepcopy(equipment),
            },
            "cashCents": 100_000,
            "debtCents": 0,
            "creditLimitCents": 500_000,
            "bankrupt": False,
            "cumulativeOperatingProfitCents": 20_000,
            "totalRevenueCents": 120_000,
            "totalCostsCents": 100_000,
            "totalUnitsSold": 100,
            "totalWasteUnits": 2,
            "reputationBps": 5_000,
            "lastTick": None,
        },
        "recentEvents": [],
    }


def provider_response(
    content: str,
    *,
    finish_reason: str = "stop",
    reasoning_content: str | None = None,
    reasoning: str | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {"content": content}
    if reasoning_content is not None:
        message["reasoning_content"] = reasoning_content
    if reasoning is not None:
        message["reasoning"] = reasoning
    return {
        "choices": [
            {"message": message, "finish_reason": finish_reason}
        ],
        "usage": {"completion_tokens": 12},
    }


class DecisionHarnessTest(unittest.TestCase):
    def test_prompt_is_mechanical_not_a_strategy_coach(self) -> None:
        self.assertIn("recommend a strategy", SYSTEM_PROMPT)
        self.assertNotIn("expected payback", SYSTEM_PROMPT)
        self.assertNotIn("Change as few controls", SYSTEM_PROMPT)
        self.assertNotIn("retain at least", SYSTEM_PROMPT)

    def test_parameters_outside_params_get_one_structured_correction(self) -> None:
        malformed = {
            "actions": [
                {
                    "type": "purchase_inventory",
                    "ingredientId": "staples",
                    "quantity": 20,
                    "params": {},
                }
            ]
        }
        corrected = {
            "actions": [
                {
                    "type": "purchase_inventory",
                    "params": {"ingredientId": "staples", "quantity": 20},
                }
            ]
        }
        responses = [
            provider_response(json.dumps(malformed)),
            provider_response(json.dumps(corrected)),
        ]
        calls: list[list[dict[str, str]]] = []

        def infer(messages: list[dict[str, str]]) -> dict[str, Any]:
            calls.append(deepcopy(messages))
            return responses.pop(0)

        decision = DecisionHarness().decide(observation(), infer)

        self.assertTrue(decision.correction_used)
        self.assertEqual(len(calls), 2)
        correction = json.loads(calls[1][-1]["content"])
        codes = {
            issue["code"]
            for issue in correction["validationFeedback"]["issues"]
        }
        self.assertIn("parameters_outside_params", codes)
        self.assertEqual(decision.actions, (corrected["actions"][0],))
        self.assertEqual(decision.metrics["parseValidAttempts"], 2)
        self.assertEqual(decision.metrics["envelopeValidAttempts"], 2)
        self.assertEqual(decision.metrics["schemaValidAttempts"], 1)
        self.assertEqual(decision.metrics["feasibleAttempts"], 1)

    def test_validity_metrics_are_a_cumulative_funnel(self) -> None:
        cases = [
            (
                provider_response("", finish_reason="length"),
                (0, 0, 0, 0),
            ),
            (
                provider_response("[]"),
                (1, 0, 0, 0),
            ),
            (
                provider_response(
                    '{"actions":[{"type":"borrow","params":{}}]}'
                ),
                (1, 1, 0, 0),
            ),
            (
                provider_response(
                    '{"actions":[{"type":"repair_equipment",'
                    '"params":{"assetId":"kitchen"}}]}'
                ),
                (1, 1, 1, 0),
            ),
        ]
        for response, expected in cases:
            with self.subTest(expected=expected):
                decision = DecisionHarness(correction_attempts=0).decide(
                    observation(), lambda _: response
                )
                actual = (
                    decision.metrics["parseValidAttempts"],
                    decision.metrics["envelopeValidAttempts"],
                    decision.metrics["schemaValidAttempts"],
                    decision.metrics["feasibleAttempts"],
                )
                self.assertEqual(actual, expected)

    def test_storage_preview_includes_inventory_pending_and_proposed(self) -> None:
        state = observation()
        restaurant = state["restaurant"]
        restaurant["inventoryUnits"] = 30
        restaurant["purchaseOrders"] = [
            {
                "id": "model-order-1",
                "quantity": 20,
                "status": "pending",
            }
        ]

        review = review_decision(
            {
                "actions": [
                    {
                        "type": "purchase_inventory",
                        "params": {
                            "ingredientId": "staples",
                            "quantity": 31,
                        },
                    }
                ]
            },
            state,
        )

        self.assertFalse(review.submittable)
        self.assertIn(
            "storage_capacity_exceeded",
            {issue.code for issue in review.issues},
        )
        self.assertEqual(review.projected["pendingUnits"], 20)
        self.assertEqual(review.projected["stockPositionUnits"], 50)

    def test_blocked_action_does_not_change_later_action_preview(self) -> None:
        state = observation()
        state["restaurant"]["inventoryUnits"] = 20
        state["restaurant"]["cashCents"] = 1_000

        review = review_decision(
            {
                "actions": [
                    {
                        "type": "purchase_inventory",
                        "params": {
                            "ingredientId": "staples",
                            "quantity": 35,
                        },
                    },
                    {"type": "borrow", "params": {"amountCents": 20_000}},
                    {
                        "type": "purchase_inventory",
                        "params": {
                            "ingredientId": "staples",
                            "quantity": 30,
                        },
                    },
                ]
            },
            state,
        )

        self.assertEqual(len(review.previews), 2)
        self.assertEqual(
            review.previews[1].details["stockPositionBeforeUnits"], 20
        )
        self.assertEqual(review.projected["stockPositionUnits"], 50)
        self.assertEqual(review.projected["cashCents"], 9_000)

    def test_actions_preview_in_submission_order(self) -> None:
        state = observation()
        state["restaurant"]["cashCents"] = 1_000

        review = review_decision(
            {
                "actions": [
                    {"type": "borrow", "params": {"amountCents": 10_000}},
                    {
                        "type": "purchase_inventory",
                        "params": {
                            "ingredientId": "staples",
                            "quantity": 20,
                        },
                    },
                ]
            },
            state,
        )

        self.assertTrue(review.submittable)
        self.assertEqual(review.previews[0].cash_after_cents, 11_000)
        self.assertEqual(review.previews[1].cash_after_cents, 3_000)
        self.assertEqual(review.projected["debtCents"], 10_000)

    def test_equipment_actions_use_status_not_condition(self) -> None:
        operational = review_decision(
            {
                "actions": [
                    {
                        "type": "repair_equipment",
                        "params": {"assetId": "kitchen"},
                    }
                ]
            },
            observation(),
        )
        self.assertIn(
            "repair_requires_broken_equipment",
            {issue.code for issue in operational.issues},
        )

        broken_state = observation()
        broken_state["restaurant"]["equipment"]["kitchen"]["status"] = (
            "broken"
        )
        maintenance = review_decision(
            {
                "actions": [
                    {
                        "type": "schedule_maintenance",
                        "params": {"assetId": "kitchen"},
                    }
                ]
            },
            broken_state,
        )
        self.assertIn(
            "maintenance_requires_operational_equipment",
            {issue.code for issue in maintenance.issues},
        )

    def test_investment_preview_has_exact_immediate_and_recurring_costs(self) -> None:
        state = observation()
        restaurant = state["restaurant"]
        restaurant["capacityLevel"] = 1
        restaurant["storageCapacityUnits"] = 120

        review = review_decision(
            {"actions": [{"type": "invest", "params": {"kind": "capacity"}}]},
            state,
        )

        preview = review.previews[0]
        self.assertEqual(preview.estimated_cost_cents, 44_000)
        self.assertEqual(preview.details["addedFixedCostPerTickCents"], 350)
        self.assertEqual(preview.details["addedUtilityCostPerTickCents"], 150)
        self.assertEqual(preview.details["addedWeeklyRentCents"], 1_800)
        self.assertEqual(preview.details["addedCoordinationBurdenBps"], 550)
        self.assertEqual(review.projected["capacityLevel"], 2)
        self.assertEqual(review.projected["storageCapacityUnits"], 160)

    def test_configured_reserve_is_nonblocking_and_does_not_retry(self) -> None:
        response = provider_response(
            '{"actions":[{"type":"purchase_inventory",'
            '"params":{"ingredientId":"staples","quantity":20}}]}'
        )
        calls = 0

        def infer(_: list[dict[str, str]]) -> dict[str, Any]:
            nonlocal calls
            calls += 1
            return response

        decision = DecisionHarness(cash_reserve_cents=95_000).decide(
            observation(), infer
        )

        self.assertEqual(calls, 1)
        self.assertTrue(decision.metrics["decisionSubmittable"])
        self.assertEqual(decision.metrics["policyWarningCount"], 1)
        self.assertEqual(decision.metrics["submittedActionCount"], 1)

    def test_empty_action_decision_is_valid_and_distinct_from_action_count(self) -> None:
        decision = DecisionHarness().decide(
            observation(),
            lambda _: provider_response('{"actions":[],"note":"wait"}'),
        )

        self.assertEqual(decision.actions, ())
        self.assertTrue(decision.metrics["decisionSubmittable"])
        self.assertEqual(decision.metrics["submittedActionCount"], 0)
        self.assertEqual(decision.metrics["feasibleAttempts"], 1)

    def test_length_limited_empty_content_gets_one_correction(self) -> None:
        responses = [
            provider_response("", finish_reason="length"),
            provider_response('{"actions":[]}'),
        ]

        decision = DecisionHarness().decide(
            observation(), lambda _: responses.pop(0)
        )

        self.assertTrue(decision.correction_used)
        self.assertTrue(decision.metrics["correctionSucceeded"])
        self.assertEqual(decision.metrics["lengthLimitedAttempts"], 1)
        self.assertEqual(decision.metrics["parseValidAttempts"], 1)

    def test_provider_reasoning_fields_are_preserved(self) -> None:
        content = '{"actions":[]}'
        first = DecisionHarness(correction_attempts=0).decide(
            observation(),
            lambda _: provider_response(
                content, reasoning_content="provider-specific reasoning"
            ),
        )
        second = DecisionHarness(correction_attempts=0).decide(
            observation(),
            lambda _: provider_response(content, reasoning="standard reasoning"),
        )

        self.assertEqual(
            first.attempts[0].reasoning, "provider-specific reasoning"
        )
        self.assertEqual(second.attempts[0].reasoning, "standard reasoning")

    def test_outcome_feedback_reports_receipts_events_and_commitments(self) -> None:
        previous = observation()
        current = observation()
        current["tick"] = 13
        restaurant = current["restaurant"]
        restaurant.update(
            cashCents=108_000,
            debtCents=10_000,
            cumulativeOperatingProfitCents=24_000,
            totalRevenueCents=130_000,
            totalCostsCents=106_000,
            totalUnitsSold=108,
            totalWasteUnits=3,
            inventoryUnits=2,
            reputationBps=5_100,
            lastTick={
                "stockoutUnits": 2,
                "lostToCapacityUnits": 0,
                "operatingProfitCents": -100,
                "kitchenDowntime": False,
                "refrigerationDowntime": True,
            },
        )
        restaurant["purchaseOrders"] = [
            {
                "id": "model-order-4",
                "ingredientId": "staples",
                "quantity": 30,
                "unitCostCents": 400,
                "orderedTick": 10,
                "originalDueTick": 12,
                "dueTick": 14,
                "disruptionCount": 1,
                "status": "pending",
            }
        ]
        restaurant["staffing"]["chef"].update(
            targetCount=3,
            pendingHireCount=1,
            hiringTicksRemaining=1,
        )
        restaurant["equipment"]["refrigeration"].update(
            status="maintenance", downtimeTicks=1
        )
        current["recentEvents"] = [
            {"id": "old", "tick": 9, "source": "operations"},
            {"id": "action", "tick": 10, "source": "agent"},
            {"id": "delay", "tick": 12, "source": "environment"},
            {"id": "future", "tick": 13, "source": "agent"},
        ]
        submitted = [
            {
                "result": {
                    "result": {
                        "accepted": True,
                        "costCents": 12_000,
                        "message": "ingredient order placed",
                    }
                }
            },
            {
                "accepted": False,
                "costCents": 0,
                "message": "equipment is not broken",
            },
        ]

        feedback = build_outcome_feedback(previous, current, submitted)

        self.assertEqual(feedback["elapsedTicks"], 3)
        self.assertEqual(feedback["restaurantDeltas"]["cashCents"], 8_000)
        self.assertEqual(
            feedback["restaurantDeltas"]["cumulativeOperatingProfitCents"],
            4_000,
        )
        self.assertEqual(
            feedback["actionResultSummary"],
            {
                "submittedCount": 2,
                "acceptedCount": 1,
                "rejectedCount": 1,
                "unknownCount": 0,
                "acceptedImmediateCostCents": 12_000,
                "rejections": [
                    {
                        "actionIndex": 1,
                        "message": "equipment is not broken",
                    }
                ],
            },
        )
        self.assertEqual(
            [event["id"] for event in feedback["observedEvents"]],
            ["action", "delay"],
        )
        self.assertEqual(
            feedback["pendingCommitments"]["pendingOrders"][0]["dueTick"],
            14,
        )
        self.assertEqual(
            feedback["pendingCommitments"]["staffing"]["chef"][
                "pendingHireCount"
            ],
            1,
        )
        self.assertEqual(
            feedback["pendingCommitments"]["equipment"]["refrigeration"][
                "status"
            ],
            "maintenance",
        )
        self.assertEqual(
            feedback["alerts"],
            [
                "stockout",
                "negative_operating_profit",
                "refrigeration_downtime",
                "action_rejected",
            ],
        )
        self.assertIn("final tick", feedback["limitations"][-1])


class CandidateDecisionHarnessTest(unittest.TestCase):
    def test_returns_supported_distinct_feasible_plans_without_selecting_one(self) -> None:
        for candidate_count in (3, 5, 10):
            with self.subTest(candidate_count=candidate_count):
                content = json.dumps(
                    {
                        "candidates": [
                            {
                                "actions": [
                                    {
                                        "type": "set_marketing",
                                        "params": {"budgetCents": index * 100},
                                    }
                                ],
                                "note": f"marketing {index * 100}",
                            }
                            for index in range(candidate_count)
                        ]
                    }
                )
                calls: list[list[dict[str, str]]] = []

                def infer(messages: list[dict[str, str]]) -> dict[str, Any]:
                    calls.append(deepcopy(messages))
                    return provider_response(content)

                decision = CandidateDecisionHarness(
                    candidate_count=candidate_count
                ).decide(observation(), infer)

                self.assertEqual(len(calls), 1)
                self.assertEqual(
                    calls[0][0]["content"], candidate_system_prompt(candidate_count)
                )
                self.assertEqual(
                    [candidate.candidate_id for candidate in decision.candidates],
                    [f"plan_{index}" for index in range(candidate_count)],
                )
                self.assertEqual(
                    decision.metrics["candidateCount"], candidate_count
                )
                self.assertEqual(
                    decision.metrics["candidateActionCount"], candidate_count
                )
                self.assertNotIn("selected", decision.metrics)

    def test_rejects_unsupported_candidate_count(self) -> None:
        with self.assertRaisesRegex(ValueError, "3, 5, 10"):
            CandidateDecisionHarness(candidate_count=4)

    def test_duplicate_and_empty_candidates_get_one_structured_correction(self) -> None:
        action = {
            "type": "set_marketing",
            "params": {"budgetCents": 0},
        }
        malformed = {
            "candidates": [
                {"actions": [action], "note": "first"},
                {"actions": [action], "note": "duplicate"},
                {"actions": [], "note": "empty"},
            ]
        }
        corrected = {
            "candidates": [
                {
                    "actions": [
                        {
                            "type": "set_marketing",
                            "params": {"budgetCents": budget},
                        }
                    ],
                    "note": f"marketing {budget}",
                }
                for budget in (0, 100, 200)
            ]
        }
        responses = [
            provider_response(json.dumps(malformed)),
            provider_response(json.dumps(corrected)),
        ]
        calls: list[list[dict[str, str]]] = []

        def infer(messages: list[dict[str, str]]) -> dict[str, Any]:
            calls.append(deepcopy(messages))
            return responses.pop(0)

        decision = CandidateDecisionHarness().decide(observation(), infer)

        self.assertTrue(decision.correction_used)
        self.assertTrue(decision.metrics["correctionSucceeded"])
        correction = json.loads(calls[1][-1]["content"])
        codes = {
            issue["code"]
            for issue in correction["validationFeedback"]["issues"]
        }
        self.assertEqual(
            codes, {"candidate_must_not_be_empty", "duplicate_candidate"}
        )
        self.assertEqual(len(decision.candidates), 3)


if __name__ == "__main__":
    unittest.main()
