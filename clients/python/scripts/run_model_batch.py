#!/usr/bin/env python3
"""Run matched Restaurant Sim model episodes and archive every trace in R2."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


CLIENT_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = CLIENT_ROOT.parents[1]
sys.path.insert(0, str(CLIENT_ROOT))

from restaurant_sim.baseline import BaselineConfig, HeuristicBaseline  # noqa: E402
from restaurant_sim.client import Client, ClientError  # noqa: E402
from restaurant_sim.harness import (  # noqa: E402
    SYSTEM_PROMPT,
    SUPPORTED_CANDIDATE_COUNTS,
    CandidateDecision,
    CandidateDecisionHarness,
    DecisionHarness,
    build_outcome_feedback,
    candidate_system_prompt,
    candidate_system_prompt_sha256,
    review_decision,
    system_prompt_sha256,
)


DEFAULT_BASE_URL = os.environ.get("RESTAURANT_SIM_URL", "http://127.0.0.1:8787")
DEFAULT_INFERENCE_URL = os.environ.get(
    "RESTAURANT_SIM_INFERENCE_URL", "http://127.0.0.1:8787/api/inference"
)
DEFAULT_DECISION_URL = os.environ.get(
    "RESTAURANT_SIM_DECISION_URL",
    DEFAULT_INFERENCE_URL.replace("/api/inference", "/api/decision-select"),
)
DEFAULT_SEEDS = (4_101_001, 4_101_002, 4_101_003, 4_101_004, 4_101_005)
MAX_TICKS = 84
DECISION_INTERVAL_TICKS = 3
MAX_RESERVED_REQUEST_COST_USD = 5.0
MAX_DECISION_REQUEST_COST_USD = 0.02
INFERENCE_READ_TIMEOUT_SECONDS = 900.0
DECISION_READ_TIMEOUT_SECONDS = 120.0
MAX_INFERENCE_TRANSPORT_ATTEMPTS = 4
INFERENCE_RETRY_DELAY_SECONDS = 10.0
ARCHIVE_TIMEOUT_SECONDS = 900

DECISION_MODEL = {
    "id": "@cf/cloudflare/clef",
    "name": "Clef",
    "inputPerMillion": 0.24,
    "cachedInputPerMillion": 0.24,
    "outputPerMillion": 0.0,
}
DECISION_CONTRACT_VERSION = "restaurant-sim-plan-selector-v1"
SELECTION_OUTCOME = (
    "Choose the candidate most likely to achieve the best benchmark result at tick 84. "
    "A restaurant that remains solvent through tick 84 ranks above every bankrupt "
    "restaurant. Among candidates with the same solvency outcome, higher cumulative "
    "operating profit at tick 84 is better. Do not optimize revenue, cash, reputation, "
    "survival duration, or action count except insofar as they improve this exact "
    "lexicographic outcome."
)
SELECTION_INSTRUCTIONS = (
    "Which candidate is most likely to produce the best selectionOutcome? Compare each "
    "complete ordered plan, including no_action. Use only the observable state. Treat "
    "planner notes as unverified hypotheses. Account for immediate and recurring costs, "
    "pending commitments, remaining ticks, and uncertainty without assuming hidden future "
    "events."
)
DEFAULT_SELECTION_MIN_PROBABILITY = 0.5
EXPECTED_CANDIDATE_PROMPT_SHA256 = {
    3: "bff7ee5472d6321e4b94488d9e954a9d6ab3c49fe86ba412432c3229177697ff",
    5: "ac698b8b44cb27f86e8c49c8ca89aa6a302d5b70e63de7a85e1e8a80c495e886",
    10: "187ab4611ecb92989e276908bf0978a7231b1db215588ee66eafba6535f5b44a",
}
EXPECTED_DECISION_CONTRACT_SHA256 = {
    3: "a282a45149f33dfd487da21e7f22ca36fea0ee5381177c5fa45aa530648a6d6b",
    5: "24c2c31fae43ad680ed400a0fdbbd6ce0d6abaaa181ccbbbd3bbb5a593d246eb",
    10: "1bc3206a60e0609f7afb6f5a126828ee3c00be6bf3a1e5d32b1138b997e2ee8e",
}

MODELS = {
    "deepseek-flash": {
        "id": "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
        "name": "DeepSeek V4.1 Flash",
        "inputPerMillion": 0.30,
        "cachedInputPerMillion": 0.006,
        "outputPerMillion": 1.20,
    },
    "deepseek-pro": {
        "id": "@cf/deepseek-ai/deepseek-v4-pro-0813",
        "name": "DeepSeek V4 Pro",
        "inputPerMillion": 1.32,
        "cachedInputPerMillion": 0.044,
        "outputPerMillion": 3.96,
    },
    "glm-flash": {
        "id": "@cf/zai-org/glm-5.3-flash",
        "name": "GLM-5.3 Flash",
        "inputPerMillion": 0.15,
        "cachedInputPerMillion": 0.03,
        "outputPerMillion": 0.50,
    },
    "glm": {
        "id": "@cf/zai-org/glm-5.3",
        "name": "GLM-5.3",
        "inputPerMillion": 1.40,
        "cachedInputPerMillion": 0.26,
        "outputPerMillion": 4.40,
    },
}


class BatchError(RuntimeError):
    """A batch operation failed with a safe-to-record message."""


class BudgetExceeded(BatchError):
    """No additional inference may start within the aggregate budget."""


class BudgetTracker:
    """Coordinate a conservative aggregate list-cost ceiling across threads."""

    def __init__(
        self,
        *,
        initial_cost_usd: float,
        initial_uncertain_cost_usd: float = 0.0,
        budget_usd: float,
        state_path: Path,
    ) -> None:
        for name, value in (
            ("initial_cost_usd", initial_cost_usd),
            ("initial_uncertain_cost_usd", initial_uncertain_cost_usd),
        ):
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{name} must be finite and nonnegative")
        if not math.isfinite(budget_usd) or budget_usd <= 0:
            raise ValueError("budget_usd must be finite and greater than zero")
        if initial_cost_usd + initial_uncertain_cost_usd > budget_usd:
            raise ValueError("initial budget exposure must not exceed budget_usd")
        self._lock = threading.Lock()
        self.initial_cost_usd = initial_cost_usd
        self.initial_uncertain_cost_usd = initial_uncertain_cost_usd
        self.budget_usd = budget_usd
        self.new_cost_usd = 0.0
        self.new_uncertain_cost_usd = 0.0
        self.reserved_usd = 0.0
        self.requests = 0
        self.failed_requests = 0
        self.state_path = state_path
        self._write_locked()

    def reserve(self, amount_usd: float = MAX_RESERVED_REQUEST_COST_USD) -> None:
        with self._lock:
            projected = (
                self.initial_cost_usd
                + self.new_cost_usd
                + self.initial_uncertain_cost_usd
                + self.new_uncertain_cost_usd
                + self.reserved_usd
                + amount_usd
            )
            if projected > self.budget_usd:
                raise BudgetExceeded(
                    "aggregate budget stop: another uncapped inference could exceed "
                    f"${self.budget_usd:.2f}"
                )
            self.reserved_usd += amount_usd
            self._write_locked()

    def complete(
        self,
        actual_cost_usd: float,
        reserved_usd: float = MAX_RESERVED_REQUEST_COST_USD,
    ) -> None:
        with self._lock:
            self.reserved_usd -= reserved_usd
            self.new_cost_usd += actual_cost_usd
            self.requests += 1
            if self.budget_exposure_usd > self.budget_usd:
                raise BudgetExceeded(
                    "aggregate conservative budget exposure reached "
                    f"${self.budget_exposure_usd:.6f}"
                )
            self._write_locked()

    def fail_uncertain(
        self, reserved_usd: float = MAX_RESERVED_REQUEST_COST_USD
    ) -> None:
        with self._lock:
            self.reserved_usd -= reserved_usd
            self.new_uncertain_cost_usd += reserved_usd
            self.failed_requests += 1
            self._write_locked()

    def cancel(self, reserved_usd: float = MAX_RESERVED_REQUEST_COST_USD) -> None:
        with self._lock:
            self.reserved_usd -= reserved_usd
            self._write_locked()

    @property
    def total_cost_usd(self) -> float:
        return self.initial_cost_usd + self.new_cost_usd

    @property
    def uncertain_cost_usd(self) -> float:
        return self.initial_uncertain_cost_usd + self.new_uncertain_cost_usd

    @property
    def budget_exposure_usd(self) -> float:
        return self.total_cost_usd + self.uncertain_cost_usd + self.reserved_usd

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot_locked()

    def _snapshot_locked(self) -> dict[str, Any]:
        return {
            "budgetUsd": self.budget_usd,
            "initialTrackedCostUsd": self.initial_cost_usd,
            "newTrackedCostUsd": self.new_cost_usd,
            "totalTrackedCostUsd": self.total_cost_usd,
            "initialUncertainCostReserveUsd": self.initial_uncertain_cost_usd,
            "newUncertainCostReserveUsd": self.new_uncertain_cost_usd,
            "uncertainCostReserveUsd": self.uncertain_cost_usd,
            "conservativeBudgetExposureUsd": self.budget_exposure_usd,
            "reservedUsd": self.reserved_usd,
            "completedInferenceRequests": self.requests,
            "failedInferenceRequests": self.failed_requests,
            "reservationPerRequestUsd": MAX_RESERVED_REQUEST_COST_USD,
        }

    def _write_locked(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(self._snapshot_locked(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(self.state_path)


def json_request(
    url: str,
    *,
    method: str = "GET",
    token: str | None = None,
    payload: Any = None,
    accept: str = "application/json",
    timeout: float = 120.0,
) -> tuple[Any, dict[str, str]]:
    headers = {"Accept": accept, "User-Agent": "restaurant-sim-batch/1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if payload is not None:
        body = json.dumps(
            payload, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            response_headers = {key.lower(): value for key, value in response.headers.items()}
    except HTTPError as error:
        raw = error.read()
        try:
            detail = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            detail = raw.decode("utf-8", errors="replace")[:2_000]
        raise BatchError(f"HTTP {error.code} from {url}: {detail}") from None
    except (URLError, TimeoutError, OSError) as error:
        raise BatchError(f"request to {url} failed: {error}") from error
    if accept == "application/x-ndjson" or response_headers.get(
        "content-type", ""
    ).startswith("text/event-stream"):
        return raw.decode("utf-8"), response_headers
    try:
        return json.loads(raw.decode("utf-8")), response_headers
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BatchError(f"invalid JSON from {url}") from error


def parse_chat_completion_stream(raw: str) -> dict[str, Any]:
    """Reassemble an OpenAI-compatible SSE stream without dropping raw chunks."""
    chunks: list[dict[str, Any]] = []
    for event in raw.replace("\r\n", "\n").split("\n\n"):
        data = "\n".join(
            line[5:].lstrip()
            for line in event.splitlines()
            if line.startswith("data:")
        )
        if not data or data == "[DONE]":
            continue
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError as error:
            raise BatchError("invalid JSON event from Workers AI stream") from error
        if not isinstance(chunk, dict):
            raise BatchError("Workers AI stream event must be a JSON object")
        chunks.append(chunk)
    if not chunks:
        raise BatchError("Workers AI stream did not contain completion events")

    content: list[str] = []
    reasoning: list[str] = []
    finish_reason: Any = None
    usage: dict[str, Any] = {}
    role = "assistant"
    for chunk in chunks:
        if isinstance(chunk.get("usage"), dict):
            usage = chunk["usage"]
        choices = chunk.get("choices")
        if not isinstance(choices, list) or not choices:
            continue
        choice = choices[0]
        if not isinstance(choice, dict):
            continue
        if choice.get("finish_reason") is not None:
            finish_reason = choice["finish_reason"]
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            continue
        if isinstance(delta.get("role"), str):
            role = delta["role"]
        if isinstance(delta.get("content"), str):
            content.append(delta["content"])
        for key in ("reasoning_content", "reasoning"):
            if isinstance(delta.get(key), str):
                reasoning.append(delta[key])
                break

    first = chunks[0]
    response: dict[str, Any] = {
        "id": first.get("id"),
        "object": "chat.completion",
        "created": first.get("created"),
        "model": first.get("model"),
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": role,
                    "content": "".join(content),
                    "reasoning_content": "".join(reasoning),
                },
                "finish_reason": finish_reason,
            }
        ],
        "usage": usage,
        "stream": {"chunks": chunks},
    }
    return response


def usage_cost(model: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    usage = response.get("usage")
    usage = usage if isinstance(usage, dict) else {}
    input_tokens = _int(usage.get("prompt_tokens", usage.get("input_tokens")))
    output_tokens = _int(
        usage.get("completion_tokens", usage.get("output_tokens"))
    )
    details = usage.get("prompt_tokens_details")
    details = details if isinstance(details, dict) else {}
    cached_tokens = _int(details.get("cached_tokens", usage.get("cached_tokens")))
    cached_tokens = min(cached_tokens, input_tokens)
    uncached_tokens = input_tokens - cached_tokens
    cost = (
        uncached_tokens * model["inputPerMillion"]
        + cached_tokens * model["cachedInputPerMillion"]
        + output_tokens * model["outputPerMillion"]
    ) / 1_000_000
    return {
        "inputTokens": input_tokens,
        "cachedInputTokens": cached_tokens,
        "uncachedInputTokens": uncached_tokens,
        "outputTokens": output_tokens,
        "listCostUsd": cost,
        "neurons": usage.get("neurons"),
    }


def retryable_inference_error(error: BatchError) -> bool:
    message = str(error)
    return message.startswith("request to ") or any(
        message.startswith(f"HTTP {status} ") for status in (502, 503, 504)
    )


def empty_usage_cost() -> dict[str, Any]:
    return {
        "inputTokens": 0,
        "cachedInputTokens": 0,
        "uncachedInputTokens": 0,
        "outputTokens": 0,
        "listCostUsd": 0.0,
        "neurons": None,
    }


class ModelInference:
    def __init__(
        self,
        *,
        inference_url: str,
        admin_token: str,
        model: dict[str, Any],
        budget: BudgetTracker,
        call_records: list[dict[str, Any]],
    ) -> None:
        self.url = inference_url
        self.admin_token = admin_token
        self.model = model
        self.budget = budget
        self.call_records = call_records

    def __call__(self, messages: list[dict[str, str]]) -> Any:
        request_payload = {
            "model": self.model["id"],
            "messages": messages,
            "reasoning_effort": "high",
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
        }
        forbidden = {
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
        }
        if forbidden.intersection(request_payload):
            raise AssertionError("an explicit completion-token cap was added")

        for transport_attempt in range(1, MAX_INFERENCE_TRANSPORT_ATTEMPTS + 1):
            self.budget.reserve()
            started_at = time.time()
            try:
                response, _ = json_request(
                    self.url,
                    method="POST",
                    token=self.admin_token,
                    payload=request_payload,
                    timeout=INFERENCE_READ_TIMEOUT_SECONDS,
                )
                if isinstance(response, str):
                    response = parse_chat_completion_stream(response)
                if not isinstance(response, dict):
                    raise BatchError("Workers AI response must be a JSON object")
                cost = usage_cost(self.model, response)
            except BatchError as error:
                retryable = retryable_inference_error(error)
                if retryable:
                    self.budget.fail_uncertain()
                else:
                    self.budget.cancel()
                self.call_records.append(
                    {
                        "startedAt": started_at,
                        "completedAt": time.time(),
                        "transportAttempt": transport_attempt,
                        "request": request_payload,
                        "error": {
                            "type": type(error).__name__,
                            "message": str(error),
                            "retryable": retryable,
                        },
                        "usageCost": empty_usage_cost(),
                        "uncertainCostReserveUsd": (
                            MAX_RESERVED_REQUEST_COST_USD if retryable else 0.0
                        ),
                        "aggregateBudgetAfter": self.budget.snapshot(),
                    }
                )
                if (
                    not retryable
                    or transport_attempt == MAX_INFERENCE_TRANSPORT_ATTEMPTS
                ):
                    raise
                time.sleep(INFERENCE_RETRY_DELAY_SECONDS)
                continue
            except BaseException:
                self.budget.cancel()
                raise
            self.budget.complete(cost["listCostUsd"])
            self.call_records.append(
                {
                    "startedAt": started_at,
                    "completedAt": time.time(),
                    "transportAttempt": transport_attempt,
                    "request": request_payload,
                    "response": response,
                    "usageCost": cost,
                    "uncertainCostReserveUsd": 0.0,
                    "aggregateBudgetAfter": self.budget.snapshot(),
                }
            )
            return response
        raise AssertionError("inference transport attempts exhausted without a result")


def decision_candidate_ids(candidate_count: int) -> tuple[str, ...]:
    if candidate_count not in SUPPORTED_CANDIDATE_COUNTS:
        raise ValueError(
            "candidate_count must be one of "
            + ", ".join(str(count) for count in SUPPORTED_CANDIDATE_COUNTS)
        )
    return tuple(f"plan_{index}" for index in range(candidate_count)) + ("no_action",)


def decision_criterion(candidate_id: str) -> str:
    return (
        f"The complete ordered {candidate_id} plan in state.candidates. Judge the "
        "plan as a whole, not merely its first action."
    )


def decision_criteria(candidate_count: int) -> dict[str, str]:
    return {
        candidate_id: decision_criterion(candidate_id)
        for candidate_id in decision_candidate_ids(candidate_count)
    }


def decision_contract_sha256(
    minimum_probability: float, candidate_count: int = 3
) -> str:
    contract = {
        "candidateCount": candidate_count,
        "candidateIds": decision_candidate_ids(candidate_count),
        "contractVersion": DECISION_CONTRACT_VERSION,
        "lowProbabilityFallback": "no_action",
        "minimumProbability": minimum_probability,
        "model": DECISION_MODEL["id"],
        "question": {
            "criteria": decision_criteria(candidate_count),
            "id": "terminal_outcome",
            "instructions": SELECTION_INSTRUCTIONS,
            "type": "choice",
        },
        "selectionOutcome": SELECTION_OUTCOME,
    }
    encoded = json.dumps(
        contract, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def decision_request_matches_contract(
    request: Any, candidate_count: int
) -> bool:
    if not isinstance(request, dict) or set(request) != {"model", "state", "questions"}:
        return False
    state = request.get("state")
    questions = request.get("questions")
    if not isinstance(state, dict) or not isinstance(questions, dict):
        return False
    candidates = state.get("candidates")
    if not isinstance(candidates, list):
        return False
    return (
        request.get("model") == DECISION_MODEL["id"]
        and set(state)
        == {
            "contractVersion",
            "candidateCount",
            "selectionOutcome",
            "observation",
            "outcomeFeedback",
            "candidates",
        }
        and state.get("contractVersion") == DECISION_CONTRACT_VERSION
        and state.get("candidateCount") == candidate_count
        and state.get("selectionOutcome") == SELECTION_OUTCOME
        and [
            candidate.get("candidateId")
            for candidate in candidates
            if isinstance(candidate, dict)
        ]
        == list(decision_candidate_ids(candidate_count))
        and questions
        == {
            "terminal_outcome": {
                "type": "choice",
                "instructions": SELECTION_INSTRUCTIONS,
                "criteria": decision_criteria(candidate_count),
            }
        }
    )


class ClefPlanSelector:
    """Choose one planner-generated action bundle against the benchmark outcome."""

    def __init__(
        self,
        *,
        decision_url: str,
        admin_token: str,
        budget: BudgetTracker,
        call_records: list[dict[str, Any]],
        candidate_count: int = 3,
        minimum_probability: float = DEFAULT_SELECTION_MIN_PROBABILITY,
    ) -> None:
        if not 0.0 < minimum_probability <= 1.0:
            raise ValueError("minimum_probability must be greater than 0 and at most 1")
        self.url = decision_url
        self.admin_token = admin_token
        self.budget = budget
        self.call_records = call_records
        self.candidate_count = candidate_count
        self.candidate_ids = decision_candidate_ids(candidate_count)
        self.minimum_probability = minimum_probability

    def __call__(
        self,
        *,
        observation: dict[str, Any],
        outcome_feedback: dict[str, Any] | None,
        decision: CandidateDecision,
    ) -> dict[str, Any]:
        if len(decision.candidates) != self.candidate_count:
            raise BatchError(
                f"planner did not produce {self.candidate_count} selectable candidates"
            )

        candidates = [
            {
                "candidateId": candidate.candidate_id,
                "actions": list(candidate.actions),
                "note": candidate.note,
                "previews": [asdict(preview) for preview in candidate.review.previews],
                "projected": candidate.review.projected,
            }
            for candidate in decision.candidates
        ]
        no_action_review = review_decision({"actions": []}, observation)
        candidates.append(
            {
                "candidateId": "no_action",
                "actions": [],
                "note": (
                    "Submit no actions this tick; current settings and pending commitments "
                    "continue unchanged."
                ),
                "previews": [],
                "projected": no_action_review.projected,
            }
        )
        request_payload = {
            "model": DECISION_MODEL["id"],
            "state": {
                "contractVersion": DECISION_CONTRACT_VERSION,
                "candidateCount": self.candidate_count,
                "selectionOutcome": SELECTION_OUTCOME,
                "observation": observation,
                "outcomeFeedback": outcome_feedback,
                "candidates": candidates,
            },
            "questions": {
                "terminal_outcome": {
                    "type": "choice",
                    "instructions": SELECTION_INSTRUCTIONS,
                    "criteria": decision_criteria(self.candidate_count),
                }
            },
        }

        response = self._request(request_payload)
        answer = self._validate_response(response)
        model_choice = answer["choice"]
        probabilities = answer["probabilities"]
        model_choice_probability = probabilities[model_choice]
        selected_candidate_id = model_choice
        route = "selected"
        if model_choice == "no_action":
            route = "no_action_selected"
        elif model_choice_probability < self.minimum_probability:
            selected_candidate_id = "no_action"
            route = "low_probability_fallback"
        selected = next(
            candidate
            for candidate in candidates
            if candidate["candidateId"] == selected_candidate_id
        )
        return {
            "contractVersion": DECISION_CONTRACT_VERSION,
            "contractSha256": decision_contract_sha256(
                self.minimum_probability, self.candidate_count
            ),
            "model": DECISION_MODEL["id"],
            "candidateCount": self.candidate_count,
            "minimumProbability": self.minimum_probability,
            "selectionOutcome": SELECTION_OUTCOME,
            "modelChoice": model_choice,
            "modelChoiceProbability": model_choice_probability,
            "confidence": answer["confidence"],
            "probabilities": probabilities,
            "route": route,
            "selectedCandidateId": selected_candidate_id,
            "selectedActions": selected["actions"],
        }

    def _request(self, request_payload: dict[str, Any]) -> dict[str, Any]:
        for transport_attempt in range(1, MAX_INFERENCE_TRANSPORT_ATTEMPTS + 1):
            self.budget.reserve(MAX_DECISION_REQUEST_COST_USD)
            started_at = time.time()
            try:
                response, _ = json_request(
                    self.url,
                    method="POST",
                    token=self.admin_token,
                    payload=request_payload,
                    timeout=DECISION_READ_TIMEOUT_SECONDS,
                )
                if not isinstance(response, dict):
                    raise BatchError("Clef response must be a JSON object")
            except BatchError as error:
                retryable = retryable_inference_error(error)
                if retryable:
                    self.budget.fail_uncertain(MAX_DECISION_REQUEST_COST_USD)
                else:
                    self.budget.cancel(MAX_DECISION_REQUEST_COST_USD)
                self.call_records.append(
                    {
                        "startedAt": started_at,
                        "completedAt": time.time(),
                        "transportAttempt": transport_attempt,
                        "request": request_payload,
                        "error": {
                            "type": type(error).__name__,
                            "message": str(error),
                            "retryable": retryable,
                        },
                        "usageCost": empty_usage_cost(),
                        "uncertainCostReserveUsd": (
                            MAX_DECISION_REQUEST_COST_USD if retryable else 0.0
                        ),
                        "aggregateBudgetAfter": self.budget.snapshot(),
                    }
                )
                if (
                    not retryable
                    or transport_attempt == MAX_INFERENCE_TRANSPORT_ATTEMPTS
                ):
                    raise
                time.sleep(INFERENCE_RETRY_DELAY_SECONDS)
                continue
            except BaseException:
                self.budget.cancel(MAX_DECISION_REQUEST_COST_USD)
                raise

            try:
                self._validate_usage(response)
                cost = usage_cost(DECISION_MODEL, response)
            except BatchError as error:
                self.budget.fail_uncertain(MAX_DECISION_REQUEST_COST_USD)
                self.call_records.append(
                    {
                        "startedAt": started_at,
                        "completedAt": time.time(),
                        "transportAttempt": transport_attempt,
                        "request": request_payload,
                        "response": response,
                        "error": {
                            "type": type(error).__name__,
                            "message": str(error),
                            "retryable": False,
                        },
                        "usageCost": empty_usage_cost(),
                        "uncertainCostReserveUsd": MAX_DECISION_REQUEST_COST_USD,
                        "aggregateBudgetAfter": self.budget.snapshot(),
                    }
                )
                raise

            try:
                self._validate_response(response)
            except BatchError as error:
                self.budget.complete(
                    cost["listCostUsd"], MAX_DECISION_REQUEST_COST_USD
                )
                self.call_records.append(
                    {
                        "startedAt": started_at,
                        "completedAt": time.time(),
                        "transportAttempt": transport_attempt,
                        "request": request_payload,
                        "response": response,
                        "error": {
                            "type": type(error).__name__,
                            "message": str(error),
                            "retryable": False,
                        },
                        "usageCost": cost,
                        "uncertainCostReserveUsd": 0.0,
                        "aggregateBudgetAfter": self.budget.snapshot(),
                    }
                )
                raise

            self.budget.complete(
                cost["listCostUsd"], MAX_DECISION_REQUEST_COST_USD
            )
            self.call_records.append(
                {
                    "startedAt": started_at,
                    "completedAt": time.time(),
                    "transportAttempt": transport_attempt,
                    "request": request_payload,
                    "response": response,
                    "usageCost": cost,
                    "uncertainCostReserveUsd": 0.0,
                    "aggregateBudgetAfter": self.budget.snapshot(),
                }
            )
            return response
        raise AssertionError("decision transport attempts exhausted without a result")

    @staticmethod
    def _validate_usage(response: dict[str, Any]) -> None:
        if response.get("model") != "clef":
            raise BatchError("Clef response model must be clef")
        usage = response.get("usage")
        if not isinstance(usage, dict):
            raise BatchError("Clef response must contain usage")
        for field in ("input_tokens", "output_tokens"):
            value = usage.get(field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise BatchError(
                    f"Clef usage {field} must be a nonnegative integer"
                )

    def _validate_response(self, response: dict[str, Any]) -> dict[str, Any]:
        answers = response.get("answers")
        if not isinstance(answers, dict) or set(answers) != {"terminal_outcome"}:
            raise BatchError("Clef response must contain only terminal_outcome")
        answer = answers["terminal_outcome"]
        if not isinstance(answer, dict) or answer.get("type") != "choice":
            raise BatchError("Clef terminal_outcome must be a choice answer")
        choice = answer.get("choice")
        if choice not in self.candidate_ids:
            raise BatchError("Clef selected an unknown candidate")
        probabilities = answer.get("probabilities")
        if not isinstance(probabilities, dict) or set(probabilities) != set(
            self.candidate_ids
        ):
            raise BatchError("Clef probabilities must cover exactly the candidate IDs")
        for candidate_id, probability in probabilities.items():
            if (
                isinstance(probability, bool)
                or not isinstance(probability, (int, float))
                or not 0.0 <= probability <= 1.0
            ):
                raise BatchError(
                    f"Clef probability for {candidate_id} must be between 0 and 1"
                )
        if abs(sum(probabilities.values()) - 1.0) > 0.01:
            raise BatchError("Clef probabilities must sum to 1")
        confidence = answer.get("confidence")
        if (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not 0.0 <= confidence <= 1.0
        ):
            raise BatchError("Clef confidence must be between 0 and 1")
        if probabilities[choice] + 1e-12 < max(probabilities.values()):
            raise BatchError("Clef choice must have the highest probability")
        return answer


def submit_actions(
    client: Client,
    actions: list[dict[str, Any]],
    *,
    request_prefix: str,
) -> list[dict[str, Any]]:
    submitted: list[dict[str, Any]] = []
    for index, action in enumerate(actions):
        request_id = f"{request_prefix}-{index}-{action['type']}"
        try:
            response = client.act(
                action["type"], request_id=request_id, **action["params"]
            )
            submitted.append(
                {
                    "action": action,
                    "requestId": request_id,
                    "result": response,
                }
            )
        except ClientError as error:
            submitted.append(
                {
                    "action": action,
                    "requestId": request_id,
                    "clientError": error.as_dict(),
                }
            )
    return submitted


def run_episode(
    *,
    model_key: str,
    seed: int,
    batch_id: str,
    base_url: str,
    inference_url: str,
    decision_selector: str,
    decision_url: str,
    candidate_count: int,
    selection_min_probability: float,
    admin_token: str,
    output_root: Path,
    budget: BudgetTracker,
) -> dict[str, Any]:
    model = MODELS[model_key]
    slug = f"{batch_id}-{model_key}-seed-{seed}"
    run_dir = output_root / slug
    run_dir.mkdir(parents=True, exist_ok=False)
    checkpoint_path = run_dir / "checkpoint.ndjson"
    run_path = run_dir / "run.json"
    export_path = run_dir / "game-export.json"
    export_jsonl_path = run_dir / "game-export.jsonl"
    game_id: str | None = None
    decisions: list[dict[str, Any]] = []
    status = "failed"
    failure: dict[str, Any] | None = None
    started_at = time.time()

    try:
        created, _ = json_request(
            f"{base_url}/api/games",
            method="POST",
            token=admin_token,
            payload={
                "seed": seed,
                "maxTicks": MAX_TICKS,
                "restaurants": [
                    {"id": "model", "name": model["name"]},
                    {"id": "heuristic", "name": "Heuristic Baseline"},
                ],
            },
        )
        game_id = created["id"]
        seat_tokens = {
            seat["restaurantId"]: seat["token"] for seat in created["seats"]
        }
        model_client = Client(base_url, game_id, seat_tokens["model"], timeout=60.0)
        heuristic_client = Client(
            base_url, game_id, seat_tokens["heuristic"], timeout=60.0
        )
        baseline = HeuristicBaseline(
            BaselineConfig(decision_interval_ticks=DECISION_INTERVAL_TICKS)
        )
        harness = (
            CandidateDecisionHarness(candidate_count=candidate_count)
            if decision_selector == "clef"
            else DecisionHarness()
        )
        previous_model_observation: dict[str, Any] | None = None
        previous_model_results: list[dict[str, Any]] = []

        for tick in range(0, MAX_TICKS, DECISION_INTERVAL_TICKS):
            model_observation = model_client.state()
            heuristic_observation = heuristic_client.state()
            if model_observation["tick"] != tick or heuristic_observation["tick"] != tick:
                raise BatchError(
                    f"expected tick {tick}, got model={model_observation['tick']} "
                    f"heuristic={heuristic_observation['tick']}"
                )

            feedback = None
            if previous_model_observation is not None:
                feedback = build_outcome_feedback(
                    previous_model_observation,
                    model_observation,
                    previous_model_results,
                )

            inference_calls: list[dict[str, Any]] = []
            decision_calls: list[dict[str, Any]] = []
            selection: dict[str, Any] | None = None
            model_submitted: list[dict[str, Any]] = []
            restaurant = model_observation.get("restaurant", {})
            if not restaurant.get("bankrupt", False):
                inference = ModelInference(
                    inference_url=inference_url,
                    admin_token=admin_token,
                    model=model,
                    budget=budget,
                    call_records=inference_calls,
                )
                try:
                    decision = harness.decide(
                        model_observation,
                        inference,
                        outcome_feedback=feedback,
                    )
                except BaseException as decision_error:
                    failed_record = {
                        "tick": tick,
                        "observation": model_observation,
                        "outcomeFeedback": feedback,
                        "decision": None,
                        "inferenceCalls": inference_calls,
                        "decisionCalls": decision_calls,
                        "selection": None,
                        "modelSubmitted": [],
                        "heuristicObservation": heuristic_observation,
                        "heuristicSuggested": [],
                        "heuristicSubmitted": [],
                        "stepResult": None,
                        "failure": {
                            "stage": "model_inference",
                            "type": type(decision_error).__name__,
                            "message": str(decision_error),
                        },
                    }
                    decisions.append(failed_record)
                    with checkpoint_path.open("a", encoding="utf-8") as checkpoint:
                        checkpoint.write(
                            json.dumps(failed_record, separators=(",", ":")) + "\n"
                        )
                    raise
                if decision_selector == "clef":
                    selection_stage = "decision_selection"
                    try:
                        if len(decision.candidates) != candidate_count:
                            selection_stage = "candidate_generation"
                            raise BatchError(
                                f"planner did not produce {candidate_count} valid candidates"
                            )
                        selector = ClefPlanSelector(
                            decision_url=decision_url,
                            admin_token=admin_token,
                            budget=budget,
                            call_records=decision_calls,
                            candidate_count=candidate_count,
                            minimum_probability=selection_min_probability,
                        )
                        selection = selector(
                            observation=model_observation,
                            outcome_feedback=feedback,
                            decision=decision,
                        )
                    except BaseException as selection_error:
                        failed_record = {
                            "tick": tick,
                            "observation": model_observation,
                            "outcomeFeedback": feedback,
                            "decision": asdict(decision),
                            "inferenceCalls": inference_calls,
                            "decisionCalls": decision_calls,
                            "selection": None,
                            "modelSubmitted": [],
                            "heuristicObservation": heuristic_observation,
                            "heuristicSuggested": [],
                            "heuristicSubmitted": [],
                            "stepResult": None,
                            "failure": {
                                "stage": selection_stage,
                                "type": type(selection_error).__name__,
                                "message": str(selection_error),
                            },
                        }
                        decisions.append(failed_record)
                        with checkpoint_path.open(
                            "a", encoding="utf-8"
                        ) as checkpoint:
                            checkpoint.write(
                                json.dumps(failed_record, separators=(",", ":"))
                                + "\n"
                            )
                        raise
                    model_actions = list(selection["selectedActions"])
                else:
                    model_actions = list(decision.actions)
                model_submitted = submit_actions(
                    model_client,
                    model_actions,
                    request_prefix=f"{slug}-t{tick:03d}",
                )
                decision_record: dict[str, Any] | None = asdict(decision)
            else:
                model_actions = []
                decision_record = None

            heuristic_intents = baseline.decide(
                heuristic_observation, tick=tick
            )
            heuristic_actions = [
                {"type": intent.action_type, "params": intent.params}
                for intent in heuristic_intents
            ]
            heuristic_submitted = submit_actions(
                heuristic_client,
                heuristic_actions,
                request_prefix=f"heuristic-{slug}-t{tick:03d}",
            )

            step_result, _ = json_request(
                f"{base_url}/api/games/{quote(game_id, safe='')}/control/step",
                method="POST",
                token=admin_token,
                payload={"ticks": min(DECISION_INTERVAL_TICKS, MAX_TICKS - tick)},
            )
            record = {
                "tick": tick,
                "observation": model_observation,
                "outcomeFeedback": feedback,
                "decision": decision_record,
                "inferenceCalls": inference_calls,
                "decisionCalls": decision_calls,
                "selection": selection,
                "modelSubmitted": model_submitted,
                "heuristicObservation": heuristic_observation,
                "heuristicSuggested": [asdict(intent) for intent in heuristic_intents],
                "heuristicSubmitted": heuristic_submitted,
                "stepResult": step_result,
            }
            decisions.append(record)
            with checkpoint_path.open("a", encoding="utf-8") as checkpoint:
                checkpoint.write(json.dumps(record, separators=(",", ":")) + "\n")
            previous_model_observation = model_observation
            previous_model_results = model_submitted

        final_model_observation = model_client.state()
        final_heuristic_observation = heuristic_client.state()
        if final_model_observation["tick"] != MAX_TICKS:
            raise BatchError("episode did not reach the terminal tick")
        status = "completed"
    except BaseException as error:
        failure = {
            "type": type(error).__name__,
            "message": str(error),
            "traceback": traceback.format_exc(),
        }
        final_model_observation = None
        final_heuristic_observation = None
    finally:
        export_data = None
        export_jsonl = None
        if game_id is not None:
            try:
                export_data, _ = json_request(
                    f"{base_url}/api/games/{quote(game_id, safe='')}/export",
                    token=admin_token,
                )
                export_jsonl, _ = json_request(
                    f"{base_url}/api/games/{quote(game_id, safe='')}/export?format=jsonl",
                    token=admin_token,
                    accept="application/x-ndjson",
                )
                export_path.write_text(
                    json.dumps(export_data, separators=(",", ":")) + "\n",
                    encoding="utf-8",
                )
                export_jsonl_path.write_text(export_jsonl, encoding="utf-8")
            except BaseException as export_error:
                if failure is None:
                    failure = {
                        "type": type(export_error).__name__,
                        "message": f"export failed: {export_error}",
                        "traceback": traceback.format_exc(),
                    }
                    status = "failed"

        summary = summarize_run(
            slug=slug,
            game_id=game_id,
            model_key=model_key,
            model=model,
            seed=seed,
            status=status,
            failure=failure,
            decisions=decisions,
            export_data=export_data,
            started_at=started_at,
            budget=budget.snapshot(),
            decision_selector=decision_selector,
            candidate_count=candidate_count,
            selection_min_probability=selection_min_probability,
        )
        prompt = (
            candidate_system_prompt(candidate_count)
            if decision_selector == "clef"
            else SYSTEM_PROMPT
        )
        prompt_sha256 = (
            candidate_system_prompt_sha256(candidate_count)
            if decision_selector == "clef"
            else system_prompt_sha256()
        )
        recorded_decision_requests = [
            call["request"]
            for decision in decisions
            for call in decision.get("decisionCalls", [])
            if "request" in call
        ]
        run_document = {
            "summary": summary,
            "systemPrompt": prompt,
            "providerRequestSettings": {
                "reasoningEffort": "high",
                "temperature": 0.2,
                "responseFormat": {"type": "json_object"},
                "explicitCompletionTokenLimit": None,
            },
            "decisionSelector": (
                {
                    "model": DECISION_MODEL["id"],
                    "contractVersion": DECISION_CONTRACT_VERSION,
                    "contractSha256": decision_contract_sha256(
                        selection_min_probability, candidate_count
                    ),
                    "expectedContractSha256": EXPECTED_DECISION_CONTRACT_SHA256[
                        candidate_count
                    ],
                    "candidateCount": candidate_count,
                    "minimumProbability": selection_min_probability,
                    "selectionOutcome": SELECTION_OUTCOME,
                }
                if decision_selector == "clef"
                else None
            ),
            "verification": {
                "promptHashMatchesFrozenContract": (
                    prompt_sha256
                    == (
                        EXPECTED_CANDIDATE_PROMPT_SHA256[candidate_count]
                        if decision_selector == "clef"
                        else "e3a773f000f0d5bb8e4b1357459cd9434e63298875779ade779d2e7d6f8d6b61"
                    )
                ),
                "gameExportDownloaded": export_path.exists(),
                "gameExportJsonlDownloaded": export_jsonl_path.exists(),
                "gameExportSha256": _file_sha256(export_path),
                "gameExportJsonlSha256": _file_sha256(export_jsonl_path),
                "providerRequestsHaveNoCompletionTokenLimit": all(
                    not {
                        "max_tokens",
                        "max_completion_tokens",
                        "max_output_tokens",
                    }.intersection(call["request"])
                    for decision in decisions
                    for call in decision.get("inferenceCalls", [])
                ),
                "decisionCallsUseFrozenContract": (
                    bool(recorded_decision_requests)
                    and all(
                        decision_request_matches_contract(request, candidate_count)
                        for request in recorded_decision_requests
                    )
                    if decision_selector == "clef"
                    else None
                ),
            },
            "finalModelObservation": final_model_observation,
            "finalHeuristicObservation": final_heuristic_observation,
            "decisions": decisions,
        }
        run_path.write_text(
            json.dumps(run_document, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        with checkpoint_path.open("a", encoding="utf-8") as checkpoint:
            checkpoint.write(
                json.dumps({"type": "summary", "summary": summary}) + "\n"
            )

        archive_result = None
        if game_id is not None and export_path.exists() and export_jsonl_path.exists():
            try:
                command = [
                    "node",
                    str(REPOSITORY_ROOT / "apps/api/scripts/archive-run.mjs"),
                    "--base-url",
                    base_url,
                    "--game-id",
                    game_id,
                    "--token-file",
                    str(Path(os.environ["RESTAURANT_SIM_ADMIN_TOKEN_FILE"])),
                    str(run_path),
                    str(checkpoint_path),
                    str(export_path),
                    str(export_jsonl_path),
                ]
                completed = subprocess.run(
                    command,
                    cwd=REPOSITORY_ROOT,
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=ARCHIVE_TIMEOUT_SECONDS,
                )
                archive_result = json.loads(completed.stdout)
            except subprocess.CalledProcessError as archive_error:
                detail = (archive_error.stderr or archive_error.stdout or "").strip()
                archive_result = {
                    "verified": False,
                    "error": (
                        f"CalledProcessError: archive exited {archive_error.returncode}"
                        + (f": {detail[-2_000:]}" if detail else "")
                    ),
                }
            except BaseException as archive_error:
                archive_result = {
                    "verified": False,
                    "error": f"{type(archive_error).__name__}: {archive_error}",
                }

        summary["archive"] = archive_result
        summary_path = run_dir / "summary.json"
        summary_path.write_text(
            json.dumps(summary, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(
            json.dumps(
                {
                    "slug": slug,
                    "status": status,
                    "modelProfitCents": summary.get("modelProfitCents"),
                    "listCostUsd": summary["usage"]["listCostUsd"],
                    "decisionListCostUsd": summary["decisionUsage"][
                        "listCostUsd"
                    ],
                    "archiveVerified": bool(
                        archive_result and archive_result.get("verified")
                    ),
                }
            ),
            flush=True,
        )
        return summary


def summarize_run(
    *,
    slug: str,
    game_id: str | None,
    model_key: str,
    model: dict[str, Any],
    seed: int,
    status: str,
    failure: dict[str, Any] | None,
    decisions: list[dict[str, Any]],
    export_data: Any,
    started_at: float,
    budget: dict[str, Any],
    decision_selector: str,
    candidate_count: int,
    selection_min_probability: float,
) -> dict[str, Any]:
    calls = [
        call for decision in decisions for call in decision.get("inferenceCalls", [])
    ]
    usage = {
        "requests": len(calls),
        "successfulRequests": sum(
            "response" in call and "error" not in call for call in calls
        ),
        "failedRequests": sum("error" in call for call in calls),
        "uncertainCostReserveUsd": sum(
            call.get("uncertainCostReserveUsd", 0.0) for call in calls
        ),
        "inputTokens": sum(call["usageCost"]["inputTokens"] for call in calls),
        "cachedInputTokens": sum(
            call["usageCost"]["cachedInputTokens"] for call in calls
        ),
        "uncachedInputTokens": sum(
            call["usageCost"]["uncachedInputTokens"] for call in calls
        ),
        "outputTokens": sum(call["usageCost"]["outputTokens"] for call in calls),
        "listCostUsd": sum(call["usageCost"]["listCostUsd"] for call in calls),
    }
    decision_calls = [
        call for decision in decisions for call in decision.get("decisionCalls", [])
    ]
    decision_usage = {
        "requests": len(decision_calls),
        "successfulRequests": sum(
            "response" in call and "error" not in call for call in decision_calls
        ),
        "failedRequests": sum("error" in call for call in decision_calls),
        "uncertainCostReserveUsd": sum(
            call.get("uncertainCostReserveUsd", 0.0) for call in decision_calls
        ),
        "inputTokens": sum(
            call["usageCost"]["inputTokens"] for call in decision_calls
        ),
        "cachedInputTokens": sum(
            call["usageCost"]["cachedInputTokens"] for call in decision_calls
        ),
        "uncachedInputTokens": sum(
            call["usageCost"]["uncachedInputTokens"] for call in decision_calls
        ),
        "outputTokens": sum(
            call["usageCost"]["outputTokens"] for call in decision_calls
        ),
        "listCostUsd": sum(
            call["usageCost"]["listCostUsd"] for call in decision_calls
        ),
    }
    leaderboard = []
    environment_events = 0
    actor_logs = 0
    if isinstance(export_data, dict):
        results = export_data.get("results")
        if isinstance(results, dict) and isinstance(results.get("leaderboard"), list):
            leaderboard = results["leaderboard"]
        environment_events = len(export_data.get("environmentEvents", []))
        actor_logs = len(export_data.get("logs", []))
    model_result = next(
        (row for row in leaderboard if row.get("restaurantId") == "model"), {}
    )
    heuristic_result = next(
        (row for row in leaderboard if row.get("restaurantId") == "heuristic"), {}
    )
    model_submissions = [
        item for decision in decisions for item in decision.get("modelSubmitted", [])
    ]
    accepted = sum(
        item.get("result", {}).get("result", {}).get("accepted") is True
        for item in model_submissions
    )
    rejected = sum(
        item.get("result", {}).get("result", {}).get("accepted") is False
        or "clientError" in item
        for item in model_submissions
    )
    harness_metrics: dict[str, int] = {}
    for decision in decisions:
        metrics = (decision.get("decision") or {}).get("metrics", {})
        for name, value in metrics.items():
            if isinstance(value, bool):
                value = int(value)
            if isinstance(value, int):
                harness_metrics[name] = harness_metrics.get(name, 0) + value
    selections = [
        selection
        for decision in decisions
        if isinstance((selection := decision.get("selection")), dict)
    ]
    selection_routes: dict[str, int] = {}
    selected_candidates: dict[str, int] = {}
    for selection in selections:
        route = selection.get("route")
        if isinstance(route, str):
            selection_routes[route] = selection_routes.get(route, 0) + 1
        candidate_id = selection.get("selectedCandidateId")
        if isinstance(candidate_id, str):
            selected_candidates[candidate_id] = (
                selected_candidates.get(candidate_id, 0) + 1
            )

    prompt_sha256 = (
        candidate_system_prompt_sha256(candidate_count)
        if decision_selector == "clef"
        else system_prompt_sha256()
    )

    return {
        "slug": slug,
        "gameId": game_id,
        "batchId": slug.split(f"-{model_key}-seed-")[0],
        "modelKey": model_key,
        "model": model["id"],
        "modelName": model["name"],
        "seed": seed,
        "maxTicks": MAX_TICKS,
        "decisionIntervalTicks": DECISION_INTERVAL_TICKS,
        "status": status,
        "failure": failure,
        "startedAt": started_at,
        "completedAt": time.time(),
        "promptSha256": prompt_sha256,
        "expectedPromptSha256": (
            EXPECTED_CANDIDATE_PROMPT_SHA256[candidate_count]
            if decision_selector == "clef"
            else "e3a773f000f0d5bb8e4b1357459cd9434e63298875779ade779d2e7d6f8d6b61"
        ),
        "inferenceSettings": {
            "reasoningEffort": "high",
            "temperature": 0.2,
            "responseFormat": "json_object",
            "explicitCompletionTokenLimit": None,
        },
        "leaderboard": leaderboard,
        "modelProfitCents": model_result.get("cumulativeOperatingProfitCents"),
        "heuristicProfitCents": heuristic_result.get(
            "cumulativeOperatingProfitCents"
        ),
        "modelCashCents": model_result.get("cashCents"),
        "modelDebtCents": model_result.get("debtCents"),
        "modelBankrupt": model_result.get("bankrupt"),
        "usage": usage,
        "decisionUsage": decision_usage,
        "decisionSelector": (
            {
                "model": DECISION_MODEL["id"],
                "contractVersion": DECISION_CONTRACT_VERSION,
                "contractSha256": decision_contract_sha256(
                    selection_min_probability, candidate_count
                ),
                "expectedContractSha256": EXPECTED_DECISION_CONTRACT_SHA256[
                    candidate_count
                ],
                "candidateCount": candidate_count,
                "minimumProbability": selection_min_probability,
                "selectionOutcome": SELECTION_OUTCOME,
                "selections": len(selections),
                "routes": selection_routes,
                "selectedCandidates": selected_candidates,
                "selectedActions": sum(
                    len(selection.get("selectedActions", []))
                    for selection in selections
                ),
            }
            if decision_selector == "clef"
            else None
        ),
        "harnessMetrics": harness_metrics,
        "simulatorAcceptance": {
            "submitted": len(model_submissions),
            "accepted": accepted,
            "rejected": rejected,
        },
        "environmentEvents": environment_events,
        "actorLogs": actor_logs,
        "aggregateBudget": budget,
    }


def write_batch_results(output_root: Path, summaries: list[dict[str, Any]]) -> None:
    sorted_summaries = sorted(
        summaries, key=lambda item: (item["modelKey"], item["seed"])
    )
    (output_root / "batch-results.json").write_text(
        json.dumps(sorted_summaries, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    columns = (
        "modelKey",
        "model",
        "seed",
        "status",
        "modelProfitCents",
        "heuristicProfitCents",
        "modelCashCents",
        "modelDebtCents",
        "modelBankrupt",
    )
    with (output_root / "batch-results.csv").open(
        "w", encoding="utf-8", newline=""
    ) as destination:
        writer = csv.DictWriter(destination, fieldnames=columns)
        writer.writeheader()
        for summary in sorted_summaries:
            writer.writerow({name: summary.get(name) for name in columns})


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-id", required=True)
    parser.add_argument(
        "--models",
        default=",".join(MODELS),
        help="comma-separated model aliases: " + ", ".join(MODELS),
    )
    parser.add_argument(
        "--seeds",
        default=",".join(str(seed) for seed in DEFAULT_SEEDS),
        help="comma-separated integer seeds",
    )
    parser.add_argument(
        "--jobs",
        help=(
            "comma-separated model:seed pairs; overrides --models and --seeds "
            "without creating their Cartesian product"
        ),
    )
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--inference-url", default=DEFAULT_INFERENCE_URL)
    parser.add_argument(
        "--decision-selector",
        choices=("none", "clef"),
        default="none",
        help="ask the planner for candidates and let Clef select one",
    )
    parser.add_argument(
        "--candidate-count",
        choices=SUPPORTED_CANDIDATE_COUNTS,
        default=3,
        type=int,
        help="number of planner candidates before the runner adds no_action",
    )
    parser.add_argument("--decision-url", default=DEFAULT_DECISION_URL)
    parser.add_argument(
        "--selection-min-probability",
        default=DEFAULT_SELECTION_MIN_PROBABILITY,
        type=float,
        help="fall back to no_action when Clef's winning probability is below this value",
    )
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--initial-cost-usd", required=True, type=float)
    parser.add_argument("--initial-uncertain-cost-usd", default=0.0, type=float)
    parser.add_argument("--budget-usd", default=100.0, type=float)
    parser.add_argument("--workers", default=4, type=int)
    parser.add_argument(
        "--canary-first",
        action="store_true",
        help="finish and verify the first run before starting the rest",
    )
    return parser.parse_args(argv)


def parse_explicit_jobs(value: str) -> list[tuple[str, int]]:
    jobs: list[tuple[str, int]] = []
    for item in value.split(","):
        model_key, separator, raw_seed = item.strip().partition(":")
        if not separator or model_key not in MODELS:
            raise ValueError(f"invalid job {item!r}; expected known-model:integer-seed")
        try:
            job = (model_key, int(raw_seed))
        except ValueError:
            raise ValueError(
                f"invalid job {item!r}; expected known-model:integer-seed"
            ) from None
        if job in jobs:
            raise ValueError(f"duplicate job {item!r}")
        jobs.append(job)
    return jobs


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.workers < 1:
        raise SystemExit("at least one seed and one worker are required")
    if not 0.0 < args.selection_min_probability <= 1.0:
        raise SystemExit("selection minimum probability must be greater than 0 and at most 1")
    if args.decision_selector == "none" and args.candidate_count != 3:
        raise SystemExit("candidate count applies only when --decision-selector=clef")
    if args.jobs:
        try:
            jobs = parse_explicit_jobs(args.jobs)
        except ValueError as error:
            raise SystemExit(str(error)) from None
    else:
        model_keys = tuple(
            item.strip() for item in args.models.split(",") if item.strip()
        )
        unknown = set(model_keys) - set(MODELS)
        if unknown:
            raise SystemExit("unknown model alias(es): " + ", ".join(sorted(unknown)))
        seeds = tuple(int(item) for item in args.seeds.split(",") if item.strip())
        if not seeds:
            raise SystemExit("at least one seed and one worker are required")
        jobs = [(model_key, seed) for model_key in model_keys for seed in seeds]
    if system_prompt_sha256() != (
        "e3a773f000f0d5bb8e4b1357459cd9434e63298875779ade779d2e7d6f8d6b61"
    ):
        raise SystemExit("SYSTEM_PROMPT hash does not match the frozen batch contract")
    if (
        args.decision_selector == "clef"
        and candidate_system_prompt_sha256(args.candidate_count)
        != EXPECTED_CANDIDATE_PROMPT_SHA256[args.candidate_count]
    ):
        raise SystemExit(
            "CANDIDATE_SYSTEM_PROMPT hash does not match the frozen selection contract"
        )
    if (
        args.decision_selector == "clef"
        and decision_contract_sha256(
            args.selection_min_probability, args.candidate_count
        )
        != EXPECTED_DECISION_CONTRACT_SHA256[args.candidate_count]
    ):
        raise SystemExit("decision contract hash does not match the frozen selection contract")

    admin_token = args.token_file.read_text(encoding="utf-8").strip()
    if not admin_token:
        raise SystemExit("admin token file is empty")
    args.output_dir.mkdir(parents=True, exist_ok=False)
    os.environ["RESTAURANT_SIM_ADMIN_TOKEN_FILE"] = str(args.token_file.resolve())
    budget = BudgetTracker(
        initial_cost_usd=args.initial_cost_usd,
        initial_uncertain_cost_usd=args.initial_uncertain_cost_usd,
        budget_usd=args.budget_usd,
        state_path=args.output_dir / "budget.json",
    )
    summaries: list[dict[str, Any]] = []
    if args.canary_first:
        canary_model, canary_seed = jobs.pop(0)
        canary = run_episode(
            model_key=canary_model,
            seed=canary_seed,
            batch_id=args.batch_id,
            base_url=args.base_url.rstrip("/"),
            inference_url=args.inference_url,
            decision_selector=args.decision_selector,
            decision_url=args.decision_url,
            candidate_count=args.candidate_count,
            selection_min_probability=args.selection_min_probability,
            admin_token=admin_token,
            output_root=args.output_dir,
            budget=budget,
        )
        summaries.append(canary)
        write_batch_results(args.output_dir, summaries)
        if canary.get("status") != "completed" or not (
            canary.get("archive") or {}
        ).get("verified"):
            print("Canary failed or its R2 archive did not verify; batch stopped.")
            return 1

    if not jobs:
        write_batch_results(args.output_dir, summaries)
        return 0
    with ThreadPoolExecutor(max_workers=min(args.workers, len(jobs))) as executor:
        futures = {
            executor.submit(
                run_episode,
                model_key=model_key,
                seed=seed,
                batch_id=args.batch_id,
                base_url=args.base_url.rstrip("/"),
                inference_url=args.inference_url,
                decision_selector=args.decision_selector,
                decision_url=args.decision_url,
                candidate_count=args.candidate_count,
                selection_min_probability=args.selection_min_probability,
                admin_token=admin_token,
                output_root=args.output_dir,
                budget=budget,
            ): (model_key, seed)
            for model_key, seed in jobs
        }
        for future in as_completed(futures):
            model_key, seed = futures[future]
            try:
                summaries.append(future.result())
            except BaseException as error:
                summaries.append(
                    {
                        "modelKey": model_key,
                        "model": MODELS[model_key]["id"],
                        "seed": seed,
                        "status": "runner_failed",
                        "failure": {
                            "type": type(error).__name__,
                            "message": str(error),
                        },
                    }
                )
            write_batch_results(args.output_dir, summaries)
    write_batch_results(args.output_dir, summaries)
    failures = [summary for summary in summaries if summary.get("status") != "completed"]
    print(
        json.dumps(
            {
                "batchId": args.batch_id,
                "runs": len(summaries),
                "completed": len(summaries) - len(failures),
                "failed": len(failures),
                "budget": budget.snapshot(),
                "outputDir": str(args.output_dir),
            },
            indent=2,
        ),
        flush=True,
    )
    return 1 if failures else 0


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _file_sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
