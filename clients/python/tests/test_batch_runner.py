from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_model_batch.py"
SPEC = importlib.util.spec_from_file_location("run_model_batch", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
run_model_batch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_model_batch)


class StreamParsingTests(unittest.TestCase):
    def test_reassembles_content_reasoning_usage_and_preserves_chunks(self) -> None:
        chunks = [
            {
                "id": "completion-1",
                "object": "chat.completion.chunk",
                "created": 123,
                "model": "model-1",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "reasoning_content": "why "},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "completion-1",
                "object": "chat.completion.chunk",
                "created": 123,
                "model": "model-1",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"reasoning_content": "this", "content": '{"actions":'},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "completion-1",
                "object": "chat.completion.chunk",
                "created": 123,
                "model": "model-1",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": "[]}"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 20,
                    "total_tokens": 120,
                },
            },
        ]
        raw = "\n\n".join(f"data: {json.dumps(chunk)}" for chunk in chunks)
        raw += "\n\ndata: [DONE]\n\n"

        response = run_model_batch.parse_chat_completion_stream(raw)

        message = response["choices"][0]["message"]
        self.assertEqual(message["content"], '{"actions":[]}')
        self.assertEqual(message["reasoning_content"], "why this")
        self.assertEqual(response["choices"][0]["finish_reason"], "stop")
        self.assertEqual(response["usage"]["completion_tokens"], 20)
        self.assertEqual(response["stream"]["chunks"], chunks)

    def test_rejects_empty_stream(self) -> None:
        with self.assertRaisesRegex(
            run_model_batch.BatchError, "did not contain completion events"
        ):
            run_model_batch.parse_chat_completion_stream("data: [DONE]\n\n")


class ExplicitJobsTests(unittest.TestCase):
    def test_preserves_exact_jobs_without_cartesian_expansion(self) -> None:
        self.assertEqual(
            run_model_batch.parse_explicit_jobs(
                "glm:4101001,deepseek-pro:4101002,deepseek-pro:4101005"
            ),
            [
                ("glm", 4_101_001),
                ("deepseek-pro", 4_101_002),
                ("deepseek-pro", 4_101_005),
            ],
        )

    def test_rejects_duplicate_job(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate job"):
            run_model_batch.parse_explicit_jobs(
                "deepseek-pro:4101001,deepseek-pro:4101001"
            )


class VerifierConfigurationTests(unittest.TestCase):
    def test_frozen_review_and_verifier_hashes_match(self) -> None:
        self.assertEqual(
            run_model_batch.plan_review_system_prompt_sha256(),
            run_model_batch.EXPECTED_PLAN_REVIEW_PROMPT_SHA256,
        )
        self.assertEqual(
            run_model_batch.plan_verifier_contract_sha256(),
            run_model_batch.EXPECTED_PLAN_VERIFIER_CONTRACT_SHA256,
        )

    def test_selector_and_verifier_cannot_run_in_the_same_arm(self) -> None:
        with self.assertRaisesRegex(SystemExit, "mutually exclusive"):
            run_model_batch.main(
                [
                    "--batch-id",
                    "invalid",
                    "--decision-selector",
                    "clef",
                    "--plan-verifier",
                    "clef",
                    "--token-file",
                    "unused-token-file",
                    "--output-dir",
                    "unused-output",
                    "--initial-cost-usd",
                    "0",
                ]
            )

    def test_all_single_plan_arms_reject_an_invalid_final_plan(self) -> None:
        invalid = run_model_batch.DecisionHarness(correction_attempts=0).decide(
            candidate_observation(), lambda _: {"choices": []}
        )
        with self.assertRaisesRegex(
            run_model_batch.BatchError, "deterministically valid plan"
        ):
            run_model_batch.require_submittable_decision(invalid)

    def test_required_revision_cannot_execute_an_unchanged_plan(self) -> None:
        decision = planner_decision()
        verification = {"revisionRequired": True}
        with self.assertRaisesRegex(run_model_batch.BatchError, "required revision"):
            run_model_batch.require_reviewed_actions(
                original_actions=list(decision.actions),
                reviewed_decision=decision,
                verification=verification,
            )
        self.assertFalse(verification["actionsChanged"])

    def test_batch_success_requires_completed_verified_archive(self) -> None:
        self.assertTrue(
            run_model_batch.run_succeeded(
                {"status": "completed", "archive": {"verified": True}}
            )
        )
        self.assertFalse(
            run_model_batch.run_succeeded(
                {"status": "completed", "archive": {"verified": False}}
            )
        )
        self.assertFalse(
            run_model_batch.run_succeeded(
                {"status": "failed", "archive": {"verified": True}}
            )
        )


class VerifierOrchestrationTests(unittest.TestCase):
    def test_verifier_failure_reviews_and_submits_reviewed_plan(self) -> None:
        original = planner_decision()
        reviewed_response = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "actions": [
                                    {
                                        "type": "set_marketing",
                                        "params": {"budgetCents": 400},
                                    }
                                ],
                                "note": "Reviewed against the supplied evidence.",
                            }
                        )
                    },
                    "finish_reason": "stop",
                }
            ]
        }
        reviewed = run_model_batch.DecisionHarness().decide(
            candidate_observation(), lambda _: reviewed_response
        )
        clock = {"tick": 0}

        class FakeClient:
            def __init__(self, *_: object, **__: object) -> None:
                pass

            def state(self) -> dict[str, object]:
                return {
                    "tick": clock["tick"],
                    "restaurant": {"bankrupt": False},
                }

        def fake_request(url: str, **kwargs: object) -> tuple[object, object]:
            if url.endswith("/api/games"):
                return (
                    {
                        "id": "game-1",
                        "seats": [
                            {"restaurantId": "model", "token": "model-token"},
                            {
                                "restaurantId": "heuristic",
                                "token": "heuristic-token",
                            },
                        ],
                    },
                    {},
                )
            if url.endswith("/control/step"):
                payload = kwargs["payload"]
                assert isinstance(payload, dict)
                clock["tick"] += int(payload["ticks"])
                return ({"tick": clock["tick"]}, {})
            if url.endswith("/export?format=jsonl"):
                return ('{"type":"metadata"}\n', {})
            if url.endswith("/export"):
                return (
                    {
                        "results": {"leaderboard": []},
                        "environmentEvents": [],
                        "logs": [],
                    },
                    {},
                )
            raise AssertionError(f"unexpected request: {url}")

        def fake_submit(
            _client: object, actions: list[dict[str, object]], **_: object
        ) -> list[dict[str, object]]:
            return [
                {
                    "action": action,
                    "result": {"result": {"accepted": True}},
                }
                for action in actions
            ]

        with TemporaryDirectory() as directory:
            output_root = Path(directory)
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=10.0,
                state_path=output_root / "budget.json",
            )
            with (
                patch.object(run_model_batch, "MAX_TICKS", 3),
                patch.object(run_model_batch, "Client", FakeClient),
                patch.object(run_model_batch, "json_request", side_effect=fake_request),
                patch.object(
                    run_model_batch.DecisionHarness,
                    "decide",
                    return_value=original,
                ),
                patch.object(
                    run_model_batch.DecisionHarness,
                    "review",
                    return_value=reviewed,
                ) as review,
                patch.object(
                    run_model_batch.ClefPlanVerifier,
                    "__call__",
                    side_effect=run_model_batch.BatchError("Clef unavailable"),
                ),
                patch.object(
                    run_model_batch.HeuristicBaseline,
                    "decide",
                    return_value=[],
                ),
                patch.object(
                    run_model_batch,
                    "submit_actions",
                    side_effect=fake_submit,
                ) as submit,
                patch.object(
                    run_model_batch.subprocess,
                    "run",
                    return_value=SimpleNamespace(
                        stdout='{"verified":true,"gameId":"game-1"}'
                    ),
                ),
                patch.dict(
                    os.environ,
                    {"RESTAURANT_SIM_ADMIN_TOKEN_FILE": "/tmp/test-token"},
                ),
            ):
                summary = run_model_batch.run_episode(
                    model_key="glm",
                    seed=4_101_006,
                    batch_id="verifier-fallback-test",
                    base_url="https://relay.example",
                    inference_url="https://relay.example/api/inference",
                    decision_selector="none",
                    decision_url="https://relay.example/api/decision-select",
                    plan_verifier="clef",
                    verifier_url="https://relay.example/api/plan-verify",
                    candidate_count=3,
                    selection_min_probability=0.5,
                    admin_token="admin-token",
                    output_root=output_root,
                    budget=budget,
                )

            self.assertEqual(summary["status"], "completed")
            self.assertEqual(
                summary["planVerifier"]["routes"],
                {"verifier_error_review": 1},
            )
            review.assert_called_once()
            submitted_actions = submit.call_args_list[0].args[1]
            self.assertEqual(submitted_actions, list(reviewed.actions))
            self.assertNotEqual(submitted_actions, list(original.actions))
            run_document = json.loads(
                (
                    output_root
                    / "verifier-fallback-test-glm-seed-4101006"
                    / "run.json"
                ).read_text(encoding="utf-8")
            )
            decision = run_document["decisions"][0]
            self.assertEqual(decision["verification"]["route"], "verifier_error_review")
            self.assertEqual(decision["modelSubmitted"][0]["action"], reviewed.actions[0])


class InferenceRetryTests(unittest.TestCase):
    def test_retries_transport_failures_and_reserves_uncertain_cost(self) -> None:
        response = {
            "choices": [{"message": {"content": '{"actions":[]}'}}],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120,
            },
        }
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=10.0,
                initial_uncertain_cost_usd=5.0,
                budget_usd=100.0,
                state_path=Path(directory) / "budget.json",
            )
            calls: list[dict[str, object]] = []
            inference = run_model_batch.ModelInference(
                inference_url="https://relay.example/api/inference",
                admin_token="secret",
                model=run_model_batch.MODELS["glm"],
                budget=budget,
                call_records=calls,
            )
            with (
                patch.object(
                    run_model_batch,
                    "json_request",
                    side_effect=[
                        run_model_batch.BatchError(
                            "request to https://relay.example failed: timed out"
                        ),
                        run_model_batch.BatchError(
                            "request to https://relay.example failed: timed out"
                        ),
                        run_model_batch.BatchError(
                            "request to https://relay.example failed: timed out"
                        ),
                        (response, {}),
                    ],
                ),
                patch.object(run_model_batch.time, "sleep"),
            ):
                self.assertIs(inference([{"role": "user", "content": "state"}]), response)

            self.assertEqual(len(calls), 4)
            self.assertTrue(calls[0]["error"]["retryable"])
            self.assertEqual(calls[0]["uncertainCostReserveUsd"], 5.0)
            self.assertEqual(calls[-1]["transportAttempt"], 4)
            snapshot = budget.snapshot()
            self.assertEqual(snapshot["failedInferenceRequests"], 3)
            self.assertEqual(snapshot["completedInferenceRequests"], 1)
            self.assertEqual(snapshot["uncertainCostReserveUsd"], 20.0)
            self.assertGreater(snapshot["totalTrackedCostUsd"], 10.0)

    def test_missing_usage_fails_and_preserves_uncertain_cost(self) -> None:
        response = {
            "choices": [{"message": {"content": '{"actions":[]}'}}],
        }
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=10.0,
                state_path=Path(directory) / "budget.json",
            )
            calls: list[dict[str, object]] = []
            inference = run_model_batch.ModelInference(
                inference_url="https://relay.example/api/inference",
                admin_token="secret",
                model=run_model_batch.MODELS["glm"],
                budget=budget,
                call_records=calls,
            )
            with (
                patch.object(
                    run_model_batch,
                    "json_request",
                    return_value=(response, {}),
                ),
                self.assertRaisesRegex(run_model_batch.BatchError, "contain usage"),
            ):
                inference([{"role": "user", "content": "state"}])

            self.assertIs(calls[0]["response"], response)
            self.assertTrue(calls[0]["error"]["chargeUncertain"])
            self.assertEqual(calls[0]["uncertainCostReserveUsd"], 5.0)
            self.assertEqual(budget.snapshot()["uncertainCostReserveUsd"], 5.0)

    def test_http_500_is_nonretryable_but_preserves_uncertain_cost(self) -> None:
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=10.0,
                state_path=Path(directory) / "budget.json",
            )
            calls: list[dict[str, object]] = []
            inference = run_model_batch.ModelInference(
                inference_url="https://relay.example/api/inference",
                admin_token="secret",
                model=run_model_batch.MODELS["glm"],
                budget=budget,
                call_records=calls,
            )
            with (
                patch.object(
                    run_model_batch,
                    "json_request",
                    side_effect=run_model_batch.BatchError(
                        "HTTP 500 from https://relay.example: internal error"
                    ),
                ),
                self.assertRaises(run_model_batch.BatchError),
            ):
                inference([{"role": "user", "content": "state"}])

            self.assertEqual(len(calls), 1)
            self.assertFalse(calls[0]["error"]["retryable"])
            self.assertTrue(calls[0]["error"]["chargeUncertain"])
            self.assertEqual(budget.snapshot()["uncertainCostReserveUsd"], 5.0)


def candidate_observation() -> dict[str, object]:
    return {
        "restaurantId": "model",
        "tick": 0,
        "maxTicks": 84,
        "market": {"ingredientUnitCostCents": 400},
        "restaurant": {
            "cashCents": 100_000,
            "debtCents": 0,
            "creditLimitCents": 500_000,
            "inventoryUnits": 10,
            "storageCapacityUnits": 80,
            "purchaseOrders": [],
            "marketingSpendPerTickCents": 500,
            "menuPriceCents": 1_300,
            "capacityLevel": 0,
            "qualityLevel": 0,
            "cooks": 2,
            "servers": 2,
            "staffing": {},
            "equipment": {},
        },
        "recentEvents": [],
    }


def candidate_decision(candidate_count: int = 3) -> object:
    content = json.dumps(
        {
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
                for budget in range(0, candidate_count * 100, 100)
            ]
        }
    )
    response = {
        "choices": [
            {
                "message": {"content": content},
                "finish_reason": "stop",
            }
        ]
    }
    return run_model_batch.CandidateDecisionHarness(
        candidate_count=candidate_count
    ).decide(
        candidate_observation(), lambda _: response
    )


def clef_response(
    probability: float, choice: str = "plan_1", candidate_count: int = 3
) -> dict[str, object]:
    candidate_ids = run_model_batch.decision_candidate_ids(candidate_count)
    remainder = (1.0 - probability) / (len(candidate_ids) - 1)
    probabilities = {
        candidate_id: remainder
        for candidate_id in candidate_ids
    }
    probabilities[choice] = probability
    return {
        "model": "clef",
        "answers": {
            "terminal_outcome": {
                "type": "choice",
                "choice": choice,
                "confidence": 0.6,
                "probabilities": probabilities,
            }
        },
        "usage": {"input_tokens": 1_000, "output_tokens": 20},
    }


def planner_decision() -> object:
    response = {
        "choices": [
            {
                "message": {
                    "content": json.dumps(
                        {
                            "actions": [
                                {
                                    "type": "set_marketing",
                                    "params": {"budgetCents": 200},
                                }
                            ],
                            "note": "Demand is weak",
                        }
                    )
                },
                "finish_reason": "stop",
            }
        ]
    }
    return run_model_batch.DecisionHarness().decide(
        candidate_observation(), lambda _: response
    )


def clef_verifier_response(probability: float) -> dict[str, object]:
    return {
        "model": "clef",
        "answers": {
            "material_state_misread": {
                "type": "noul",
                "noul": probability,
            }
        },
        "usage": {"input_tokens": 1_000, "output_tokens": 0},
    }


class ClefPlanSelectorTests(unittest.TestCase):
    def test_probability_boundary_routes_to_selected_plan_or_no_action(self) -> None:
        for candidate_count in (3, 5, 10):
            for probability, expected_route, expected_candidate in (
                (0.49, "low_probability_fallback", "no_action"),
                (0.50, "selected", "plan_1"),
                (0.51, "selected", "plan_1"),
            ):
                with self.subTest(
                    candidate_count=candidate_count, probability=probability
                ):
                    with TemporaryDirectory() as directory:
                        budget = run_model_batch.BudgetTracker(
                            initial_cost_usd=0.0,
                            budget_usd=10.0,
                            state_path=Path(directory) / "budget.json",
                        )
                        calls: list[dict[str, object]] = []
                        selector = run_model_batch.ClefPlanSelector(
                            decision_url="https://relay.example/api/decision-select",
                            admin_token="secret",
                            budget=budget,
                            call_records=calls,
                            candidate_count=candidate_count,
                        )
                        with patch.object(
                            run_model_batch,
                            "json_request",
                            return_value=(
                                clef_response(
                                    probability, candidate_count=candidate_count
                                ),
                                {},
                            ),
                        ):
                            result = selector(
                                observation=candidate_observation(),
                                outcome_feedback=None,
                                decision=candidate_decision(candidate_count),
                            )

                        self.assertEqual(result["route"], expected_route)
                        self.assertEqual(result["candidateCount"], candidate_count)
                        self.assertEqual(
                            result["selectedCandidateId"], expected_candidate
                        )
                        self.assertEqual(
                            len(result["selectedActions"]),
                            0 if expected_candidate == "no_action" else 1,
                        )
                        request = calls[0]["request"]
                        self.assertEqual(
                            request["state"]["candidateCount"], candidate_count
                        )
                        self.assertEqual(
                            [
                                item["candidateId"]
                                for item in request["state"]["candidates"]
                            ],
                            list(
                                run_model_batch.decision_candidate_ids(
                                    candidate_count
                                )
                            ),
                        )
                        self.assertTrue(
                            run_model_batch.decision_request_matches_contract(
                                request, candidate_count
                            )
                        )
                        self.assertEqual(
                            calls[0]["usageCost"]["listCostUsd"], 0.00024
                        )

    def test_rejects_incomplete_or_out_of_range_probability_vectors(self) -> None:
        incomplete = clef_response(0.7)
        del incomplete["answers"]["terminal_outcome"]["probabilities"][
            "no_action"
        ]
        out_of_range = clef_response(0.7)
        out_of_range["answers"]["terminal_outcome"]["probabilities"][
            "plan_0"
        ] = -0.1

        with TemporaryDirectory() as directory:
            selector = run_model_batch.ClefPlanSelector(
                decision_url="https://relay.example/api/decision-select",
                admin_token="secret",
                budget=run_model_batch.BudgetTracker(
                    initial_cost_usd=0.0,
                    budget_usd=10.0,
                    state_path=Path(directory) / "budget.json",
                ),
                call_records=[],
            )
            for response, message in (
                (incomplete, "cover exactly"),
                (out_of_range, "between 0 and 1"),
            ):
                with self.subTest(message=message):
                    with self.assertRaisesRegex(run_model_batch.BatchError, message):
                        selector._validate_response(response)

    def test_transport_failure_is_recorded_and_never_returns_actions(self) -> None:
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=10.0,
                state_path=Path(directory) / "budget.json",
            )
            calls: list[dict[str, object]] = []
            selector = run_model_batch.ClefPlanSelector(
                decision_url="https://relay.example/api/decision-select",
                admin_token="secret",
                budget=budget,
                call_records=calls,
            )
            with (
                patch.object(
                    run_model_batch,
                    "json_request",
                    side_effect=run_model_batch.BatchError(
                        "HTTP 400 from https://relay.example: malformed"
                    ),
                ),
                self.assertRaises(run_model_batch.BatchError),
            ):
                selector(
                    observation=candidate_observation(),
                    outcome_feedback=None,
                    decision=candidate_decision(),
                )

            self.assertEqual(len(calls), 1)
            self.assertIn("error", calls[0])
            self.assertNotIn("response", calls[0])
            self.assertEqual(budget.snapshot()["reservedUsd"], 0.0)

    def test_http_500_preserves_uncertain_clef_cost_without_retrying(self) -> None:
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=10.0,
                state_path=Path(directory) / "budget.json",
            )
            calls: list[dict[str, object]] = []
            selector = run_model_batch.ClefPlanSelector(
                decision_url="https://relay.example/api/decision-select",
                admin_token="secret",
                budget=budget,
                call_records=calls,
            )
            with (
                patch.object(
                    run_model_batch,
                    "json_request",
                    side_effect=run_model_batch.BatchError(
                        "HTTP 500 from https://relay.example: internal error"
                    ),
                ),
                self.assertRaises(run_model_batch.BatchError),
            ):
                selector._request({"request": "fixture"})

            self.assertEqual(len(calls), 1)
            self.assertFalse(calls[0]["error"]["retryable"])
            self.assertTrue(calls[0]["error"]["chargeUncertain"])
            self.assertEqual(
                budget.snapshot()["uncertainCostReserveUsd"],
                run_model_batch.MAX_DECISION_REQUEST_COST_USD,
            )

    def test_invalid_paid_response_records_known_usage_and_raw_response(self) -> None:
        response = clef_response(0.7)
        del response["answers"]["terminal_outcome"]["probabilities"]["no_action"]
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=10.0,
                state_path=Path(directory) / "budget.json",
            )
            calls: list[dict[str, object]] = []
            selector = run_model_batch.ClefPlanSelector(
                decision_url="https://relay.example/api/decision-select",
                admin_token="secret",
                budget=budget,
                call_records=calls,
            )
            with (
                patch.object(
                    run_model_batch,
                    "json_request",
                    return_value=(response, {}),
                ),
                self.assertRaisesRegex(run_model_batch.BatchError, "cover exactly"),
            ):
                selector._request({"request": "fixture"})

            self.assertIs(calls[0]["response"], response)
            self.assertIn("error", calls[0])
            self.assertEqual(calls[0]["usageCost"]["listCostUsd"], 0.00024)
            snapshot = budget.snapshot()
            self.assertEqual(snapshot["totalTrackedCostUsd"], 0.00024)
            self.assertEqual(snapshot["uncertainCostReserveUsd"], 0.0)

    def test_missing_usage_reserves_unknown_paid_cost(self) -> None:
        response = clef_response(0.7)
        del response["usage"]
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=10.0,
                state_path=Path(directory) / "budget.json",
            )
            calls: list[dict[str, object]] = []
            selector = run_model_batch.ClefPlanSelector(
                decision_url="https://relay.example/api/decision-select",
                admin_token="secret",
                budget=budget,
                call_records=calls,
            )
            with (
                patch.object(
                    run_model_batch,
                    "json_request",
                    return_value=(response, {}),
                ),
                self.assertRaisesRegex(run_model_batch.BatchError, "contain usage"),
            ):
                selector._request({"request": "fixture"})

            self.assertIs(calls[0]["response"], response)
            self.assertIn("error", calls[0])
            self.assertEqual(calls[0]["usageCost"]["listCostUsd"], 0.0)
            self.assertEqual(
                budget.snapshot()["uncertainCostReserveUsd"],
                run_model_batch.MAX_DECISION_REQUEST_COST_USD,
            )


class ClefPlanVerifierTests(unittest.TestCase):
    def test_probability_bands_execute_review_or_require_revision(self) -> None:
        for probability, route, review, revision in (
            (0.2999, "execute_original", False, False),
            (0.3, "review_recommended", True, False),
            (0.6999, "review_recommended", True, False),
            (0.7, "revision_required", True, True),
        ):
            with self.subTest(probability=probability):
                with TemporaryDirectory() as directory:
                    calls: list[dict[str, object]] = []
                    verifier = run_model_batch.ClefPlanVerifier(
                        verifier_url="https://relay.example/api/plan-verify",
                        admin_token="secret",
                        budget=run_model_batch.BudgetTracker(
                            initial_cost_usd=0.0,
                            budget_usd=10.0,
                            state_path=Path(directory) / "budget.json",
                        ),
                        call_records=calls,
                    )
                    with patch.object(
                        run_model_batch,
                        "json_request",
                        return_value=(clef_verifier_response(probability), {}),
                    ):
                        result = verifier(
                            observation=candidate_observation(),
                            outcome_feedback=None,
                            decision=planner_decision(),
                        )

                    self.assertEqual(result["route"], route)
                    self.assertEqual(result["requiresReview"], review)
                    self.assertEqual(result["revisionRequired"], revision)
                    self.assertEqual(
                        result["materialStateMisreadProbability"], probability
                    )
                    request = calls[0]["request"]
                    self.assertTrue(
                        run_model_batch.plan_verifier_request_matches_contract(request)
                    )
                    self.assertEqual(
                        request["state"]["proposedPlan"]["actions"],
                        request["state"]["deterministicReview"]["validatedActions"],
                    )
                    self.assertEqual(
                        calls[0]["usageCost"]["listCostUsd"], 0.00024
                    )
                    request["state"]["deterministicReview"]["previews"] = [None]
                    self.assertFalse(
                        run_model_batch.plan_verifier_request_matches_contract(request)
                    )

    def test_rejects_invalid_noul_without_losing_paid_usage(self) -> None:
        response = clef_verifier_response(0.8)
        response["answers"]["material_state_misread"]["noul"] = 1.2
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=10.0,
                state_path=Path(directory) / "budget.json",
            )
            calls: list[dict[str, object]] = []
            verifier = run_model_batch.ClefPlanVerifier(
                verifier_url="https://relay.example/api/plan-verify",
                admin_token="secret",
                budget=budget,
                call_records=calls,
            )
            with (
                patch.object(
                    run_model_batch,
                    "json_request",
                    return_value=(response, {}),
                ),
                self.assertRaisesRegex(run_model_batch.BatchError, "between 0 and 1"),
            ):
                verifier(
                    observation=candidate_observation(),
                    outcome_feedback=None,
                    decision=planner_decision(),
                )

            self.assertIs(calls[0]["response"], response)
            self.assertIn("error", calls[0])
            self.assertEqual(calls[0]["usageCost"]["listCostUsd"], 0.00024)
            self.assertEqual(budget.snapshot()["uncertainCostReserveUsd"], 0.0)


class BudgetValidationTests(unittest.TestCase):
    def test_rejects_invalid_initial_budget_values(self) -> None:
        with TemporaryDirectory() as directory:
            state_path = Path(directory) / "budget.json"
            for kwargs, message in (
                ({"initial_cost_usd": -1.0, "budget_usd": 10.0}, "nonnegative"),
                ({"initial_cost_usd": float("nan"), "budget_usd": 10.0}, "finite"),
                ({"initial_cost_usd": 0.0, "budget_usd": float("inf")}, "finite"),
                (
                    {
                        "initial_cost_usd": 8.0,
                        "initial_uncertain_cost_usd": 3.0,
                        "budget_usd": 10.0,
                    },
                    "must not exceed",
                ),
            ):
                with self.subTest(kwargs=kwargs):
                    with self.assertRaisesRegex(ValueError, message):
                        run_model_batch.BudgetTracker(
                            state_path=state_path,
                            **kwargs,
                        )

    def test_budget_stop_latches_across_smaller_later_reservations(self) -> None:
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=4.9,
                budget_usd=5.0,
                state_path=Path(directory) / "budget.json",
            )
            with self.assertRaises(run_model_batch.BudgetExceeded):
                budget.reserve(0.2)
            with self.assertRaises(run_model_batch.BudgetExceeded):
                budget.reserve(0.01)
            snapshot = budget.snapshot()
            self.assertTrue(snapshot["exhausted"])
            self.assertIn("budget stop", snapshot["exhaustedReason"])


class SelectionSummaryTests(unittest.TestCase):
    def test_separates_proposed_selected_and_simulator_accepted_actions(self) -> None:
        usage_cost = {
            "inputTokens": 1_000,
            "cachedInputTokens": 0,
            "uncachedInputTokens": 1_000,
            "outputTokens": 20,
            "listCostUsd": 0.00024,
        }
        decisions = [
            {
                "decision": {
                    "metrics": {
                        "candidateCount": 3,
                        "candidateActionCount": 7,
                    }
                },
                "inferenceCalls": [],
                "decisionCalls": [
                    {
                        "response": {},
                        "usageCost": usage_cost,
                        "uncertainCostReserveUsd": 0.0,
                    }
                ],
                "selection": {
                    "route": "selected",
                    "selectedCandidateId": "plan_2",
                    "selectedActions": [
                        {
                            "type": "set_marketing",
                            "params": {"budgetCents": 200},
                        }
                    ],
                },
                "modelSubmitted": [
                    {"result": {"result": {"accepted": True}}}
                ],
            }
        ]
        export = {
            "results": {
                "leaderboard": [
                    {
                        "restaurantId": "model",
                        "cumulativeOperatingProfitCents": 1_000,
                    }
                ]
            },
            "environmentEvents": [],
            "logs": [],
        }

        summary = run_model_batch.summarize_run(
            slug="batch-glm-seed-4101001",
            game_id="game-1",
            model_key="glm",
            model=run_model_batch.MODELS["glm"],
            seed=4_101_001,
            status="completed",
            failure=None,
            decisions=decisions,
            export_data=export,
            started_at=0.0,
            budget={},
            decision_selector="clef",
            candidate_count=3,
            selection_min_probability=0.5,
        )

        self.assertEqual(summary["harnessMetrics"]["candidateActionCount"], 7)
        self.assertEqual(summary["decisionSelector"]["selectedActions"], 1)
        self.assertEqual(summary["simulatorAcceptance"]["accepted"], 1)
        self.assertEqual(summary["decisionUsage"]["inputTokens"], 1_000)
        self.assertEqual(
            summary["expectedPromptSha256"],
            run_model_batch.EXPECTED_CANDIDATE_PROMPT_SHA256[3],
        )

    def test_summarizes_verifier_routes_and_review_changes_separately(self) -> None:
        usage_cost = {
            "inputTokens": 1_000,
            "cachedInputTokens": 0,
            "uncachedInputTokens": 1_000,
            "outputTokens": 0,
            "listCostUsd": 0.00024,
        }
        decisions = [
            {
                "decision": {"metrics": {"attempts": 1}},
                "reviewDecision": {"metrics": {"attempts": 1}},
                "inferenceCalls": [],
                "decisionCalls": [
                    {
                        "response": {},
                        "usageCost": usage_cost,
                        "uncertainCostReserveUsd": 0.0,
                    }
                ],
                "verification": {
                    "route": "revision_required",
                    "requiresReview": True,
                    "revisionRequired": True,
                    "actionsChanged": True,
                },
                "modelSubmitted": [],
            }
        ]
        summary = run_model_batch.summarize_run(
            slug="holdout-clef-glm-seed-4101006",
            game_id="game-1",
            model_key="glm",
            model=run_model_batch.MODELS["glm"],
            seed=4_101_006,
            status="completed",
            failure=None,
            decisions=decisions,
            export_data=None,
            started_at=0.0,
            budget={},
            decision_selector="none",
            plan_verifier="clef",
            candidate_count=3,
            selection_min_probability=0.5,
        )

        verifier = summary["planVerifier"]
        self.assertEqual(verifier["routes"], {"revision_required": 1})
        self.assertEqual(verifier["reviewedDecisions"], 1)
        self.assertEqual(verifier["requiredRevisions"], 1)
        self.assertEqual(verifier["changedActionPlans"], 1)
        self.assertEqual(summary["reviewHarnessMetrics"], {"attempts": 1})
        self.assertEqual(summary["decisionUsage"]["listCostUsd"], 0.00024)


if __name__ == "__main__":
    unittest.main()
