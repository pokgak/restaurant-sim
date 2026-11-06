import { formatCentsExact, formatPercent } from "../lib/format";
import type { CalendarSnapshot, MarketSnapshot } from "../types";

interface MarketPanelProps {
  market: MarketSnapshot;
  calendar: CalendarSnapshot;
}

function titleCase(value: string): string {
  return value.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

export function MarketPanel({ market, calendar }: MarketPanelProps) {
  const demandBand =
    market.demandIndexPercent >= 85
      ? "Surging"
      : market.demandIndexPercent >= 65
        ? "Strong"
        : market.demandIndexPercent >= 40
          ? "Steady"
          : "Constrained";
  const disruptionBand =
    market.supplyDisruptionPercent >= 30
      ? "High disruption"
      : market.supplyDisruptionPercent >= 10
        ? "Watch supply"
        : "Supply stable";

  return (
    <section className="panel market-panel" aria-labelledby="market-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Demand environment</p>
          <h2 id="market-title">Day {calendar.day} · {calendar.dayName}</h2>
        </div>
        <span className={`phase-badge ${market.supplyDisruptionPercent >= 30 ? "phase-warning" : ""}`}>
          {disruptionBand}
        </span>
      </div>

      <div className="environment-grid">
        <div>
          <span>Weather</span>
          <strong>{titleCase(calendar.weather)}</strong>
          <small>{formatPercent(calendar.weatherDemandPercent)} demand factor</small>
        </div>
        <div>
          <span>Local event</span>
          <strong>{titleCase(calendar.localEvent)}</strong>
          <small>{formatPercent(calendar.localDemandPercent)} demand factor</small>
        </div>
        <div>
          <span>Season</span>
          <strong>{titleCase(calendar.season)}</strong>
          <small>{formatPercent(calendar.seasonDemandPercent)} demand factor</small>
        </div>
        <div>
          <span>Day type</span>
          <strong>{calendar.isWeekend ? "Weekend" : "Weekday"}</strong>
          <small>Day {calendar.dayOfWeek + 1} of week</small>
        </div>
      </div>

      <div className="demand-gauge">
        <div>
          <span>Combined demand regime</span>
          <strong>{Math.round(calendar.demandRegimePercent)}</strong>
          <small>/ 100</small>
        </div>
        <div
          className="gauge-track"
          role="meter"
          aria-label={`Combined demand regime ${calendar.demandRegimePercent} percent`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={calendar.demandRegimePercent}
        >
          <span style={{ width: `${Math.min(100, calendar.demandRegimePercent)}%` }} />
        </div>
      </div>

      <dl className="market-totals">
        <div>
          <dt>Demand index</dt>
          <dd>{Math.round(market.demandIndexPercent)}</dd>
          <small>{demandBand}</small>
        </div>
        <div>
          <dt>Ingredient unit</dt>
          <dd>{formatCentsExact(market.ingredientUnitCostCents)}</dd>
          <small>Current market</small>
        </div>
        <div>
          <dt>Supply disruption</dt>
          <dd>{formatPercent(market.supplyDisruptionPercent)}</dd>
          <small>Current pressure</small>
        </div>
      </dl>
    </section>
  );
}
