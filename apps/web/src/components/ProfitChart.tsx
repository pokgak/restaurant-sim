import { formatCents } from "../lib/format";
import type { LeaderboardEntry, ProfitPoint } from "../types";

interface ProfitChartProps {
  series: ProfitPoint[];
  restaurants: LeaderboardEntry[];
  maxTicks: number;
  selectedId?: string;
}

const COLORS = ["#f4b35d", "#5ac0a8", "#e97b66", "#8e9fe8", "#ca87d6"];

export function restaurantColor(restaurantId: string, restaurants: LeaderboardEntry[]): string {
  const index = restaurants.findIndex((restaurant) => restaurant.restaurantId === restaurantId);
  return COLORS[Math.max(0, index) % COLORS.length];
}

export function ProfitChart({ series, restaurants, maxTicks, selectedId }: ProfitChartProps) {
  const width = 760;
  const height = 246;
  const padding = { top: 18, right: 18, bottom: 30, left: 58 };
  const values = series.flatMap((point) =>
    point.restaurants.map((restaurant) => restaurant.cumulativeOperatingProfitCents),
  );
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(1, ...values);
  const yMin = Math.floor(rawMin / 10_000) * 10_000;
  const yMax = Math.ceil(rawMax / 10_000) * 10_000 || 10_000;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (tick: number) => padding.left + (tick / Math.max(maxTicks, 1)) * plotWidth;
  const y = (value: number) =>
    padding.top + (1 - (value - yMin) / Math.max(yMax - yMin, 1)) * plotHeight;
  const yTicks = Array.from({ length: 4 }, (_, index) => yMin + ((yMax - yMin) / 3) * index);
  const xTicks = [0, Math.round(maxTicks / 2), maxTicks];

  const pathFor = (restaurantId: string) =>
    series
      .map((point, index) => {
        const value = point.restaurants.find((item) => item.restaurantId === restaurantId);
        if (!value) return "";
        return `${index === 0 ? "M" : "L"} ${x(point.tick).toFixed(1)} ${y(value.cumulativeOperatingProfitCents).toFixed(1)}`;
      })
      .join(" ");

  return (
    <section className="panel chart-panel" aria-labelledby="chart-title">
      <div className="panel-heading chart-heading">
        <div>
          <p className="eyebrow">Performance telemetry</p>
          <h2 id="chart-title">Operating profit over time</h2>
        </div>
        <div className="chart-legend" aria-label="Restaurant chart legend">
          {restaurants.map((restaurant) => (
            <span key={restaurant.restaurantId} className={selectedId === restaurant.restaurantId ? "legend-selected" : undefined}>
              <i style={{ background: restaurantColor(restaurant.restaurantId, restaurants) }} />
              {restaurant.name}
            </span>
          ))}
        </div>
      </div>

      {series.length === 0 ? (
        <div className="chart-empty">Profit telemetry appears after the first simulation tick.</div>
      ) : (
        <svg
          className="profit-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Line chart comparing restaurant operating profit by simulation tick"
        >
          <title>Operating profit by restaurant and simulation tick</title>
          {yTicks.map((tickValue) => (
            <g key={tickValue}>
              <line
                className="grid-line"
                x1={padding.left}
                y1={y(tickValue)}
                x2={width - padding.right}
                y2={y(tickValue)}
              />
              <text className="axis-label" x={padding.left - 10} y={y(tickValue) + 4} textAnchor="end">
                {formatCents(tickValue, true)}
              </text>
            </g>
          ))}
          {xTicks.map((tickValue) => (
            <text
              key={tickValue}
              className="axis-label"
              x={x(tickValue)}
              y={height - 8}
              textAnchor={tickValue === 0 ? "start" : tickValue === maxTicks ? "end" : "middle"}
            >
              T{tickValue}
            </text>
          ))}
          {yMin < 0 && (
            <line
              className="zero-line"
              x1={padding.left}
              y1={y(0)}
              x2={width - padding.right}
              y2={y(0)}
            />
          )}
          {restaurants.map((restaurant) => {
            const selected = restaurant.restaurantId === selectedId;
            return (
              <path
                key={restaurant.restaurantId}
                d={pathFor(restaurant.restaurantId)}
                fill="none"
                stroke={restaurantColor(restaurant.restaurantId, restaurants)}
                strokeWidth={selected ? 3.4 : 2}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={selectedId && !selected ? 0.48 : 1}
              />
            );
          })}
          {restaurants.map((restaurant) => {
            const lastPoint = series[series.length - 1];
            const value = lastPoint?.restaurants.find(
              (item) => item.restaurantId === restaurant.restaurantId,
            );
            if (!lastPoint || !value) return null;
            return (
              <circle
                key={restaurant.restaurantId}
                cx={x(lastPoint.tick)}
                cy={y(value.cumulativeOperatingProfitCents)}
                r={restaurant.restaurantId === selectedId ? 4.5 : 3}
                fill={restaurantColor(restaurant.restaurantId, restaurants)}
                stroke="#191713"
                strokeWidth="2"
              />
            );
          })}
        </svg>
      )}
    </section>
  );
}
