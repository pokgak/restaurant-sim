#!/usr/bin/env python3
"""Inspect one seat and optionally apply the baseline's current suggestions."""

from __future__ import annotations

import argparse
import json

from restaurant_sim import Client
from restaurant_sim.baseline import HeuristicBaseline


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="submit suggestions; without this flag the script is read-only",
    )
    args = parser.parse_args()

    client = Client.from_env()
    public = client.public_state()
    observation = client.state()
    intents = HeuristicBaseline().decide(observation, tick=public["tick"])

    print(json.dumps({"tick": public["tick"], "observation": observation}, indent=2))
    for intent in intents:
        item = {
            "type": intent.action_type,
            "params": intent.params,
            "reason": intent.reason,
        }
        if args.apply:
            # Keep this ID if retrying after a transport failure.
            request_id = client.new_request_id()
            item["requestId"] = request_id
            item["result"] = client.act(
                intent.action_type,
                request_id=request_id,
                **intent.params,
            )
        print(json.dumps(item, indent=2))


if __name__ == "__main__":
    main()
