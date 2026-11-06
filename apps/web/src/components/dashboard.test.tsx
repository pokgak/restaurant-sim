import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeFixture } from "../data/fixture";
import type { GameEvent } from "../types";
import { EventFeed, RECENT_EVENT_DISPLAY_LIMIT } from "./EventFeed";
import { Leaderboard } from "./Leaderboard";
import { MarketPanel } from "./MarketPanel";
import { RestaurantDetail } from "./RestaurantDetail";
import { ErrorState, TraceAlert } from "./States";

describe("Leaderboard", () => {
  it("preserves API ranking while exposing cash, debt, bankruptcy, and selection", () => {
    const game = makeFixture();
    const onSelect = vi.fn();

    render(
      <Leaderboard
        entries={[game.leaderboard[2]!, game.leaderboard[0]!, game.leaderboard[3]!, game.leaderboard[1]!]}
        selectedId={game.leaderboard[0]!.restaurantId}
        onSelect={onSelect}
      />,
    );

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("Night Market Noodles");
    expect(rows[3]).toHaveTextContent("Pasta Lab");
    expect(rows[3]).toHaveTextContent("Bankrupt");
    expect(rows[3]).toHaveTextContent("-$124");
    expect(screen.getByRole("columnheader", { name: "Cash" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Debt" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Night Market Noodles/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /Juniper Grill/ }));
    expect(onSelect).toHaveBeenCalledWith("rest-juniper");
  });

  it("shows a useful empty state instead of an empty table", () => {
    render(<Leaderboard entries={[]} />);

    expect(screen.getByText("No restaurants have reported results yet.")).toBeVisible();
  });
});

describe("realism telemetry", () => {
  it("renders calendar, weather, local shock, and supply context", () => {
    const game = makeFixture();
    render(<MarketPanel market={game.market} calendar={game.calendar} />);

    expect(screen.getByRole("heading", { name: "Day 20 · Saturday" })).toBeVisible();
    expect(screen.getByText("Storm")).toBeVisible();
    expect(screen.getByText("Construction")).toBeVisible();
    expect(screen.getByText("High disruption")).toBeVisible();
    expect(screen.getByText("36%")).toBeVisible();
    expect(screen.getByRole("meter", { name: "Combined demand regime 72 percent" }))
      .toHaveAttribute("aria-valuenow", "72");
  });

  it("renders selected staffing, equipment, inventory, solvency, and every cost bridge line", () => {
    const restaurant = makeFixture().restaurants[1]!;
    render(<RestaurantDetail restaurant={restaurant} />);

    expect(screen.getByRole("heading", { name: "Juniper Grill" })).toBeVisible();
    expect(screen.getByLabelText("Liquidity and solvency")).toHaveTextContent("Cash");
    expect(screen.getByText("3 actual / 4 target")).toBeVisible();
    expect(screen.getByText("2 actual / 3 target")).toBeVisible();
    expect(screen.getByText("broken")).toBeVisible();
    expect(screen.getByText("3 ticks of downtime remaining")).toBeVisible();
    expect(screen.getByText("31 units")).toBeVisible();

    const bridge = screen.getByLabelText("Latest day cost bridge");
    for (const label of [
      "COGS",
      "Spoilage",
      "Labor",
      "Fixed",
      "Rent",
      "Utilities",
      "Interest",
      "Repair",
    ]) {
      expect(within(bridge).getByText(label)).toBeVisible();
    }
    expect(within(bridge).getByText("Cash movement")).toBeVisible();
    expect(within(bridge).getByText("Prepaid inventory recognized")).toBeVisible();
  });

  it("makes a selected bankrupt operation explicit in text", () => {
    const restaurant = makeFixture().restaurants[3]!;
    render(<RestaurantDetail restaurant={restaurant} />);

    expect(screen.getByText("Bankrupt")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Operations halted");
    expect(screen.getByText("-$124")).toBeVisible();
  });
});

describe("EventFeed", () => {
  it("labels all sources and severities while bounding the visible recent feed", () => {
    const game = makeFixture();
    const repeated: GameEvent[] = Array.from({ length: 12 }, (_, index) => ({
      ...game.recentEvents[index % game.recentEvents.length]!,
      id: `bounded-event-${index}`,
      tick: index + 1,
      message: `bounded message ${index}`,
    }));

    render(<EventFeed events={repeated} restaurants={game.leaderboard} />);

    expect(screen.getByText(`${RECENT_EVENT_DISPLAY_LIMIT} of 12 · newest first`)).toBeVisible();
    expect(screen.getByText("bounded message 11")).toBeVisible();
    expect(screen.getByText("bounded message 2")).toBeVisible();
    expect(screen.queryByText("bounded message 1")).not.toBeInTheDocument();
    expect(screen.getAllByText("Agent decision").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Environment").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Operations").length).toBeGreaterThan(0);
    expect(screen.getAllByText("critical").length).toBeGreaterThan(0);
  });
});

describe("ErrorState", () => {
  it("announces the API error and offers a working retry action", () => {
    const retry = vi.fn();
    render(<ErrorState message="Feed returned 503" onRetry={retry} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Feed returned 503");
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("announces protected trace exports without navigating away", () => {
    const { getByRole } = render(
      <TraceAlert message="Trace export requires authorization for this deployment." />,
    );

    expect(getByRole("alert")).toHaveTextContent(
      "Trace export unavailableTrace export requires authorization for this deployment.",
    );
  });
});
