import { formatCents } from "../lib/format";
import type { LeaderboardEntry } from "../types";

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  selectedId?: string;
  onSelect?: (restaurantId: string) => void;
}

export function rankEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort(
    (a, b) => a.rank - b.rank || b.operatingProfitCents - a.operatingProfitCents,
  );
}

export function Leaderboard({ entries, selectedId, onSelect }: LeaderboardProps) {
  const ranked = rankEntries(entries);
  const leadingProfit = ranked[0]?.operatingProfitCents ?? 0;

  return (
    <section className="panel leaderboard-panel" aria-labelledby="leaderboard-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Field position & solvency</p>
          <h2 id="leaderboard-title">Profit leaderboard</h2>
        </div>
        <span className="panel-note">Cumulative operating basis</span>
      </div>

      <div className="table-scroll">
        <table className="leaderboard-table">
          <thead>
            <tr>
              <th scope="col">Rank / restaurant</th>
              <th scope="col" className="numeric">Op. profit</th>
              <th scope="col" className="numeric">Cash</th>
              <th scope="col" className="numeric optional-column">Debt</th>
              <th scope="col" className="numeric optional-column">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {ranked.length === 0 ? (
              <tr>
                <td colSpan={5} className="empty-cell">
                  <span className="empty-mark" aria-hidden="true">—</span>
                  No restaurants have reported results yet.
                </td>
              </tr>
            ) : (
              ranked.map((entry) => {
                const isSelected = entry.restaurantId === selectedId;
                const gap = leadingProfit - entry.operatingProfitCents;
                return (
                  <tr
                    key={entry.restaurantId}
                    className={`${isSelected ? "selected-row" : ""} ${entry.bankrupt ? "bankrupt-row" : ""}`.trim()}
                  >
                    <th scope="row">
                      <button
                        className="restaurant-select"
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => onSelect?.(entry.restaurantId)}
                      >
                        <span className={`rank-badge rank-${entry.rank}`}>{entry.rank}</span>
                        <span>
                          <strong>{entry.name}</strong>
                          <small>
                            {entry.bankrupt ? (
                              <span className="bankrupt-label">Bankrupt</span>
                            ) : entry.rank === 1 ? (
                              "Leader"
                            ) : (
                              `${formatCents(gap)} off lead`
                            )}
                          </small>
                        </span>
                      </button>
                    </th>
                    <td className="numeric profit-cell">{formatCents(entry.operatingProfitCents)}</td>
                    <td className={`numeric ${entry.cashCents < 0 ? "negative-cell" : "cash-cell"}`}>
                      {formatCents(entry.cashCents)}
                    </td>
                    <td className="numeric optional-column debt-cell">{formatCents(entry.debtCents)}</td>
                    <td className="numeric optional-column muted-cell">{formatCents(entry.revenueCents)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
