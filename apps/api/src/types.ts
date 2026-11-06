import type { GameConfig, PlayerAction } from "@restaurant-sim/sim";
import type { JsonValue } from "./json";

export interface SeatInput {
  actorId: string;
  displayName: string;
  tokenDigest: string;
}

export interface InitializeInput {
  gameId: string;
  config: GameConfig;
  seats: SeatInput[];
}

export interface RpcResult {
  status: number;
  body: JsonValue;
  replayed?: boolean;
}

export interface StartInput {
  ticks: number;
  intervalMs: number;
}

export interface StepInput {
  ticks: number;
}

export interface AuditExportRow {
  seq: number;
  actorSeq: number;
  actorId: string;
  requestId: string | null;
  route: string;
  kind: string;
  gameTick: number;
  request: JsonValue;
  result: JsonValue;
  ok: boolean;
  stateDigest: string;
  wallTimestamp: number;
  latencyMs: number;
}

export interface EnvironmentEventExportRow {
  sequence: number;
  engineEventId: string;
  tick: number;
  category: string;
  source: string;
  severity: string;
  restaurantId: string | null;
  event: JsonValue;
  stateDigest: string;
}

export interface ValidActionRequest {
  requestId: string;
  action: PlayerAction;
}
