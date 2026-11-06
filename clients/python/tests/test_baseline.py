from __future__ import annotations

from copy import deepcopy
import unittest
from typing import Any

from restaurant_sim.baseline import (
    BaselineConfig,
    HeuristicBaseline,
    run_baseline,
)


def canonical_observation() -> dict[str, Any]:
    staff = {
        "count": 2,
        "targetCount": 2,
        "absentCount": 0,
        "averageSkillBps": 8_000,
        "fatigueBps": 1_000,
        "moraleBps": 8_000,
        "pendingHireCount": 0,
        "hiringTicksRemaining": 0,
        "trainingTicksRemaining": 0,
        "pendingSkillGainBps": 0,
        "turnoverCount": 0,
    }
    equipment = {
        "conditionBps": 9_000,
        "status": "operational",
        "downtimeTicks": 0,
        "maintenanceBoostTicks": 0,
        "totalBreakdowns": 0,
        "totalMaintenance": 0,
        "repairCostsCents": 0,
    }
    return {
        "restaurantId": "restaurant-a",
        "tick": 12,
        "maxTicks": 100,
        "finished": False,
        "market": {
            "ingredientUnitCostCents": 400,
            "demandIndexBps": 10_000,
            "supplyDisruptionBps": 0,
        },
        "calendar": {
            "day": 12,
            "dayOfWeek": 5,
            "dayName": "Saturday",
            "isWeekend": True,
            "season": "winter",
            "seasonDemandBps": 9_500,
            "weather": "clear",
            "weatherDemandBps": 10_000,
            "localEvent": "none",
            "localDemandBps": 10_000,
            "demandRegimeBps": 10_000,
        },
        "restaurant": {
            "id": "restaurant-a",
            "menuPriceCents": 1_300,
            "inventoryUnits": 60,
            "storageCapacityUnits": 80,
            "inventoryLots": [
                {
                    "id": "lot-1",
                    "ingredientId": "staples",
                    "quantity": 60,
                    "unitCostCents": 400,
                    "ageTicks": 1,
                    "shelfLifeTicks": 6,
                    "receivedTick": 11,
                }
            ],
            "purchaseOrders": [],
            "nextOrderNumber": 2,
            "cooks": 2,
            "servers": 2,
            "staffing": {"chef": deepcopy(staff), "server": deepcopy(staff)},
            "marketingSpendPerTickCents": 500,
            "capacityLevel": 0,
            "qualityLevel": 0,
            "coordinationBurdenBps": 0,
            "equipment": {
                "kitchen": {"id": "kitchen", "kind": "kitchen", **equipment},
                "refrigeration": {
                    "id": "refrigeration",
                    "kind": "refrigeration",
                    **equipment,
                },
            },
            "reputationBps": 5_000,
            "cashCents": 100_000,
            "inventoryAssetCents": 24_000,
            "debtCents": 0,
            "creditLimitCents": 500_000,
            "bankrupt": False,
            "bankruptcyTick": None,
            "totalBorrowedCents": 0,
            "totalRepaidCents": 0,
            "totalInterestCents": 0,
            "cumulativeOperatingProfitCents": 20_000,
            "totalRevenueCents": 120_000,
            "totalCostsCents": 100_000,
            "totalUnitsSold": 100,
            "totalWasteUnits": 2,
            "lastTick": {
                "tick": 11,
                "potentialDemandUnits": 9,
                "serviceCapacityUnits": 12,
                "unitsSold": 9,
                "lostToCapacityUnits": 0,
                "stockoutUnits": 0,
                "wasteUnits": 0,
                "deliveredUnits": 0,
                "absentStaff": 0,
                "kitchenDowntime": False,
                "refrigerationDowntime": False,
                "revenueCents": 11_700,
                "wageCostCents": 1_480,
                "marketingCostCents": 500,
                "fixedCostCents": 700,
                "rentCostCents": 0,
                "utilityCostCents": 400,
                "interestCostCents": 0,
                "repairCostCents": 0,
                "costOfGoodsSoldCents": 3_600,
                "spoilageCostCents": 0,
                "operatingProfitCents": 5_020,
                "cashFlowCents": 8_620,
                "cashCents": 100_000,
            },
        },
        "competitors": [],
        "recentEvents": [
            {
                "id": "event-1",
                "type": "environment",
                "category": "environment",
                "severity": "info",
                "source": "environment",
                "tick": 12,
                "message": "clear weather",
                "effects": {},
            }
        ],
    }


class FakeClient:
    def __init__(self) -> None:
        self.state_reads = 0
        self.waits: list[tuple[int, float, float]] = []
        self.actions: list[tuple[str, dict[str, Any]]] = []
        self._request_id = 0

    def public_state(self) -> dict[str, Any]:
        return {"tick": 0, "maxTicks": 6, "status": "running"}

    def state(self) -> dict[str, Any]:
        self.state_reads += 1
        return {
            "demand": 50,
            "capacity": 50,
            "inventory": {"rice": {"quantity": 0, "targetQuantity": 8}},
        }

    def new_request_id(self) -> str:
        self._request_id += 1
        return f"request-{self._request_id}"

    def act(
        self, action_type: str, *, request_id: str, **params: Any
    ) -> dict[str, Any]:
        self.actions.append(
            (action_type, {"requestId": request_id, **params})
        )
        return {"ok": True}

    def wait_for_tick(
        self, target_tick: int, *, poll_interval: float, timeout: float
    ) -> dict[str, Any]:
        self.waits.append((target_tick, poll_interval, timeout))
        return {"tick": target_tick, "maxTicks": 6, "status": "running"}

    def _url(self, endpoint: str) -> str:
        return f"https://example.test/{endpoint}"


class HeuristicBaselineTest(unittest.TestCase):
    def test_exact_canonical_realism_observation_is_stable(self) -> None:
        self.assertEqual(HeuristicBaseline().decide(canonical_observation()), [])

    def test_delayed_hires_do_not_repeatedly_raise_staff_targets(self) -> None:
        observation = canonical_observation()
        observation["restaurant"]["lastTick"].update(
            potentialDemandUnits=20,
            serviceCapacityUnits=10,
        )
        for role in ("chef", "server"):
            staffing = observation["restaurant"]["staffing"][role]
            staffing.update(
                targetCount=3,
                pendingHireCount=1,
                hiringTicksRemaining=2,
            )

        actions = HeuristicBaseline().decide(observation)

        self.assertNotIn("set_staff", [action.action_type for action in actions])

    def test_pending_order_prevents_duplicate_inventory_purchase(self) -> None:
        observation = canonical_observation()
        restaurant = observation["restaurant"]
        restaurant["inventoryUnits"] = 5
        restaurant["purchaseOrders"] = [
            {
                "id": "restaurant-a-order-1",
                "ingredientId": "staples",
                "quantity": 55,
                "unitCostCents": 400,
                "orderedTick": 12,
                "originalDueTick": 14,
                "dueTick": 14,
                "disruptionCount": 0,
                "status": "pending",
                "deliveredTick": None,
            }
        ]

        actions = HeuristicBaseline().decide(observation)

        self.assertNotIn(
            "purchase_inventory", [action.action_type for action in actions]
        )

    def test_low_cash_borrows_before_inventory_and_reduces_marketing(self) -> None:
        observation = canonical_observation()
        restaurant = observation["restaurant"]
        restaurant["cashCents"] = 5_000
        restaurant["inventoryUnits"] = 0
        restaurant["inventoryLots"] = []
        restaurant["marketingSpendPerTickCents"] = 1_000
        restaurant["lastTick"].update(
            potentialDemandUnits=10,
            serviceCapacityUnits=10,
        )

        actions = HeuristicBaseline().decide(observation)
        by_type = {action.action_type: action for action in actions}

        self.assertEqual(
            [action.action_type for action in actions[:2]],
            ["borrow", "purchase_inventory"],
        )
        self.assertEqual(by_type["borrow"].params, {"amountCents": 35_000})
        self.assertEqual(by_type["purchase_inventory"].params["quantity"], 50)
        self.assertEqual(by_type["set_marketing"].params, {"budgetCents": 500})

        custom = HeuristicBaseline(
            BaselineConfig(cash_reserve_cents=10_000)
        ).decide(deepcopy(observation))
        self.assertEqual(custom[0].params, {"amountCents": 25_000})

        credit_constrained = deepcopy(observation)
        credit_constrained["restaurant"]["debtCents"] = 395_000
        constrained = HeuristicBaseline().decide(credit_constrained)
        constrained_types = [action.action_type for action in constrained]
        self.assertNotIn("borrow", constrained_types)
        self.assertNotIn("purchase_inventory", constrained_types)

    def test_surplus_cash_repays_bounded_debt_and_keeps_reserve(self) -> None:
        observation = canonical_observation()
        observation["restaurant"]["debtCents"] = 50_000

        actions = HeuristicBaseline().decide(observation)

        self.assertEqual(
            [(action.action_type, action.params) for action in actions],
            [("repay_loan", {"amountCents": 25_000})],
        )

    def test_broken_equipment_is_repaired_before_preventive_maintenance(self) -> None:
        observation = canonical_observation()
        equipment = observation["restaurant"]["equipment"]
        equipment["kitchen"]["conditionBps"] = 6_000
        equipment["refrigeration"].update(status="broken", conditionBps=3_000)

        actions = HeuristicBaseline().decide(observation)

        self.assertEqual(
            [(action.action_type, action.params) for action in actions],
            [
                ("repair_equipment", {"assetId": "refrigeration"}),
                ("schedule_maintenance", {"assetId": "kitchen"}),
            ],
        )

    def test_only_stock_risk_makes_a_genuinely_late_order_expedite(self) -> None:
        observation = canonical_observation()
        restaurant = observation["restaurant"]
        restaurant["inventoryUnits"] = 5
        restaurant["purchaseOrders"] = [
            {
                "id": "restaurant-a-order-1",
                "ingredientId": "staples",
                "quantity": 40,
                "unitCostCents": 400,
                "orderedTick": 8,
                "originalDueTick": 10,
                "dueTick": 15,
                "disruptionCount": 1,
                "status": "pending",
                "deliveredTick": None,
            }
        ]

        actions = HeuristicBaseline().decide(observation)

        self.assertEqual(
            [(action.action_type, action.params) for action in actions],
            [("expedite_delivery", {"orderId": "restaurant-a-order-1"})],
        )

    def test_bankrupt_restaurant_is_a_no_op(self) -> None:
        observation = canonical_observation()
        observation["restaurant"]["bankrupt"] = True

        self.assertEqual(HeuristicBaseline().decide(observation), [])

    def test_training_requires_liquidity_and_available_coverage(self) -> None:
        observation = canonical_observation()
        restaurant = observation["restaurant"]
        restaurant["marketingSpendPerTickCents"] = 5_000
        restaurant["lastTick"].update(
            potentialDemandUnits=6,
            serviceCapacityUnits=12,
        )
        restaurant["staffing"]["chef"].update(
            count=3,
            targetCount=3,
            averageSkillBps=6_500,
        )

        covered = HeuristicBaseline().decide(observation)
        chef = observation["restaurant"]["staffing"]["chef"]
        chef["absentCount"] = 2
        uncovered = HeuristicBaseline().decide(observation)

        self.assertIn("train_staff", [action.action_type for action in covered])
        self.assertNotIn("train_staff", [action.action_type for action in uncovered])

    def test_realism_actions_are_bounded_ordered_and_cadenced(self) -> None:
        observation = canonical_observation()
        restaurant = observation["restaurant"]
        restaurant["cashCents"] = 5_000
        restaurant["inventoryUnits"] = 0
        restaurant["inventoryLots"] = []
        restaurant["marketingSpendPerTickCents"] = 5_000
        baseline = HeuristicBaseline(BaselineConfig(max_actions_per_decision=3))

        actions = baseline.decide(observation)
        too_soon = baseline.decide(observation, tick=14)

        self.assertLessEqual(len(actions), 3)
        self.assertEqual(actions[0].action_type, "borrow")
        self.assertLessEqual(actions[0].params["amountCents"], 100_000)
        purchase = next(
            action for action in actions if action.action_type == "purchase_inventory"
        )
        self.assertLessEqual(purchase.params["quantity"], 100)
        self.assertEqual(too_soon, [])

    def test_tick_zero_infers_capacity_and_reorders_before_next_decision(self) -> None:
        observation = {
            "tick": 0,
            "market": {"ingredientUnitCostCents": 400},
            "restaurant": {
                "menuPriceCents": 1_300,
                "inventoryUnits": 36,
                "cooks": 2,
                "servers": 2,
                "marketingSpendPerTickCents": 0,
                "capacityLevel": 0,
                "lastTick": None,
            },
        }

        actions = HeuristicBaseline().decide(observation)

        self.assertEqual(
            [(action.action_type, action.params) for action in actions],
            [
                (
                    "purchase_inventory",
                    {"ingredientId": "staples", "quantity": 12},
                )
            ],
        )

    def test_stockout_uses_demand_capacity_not_zero_units_sold(self) -> None:
        observation = {
            "tick": 6,
            "market": {"ingredientUnitCostCents": 400},
            "restaurant": {
                "menuPriceCents": 1_300,
                "inventoryUnits": 0,
                "cooks": 2,
                "servers": 2,
                "marketingSpendPerTickCents": 0,
                "capacityLevel": 0,
                "lastTick": {
                    "potentialDemandUnits": 31,
                    "serviceCapacityUnits": 12,
                    "unitsSold": 0,
                    "revenueCents": 0,
                    "operatingProfitCents": -1_480,
                },
            },
        }

        actions = HeuristicBaseline().decide(observation)
        inventory_action = next(
            action
            for action in actions
            if action.action_type == "purchase_inventory"
        )

        self.assertEqual(
            inventory_action.params,
            {"ingredientId": "staples", "quantity": 48},
        )

    def test_canonical_observation_drives_asymmetric_bounded_actions(self) -> None:
        observation = {
            "restaurantId": "restaurant-a",
            "tick": 9,
            "maxTicks": 100,
            "finished": False,
            "market": {
                "ingredientUnitCostCents": 437,
                "demandIndexBps": 10_321,
            },
            "restaurant": {
                "id": "restaurant-a",
                "menuPriceCents": 1_373,
                "inventoryUnits": 7,
                "cooks": 3,
                "servers": 3,
                "marketingSpendPerTickCents": 913,
                "capacityLevel": 1,
                "qualityLevel": 2,
                "reputationBps": 5_123,
                "cumulativeOperatingProfitCents": 31_337,
                "totalRevenueCents": 71_111,
                "totalCostsCents": 39_774,
                "totalUnitsSold": 73,
                "totalWasteUnits": 5,
                "lastTick": {
                    "tick": 8,
                    "potentialDemandUnits": 23,
                    "serviceCapacityUnits": 16,
                    "unitsSold": 16,
                    "lostToCapacityUnits": 7,
                    "stockoutUnits": 0,
                    "wasteUnits": 1,
                    "revenueCents": 21_968,
                    "wageCostCents": 2_220,
                    "marketingCostCents": 913,
                    "operatingProfitCents": 1_835,
                },
            },
            "competitors": [],
        }
        baseline = HeuristicBaseline(
            BaselineConfig(inventory_target_ticks=20)
        )

        actions = baseline.decide(observation)

        self.assertEqual(
            [(action.action_type, action.params) for action in actions],
            [
                (
                    "set_menu_price",
                    {"dishId": "house", "priceCents": 1_441},
                ),
                (
                    "purchase_inventory",
                    {"ingredientId": "staples", "quantity": 93},
                ),
                ("set_staff", {"role": "chef", "count": 4}),
                ("set_staff", {"role": "server", "count": 4}),
                ("set_marketing", {"budgetCents": 413}),
            ],
        )
        self.assertEqual(actions[0].reason, "protect a thin operating margin")

    def test_high_demand_actions_are_bounded_and_cadenced(self) -> None:
        observation = {
            "market": {"demand": 120},
            "restaurant": {
                "capacity": 80,
                "revenueCents": 10_000,
                "operatingProfitCents": 2_000,
                "menu": [
                    {"dishId": "rice", "priceCents": 1_000, "costCents": 500}
                ],
                "inventory": [
                    {
                        "ingredientId": "rice",
                        "quantity": 1,
                        "usagePerTick": 5,
                    }
                ],
                "staff": {"chef": 2, "server": 2},
                "marketingBudgetCents": 1_000,
            },
        }
        baseline = HeuristicBaseline(
            BaselineConfig(decision_interval_ticks=3, max_actions_per_decision=5)
        )

        first = baseline.decide(observation, tick=4)
        too_soon = baseline.decide(observation, tick=6)

        self.assertLessEqual(len(first), 5)
        self.assertEqual(too_soon, [])
        self.assertEqual(
            [action.action_type for action in first],
            [
                "set_menu_price",
                "purchase_inventory",
                "set_staff",
                "set_staff",
                "set_marketing",
            ],
        )
        self.assertLess(first[-1].params["budgetCents"], 1_000)

    def test_spare_capacity_reduces_price_and_adds_marketing(self) -> None:
        observation = {
            "demand": 20,
            "capacity": 100,
            "profitMargin": 0.4,
            "menu": {"noodles": {"priceCents": 1_000, "costCents": 400}},
            "staff": {"chef": 1, "server": 1},
            "marketingBudgetCents": 200,
        }

        actions = HeuristicBaseline().decide(observation, tick=1)
        by_type = {action.action_type: action for action in actions}

        self.assertEqual(by_type["set_menu_price"].params["priceCents"], 950)
        self.assertEqual(by_type["set_marketing"].params["budgetCents"], 700)

    def test_runner_reads_and_acts_once_per_explicit_decision_interval(self) -> None:
        client = FakeClient()

        result = run_baseline(
            client,  # type: ignore[arg-type]
            poll_interval=2.0,
            wait_timeout=10.0,
        )

        self.assertEqual(result, {"decisions": 2, "actions": 2, "lastTick": 6})
        self.assertEqual(client.state_reads, 2)
        self.assertEqual(client.waits, [(3, 2.0, 10.0), (6, 2.0, 10.0)])
        self.assertEqual(
            [action_type for action_type, _ in client.actions],
            ["purchase_inventory", "purchase_inventory"],
        )


if __name__ == "__main__":
    unittest.main()
