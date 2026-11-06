"""Command-line interface for Restaurant Sim agents."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from .baseline import BaselineConfig, HeuristicBaseline, run_baseline
from .client import Client, ClientError, ConfigurationError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rsim")
    parser.add_argument(
        "--request-timeout",
        type=float,
        default=10.0,
        help="timeout in seconds for each HTTP request (default: 10)",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("state", help="print the private seat observation")
    commands.add_parser("public", help="print the public game snapshot")

    act = commands.add_parser("act", help="submit any current or future action")
    act.add_argument("type", help="action type")
    act.add_argument(
        "--request-id", help="stable request ID to reuse for a retry"
    )
    act.add_argument(
        "--params",
        default="{}",
        metavar="JSON",
        help="JSON object of action parameters (default: {})",
    )
    act.add_argument(
        "--param",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="merge one parameter; VALUE accepts JSON or an unquoted string",
    )

    wait = commands.add_parser("wait", help="wait for a public game tick")
    wait.add_argument("tick", type=int, help="target tick (inclusive)")
    wait.add_argument(
        "--poll-interval",
        type=float,
        default=1.0,
        help="seconds between audit-logged reads (default: 1)",
    )
    wait.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="overall wait timeout in seconds (default: 30)",
    )

    baseline = commands.add_parser(
        "baseline", help="run the adaptive heuristic baseline"
    )
    baseline.add_argument(
        "--decision-interval",
        type=int,
        default=3,
        help="ticks between private observations and decisions (default: 3)",
    )
    baseline.add_argument(
        "--max-actions",
        type=int,
        default=5,
        help="maximum actions per decision (default: 5)",
    )
    baseline.add_argument(
        "--cash-reserve",
        type=int,
        default=20_000,
        metavar="CENTS",
        help="minimum cash retained after planned spending (default: 20000)",
    )
    baseline.add_argument(
        "--poll-interval",
        type=float,
        default=1.0,
        help="seconds between audit-logged public reads (default: 1)",
    )
    baseline.add_argument(
        "--wait-timeout",
        type=float,
        default=30.0,
        help="timeout for each tick wait (default: 30)",
    )
    baseline.add_argument(
        "--until-tick", type=int, help="stop before acting at this tick"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        client = Client.from_env(timeout=args.request_timeout)
        if args.command == "state":
            _print_json(client.state())
        elif args.command == "public":
            _print_json(client.public_state())
        elif args.command == "act":
            params = _action_params(args.params, args.param)
            _print_json(
                client.act(args.type, request_id=args.request_id, **params)
            )
        elif args.command == "wait":
            _print_json(
                client.wait_for_tick(
                    args.tick,
                    poll_interval=args.poll_interval,
                    timeout=args.timeout,
                )
            )
        elif args.command == "baseline":
            config = BaselineConfig(
                decision_interval_ticks=args.decision_interval,
                max_actions_per_decision=args.max_actions,
                cash_reserve_cents=args.cash_reserve,
            )
            summary = run_baseline(
                client,
                agent=HeuristicBaseline(config),
                poll_interval=args.poll_interval,
                wait_timeout=args.wait_timeout,
                until_tick=args.until_tick,
                on_event=_print_json,
            )
            _print_json({"summary": summary})
        return 0
    except (ClientError, ValueError) as error:
        if isinstance(error, ClientError):
            value = error.as_dict()
        else:
            value = {"code": "invalid_argument", "message": str(error)}
        print(json.dumps({"error": value}, sort_keys=True), file=sys.stderr)
        return 1


def _action_params(raw_json: str, raw_pairs: list[str]) -> dict[str, Any]:
    try:
        parsed = json.loads(raw_json)
    except json.JSONDecodeError as error:
        raise ConfigurationError(f"--params is not valid JSON: {error.msg}") from error
    if not isinstance(parsed, dict):
        raise ConfigurationError("--params must be a JSON object")
    params = dict(parsed)
    for pair in raw_pairs:
        if "=" not in pair:
            raise ConfigurationError("--param must use KEY=VALUE")
        key, raw_value = pair.split("=", 1)
        if not key:
            raise ConfigurationError("--param key must not be empty")
        try:
            value = json.loads(raw_value)
        except json.JSONDecodeError:
            value = raw_value
        params[key] = value
    return params


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


if __name__ == "__main__":
    raise SystemExit(main())
