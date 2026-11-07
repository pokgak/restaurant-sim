"""Frozen deterministic policy library for policy-controller experiments."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any, Mapping

from .baseline import BaselineConfig, HeuristicBaseline


POLICY_VERSION = "restaurant-sim-policy-v1"
POLICY_IDS = (
    "balanced",
    "cash_guard",
    "maintenance_first",
    "lean_operator",
    "moderate_growth",
    "inventory_buffer",
    "price_power",
    "workforce_quality",
    "debt_averse",
    "growth_credit",
)


@dataclass(frozen=True)
class PolicyDefinition:
    """Stable identity, continuation description, and baseline parameters."""

    policy_id: str
    description: str
    config: BaselineConfig

    def parameters(self) -> dict[str, Any]:
        return asdict(self.config)

    def serialized(self) -> dict[str, Any]:
        return {
            "policyId": self.policy_id,
            "policyVersion": POLICY_VERSION,
            "description": self.description,
            "parameters": self.parameters(),
        }


def _description(style: str) -> str:
    return (
        f"{style} At every three-tick decision point, recompute the deterministic "
        "HeuristicBaseline actions from the then-current observation using the frozen "
        "parameters below, preserve that controller's own cadence state, submit the "
        "validated actions in priority order, and repeat this same rule through tick 84."
    )


POLICIES = (
    PolicyDefinition(
        "balanced",
        _description(
            "Balance liquidity, inventory, staffing, pricing, maintenance, and demand."
        ),
        BaselineConfig(decision_interval_ticks=3),
    ),
    PolicyDefinition(
        "cash_guard",
        _description(
            "Defend a high cash reserve, trim marketing faster, and limit credit usage."
        ),
        BaselineConfig(
            decision_interval_ticks=3,
            price_step_basis_points=750,
            marketing_step_cents=1_000,
            cash_reserve_cents=40_000,
            max_credit_utilization_basis_points=6_000,
            max_debt_repayment_cents=15_000,
        ),
    ),
    PolicyDefinition(
        "maintenance_first",
        _description(
            "Service equipment early while retaining a moderate operating buffer."
        ),
        BaselineConfig(
            decision_interval_ticks=3,
            inventory_target_ticks=5,
            cash_reserve_cents=25_000,
            maintenance_condition_basis_points=8_500,
            training_skill_basis_points=7_000,
        ),
    ),
    PolicyDefinition(
        "lean_operator",
        _description(
            "Use larger staffing and marketing adjustments with a compact action budget."
        ),
        BaselineConfig(
            decision_interval_ticks=3,
            max_actions_per_decision=4,
            inventory_target_ticks=4,
            max_staff_step=2,
            marketing_step_cents=1_000,
            cash_reserve_cents=30_000,
            training_skill_basis_points=6_000,
        ),
    ),
    PolicyDefinition(
        "moderate_growth",
        _description(
            "Accept measured liquidity and inventory expansion to support demand growth."
        ),
        BaselineConfig(
            decision_interval_ticks=3,
            inventory_target_ticks=6,
            max_inventory_order=125,
            marketing_step_cents=750,
            cash_reserve_cents=15_000,
            max_credit_utilization_basis_points=8_500,
            maintenance_condition_basis_points=6_000,
        ),
    ),
    PolicyDefinition(
        "inventory_buffer",
        _description(
            "Hold a deep inventory buffer and replenish it in larger bounded orders."
        ),
        BaselineConfig(
            decision_interval_ticks=3,
            inventory_target_ticks=8,
            max_inventory_order=150,
            cash_reserve_cents=25_000,
            max_credit_utilization_basis_points=7_500,
        ),
    ),
    PolicyDefinition(
        "price_power",
        _description(
            "Move menu prices decisively when margins or utilization call for repricing."
        ),
        BaselineConfig(
            decision_interval_ticks=3,
            price_step_basis_points=1_000,
            inventory_target_ticks=5,
            marketing_step_cents=250,
            cash_reserve_cents=22_500,
        ),
    ),
    PolicyDefinition(
        "workforce_quality",
        _description(
            "Invest earlier and more heavily in staff skill while scaling roles promptly."
        ),
        BaselineConfig(
            decision_interval_ticks=3,
            max_staff_step=2,
            cash_reserve_cents=22_000,
            training_skill_basis_points=9_000,
            training_budget_cents=2_000,
        ),
    ),
    PolicyDefinition(
        "debt_averse",
        _description(
            "Constrain leverage and repay debt in larger safe increments above reserve."
        ),
        BaselineConfig(
            decision_interval_ticks=3,
            marketing_step_cents=750,
            cash_reserve_cents=30_000,
            max_credit_utilization_basis_points=5_000,
            max_debt_repayment_cents=50_000,
            maintenance_condition_basis_points=7_000,
        ),
    ),
    PolicyDefinition(
        "growth_credit",
        _description(
            "Use available credit, inventory, and marketing aggressively to fund growth."
        ),
        BaselineConfig(
            decision_interval_ticks=3,
            price_step_basis_points=400,
            inventory_target_ticks=7,
            max_inventory_order=175,
            marketing_step_cents=1_000,
            cash_reserve_cents=10_000,
            max_credit_utilization_basis_points=9_500,
            maintenance_condition_basis_points=5_000,
        ),
    ),
)

POLICY_BY_ID = {policy.policy_id: policy for policy in POLICIES}

if tuple(policy.policy_id for policy in POLICIES) != POLICY_IDS:
    raise AssertionError("policy definitions drifted from their canonical order")


class PolicyController:
    """One stateful deterministic continuation-rule instance."""

    def __init__(self, definition: PolicyDefinition) -> None:
        self.definition = definition
        self._baseline = HeuristicBaseline(definition.config)

    def decide(
        self, observation: Mapping[str, Any], *, tick: int | None = None
    ) -> list[dict[str, Any]]:
        return [
            {"type": intent.action_type, "params": intent.params}
            for intent in self._baseline.decide(observation, tick=tick)
        ]


def policy_definitions(candidate_count: int) -> tuple[PolicyDefinition, ...]:
    if candidate_count not in (5, 10):
        raise ValueError("policy candidate count must be 5 or 10")
    return POLICIES[:candidate_count]


def policy_library_sha256() -> str:
    encoded = json.dumps(
        [policy.serialized() for policy in POLICIES],
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


# Updated only when the preregistered policy library intentionally changes.
EXPECTED_POLICY_LIBRARY_SHA256 = (
    "8e357a03fb3e5a54defb5a10f411bec4e13944aa038b4235f88c1c4c614178ca"
)
