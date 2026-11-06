import type { PublicGame } from "../types";

function statusCopy(status: PublicGame["status"]): string {
  if (status === "paused") return "Simulation paused";
  if (status === "completed") return "Episode complete";
  return "Running live";
}

export function EpisodeBar({ game }: { game: PublicGame }) {
  const progress = Math.min(100, Math.round((game.tick / Math.max(game.maxTicks, 1)) * 100));

  return (
    <section className="episode-bar" aria-label="Episode status" aria-live="polite">
      <div className="episode-identity">
        <span className={`status-indicator status-${game.status}`} aria-hidden="true" />
        <div>
          <span className="bar-label">Episode</span>
          <strong>{game.id}</strong>
        </div>
      </div>
      <div className={`status-block status-${game.status}`}>
        <span className="status-icon" aria-hidden="true">
          {game.status === "live" ? "●" : game.status === "paused" ? "Ⅱ" : "✓"}
        </span>
        <div>
          <span className="bar-label">Status</span>
          <strong>{statusCopy(game.status)}</strong>
        </div>
      </div>
      <div className="tick-block">
        <div className="tick-copy">
          <span>
            Tick <strong>{game.tick}</strong> / {game.maxTicks}
          </span>
          <b>{progress}%</b>
        </div>
        <div
          className="episode-progress"
          role="progressbar"
          aria-label="Episode progress"
          aria-valuemin={0}
          aria-valuemax={game.maxTicks}
          aria-valuenow={game.tick}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="seed-block">
        <span className="bar-label">Seed</span>
        <strong>{game.seed.toLocaleString("en-US")}</strong>
      </div>
    </section>
  );
}
