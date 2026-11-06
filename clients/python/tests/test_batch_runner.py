from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
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


if __name__ == "__main__":
    unittest.main()
