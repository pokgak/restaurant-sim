"""Zero-runtime-dependency HTTP client for Restaurant Sim."""

from __future__ import annotations

import json
import os
import time
import uuid
from collections.abc import Mapping
from typing import Any, Literal
from urllib.error import HTTPError as UrlHTTPError
from urllib.error import URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


class ClientError(Exception):
    """Base class for errors callers can inspect programmatically."""

    code = "client_error"

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self)}


class ConfigurationError(ClientError):
    """The client configuration is missing or invalid."""

    code = "configuration_error"


class TransportError(ClientError):
    """The server could not be reached or the request timed out."""

    code = "transport_error"

    def __init__(
        self,
        message: str,
        *,
        method: str,
        url: str,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.method = method
        self.url = url
        self.request_id = request_id

    def as_dict(self) -> dict[str, Any]:
        value = super().as_dict()
        value.update(method=self.method, url=self.url)
        if self.request_id is not None:
            value["requestId"] = self.request_id
        return value


class ProtocolError(ClientError):
    """The server returned a successful response with an invalid shape."""

    code = "protocol_error"

    def __init__(self, message: str, *, method: str, url: str) -> None:
        super().__init__(message)
        self.method = method
        self.url = url

    def as_dict(self) -> dict[str, Any]:
        value = super().as_dict()
        value.update(method=self.method, url=self.url)
        return value


class APIError(ClientError):
    """A non-success HTTP response from Restaurant Sim."""

    code = "api_error"

    def __init__(
        self,
        message: str,
        *,
        status: int,
        method: str,
        url: str,
        server_code: str | None = None,
        details: Any = None,
        response: Any = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.method = method
        self.url = url
        self.server_code = server_code
        self.details = details
        self.response = response
        self.request_id = request_id

    def as_dict(self) -> dict[str, Any]:
        value = super().as_dict()
        value.update(status=self.status, method=self.method, url=self.url)
        if self.server_code is not None:
            value["serverCode"] = self.server_code
        if self.details is not None:
            value["details"] = self.details
        if self.request_id is not None:
            value["requestId"] = self.request_id
        return value


class WaitTimeout(ClientError):
    """A public tick did not reach the requested value before the deadline."""

    code = "wait_timeout"

    def __init__(
        self,
        *,
        target_tick: int,
        last_tick: int | None,
        timeout: float,
        poll_interval: float,
        polls: int,
    ) -> None:
        super().__init__(
            f"tick did not reach {target_tick} within {timeout:g} seconds "
            f"(last tick: {last_tick})"
        )
        self.target_tick = target_tick
        self.last_tick = last_tick
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.polls = polls

    def as_dict(self) -> dict[str, Any]:
        value = super().as_dict()
        value.update(
            targetTick=self.target_tick,
            lastTick=self.last_tick,
            timeout=self.timeout,
            pollInterval=self.poll_interval,
            polls=self.polls,
        )
        return value


class Client:
    """Client for the private seat API and public game snapshot.

    ``from_env`` reads ``RESTAURANT_SIM_URL``, ``RESTAURANT_SIM_GAME``, and
    ``RESTAURANT_SIM_TOKEN``. Private requests send the token as a Bearer
    credential; public snapshots deliberately do not send it.
    """

    def __init__(
        self,
        base_url: str,
        game_id: str,
        token: str,
        *,
        timeout: float = 10.0,
    ) -> None:
        self.base_url = _validate_base_url(base_url)
        if not game_id:
            raise ConfigurationError("game_id must not be empty")
        if not token:
            raise ConfigurationError("token must not be empty")
        if timeout <= 0:
            raise ConfigurationError("timeout must be greater than zero")
        self.game_id = game_id
        self.token = token
        self.timeout = timeout

    @classmethod
    def from_env(
        cls,
        env: Mapping[str, str] | None = None,
        *,
        timeout: float = 10.0,
    ) -> Client:
        """Build a client from the three Restaurant Sim environment values."""

        source = os.environ if env is None else env
        names = (
            "RESTAURANT_SIM_URL",
            "RESTAURANT_SIM_GAME",
            "RESTAURANT_SIM_TOKEN",
        )
        missing = [name for name in names if not source.get(name)]
        if missing:
            raise ConfigurationError(
                "missing environment variable(s): " + ", ".join(missing)
            )
        return cls(
            source["RESTAURANT_SIM_URL"],
            source["RESTAURANT_SIM_GAME"],
            source["RESTAURANT_SIM_TOKEN"],
            timeout=timeout,
        )

    @staticmethod
    def new_request_id() -> str:
        """Return a unique ID that can be reused for retries of one action."""

        return str(uuid.uuid4())

    def state(self) -> Any:
        """Return this seat's private observation."""

        return self._request("GET", "agent/state", authenticated=True)

    def public_state(self) -> Any:
        """Return the game's public snapshot without sending the seat token."""

        return self._request("GET", "public", authenticated=False)

    def act(
        self,
        action_type: str,
        *,
        request_id: str | None = None,
        **params: Any,
    ) -> Any:
        """Submit an action, passing all parameters through unchanged.

        Pass ``request_id`` explicitly when the caller may retry after an
        uncertain transport result. Automatically generated IDs are attached
        to structured exceptions so that the same action can be retried.
        """

        if not isinstance(action_type, str) or not action_type:
            raise ConfigurationError("action_type must not be empty")
        action_request_id = (
            self.new_request_id() if request_id is None else request_id
        )
        if not isinstance(action_request_id, str) or not action_request_id:
            raise ConfigurationError("request_id must not be empty")
        payload = {
            "requestId": action_request_id,
            "type": action_type,
            "params": params,
        }
        return self._request(
            "POST",
            "agent/actions",
            authenticated=True,
            payload=payload,
            request_id=action_request_id,
        )

    def set_menu_price(
        self,
        dish_id: str,
        price_cents: int,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "set_menu_price",
            request_id=request_id,
            dishId=dish_id,
            priceCents=price_cents,
        )

    def purchase_inventory(
        self,
        ingredient_id: str,
        quantity: int,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "purchase_inventory",
            request_id=request_id,
            ingredientId=ingredient_id,
            quantity=quantity,
        )

    def set_staff(
        self,
        role: Literal["chef", "server"] | str,
        count: int,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "set_staff", request_id=request_id, role=role, count=count
        )

    def set_marketing(
        self,
        budget_cents: int,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "set_marketing",
            request_id=request_id,
            budgetCents=budget_cents,
        )

    def invest(
        self,
        kind: Literal["capacity", "quality"] | str,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act("invest", request_id=request_id, kind=kind)

    def borrow(
        self,
        amount_cents: int,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "borrow", request_id=request_id, amountCents=amount_cents
        )

    def repay_loan(
        self,
        amount_cents: int,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "repay_loan", request_id=request_id, amountCents=amount_cents
        )

    def schedule_maintenance(
        self,
        asset_id: Literal["kitchen", "refrigeration"] | str,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "schedule_maintenance", request_id=request_id, assetId=asset_id
        )

    def repair_equipment(
        self,
        asset_id: Literal["kitchen", "refrigeration"] | str,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "repair_equipment", request_id=request_id, assetId=asset_id
        )

    def train_staff(
        self,
        role: Literal["chef", "server"] | str,
        budget_cents: int,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "train_staff",
            request_id=request_id,
            role=role,
            budgetCents=budget_cents,
        )

    def expedite_delivery(
        self,
        order_id: str,
        *,
        request_id: str | None = None,
    ) -> Any:
        return self.act(
            "expedite_delivery", request_id=request_id, orderId=order_id
        )

    def wait_for_tick(
        self,
        target_tick: int,
        *,
        poll_interval: float = 1.0,
        timeout: float = 30.0,
    ) -> Any:
        """Poll the public snapshot until ``tick >= target_tick``.

        One read happens immediately. Further reads are no more frequent than
        ``poll_interval`` and stop at ``timeout``. Both values are mandatory
        parts of the observable polling contract because server reads are
        audit-logged.
        """

        if isinstance(target_tick, bool) or not isinstance(target_tick, int):
            raise ConfigurationError("target_tick must be an integer")
        if target_tick < 0:
            raise ConfigurationError("target_tick must not be negative")
        if poll_interval <= 0:
            raise ConfigurationError("poll_interval must be greater than zero")
        if timeout < 0:
            raise ConfigurationError("timeout must not be negative")

        deadline = time.monotonic() + timeout
        polls = 0
        last_tick: int | None = None
        first = True
        while first or time.monotonic() < deadline:
            first = False
            snapshot = self.public_state()
            polls += 1
            last_tick = _public_tick(snapshot, method="GET", url=self._url("public"))
            if last_tick >= target_tick:
                return snapshot
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(poll_interval, remaining))

        raise WaitTimeout(
            target_tick=target_tick,
            last_tick=last_tick,
            timeout=timeout,
            poll_interval=poll_interval,
            polls=polls,
        )

    def _url(self, endpoint: str) -> str:
        encoded_game_id = quote(self.game_id, safe="")
        return f"{self.base_url}/api/games/{encoded_game_id}/{endpoint}"

    def _request(
        self,
        method: str,
        endpoint: str,
        *,
        authenticated: bool,
        payload: Any = None,
        request_id: str | None = None,
    ) -> Any:
        url = self._url(endpoint)
        headers = {
            "Accept": "application/json",
            "User-Agent": "restaurant-sim-python/0.1",
        }
        data: bytes | None = None
        if authenticated:
            headers["Authorization"] = f"Bearer {self.token}"
        if payload is not None:
            try:
                data = json.dumps(
                    payload, separators=(",", ":"), allow_nan=False
                ).encode("utf-8")
            except (TypeError, ValueError) as error:
                raise ConfigurationError(
                    f"request payload is not valid JSON: {error}"
                ) from error
            headers["Content-Type"] = "application/json"
        request = Request(url, data=data, headers=headers, method=method)

        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except UrlHTTPError as error:
            raw = error.read()
            parsed = _decode_error_body(raw)
            server_code, message, details = _server_error_fields(
                parsed, fallback=f"HTTP {error.code}"
            )
            raise APIError(
                message,
                status=error.code,
                method=method,
                url=url,
                server_code=server_code,
                details=details,
                response=parsed,
                request_id=request_id,
            ) from None
        except (URLError, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            raise TransportError(
                f"{method} request failed: {reason}",
                method=method,
                url=url,
                request_id=request_id,
            ) from error

        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProtocolError(
                "server returned invalid JSON", method=method, url=url
            ) from error


def _validate_base_url(value: str) -> str:
    if not value:
        raise ConfigurationError("base_url must not be empty")
    normalized = value.rstrip("/")
    parts = urlsplit(normalized)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ConfigurationError("base_url must be an absolute HTTP(S) URL")
    if parts.query or parts.fragment:
        raise ConfigurationError("base_url must not contain a query or fragment")
    return normalized


def _decode_error_body(raw: bytes) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return raw.decode("utf-8", errors="replace")


def _server_error_fields(
    response: Any, *, fallback: str
) -> tuple[str | None, str, Any]:
    candidate = response
    if isinstance(response, Mapping) and "error" in response:
        candidate = response["error"]

    if isinstance(candidate, Mapping):
        code = candidate.get("code")
        message = candidate.get("message") or candidate.get("error") or fallback
        details = candidate.get("details")
        return (
            str(code) if code is not None else None,
            str(message),
            details,
        )
    if isinstance(candidate, str) and candidate.strip():
        return None, candidate.strip(), None
    return None, fallback, None


def _public_tick(snapshot: Any, *, method: str, url: str) -> int:
    if not isinstance(snapshot, Mapping):
        raise ProtocolError("public snapshot must be an object", method=method, url=url)
    tick = snapshot.get("tick")
    if isinstance(tick, bool) or not isinstance(tick, int):
        raise ProtocolError(
            "public snapshot must contain an integer tick", method=method, url=url
        )
    return tick
