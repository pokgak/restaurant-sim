from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from restaurant_sim import APIError, Client, WaitTimeout


class MockHandler(BaseHTTPRequestHandler):
    server: "MockServer"

    def do_GET(self) -> None:
        self._record(None)
        status, body = self.server.next_response(self.path)
        self._send(status, body)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        self._record(body)
        status, response = self.server.next_response(self.path)
        self._send(status, response)

    def _record(self, body: Any) -> None:
        self.server.records.append(
            {
                "method": self.command,
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "content_type": self.headers.get("Content-Type"),
                "user_agent": self.headers.get("User-Agent"),
                "body": body,
            }
        )

    def _send(self, status: int, body: Any) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: Any) -> None:
        pass


class MockServer(ThreadingHTTPServer):
    records: list[dict[str, Any]]
    responses: dict[str, list[tuple[int, Any]]]

    def next_response(self, path: str) -> tuple[int, Any]:
        responses = self.responses.get(path)
        if responses:
            if len(responses) > 1:
                return responses.pop(0)
            return responses[0]
        if path.endswith("/agent/state"):
            return 200, {"tick": 4, "cashCents": 10_000}
        if path.endswith("/agent/actions"):
            return 200, {"ok": True, "code": "accepted", "message": "ok"}
        if path.endswith("/public"):
            return 200, {"tick": 4, "maxTicks": 100}
        return 404, {"error": {"code": "not_found", "message": "not found"}}


class ClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = MockServer(("127.0.0.1", 0), MockHandler)
        self.server.records = []
        self.server.responses = {}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.base_url = f"http://{host}:{port}/root/"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def client(self, game_id: str = "game-1") -> Client:
        return Client(self.base_url, game_id, "seat-secret", timeout=1)

    def test_from_env_uses_frozen_configuration_names(self) -> None:
        client = Client.from_env(
            {
                "RESTAURANT_SIM_URL": self.base_url,
                "RESTAURANT_SIM_GAME": "configured-game",
                "RESTAURANT_SIM_TOKEN": "configured-token",
            }
        )

        self.assertEqual(client.base_url, self.base_url.rstrip("/"))
        self.assertEqual(client.game_id, "configured-game")
        self.assertEqual(client.token, "configured-token")

    def test_private_state_uses_auth_and_encoded_game_url(self) -> None:
        result = self.client("game / one").state()

        self.assertEqual(result["tick"], 4)
        self.assertEqual(
            self.server.records[0]["path"],
            "/root/api/games/game%20%2F%20one/agent/state",
        )
        self.assertEqual(
            self.server.records[0]["authorization"], "Bearer seat-secret"
        )
        self.assertEqual(
            self.server.records[0]["user_agent"], "restaurant-sim-python/0.1"
        )

    def test_action_body_has_retry_id_and_passes_future_params(self) -> None:
        result = self.client().act(
            "future_action",
            request_id="retry-this-action",
            nested={"enabled": True},
            amount=7,
        )

        record = self.server.records[0]
        self.assertTrue(result["ok"])
        self.assertEqual(record["method"], "POST")
        self.assertEqual(record["content_type"], "application/json")
        self.assertEqual(record["authorization"], "Bearer seat-secret")
        self.assertEqual(
            record["body"],
            {
                "requestId": "retry-this-action",
                "type": "future_action",
                "params": {"nested": {"enabled": True}, "amount": 7},
            },
        )

    def test_action_vocabulary_and_automatic_request_ids(self) -> None:
        client = self.client()
        client.set_menu_price("burger", 1_299)
        client.purchase_inventory("flour", 20)
        client.set_staff("server", 3)
        client.set_marketing(500)
        client.invest("capacity")
        client.borrow(20_000, request_id="stable-borrow-id")
        client.repay_loan(5_000)
        client.schedule_maintenance("kitchen")
        client.repair_equipment("refrigeration")
        client.train_staff("chef", 1_500)
        client.expedite_delivery("order-7")

        bodies = [record["body"] for record in self.server.records]
        self.assertEqual(
            [(body["type"], body["params"]) for body in bodies],
            [
                ("set_menu_price", {"dishId": "burger", "priceCents": 1_299}),
                (
                    "purchase_inventory",
                    {"ingredientId": "flour", "quantity": 20},
                ),
                ("set_staff", {"role": "server", "count": 3}),
                ("set_marketing", {"budgetCents": 500}),
                ("invest", {"kind": "capacity"}),
                ("borrow", {"amountCents": 20_000}),
                ("repay_loan", {"amountCents": 5_000}),
                ("schedule_maintenance", {"assetId": "kitchen"}),
                ("repair_equipment", {"assetId": "refrigeration"}),
                ("train_staff", {"role": "chef", "budgetCents": 1_500}),
                ("expedite_delivery", {"orderId": "order-7"}),
            ],
        )
        request_ids = [body["requestId"] for body in bodies]
        self.assertEqual(len(set(request_ids)), len(request_ids))
        self.assertTrue(all(request_ids))
        self.assertEqual(request_ids[5], "stable-borrow-id")

    def test_server_error_is_structured(self) -> None:
        path = "/root/api/games/game-1/agent/state"
        self.server.responses[path] = [
            (
                422,
                {
                    "error": {
                        "code": "invalid_state",
                        "message": "seat is closed",
                        "details": {"tick": 99},
                    }
                },
            )
        ]

        with self.assertRaises(APIError) as raised:
            self.client().state()

        error = raised.exception
        self.assertEqual(error.status, 422)
        self.assertEqual(error.server_code, "invalid_state")
        self.assertEqual(str(error), "seat is closed")
        self.assertEqual(error.details, {"tick": 99})
        self.assertEqual(error.as_dict()["method"], "GET")

    def test_wait_for_tick_times_out_with_visible_poll_metadata(self) -> None:
        path = "/root/api/games/game-1/public"
        self.server.responses[path] = [(200, {"tick": 2, "maxTicks": 100})]

        with self.assertRaises(WaitTimeout) as raised:
            self.client().wait_for_tick(3, poll_interval=0.02, timeout=0.2)

        error = raised.exception
        self.assertEqual(error.target_tick, 3)
        self.assertEqual(error.last_tick, 2)
        self.assertEqual(error.poll_interval, 0.02)
        self.assertGreaterEqual(error.polls, 2)
        self.assertTrue(
            all(record["authorization"] is None for record in self.server.records)
        )

    def test_wait_for_tick_returns_first_snapshot_at_or_after_target(self) -> None:
        path = "/root/api/games/game-1/public"
        self.server.responses[path] = [
            (200, {"tick": 7}),
            (200, {"tick": 9, "marker": "ready"}),
        ]

        result = self.client().wait_for_tick(
            8, poll_interval=0.001, timeout=0.5
        )

        self.assertEqual(result, {"tick": 9, "marker": "ready"})
        self.assertEqual(len(self.server.records), 2)


if __name__ == "__main__":
    unittest.main()
