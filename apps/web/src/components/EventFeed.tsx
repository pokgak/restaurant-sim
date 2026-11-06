import type { GameEvent, LeaderboardEntry } from "../types";
import { restaurantColor } from "./ProfitChart";

interface EventFeedProps {
  events: GameEvent[];
  restaurants: LeaderboardEntry[];
}

export const RECENT_EVENT_DISPLAY_LIMIT = 10;

const sourceLabels = {
  agent: "Agent decision",
  environment: "Environment",
  operations: "Operations",
} as const;

export function EventFeed({ events, restaurants }: EventFeedProps) {
  const visibleEvents = events.slice(-RECENT_EVENT_DISPLAY_LIMIT).reverse();

  return (
    <section className="panel events-panel" aria-labelledby="events-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Bounded public feed</p>
          <h2 id="events-title">Recent events</h2>
        </div>
        <span className="panel-note">
          {visibleEvents.length} of {events.length} · newest first
        </span>
      </div>

      {visibleEvents.length === 0 ? (
        <div className="feed-empty">No recent public events have been reported.</div>
      ) : (
        <ol className="event-list">
          {visibleEvents.map((event) => {
            const restaurant = event.restaurantId
              ? restaurants.find((entry) => entry.restaurantId === event.restaurantId)
              : undefined;
            const actor = event.restaurantId
              ? restaurant?.name ?? event.restaurantId
              : event.source === "environment"
                ? "Market & calendar"
                : sourceLabels[event.source];
            const accent = event.restaurantId
              ? restaurantColor(event.restaurantId, restaurants)
              : event.source === "environment"
                ? "#8e9fe8"
                : "#bbb3a7";
            return (
              <li
                key={event.id}
                className={`event-severity-${event.severity}`}
                style={{ "--actor-color": accent } as React.CSSProperties}
              >
                <div className="event-rail">
                  <span />
                </div>
                <div className="event-content">
                  <div className="event-meta">
                    <strong>{actor}</strong>
                    <span>T{event.tick}</span>
                  </div>
                  <div className="event-tags" aria-label={`${sourceLabels[event.source]}, ${event.severity}`}>
                    <span className={`event-source event-source-${event.source}`}>
                      {sourceLabels[event.source]}
                    </span>
                    <span className={`event-type event-type-${event.category}`}>{event.category}</span>
                    <span className={`severity-badge severity-${event.severity}`}>{event.severity}</span>
                  </div>
                  <p>{event.message}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
