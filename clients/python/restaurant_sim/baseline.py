"""Adaptive, bounded-cadence heuristic baseline for Restaurant Sim."""

from __future__ import annotations

import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .client import Client, ProtocolError


HOUSE_DISH_ID = "house"
STAPLES_INGREDIENT_ID = "staples"


@dataclass(frozen=True)
class BaselineConfig:
    """Limits for baseline decisions and action sizes."""

    decision_interval_ticks: int = 3
    max_actions_per_decision: int = 5
    price_step_basis_points: int = 500
    inventory_target_ticks: int = 4
    max_inventory_order: int = 100
    max_staff_step: int = 1
    marketing_step_cents: int = 500
    cash_reserve_cents: int = 20_000
    max_credit_utilization_basis_points: int = 8_000
    max_debt_repayment_cents: int = 25_000
    maintenance_condition_basis_points: int = 6_500
    training_skill_basis_points: int = 7_500
    training_budget_cents: int = 1_000

    def __post_init__(self) -> None:
        positive_values = (
            self.decision_interval_ticks,
            self.max_actions_per_decision,
            self.price_step_basis_points,
            self.inventory_target_ticks,
            self.max_inventory_order,
            self.max_staff_step,
            self.marketing_step_cents,
            self.max_debt_repayment_cents,
        )
        if any(value <= 0 for value in positive_values):
            raise ValueError("all baseline limits must be greater than zero")
        if self.cash_reserve_cents < 0:
            raise ValueError("cash_reserve_cents must not be negative")
        if not 1 <= self.max_credit_utilization_basis_points < 10_000:
            raise ValueError(
                "max_credit_utilization_basis_points must be from 1 to 9999"
            )
        if not 1 <= self.max_debt_repayment_cents <= 100_000:
            raise ValueError(
                "max_debt_repayment_cents must be from 1 to 100000"
            )
        if not 0 <= self.maintenance_condition_basis_points <= 10_000:
            raise ValueError(
                "maintenance_condition_basis_points must be from 0 to 10000"
            )
        if not 0 <= self.training_skill_basis_points <= 10_000:
            raise ValueError(
                "training_skill_basis_points must be from 0 to 10000"
            )
        if not 500 <= self.training_budget_cents <= 5_000:
            raise ValueError("training_budget_cents must be from 500 to 5000")


@dataclass(frozen=True)
class ActionIntent:
    action_type: str
    params: dict[str, Any]
    reason: str


class HeuristicBaseline:
    """Suggest actions from the canonical Observation and tolerant aliases.

    Unknown or absent dimensions are skipped. Decisions are deterministic,
    limited to one pass per ``decision_interval_ticks``, and capped by
    ``max_actions_per_decision``.
    """

    def __init__(self, config: BaselineConfig | None = None) -> None:
        self.config = config or BaselineConfig()
        self._last_decision_tick: int | None = None

    def decide(
        self, observation: Mapping[str, Any], *, tick: int | None = None
    ) -> list[ActionIntent]:
        decision_tick = tick if tick is not None else _integer(_find(observation, "tick"))
        if decision_tick is None:
            raise ValueError("tick is required when the observation has no integer tick")
        if (
            self._last_decision_tick is not None
            and decision_tick - self._last_decision_tick
            < self.config.decision_interval_ticks
        ):
            return []
        self._last_decision_tick = decision_tick

        restaurant = _mapping(_find(observation, "restaurant"))
        if _boolean(
            _first_present(
                _find(restaurant, "bankrupt", "isBankrupt", "insolvent"),
                _find(observation, "bankrupt", "isBankrupt", "insolvent"),
            )
        ):
            return []
        market = _mapping(_find(observation, "market"))
        last_tick = _mapping(
            _first_present(
                _find(restaurant, "lastTick", "last_tick"),
                _find(observation, "lastTick", "last_tick"),
            )
        )
        demand = _first_number(
            _find(last_tick, "potentialDemandUnits"),
            _find(observation, "demand"),
            _find(market, "demand", "customerDemand", "customers"),
        )
        capacity = _first_number(
            _find(last_tick, "serviceCapacityUnits"),
            _find(observation, "capacity", "serviceCapacity"),
            _find(restaurant, "capacity", "serviceCapacity"),
        )
        utilization = (
            demand / capacity
            if demand is not None and capacity is not None and capacity > 0
            else None
        )
        margin = _profit_margin(observation, restaurant, last_tick)
        actions: list[ActionIntent] = []

        cash = _first_integer(
            _find(restaurant, "cashCents", "cash", "cashBalanceCents"),
            _find(observation, "cashCents", "cash", "cashBalanceCents"),
        )
        debt = _first_integer(
            _find(restaurant, "debtCents", "loanBalanceCents", "debt"),
            _find(observation, "debtCents", "loanBalanceCents", "debt"),
        )
        credit_limit = _first_integer(
            _find(restaurant, "creditLimitCents", "borrowingLimitCents"),
            _find(observation, "creditLimitCents", "borrowingLimitCents"),
        )
        cash_flow = _first_integer(
            _find(last_tick, "cashFlowCents", "netCashFlowCents")
        )
        liquidity_pressure = self._has_liquidity_pressure(
            cash, debt, credit_limit, cash_flow
        )

        menu_price = _integer(_find(restaurant, "menuPriceCents"))
        if menu_price is not None:
            menu_item: dict[str, Any] = {
                "dishId": HOUSE_DISH_ID,
                "priceCents": menu_price,
                "minPriceCents": 500,
                "maxPriceCents": 5_000,
            }
            ingredient_cost = _integer(_find(market, "ingredientUnitCostCents"))
            if ingredient_cost is not None:
                menu_item["costCents"] = ingredient_cost
            menu = [menu_item]
        else:
            menu = _entries(
                _first_present(
                    _find(observation, "menu"), _find(restaurant, "menu")
                ),
                id_name="dishId",
            )
        price_action = self._price_action(menu, utilization, margin)
        if price_action is not None:
            actions.append(price_action)

        inventory_units = _first_integer(
            _find(restaurant, "inventoryUnits", "inventoryQuantity"),
            _find(observation, "inventoryUnits", "inventoryQuantity"),
            _inventory_lot_units(restaurant),
        )
        capacity_level = _integer(_find(restaurant, "capacityLevel"))
        cooks = _integer(_find(restaurant, "cooks"))
        servers = _integer(_find(restaurant, "servers"))
        purchase_orders = _purchase_orders(observation, restaurant)
        pending_units = sum(
            _integer(_find(order, "quantity", "units")) or 0
            for order in purchase_orders
            if _string(_find(order, "ingredientId", "ingredient"))
            in {None, STAPLES_INGREDIENT_ID}
        )
        canonical_inventory = any(
            name in restaurant
            for name in (
                "inventoryLots",
                "purchaseOrders",
                "storageCapacityUnits",
            )
        )
        lead_time_ticks = 0
        if canonical_inventory:
            lead_time_ticks = 2
        for order in purchase_orders:
            due_tick = _integer(_find(order, "dueTick", "expectedTick"))
            if due_tick is not None:
                lead_time_ticks = max(lead_time_ticks, due_tick - decision_tick)
        expected_units: int | None = None
        if inventory_units is not None:
            inventory_item: dict[str, Any] = {
                "ingredientId": STAPLES_INGREDIENT_ID,
                "quantity": inventory_units,
                "pendingQuantity": pending_units,
            }
            potential_demand = _integer(
                _find(last_tick, "potentialDemandUnits")
            )
            reported_capacity = _integer(
                _find(last_tick, "serviceCapacityUnits")
            )
            if potential_demand is not None and reported_capacity is not None:
                expected_units = max(0, min(potential_demand, reported_capacity))
            elif (
                capacity_level is not None
                and cooks is not None
                and servers is not None
            ):
                expected_units = max(
                    0,
                    min(12 + capacity_level * 4, cooks * 7, servers * 6),
                )
            storage_capacity = _first_integer(
                _find(restaurant, "storageCapacityUnits", "storageCapacity")
            )
            if storage_capacity is None and capacity_level is not None:
                # Preserve the original scalar alias when full realism fields
                # are absent; canonical observations carry the exact capacity.
                storage_capacity = 80 + capacity_level * 20
            if storage_capacity is not None:
                inventory_item["maxQuantity"] = storage_capacity
            if expected_units is not None and expected_units > 0:
                target_ticks = max(
                    4,
                    self.config.inventory_target_ticks,
                    self.config.decision_interval_ticks,
                    lead_time_ticks + self.config.decision_interval_ticks,
                )
                reorder_point = (
                    expected_units * self.config.decision_interval_ticks
                )
                target_quantity = expected_units * target_ticks
                if storage_capacity is not None:
                    reorder_point = min(reorder_point, storage_capacity)
                    target_quantity = min(target_quantity, storage_capacity)
                inventory_item["reorderPoint"] = reorder_point
                inventory_item["targetQuantity"] = target_quantity
            inventory = [inventory_item]
        else:
            inventory = _entries(
                _first_present(
                    _find(observation, "inventory"),
                    _find(restaurant, "inventory"),
                ),
                id_name="ingredientId",
            )
        inventory_action = self._inventory_action(inventory)
        if inventory_action is not None:
            actions.append(inventory_action)

        canonical_staff = _first_present(
            _find(restaurant, "staffing", "staff"),
            _find(observation, "staffing", "staff"),
        )
        if canonical_staff is not None:
            staff = canonical_staff
        elif cooks is not None or servers is not None:
            staff = {}
            if cooks is not None:
                staff["chef"] = cooks
            if servers is not None:
                staff["server"] = servers
        else:
            staff = _first_present(
                _find(observation, "staff", "staffing"),
                _find(restaurant, "staff", "staffing"),
            )
        actions.extend(self._staff_actions(staff, utilization, margin))

        marketing = _first_number(
            _find(restaurant, "marketingSpendPerTickCents"),
            _find(observation, "marketingBudgetCents"),
            _find(_mapping(_find(observation, "marketing")), "budgetCents"),
            _find(restaurant, "marketingBudgetCents"),
            _find(_mapping(_find(restaurant, "marketing")), "budgetCents"),
        )
        marketing_action = self._marketing_action(
            marketing, utilization, margin, liquidity_pressure
        )
        if marketing_action is not None:
            actions.append(marketing_action)

        if cash is None:
            return actions[: self.config.max_actions_per_decision]

        repairs, maintenance = self._equipment_actions(restaurant, observation)
        expedite = self._expedite_action(
            purchase_orders,
            decision_tick=decision_tick,
            inventory_units=inventory_units,
            expected_units=expected_units,
        )
        training = self._training_action(
            staff,
            utilization=utilization,
            margin=margin,
            cash_flow=cash_flow,
            liquidity_pressure=liquidity_pressure,
        )

        price_actions = [
            action for action in actions if action.action_type == "set_menu_price"
        ]
        inventory_actions = [
            action
            for action in actions
            if action.action_type == "purchase_inventory"
        ]
        staff_actions = [
            action for action in actions if action.action_type == "set_staff"
        ]
        marketing_actions = [
            action for action in actions if action.action_type == "set_marketing"
        ]
        prioritized = [
            *repairs,
            *inventory_actions,
            *(marketing_actions if liquidity_pressure else []),
            *([expedite] if expedite is not None else []),
            *([maintenance] if maintenance is not None else []),
            *staff_actions,
            *price_actions,
            *([training] if training is not None else []),
            *(marketing_actions if not liquidity_pressure else []),
        ]
        return self._financially_safe_actions(
            prioritized,
            cash=cash,
            debt=debt,
            credit_limit=credit_limit,
            cash_flow=cash_flow,
            market=market,
            capacity_level=capacity_level or 0,
            purchase_orders=purchase_orders,
        )

    def _price_action(
        self,
        menu: list[dict[str, Any]],
        utilization: float | None,
        margin: float | None,
    ) -> ActionIntent | None:
        direction = 0
        reason = ""
        if margin is not None and margin < 0.15:
            direction = 1
            reason = "protect a thin operating margin"
        elif utilization is not None and utilization >= 0.9:
            direction = 1
            reason = "demand is near or above service capacity"
        elif (
            utilization is not None
            and utilization <= 0.55
            and margin is not None
            and margin >= 0.25
        ):
            direction = -1
            reason = "use spare capacity while margin is healthy"
        if direction == 0:
            return None

        for item in menu:
            dish_id = _resource_id(_find(item, "dishId", "id"))
            price = _integer(_find(item, "priceCents", "price"))
            if dish_id is None or price is None or price <= 0:
                continue
            step = max(1, price * self.config.price_step_basis_points // 10_000)
            new_price = price + direction * step
            cost = _integer(
                _find(item, "costCents", "unitCostCents", "ingredientCostCents")
            )
            if cost is not None:
                new_price = max(new_price, cost * 110 // 100)
            minimum = _integer(_find(item, "minPriceCents"))
            maximum = _integer(_find(item, "maxPriceCents"))
            if minimum is not None:
                new_price = max(new_price, minimum)
            if maximum is not None:
                new_price = min(new_price, maximum)
            if new_price != price:
                return ActionIntent(
                    "set_menu_price",
                    {"dishId": dish_id, "priceCents": new_price},
                    reason,
                )
        return None

    def _inventory_action(
        self, inventory: list[dict[str, Any]]
    ) -> ActionIntent | None:
        for item in inventory:
            ingredient_id = _resource_id(_find(item, "ingredientId", "id"))
            quantity = _number(_find(item, "quantity", "stock", "onHand"))
            if ingredient_id is None or quantity is None:
                continue
            pending = _number(
                _find(item, "pendingQuantity", "onOrder", "incomingQuantity")
            ) or 0.0
            stock_position = quantity + max(0.0, pending)
            usage = _number(_find(item, "usagePerTick", "consumptionPerTick"))
            reorder = _number(_find(item, "reorderPoint", "minimumQuantity"))
            target = _number(_find(item, "targetQuantity", "parQuantity"))
            maximum = _number(_find(item, "maxQuantity", "storageCapacity"))
            if target is None and usage is not None:
                target = usage * self.config.inventory_target_ticks
            if target is None and reorder is not None:
                target = reorder * 2
            if target is None:
                target = 12.0
            if maximum is not None:
                target = min(target, maximum)
            threshold = reorder if reorder is not None else target / 4
            if stock_position <= threshold:
                desired_order = max(1, int(round(target - stock_position)))
                order = min(self.config.max_inventory_order, 500, desired_order)
                if maximum is not None:
                    headroom = int(maximum - stock_position)
                    if headroom < 1:
                        continue
                    order = min(order, headroom)
                return ActionIntent(
                    "purchase_inventory",
                    {"ingredientId": ingredient_id, "quantity": order},
                    "restore low inventory toward its operating target",
                )
        return None

    def _staff_actions(
        self,
        staff: Any,
        utilization: float | None,
        margin: float | None,
    ) -> list[ActionIntent]:
        if utilization is None:
            return []
        states = _staff_states(staff)
        actions: list[ActionIntent] = []
        for role in ("chef", "server"):
            state = states.get(role)
            if state is None:
                continue
            count = state["count"]
            target = state["target"]
            # Hiring, departures, and temporary absence are already visible in
            # the target/pipeline. Wait for them rather than repeatedly moving
            # the target in response to delayed capacity.
            if (
                target != count
                or state["pending"] > 0
                or state["hiring_ticks"] > 0
                or state["absent"] > 0
            ):
                continue
            if utilization >= 0.95 and (margin is None or margin >= 0):
                new_count = min(10, target + self.config.max_staff_step)
                reason = "service demand exceeds comfortable capacity"
            elif utilization <= 0.45 and count > 1:
                new_count = max(1, target - self.config.max_staff_step)
                reason = "demand leaves sustained staffing headroom"
            else:
                continue
            if new_count == target:
                continue
            actions.append(
                ActionIntent(
                    "set_staff", {"role": role, "count": new_count}, reason
                )
            )
        return actions

    def _marketing_action(
        self,
        budget: float | None,
        utilization: float | None,
        margin: float | None,
        liquidity_pressure: bool = False,
    ) -> ActionIntent | None:
        if budget is None:
            return None
        current = max(0, int(round(budget)))
        if liquidity_pressure and current > 0:
            return ActionIntent(
                "set_marketing",
                {
                    "budgetCents": max(
                        0, current - self.config.marketing_step_cents
                    )
                },
                "preserve cash while liquidity is under pressure",
            )
        if utilization is None:
            return None
        if utilization < 0.75 and (margin is None or margin >= 0.12):
            new_budget = min(5_000, current + self.config.marketing_step_cents)
            if new_budget == current:
                return None
            return ActionIntent(
                "set_marketing",
                {"budgetCents": new_budget},
                "spare capacity can absorb additional demand",
            )
        if (utilization >= 0.95 or (margin is not None and margin < 0)) and current > 0:
            return ActionIntent(
                "set_marketing",
                {"budgetCents": max(0, current - self.config.marketing_step_cents)},
                "avoid buying demand while capacity or margin is constrained",
            )
        return None

    def _has_liquidity_pressure(
        self,
        cash: int | None,
        debt: int | None,
        credit_limit: int | None,
        cash_flow: int | None,
    ) -> bool:
        if cash is None:
            return False
        if cash <= self.config.cash_reserve_cents:
            return True
        if cash_flow is not None and cash_flow < 0:
            if cash + cash_flow < self.config.cash_reserve_cents:
                return True
        if debt is not None and credit_limit is not None and credit_limit > 0:
            prudent_limit = (
                credit_limit
                * self.config.max_credit_utilization_basis_points
                // 10_000
            )
            return debt >= prudent_limit
        return False

    def _equipment_actions(
        self,
        restaurant: Mapping[str, Any],
        observation: Mapping[str, Any],
    ) -> tuple[list[ActionIntent], ActionIntent | None]:
        equipment = _first_present(
            _find(restaurant, "equipment", "assets"),
            _find(observation, "equipment", "assets"),
        )
        assets = _entries(equipment, id_name="assetId")
        repairs: list[ActionIntent] = []
        maintenance_candidates: list[tuple[int, str]] = []
        for asset in assets:
            asset_id = _string(_find(asset, "assetId", "id", "kind"))
            if asset_id not in {"kitchen", "refrigeration"}:
                continue
            status = _string(_find(asset, "status", "state"))
            if status == "broken":
                repairs.append(
                    ActionIntent(
                        "repair_equipment",
                        {"assetId": asset_id},
                        "restore broken equipment and shorten operational downtime",
                    )
                )
                continue
            condition = _integer(
                _find(asset, "conditionBps", "conditionBasisPoints", "condition")
            )
            maintenance_boost = _integer(
                _find(asset, "maintenanceBoostTicks", "maintenanceTicksRemaining")
            )
            if (
                status in {None, "operational"}
                and condition is not None
                and condition <= self.config.maintenance_condition_basis_points
                and (maintenance_boost is None or maintenance_boost <= 0)
            ):
                maintenance_candidates.append((condition, asset_id))

        maintenance = None
        if maintenance_candidates:
            _, asset_id = min(maintenance_candidates)
            maintenance = ActionIntent(
                "schedule_maintenance",
                {"assetId": asset_id},
                "service deteriorating equipment before a breakdown",
            )
        return repairs, maintenance

    def _expedite_action(
        self,
        purchase_orders: list[dict[str, Any]],
        *,
        decision_tick: int,
        inventory_units: int | None,
        expected_units: int | None,
    ) -> ActionIntent | None:
        if inventory_units is None or expected_units is None or expected_units <= 0:
            return None
        candidates: list[tuple[int, dict[str, Any]]] = []
        for order in purchase_orders:
            order_id = _resource_id(_find(order, "id", "orderId"))
            due_tick = _integer(_find(order, "dueTick", "expectedTick"))
            original_due_tick = _integer(
                _find(order, "originalDueTick", "promisedTick", "orderedDueTick")
            )
            disruptions = _integer(
                _find(order, "disruptionCount", "delayCount")
            ) or 0
            delayed = _boolean(_find(order, "delayed", "isDelayed"))
            if (
                order_id is None
                or due_tick is None
                or original_due_tick is None
                or decision_tick <= original_due_tick
                or due_tick <= decision_tick + 1
                or not (disruptions > 0 or delayed or due_tick > original_due_tick)
            ):
                continue
            candidates.append((due_tick, order))

        for due_tick, order in sorted(candidates, key=lambda item: item[0]):
            available_before_delivery = inventory_units
            ingredient_id = _string(
                _find(order, "ingredientId", "ingredient")
            )
            for other in purchase_orders:
                if other is order:
                    continue
                other_ingredient_id = _string(
                    _find(other, "ingredientId", "ingredient")
                )
                if (
                    ingredient_id is not None
                    and other_ingredient_id not in {None, ingredient_id}
                ):
                    continue
                other_due = _integer(_find(other, "dueTick", "expectedTick"))
                if other_due is not None and other_due < due_tick:
                    available_before_delivery += max(
                        0, _integer(_find(other, "quantity", "units")) or 0
                    )
            required_before_delivery = expected_units * (due_tick - decision_tick)
            if available_before_delivery < required_before_delivery:
                return ActionIntent(
                    "expedite_delivery",
                    {"orderId": _resource_id(_find(order, "id", "orderId"))},
                    "a disrupted late order now threatens a stockout",
                )
        return None

    def _training_action(
        self,
        staff: Any,
        *,
        utilization: float | None,
        margin: float | None,
        cash_flow: int | None,
        liquidity_pressure: bool,
    ) -> ActionIntent | None:
        if (
            liquidity_pressure
            or utilization is None
            or utilization > 0.8
            or (margin is not None and margin < 0)
            or (cash_flow is not None and cash_flow < 0)
        ):
            return None
        candidates: list[tuple[int, str]] = []
        for role, state in _staff_states(staff).items():
            skill = state["skill"]
            available = state["count"] - state["absent"]
            if (
                skill is not None
                and skill < self.config.training_skill_basis_points
                and available >= 2
                and state["target"] == state["count"]
                and state["pending"] == 0
                and state["hiring_ticks"] == 0
                and state["training_ticks"] == 0
                and (state["fatigue"] is None or state["fatigue"] <= 7_000)
                and (state["morale"] is None or state["morale"] >= 5_000)
            ):
                candidates.append((skill, role))
        if not candidates:
            return None
        _, role = min(candidates)
        return ActionIntent(
            "train_staff",
            {"role": role, "budgetCents": self.config.training_budget_cents},
            "improve a covered role while cash and service headroom permit",
        )

    def _financially_safe_actions(
        self,
        prioritized: list[ActionIntent],
        *,
        cash: int,
        debt: int | None,
        credit_limit: int | None,
        cash_flow: int | None,
        market: Mapping[str, Any],
        capacity_level: int,
        purchase_orders: list[dict[str, Any]],
    ) -> list[ActionIntent]:
        limit = self.config.max_actions_per_decision
        essential = [
            action
            for action in prioritized
            if action.action_type in {"repair_equipment", "purchase_inventory"}
        ]
        if len(essential) >= limit:
            essential = essential[: max(0, limit - 1)]
        essential_cost = sum(
            self._action_cost(
                action, market, capacity_level, purchase_orders
            )
            or 0
            for action in essential
        )
        needed = max(
            0, self.config.cash_reserve_cents + essential_cost - cash
        )
        borrow_amount = 0
        if needed > 0 and debt is not None and credit_limit is not None:
            prudent_limit = (
                credit_limit
                * self.config.max_credit_utilization_basis_points
                // 10_000
            )
            available_credit = max(0, prudent_limit - debt)
            requested = max(5_000, needed)
            if requested <= min(100_000, available_credit) and limit >= 2:
                borrow_amount = requested

        selected: list[ActionIntent] = []
        available_cash = cash
        if borrow_amount:
            selected.append(
                ActionIntent(
                    "borrow",
                    {"amountCents": borrow_amount},
                    "fund required operations while retaining the cash reserve",
                )
            )
            available_cash += borrow_amount

        for action in prioritized:
            if len(selected) >= limit:
                break
            cost = self._action_cost(
                action, market, capacity_level, purchase_orders
            )
            if cost is None:
                continue
            if cost > 0 and available_cash - cost < self.config.cash_reserve_cents:
                continue
            selected.append(action)
            available_cash -= cost

        if (
            not borrow_amount
            and len(selected) < limit
            and debt is not None
            and debt > 0
            and (cash_flow is None or cash_flow >= 0)
        ):
            surplus = max(0, available_cash - self.config.cash_reserve_cents)
            repayment = min(
                debt, surplus, self.config.max_debt_repayment_cents, 100_000
            )
            if repayment > 0:
                selected.append(
                    ActionIntent(
                        "repay_loan",
                        {"amountCents": repayment},
                        "retire debt from cash above the protected reserve",
                    )
                )
        return selected

    def _action_cost(
        self,
        action: ActionIntent,
        market: Mapping[str, Any],
        capacity_level: int,
        purchase_orders: list[dict[str, Any]],
    ) -> int | None:
        if action.action_type == "purchase_inventory":
            unit_cost = _integer(
                _find(market, "ingredientUnitCostCents", "unitCostCents")
            )
            quantity = _integer(_find(action.params, "quantity"))
            if unit_cost is None or quantity is None:
                return None
            return unit_cost * quantity
        if action.action_type in {"schedule_maintenance", "repair_equipment"}:
            asset_id = _string(_find(action.params, "assetId"))
            if asset_id not in {"kitchen", "refrigeration"}:
                return None
            if action.action_type == "schedule_maintenance":
                return (1_800 if asset_id == "kitchen" else 1_500) + capacity_level * 300
            return (2_800 if asset_id == "kitchen" else 2_200) + capacity_level * 400
        if action.action_type == "train_staff":
            return _integer(_find(action.params, "budgetCents"))
        if action.action_type == "expedite_delivery":
            order_id = _resource_id(_find(action.params, "orderId"))
            for order in purchase_orders:
                if _resource_id(_find(order, "id", "orderId")) == order_id:
                    quantity = _integer(_find(order, "quantity", "units"))
                    return None if quantity is None else 1_000 + quantity * 20
            return None
        return 0


def run_baseline(
    client: Client,
    *,
    agent: HeuristicBaseline | None = None,
    poll_interval: float = 1.0,
    wait_timeout: float = 30.0,
    until_tick: int | None = None,
    on_event: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, int]:
    """Run the baseline until the game or an optional tick limit ends.

    The function performs one private read per decision. Between decisions it
    delegates all public polling to ``Client.wait_for_tick`` with the caller's
    explicit cadence and timeout.
    """

    baseline = agent or HeuristicBaseline()
    public = client.public_state()
    decisions = 0
    submitted = 0
    last_tick = _required_public_tick(public, client)

    while True:
        max_ticks = _integer(_find(_mapping(public), "maxTicks"))
        stop_tick = until_tick
        if max_ticks is not None:
            stop_tick = max_ticks if stop_tick is None else min(stop_tick, max_ticks)
        status = _string(_find(_mapping(public), "status"))
        if (stop_tick is not None and last_tick >= stop_tick) or status in {
            "finished",
            "completed",
            "cancelled",
        }:
            break

        observation = client.state()
        if not isinstance(observation, Mapping):
            raise ProtocolError(
                "private observation must be an object",
                method="GET",
                url=client._url("agent/state"),
            )
        intents = baseline.decide(observation, tick=last_tick)
        decisions += 1
        for intent in intents:
            request_id = client.new_request_id()
            result = client.act(
                intent.action_type,
                request_id=request_id,
                **intent.params,
            )
            submitted += 1
            if on_event is not None:
                on_event(
                    {
                        "tick": last_tick,
                        "requestId": request_id,
                        "type": intent.action_type,
                        "params": intent.params,
                        "reason": intent.reason,
                        "result": result,
                    }
                )

        target_tick = last_tick + baseline.config.decision_interval_ticks
        if stop_tick is not None:
            target_tick = min(target_tick, stop_tick)
        public = client.wait_for_tick(
            target_tick,
            poll_interval=poll_interval,
            timeout=wait_timeout,
        )
        last_tick = _required_public_tick(public, client)

    return {"decisions": decisions, "actions": submitted, "lastTick": last_tick}


def _required_public_tick(public: Any, client: Client) -> int:
    tick = _integer(_find(_mapping(public), "tick"))
    if tick is None:
        raise ProtocolError(
            "public snapshot must contain an integer tick",
            method="GET",
            url=client._url("public"),
        )
    return tick


def _profit_margin(
    observation: Mapping[str, Any],
    restaurant: Mapping[str, Any],
    last_tick: Mapping[str, Any],
) -> float | None:
    explicit = _first_number(
        _find(observation, "profitMargin", "operatingMargin", "margin"),
        _find(restaurant, "profitMargin", "operatingMargin", "margin"),
    )
    if explicit is not None:
        return explicit / 100 if abs(explicit) > 1 else explicit

    revenue = _first_number(
        _find(last_tick, "revenueCents"),
        _find(observation, "revenueCents"),
        _find(restaurant, "revenueCents"),
    )
    profit = _first_number(
        _find(last_tick, "operatingProfitCents"),
        _find(observation, "operatingProfitCents", "profitCents"),
        _find(restaurant, "operatingProfitCents", "profitCents"),
    )
    if profit is None:
        expenses = _first_number(
            _find(observation, "expensesCents"),
            _find(restaurant, "expensesCents"),
        )
        if revenue is not None and expenses is not None:
            profit = revenue - expenses
    if revenue is None or revenue <= 0 or profit is None:
        return None
    return profit / revenue


def _staff_states(value: Any) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}

    def add(role: str, raw: Any) -> None:
        normalized_role = "chef" if role == "cook" else role
        if normalized_role not in {"chef", "server"}:
            return
        if isinstance(raw, Mapping):
            count = _first_integer(
                _find(raw, "count", "actualCount", "actual")
            )
            target = _first_integer(
                _find(raw, "targetCount", "target", "desiredCount"), count
            )
            pending = _first_integer(
                _find(raw, "pendingHireCount", "pendingHires", "pipelineCount"),
                0,
            )
            hiring_ticks = _first_integer(
                _find(raw, "hiringTicksRemaining", "hireTicksRemaining"), 0
            )
            absent = _first_integer(
                _find(raw, "absentCount", "absences", "unavailableCount"), 0
            )
            training_ticks = _first_integer(
                _find(raw, "trainingTicksRemaining", "trainingRemaining"), 0
            )
            skill = _first_integer(
                _find(raw, "averageSkillBps", "skillBps", "skill")
            )
            fatigue = _first_integer(_find(raw, "fatigueBps", "fatigue"))
            morale = _first_integer(_find(raw, "moraleBps", "morale"))
        else:
            count = _integer(raw)
            target = count
            pending = 0
            hiring_ticks = 0
            absent = 0
            training_ticks = 0
            skill = None
            fatigue = None
            morale = None
        if count is None or target is None:
            return
        result[normalized_role] = {
            "count": max(0, count),
            "target": max(0, target),
            "pending": max(0, pending or 0),
            "hiring_ticks": max(0, hiring_ticks or 0),
            "absent": max(0, absent or 0),
            "training_ticks": max(0, training_ticks or 0),
            "skill": skill,
            "fatigue": fatigue,
            "morale": morale,
        }

    if isinstance(value, Mapping):
        for role in ("chef", "cook", "server"):
            if role in value:
                add(role, value[role])
    elif _is_sequence(value):
        for item in value:
            if not isinstance(item, Mapping):
                continue
            role = _string(_find(item, "role", "staffRole"))
            if role is not None:
                add(role, item)
    return result


def _inventory_lot_units(restaurant: Mapping[str, Any]) -> int | None:
    raw_lots = _find(restaurant, "inventoryLots", "lots")
    if not _is_sequence(raw_lots):
        return None
    total = 0
    found = False
    for raw in raw_lots:
        if not isinstance(raw, Mapping):
            continue
        quantity = _integer(_find(raw, "quantity", "units"))
        if quantity is not None:
            total += max(0, quantity)
            found = True
    return total if found else None


def _purchase_orders(
    observation: Mapping[str, Any], restaurant: Mapping[str, Any]
) -> list[dict[str, Any]]:
    raw_orders = _first_present(
        _find(restaurant, "purchaseOrders", "pendingOrders", "orders"),
        _find(observation, "purchaseOrders", "pendingOrders", "orders"),
    )
    orders = _entries(raw_orders, id_name="orderId")
    pending: list[dict[str, Any]] = []
    for order in orders:
        status = _string(_find(order, "status", "state"))
        delivered_tick = _find(order, "deliveredTick", "receivedTick")
        if status in {"delivered", "received", "cancelled"}:
            continue
        if delivered_tick is not None:
            continue
        pending.append(order)
    return pending


def _entries(value: Any, *, id_name: str) -> list[dict[str, Any]]:
    if _is_sequence(value):
        return [dict(item) for item in value if isinstance(item, Mapping)]
    if isinstance(value, Mapping):
        entries: list[dict[str, Any]] = []
        for key, raw in value.items():
            if isinstance(raw, Mapping):
                item = dict(raw)
            else:
                item = {"quantity": raw}
            item.setdefault(id_name, str(key))
            entries.append(item)
        return entries
    return []


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _find(value: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in value:
            return value[name]
    return None


def _first_present(*values: Any) -> Any:
    return next((value for value in values if value is not None), None)


def _first_number(*values: Any) -> float | None:
    for value in values:
        number = _number(value)
        if number is not None:
            return number
        if isinstance(value, Mapping):
            number = _first_number(
                _find(value, "value", "total", "count", "customers")
            )
            if number is not None:
                return number
    return None


def _first_integer(*values: Any) -> int | None:
    for value in values:
        integer = _integer(value)
        if integer is not None:
            return integer
    return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _integer(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _resource_id(value: Any) -> str | None:
    candidate = _string(value)
    if candidate is None or not 1 <= len(candidate) <= 64:
        return None
    if not candidate[0].isascii() or not candidate[0].isalnum():
        return None
    if any(
        not character.isascii()
        or (not character.isalnum() and character not in {"_", "-"})
        for character in candidate[1:]
    ):
        return None
    return candidate


def _boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in {"true", "yes", "bankrupt", "insolvent"}
    return False


def _is_sequence(value: Any) -> bool:
    return isinstance(value, Sequence) and not isinstance(
        value, (str, bytes, bytearray)
    )


def main(argv: list[str] | None = None) -> int:
    """Run the baseline through the shared ``rsim`` CLI parser."""

    from .cli import main as cli_main

    arguments = sys.argv[1:] if argv is None else argv
    return cli_main(["baseline", *arguments])


if __name__ == "__main__":
    raise SystemExit(main())
