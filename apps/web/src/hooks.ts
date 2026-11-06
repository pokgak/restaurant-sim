import { useCallback, useEffect, useMemo, useState } from "react";
import { createGameApi } from "./lib/api";
import type { FixtureScenario, PublicGame } from "./types";

interface PublicGameState {
  data: PublicGame | null;
  error: string | null;
  loading: boolean;
  traceError: string | null;
  traceLoading: boolean;
  retry: () => void;
  downloadTrace: () => Promise<void>;
}

export function usePublicGame(
  gameId: string,
  mock: boolean,
  scenario: FixtureScenario,
): PublicGameState {
  const api = useMemo(() => createGameApi({ mock, scenario }), [mock, scenario]);
  const [data, setData] = useState<PublicGame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timeout: number | undefined;
    let active = true;

    setData(null);
    setError(null);
    setLoading(true);

    const poll = async () => {
      try {
        const next = await api.getPublicGame(gameId, controller.signal);
        if (!active) return;
        setData(next);
        setError(null);
        setLoading(false);
        if (next.status !== "completed") {
          timeout = window.setTimeout(poll, 4_000);
        }
      } catch (requestError) {
        if (!active || (requestError instanceof DOMException && requestError.name === "AbortError")) {
          return;
        }
        setError(requestError instanceof Error ? requestError.message : "Unable to load game");
        setLoading(false);
      }
    };

    void poll();

    return () => {
      active = false;
      controller.abort();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [api, gameId, retryKey]);

  const retry = useCallback(() => setRetryKey((key) => key + 1), []);
  const downloadTrace = useCallback(async () => {
    setTraceError(null);
    setTraceLoading(true);
    try {
      await api.downloadTrace(gameId, data ?? undefined);
    } catch (traceRequestError) {
      setTraceError(
        traceRequestError instanceof Error
          ? traceRequestError.message
          : "Unable to export the episode trace.",
      );
    } finally {
      setTraceLoading(false);
    }
  }, [api, data, gameId]);

  return {
    data,
    error,
    loading,
    traceError,
    traceLoading,
    retry,
    downloadTrace,
  };
}
