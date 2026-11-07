from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from restaurant_sim.policies import (
    EXPECTED_POLICY_LIBRARY_SHA256,
    POLICIES,
    POLICY_IDS,
    PolicyController,
    policy_definitions,
    policy_library_sha256,
)


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_model_batch.py"
SPEC = importlib.util.spec_from_file_location("policy_batch_runner", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
run_model_batch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_model_batch)


def observation(tick: int = 0) -> dict[str, object]:
    return {
        "restaurantId": "model",
        "tick": tick,
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
            "bankrupt": False,
        },
        "recentEvents": [],
    }


def policy_candidates(count: int) -> list[dict[str, object]]:
    return run_model_batch.build_policy_candidates(
        [PolicyController(definition) for definition in policy_definitions(count)],
        observation(),
        tick=0,
    )


def clef_policy_response(
    count: int,
    *,
    solvency: dict[str, float] | None = None,
    scores: dict[str, float] | None = None,
) -> dict[str, object]:
    solvency = solvency or {}
    scores = scores or {}
    legend = {
        str(index): criterion
        for index, criterion in enumerate(run_model_batch.POLICY_PROFIT_CRITERIA)
    }
    answers: dict[str, object] = {}
    for definition in policy_definitions(count):
        score = scores.get(definition.policy_id, 3.0)
        level = int(score)
        probabilities = {str(index): 0.0 for index in range(7)}
        probabilities[str(level)] = 1.0
        answers[f"{definition.policy_id}_solvent"] = {
            "type": "noul",
            "noul": solvency.get(definition.policy_id, 0.5),
        }
        answers[f"{definition.policy_id}_profit_band"] = {
            "type": "score",
            "score": score,
            "legend": legend,
            "probabilities": probabilities,
            "confidence": 0.75,
        }
    return {
        "model": "clef",
        "answers": answers,
        "usage": {"input_tokens": 1_000, "output_tokens": 0},
    }


class PolicyLibraryTests(unittest.TestCase):
    def test_policy_order_diversity_descriptions_and_frozen_hash(self) -> None:
        self.assertEqual(tuple(policy.policy_id for policy in POLICIES), POLICY_IDS)
        self.assertEqual(len({json.dumps(policy.parameters(), sort_keys=True) for policy in POLICIES}), 10)
        self.assertTrue(all("through tick 84" in policy.description for policy in POLICIES))
        self.assertEqual(policy_library_sha256(), EXPECTED_POLICY_LIBRARY_SHA256)

    def test_five_arm_is_prefix_and_controllers_keep_independent_cadence(self) -> None:
        self.assertEqual(
            tuple(policy.policy_id for policy in policy_definitions(5)),
            POLICY_IDS[:5],
        )
        first = PolicyController(POLICIES[0])
        second = PolicyController(POLICIES[0])
        self.assertTrue(first.decide(observation(0), tick=0))
        self.assertTrue(second.decide(observation(1), tick=1))
        self.assertEqual(first.decide(observation(1), tick=1), [])

    def test_preflight_failure_fails_instead_of_dropping_policy(self) -> None:
        invalid = SimpleNamespace(
            definition=POLICIES[0],
            decide=lambda *_args, **_kwargs: [
                {
                    "type": "set_menu_price",
                    "params": {"dishId": "house", "priceCents": 1},
                }
            ],
        )
        with self.assertRaisesRegex(
            run_model_batch.BatchError, "balanced produced an invalid action list"
        ):
            run_model_batch.build_policy_candidates(
                [invalid], observation(), tick=0
            )


class PolicyContractTests(unittest.TestCase):
    def test_evaluator_url_is_derived_from_inference_origin(self) -> None:
        self.assertEqual(
            run_model_batch.derive_policy_evaluator_url(
                "https://relay.example/custom/inference?ignored=true"
            ),
            "https://relay.example/api/policy-evaluate",
        )

    def test_frozen_contract_hash_and_exact_request_for_five_and_ten(self) -> None:
        for count in (5, 10):
            with self.subTest(count=count):
                self.assertEqual(
                    run_model_batch.policy_evaluator_contract_sha256(count),
                    run_model_batch.EXPECTED_POLICY_EVALUATOR_CONTRACT_SHA256[count],
                )
                request = {
                    "model": run_model_batch.DECISION_MODEL["id"],
                    "state": {
                        "contractVersion": run_model_batch.POLICY_EVALUATOR_CONTRACT_VERSION,
                        "candidateCount": count,
                        "benchmarkObjective": run_model_batch.POLICY_BENCHMARK_OBJECTIVE,
                        "terminalTick": 84,
                        "observation": observation(),
                        "outcomeFeedback": None,
                        "candidates": policy_candidates(count),
                    },
                    "questions": run_model_batch.policy_questions(count),
                }
                self.assertTrue(
                    run_model_batch.policy_evaluator_request_matches_contract(
                        request, count
                    )
                )
                self.assertEqual(len(request["questions"]), count * 2)
                request["state"]["unexpected"] = True
                self.assertFalse(
                    run_model_batch.policy_evaluator_request_matches_contract(
                        request, count
                    )
                )

    def test_response_selection_tie_break_raw_scores_and_thresholds(self) -> None:
        candidates = policy_candidates(5)
        response = clef_policy_response(
            5,
            solvency={
                "balanced": 0.9,
                "cash_guard": 0.9,
                "maintenance_first": 0.8,
            },
            scores={"balanced": 5.0, "cash_guard": 5.0, "maintenance_first": 6.0},
        )
        with TemporaryDirectory() as directory:
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=1.0,
                state_path=Path(directory) / "budget.json",
            )
            calls: list[dict[str, object]] = []
            evaluator = run_model_batch.ClefPolicyEvaluator(
                evaluator_url="https://relay.example/api/policy-evaluate",
                admin_token="secret",
                budget=budget,
                call_records=calls,
                candidate_count=5,
            )
            with patch.object(
                run_model_batch,
                "json_request",
                return_value=(response, {}),
            ):
                result = evaluator(
                    observation=observation(),
                    outcome_feedback=None,
                    candidates=candidates,
                )

        self.assertEqual(result["selectedPolicyId"], "balanced")
        self.assertEqual(result["selectedActions"], candidates[0]["actions"])
        self.assertEqual(len(result["scores"]), 5)
        self.assertEqual(
            result["scores"][0]["rawProfitBandAnswer"],
            response["answers"]["balanced_profit_band"],
        )
        self.assertEqual(
            result["scores"][0]["profitThresholdProbabilities"]["5"], 1.0
        )
        self.assertTrue(
            run_model_batch.policy_evaluator_request_matches_contract(
                calls[0]["request"], 5
            )
        )
        self.assertEqual(calls[0]["usageCost"]["listCostUsd"], 0.00024)

    def test_rejects_wrong_answer_ids_legend_and_probability_vector(self) -> None:
        with TemporaryDirectory() as directory:
            evaluator = run_model_batch.ClefPolicyEvaluator(
                evaluator_url="https://relay.example/api/policy-evaluate",
                admin_token="secret",
                budget=run_model_batch.BudgetTracker(
                    initial_cost_usd=0.0,
                    budget_usd=1.0,
                    state_path=Path(directory) / "budget.json",
                ),
                call_records=[],
                candidate_count=5,
            )
            wrong_id = clef_policy_response(5)
            del wrong_id["answers"]["balanced_solvent"]
            wrong_legend = clef_policy_response(5)
            wrong_legend["answers"]["balanced_profit_band"]["legend"]["0"] = "wrong"
            wrong_vector = clef_policy_response(5)
            del wrong_vector["answers"]["balanced_profit_band"]["probabilities"]["6"]
            for value, message in (
                (wrong_id, "exactly the policy question IDs"),
                (wrong_legend, "legend does not match"),
                (wrong_vector, "cover levels 0 through 6"),
            ):
                with self.subTest(message=message):
                    with self.assertRaisesRegex(run_model_batch.BatchError, message):
                        evaluator._validate_response(value)

    def test_policy_evaluator_obeys_budget_before_transport(self) -> None:
        with TemporaryDirectory() as directory:
            evaluator = run_model_batch.ClefPolicyEvaluator(
                evaluator_url="https://relay.example/api/policy-evaluate",
                admin_token="secret",
                budget=run_model_batch.BudgetTracker(
                    initial_cost_usd=0.99,
                    budget_usd=1.0,
                    state_path=Path(directory) / "budget.json",
                ),
                call_records=[],
                candidate_count=5,
            )
            with (
                patch.object(run_model_batch, "json_request") as request,
                self.assertRaises(run_model_batch.BudgetExceeded),
            ):
                evaluator._request({"fixture": True})
            request.assert_not_called()


class PolicyRunnerTests(unittest.TestCase):
    def test_cli_rejects_incompatible_or_dishonest_policy_jobs(self) -> None:
        common = [
            "--batch-id",
            "invalid",
            "--token-file",
            "unused-token-file",
            "--output-dir",
            "unused-output",
            "--initial-cost-usd",
            "0",
        ]
        with self.assertRaisesRegex(SystemExit, "incompatible"):
            run_model_batch.main(
                common
                + [
                    "--models",
                    "policy",
                    "--policy-controller",
                    "clef",
                    "--decision-selector",
                    "clef",
                ]
            )
        with self.assertRaisesRegex(SystemExit, "require the policy model alias"):
            run_model_batch.main(common + ["--policy-controller", "fixed"])

    def test_fixed_policy_run_never_constructs_model_inference_and_records_trace(self) -> None:
        clock = {"tick": 0}

        class FakeClient:
            def __init__(self, *_args: object, **_kwargs: object) -> None:
                pass

            def state(self) -> dict[str, object]:
                return observation(clock["tick"])

        def fake_request(url: str, **kwargs: object) -> tuple[object, object]:
            if url.endswith("/api/games"):
                return (
                    {
                        "id": "policy-game",
                        "seats": [
                            {"restaurantId": "model", "token": "model-token"},
                            {"restaurantId": "heuristic", "token": "baseline-token"},
                        ],
                    },
                    {},
                )
            if url.endswith("/control/step"):
                clock["tick"] += int(kwargs["payload"]["ticks"])
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
            raise AssertionError(f"unexpected request {url}")

        def fake_submit(
            _client: object, actions: list[dict[str, object]], **_kwargs: object
        ) -> list[dict[str, object]]:
            return [
                {"action": action, "result": {"result": {"accepted": True}}}
                for action in actions
            ]

        with TemporaryDirectory() as directory:
            output = Path(directory)
            budget = run_model_batch.BudgetTracker(
                initial_cost_usd=0.0,
                budget_usd=1.0,
                state_path=output / "budget.json",
            )
            with (
                patch.object(run_model_batch, "MAX_TICKS", 3),
                patch.object(run_model_batch, "Client", FakeClient),
                patch.object(run_model_batch, "json_request", side_effect=fake_request),
                patch.object(
                    run_model_batch,
                    "ModelInference",
                    side_effect=AssertionError("generative inference was constructed"),
                ),
                patch.object(run_model_batch, "submit_actions", side_effect=fake_submit),
                patch.object(
                    run_model_batch.subprocess,
                    "run",
                    return_value=SimpleNamespace(stdout='{"verified":true}'),
                ),
                patch.dict(
                    os.environ,
                    {"RESTAURANT_SIM_ADMIN_TOKEN_FILE": "/tmp/test-token"},
                ),
            ):
                summary = run_model_batch.run_episode(
                    model_key="policy",
                    seed=4_101_011,
                    batch_id="fixed-policy-test",
                    base_url="https://relay.example",
                    inference_url="https://relay.example/api/inference",
                    decision_selector="none",
                    decision_url="https://relay.example/api/decision-select",
                    plan_verifier="none",
                    verifier_url="https://relay.example/api/plan-verify",
                    candidate_count=3,
                    selection_min_probability=0.5,
                    admin_token="admin-token",
                    output_root=output,
                    budget=budget,
                    policy_controller="fixed",
                    fixed_policy_id="balanced",
                )

            self.assertEqual(summary["status"], "completed")
            self.assertTrue(summary["archive"]["verified"])
            self.assertEqual(summary["usage"]["requests"], 0)
            self.assertEqual(summary["decisionUsage"]["requests"], 0)
            self.assertEqual(
                summary["policyController"]["selectedPolicies"], {"balanced": 1}
            )
            run_document = json.loads(
                (
                    output
                    / "fixed-policy-test-policy-seed-4101011"
                    / "run.json"
                ).read_text(encoding="utf-8")
            )
            self.assertIsNone(run_document["systemPrompt"])
            self.assertIsNone(run_document["providerRequestSettings"])
            decision = run_document["decisions"][0]
            self.assertEqual(decision["inferenceCalls"], [])
            self.assertEqual(decision["decisionCalls"], [])
            self.assertEqual(decision["policySelection"]["selectedPolicyId"], "balanced")
            self.assertEqual(len(decision["policyCandidates"]), 1)


if __name__ == "__main__":
    unittest.main()
