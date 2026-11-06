import { useEffect, useMemo, useState } from "react";
import { EpisodeBar } from "./components/EpisodeBar";
import { EventFeed } from "./components/EventFeed";
import { Leaderboard, rankEntries } from "./components/Leaderboard";
import { MarketPanel } from "./components/MarketPanel";
import { ProfitChart } from "./components/ProfitChart";
import { RestaurantDetail } from "./components/RestaurantDetail";
import { ErrorState, LoadingState, TraceAlert } from "./components/States";
import { usePublicGame } from "./hooks";
import type { FixtureScenario } from "./types";

const scenarios: FixtureScenario[] = ["live", "paused", "completed", "loading", "error"];

function initialScenario(): FixtureScenario {
  const value = new URLSearchParams(window.location.search).get("state") as FixtureScenario | null;
  return value && scenarios.includes(value) ? value : "live";
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2v10m0 0 4-4m-4 4L6 8M3 15v2h14v-2" />
    </svg>
  );
}

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M5 19h22M8 19a8 8 0 0 1 16 0M16 8V5M3 23h26" />
      <circle cx="16" cy="5" r="1.5" />
    </svg>
  );
}

export default function App() {
  const mock = import.meta.env.VITE_USE_MOCK_API !== "false";
  const gameId =
    new URLSearchParams(window.location.search).get("game") ??
    import.meta.env.VITE_GAME_ID ??
    "game-7F3A";
  const [scenario, setScenario] = useState<FixtureScenario>(initialScenario);
  const [selectedId, setSelectedId] = useState<string>();
  const {
    data,
    error,
    loading,
    traceError,
    traceLoading,
    retry,
    downloadTrace,
  } = usePublicGame(gameId, mock, scenario);

  useEffect(() => {
    if (!mock) return;
    const url = new URL(window.location.href);
    if (scenario === "live") url.searchParams.delete("state");
    else url.searchParams.set("state", scenario);
    window.history.replaceState({}, "", url);
  }, [mock, scenario]);

  const ranked = useMemo(() => rankEntries(data?.leaderboard ?? []), [data?.leaderboard]);
  const selectedEntry =
    ranked.find((restaurant) => restaurant.restaurantId === selectedId) ?? ranked[0];
  const selectedRestaurant =
    data?.restaurants.find((restaurant) => restaurant.id === selectedEntry?.restaurantId) ??
    data?.restaurants[0];

  return (
    <div className="app-frame">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark"><BrandMark /></span>
          <div>
            <strong>Restaurant Arena</strong>
            <span>Observer console</span>
          </div>
        </div>
        <div className="header-controls">
          {mock && (
            <label className="scenario-control">
              <span>Fixture state</span>
              <select
                value={scenario}
                onChange={(event) => setScenario(event.target.value as FixtureScenario)}
              >
                {scenarios.map((option) => (
                  <option value={option} key={option}>
                    {option[0].toUpperCase() + option.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="connection-chip">
            <i aria-hidden="true" />
            {mock ? "Deterministic fixture" : "Public API"}
          </span>
          <button
            type="button"
            className="trace-button"
            onClick={() => void downloadTrace()}
            disabled={!data || traceLoading}
            aria-label="Download episode trace export"
          >
            <DownloadIcon />
            {traceLoading ? "Exporting…" : "Export trace"}
          </button>
        </div>
      </header>
      {traceError && <TraceAlert message={traceError} />}

      {loading && !data ? (
        <LoadingState />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={retry} />
      ) : data ? (
        <main className="dashboard-shell">
          <EpisodeBar game={data} />
          <div className="dashboard-grid">
            <div className="primary-stack">
              <Leaderboard
                entries={data.leaderboard}
                selectedId={selectedEntry?.restaurantId}
                onSelect={setSelectedId}
              />
              <ProfitChart
                series={data.series}
                restaurants={ranked}
                maxTicks={data.maxTicks}
                selectedId={selectedEntry?.restaurantId}
              />
              {selectedRestaurant && <RestaurantDetail restaurant={selectedRestaurant} />}
            </div>
            <aside className="side-stack" aria-label="Market and event telemetry">
              <MarketPanel market={data.market} calendar={data.calendar} />
              <EventFeed events={data.recentEvents} restaurants={ranked} />
            </aside>
          </div>
          <footer className="dashboard-footer">
            <span>Public benchmark telemetry</span>
            <span>Polling every 4 seconds · Episode {data.id}</span>
          </footer>
        </main>
      ) : null}
    </div>
  );
}
