import { makeFixture } from "../data/fixture";
import type { FixtureScenario, PublicGame, RawPublicGame } from "../types";
import { adaptPublicGame } from "./adapter";

const MOCK_DELAY_MS = 260;

export interface GameApi {
  getPublicGame(gameId: string, signal: AbortSignal): Promise<PublicGame>;
  downloadTrace(gameId: string, currentGame?: PublicGame): Promise<void>;
}

interface ApiOptions {
  mock: boolean;
  scenario: FixtureScenario;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException("Request aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function createGameApi({ mock, scenario }: ApiOptions): GameApi {
  let mockPoll = 0;

  return {
    async getPublicGame(gameId, signal) {
      if (mock) {
        if (scenario === "loading") {
          await new Promise<void>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Request aborted", "AbortError")),
              { once: true },
            );
          });
        }

        await wait(MOCK_DELAY_MS, signal);
        if (scenario === "error") {
          throw new Error("Public game feed is temporarily unavailable");
        }

        const tick = scenario === "live" ? Math.min(137 + mockPoll++, 239) : undefined;
        return { ...makeFixture(scenario, tick), id: gameId };
      }

      const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/public`, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        throw new Error(`Public game feed returned ${response.status}`);
      }
      return adaptPublicGame((await response.json()) as RawPublicGame);
    },

    async downloadTrace(gameId, currentGame) {
      if (mock) {
        const payload = {
          format: "restaurant-sim-trace-v1",
          exportedAt: "2026-10-30T12:00:00.000Z",
          game: currentGame ?? makeFixture(scenario),
        };
        saveBlob(
          new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
          `${gameId}-trace.json`,
        );
        return;
      }

      const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/export`, {
        headers: { Accept: "application/json" },
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error("Trace export requires authorization for this deployment.");
      }
      if (!response.ok) {
        throw new Error(`Trace export returned ${response.status}`);
      }
      saveBlob(await response.blob(), `${gameId}-trace.json`);
    },
  };
}
