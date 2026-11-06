import type { GameConfig } from "@restaurant-sim/sim";
import {
  jsonLines,
  listRunObjects,
  putImmutable,
  refreshRunManifest,
} from "./archive";
import {
  MAX_ARTIFACT_BYTES,
  MAX_BODY_BYTES,
  MAX_CREATE_BODY_BYTES,
  MAX_GAME_TICKS,
  MAX_INTERVAL_MS,
  MAX_START_TICKS,
  MAX_STEP_TICKS,
  MAX_TOKEN_LENGTH,
  MIN_INTERVAL_MS,
} from "./limits";
import { toJsonValue, type JsonValue } from "./json";
import type {
  InitializeInput,
  RpcResult,
  SeatInput,
  StartInput,
  StepInput,
} from "./types";

export { GameRoom } from "./game-room";

type RuntimeEnv = Env & { BENCHMARK_ADMIN_TOKEN?: string };

type GameRoomRpcStub = DurableObjectStub & {
  initialize(input: InitializeInput): Promise<RpcResult>;
  publicView(): Promise<RpcResult>;
  agentState(token: string, requestId: string | null): Promise<RpcResult>;
  agentAction(token: string, rawBody: string): Promise<RpcResult>;
  controlStart(input: StartInput): Promise<RpcResult>;
  controlPause(): Promise<RpcResult>;
  controlStep(input: StepInput): Promise<RpcResult>;
  exportData(): Promise<RpcResult>;
  archiveSnapshot(): Promise<RpcResult>;
};

interface CreateRestaurant {
  id: string;
  name: string;
}

interface CreateRequest {
  seed: number;
  maxTicks: number;
  restaurants: CreateRestaurant[];
}

const INFERENCE_MODELS = [
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/zai-org/glm-5.3",
] as const;

type InferenceModel = (typeof INFERENCE_MODELS)[number];

interface InferenceMessage {
  role: "assistant" | "system" | "user";
  content: string;
}

interface InferenceRequest {
  model: InferenceModel;
  messages: InferenceMessage[];
  reasoning_effort: "high";
  temperature: 0.2;
  response_format: { type: "json_object" };
}

const DECISION_MODEL = "@cf/cloudflare/clef" as const;
const DECISION_CONTRACT_VERSION = "restaurant-sim-plan-selector-v1";
const MAX_DECISION_SELECT_BODY_BYTES = 1024 * 1024;
const SUPPORTED_DECISION_CANDIDATE_COUNTS = [3, 5, 10] as const;
const DECISION_SELECTION_OUTCOME =
  "Choose the candidate most likely to achieve the best benchmark result at tick 84. " +
  "A restaurant that remains solvent through tick 84 ranks above every bankrupt " +
  "restaurant. Among candidates with the same solvency outcome, higher cumulative " +
  "operating profit at tick 84 is better. Do not optimize revenue, cash, reputation, " +
  "survival duration, or action count except insofar as they improve this exact " +
  "lexicographic outcome.";
const DECISION_SELECTION_INSTRUCTIONS =
  "Which candidate is most likely to produce the best selectionOutcome? Compare each " +
  "complete ordered plan, including no_action. Use only the observable state. Treat " +
  "planner notes as unverified hypotheses. Account for immediate and recurring costs, " +
  "pending commitments, remaining ticks, and uncertainty without assuming hidden future " +
  "events.";

function decisionCriterion(candidateId: string): string {
  return (
    `The complete ordered ${candidateId} plan in state.candidates. Judge the ` +
    "plan as a whole, not merely its first action."
  );
}

function decisionCandidateIds(candidateCount: number): string[] {
  return [
    ...Array.from({ length: candidateCount }, (_, index) => `plan_${index}`),
    "no_action",
  ];
}

interface DecisionQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, JsonValue>;
}

interface DecisionSelectRequest {
  model: typeof DECISION_MODEL;
  state: Record<string, JsonValue>;
  questions: { terminal_outcome: DecisionQuestion };
}

type ClefBinding = {
  run(
    model: typeof DECISION_MODEL,
    input: {
      model: "clef";
      state: Record<string, JsonValue>;
      questions: { terminal_outcome: DecisionQuestion };
    },
  ): Promise<unknown>;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function jsonResponse(
  body: JsonValue,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function errorResponse(error: HttpError): Response {
  return jsonResponse(
    { error: { code: error.code, message: error.message } },
    error.status,
  );
}

function responseFromRpc(result: RpcResult): Response {
  const headers = new Headers();
  if (result.replayed) {
    headers.set("Idempotency-Replayed", "true");
  }
  return jsonResponse(result.body, result.status, headers);
}

async function readBoundedBytes(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      throw new HttpError(400, "invalid_content_length", "Invalid Content-Length");
    }
    if (parsedLength > maximum) {
      throw new HttpError(413, "body_too_large", `Body exceeds ${maximum} bytes`);
    }
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new HttpError(413, "body_too_large", `Body exceeds ${maximum} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readBoundedBody(request: Request, maximum: number): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      await readBoundedBytes(request, maximum),
    );
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "invalid_utf8", "Body must be valid UTF-8");
  }
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function parseInferenceRequest(value: unknown): InferenceRequest {
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_inference", "Inference body must be an object");
  }
  const expected = new Set([
    "model",
    "messages",
    "reasoning_effort",
    "temperature",
    "response_format",
  ]);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    throw new HttpError(
      400,
      "invalid_inference",
      `Unexpected inference field(s): ${unexpected.sort().join(", ")}`,
    );
  }
  if (!INFERENCE_MODELS.includes(value.model as InferenceModel)) {
    throw new HttpError(400, "invalid_inference", "Unsupported inference model");
  }
  if (
    !Array.isArray(value.messages) ||
    value.messages.length < 1 ||
    value.messages.length > 8 ||
    value.messages.some(
      (message) =>
        !isRecord(message) ||
        Object.keys(message).some((key) => key !== "role" && key !== "content") ||
        !["assistant", "system", "user"].includes(String(message.role)) ||
        typeof message.content !== "string" ||
        message.content.length < 1,
    )
  ) {
    throw new HttpError(
      400,
      "invalid_inference",
      "messages must contain 1-8 role/content text objects",
    );
  }
  if (value.reasoning_effort !== "high") {
    throw new HttpError(
      400,
      "invalid_inference",
      "reasoning_effort must be high",
    );
  }
  if (value.temperature !== 0.2) {
    throw new HttpError(400, "invalid_inference", "temperature must be 0.2");
  }
  if (
    !isRecord(value.response_format) ||
    Object.keys(value.response_format).length !== 1 ||
    value.response_format.type !== "json_object"
  ) {
    throw new HttpError(
      400,
      "invalid_inference",
      "response_format must be exactly {type: json_object}",
    );
  }
  return value as unknown as InferenceRequest;
}

function parseDecisionSelectRequest(value: unknown): DecisionSelectRequest {
  if (!isRecord(value)) {
    throw new HttpError(
      400,
      "invalid_decision_select",
      "Decision selection body must be an object",
    );
  }
  const expected = new Set(["model", "state", "questions"]);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  if (unexpected.length > 0) {
    throw new HttpError(
      400,
      "invalid_decision_select",
      `Unexpected decision selection field(s): ${unexpected.sort().join(", ")}`,
    );
  }
  if (value.model !== DECISION_MODEL) {
    throw new HttpError(
      400,
      "invalid_decision_select",
      "Unsupported decision model",
    );
  }
  if (!isRecord(value.state)) {
    throw new HttpError(400, "invalid_decision_select", "state must be an object");
  }
  const stateFields = new Set([
    "contractVersion",
    "candidateCount",
    "selectionOutcome",
    "observation",
    "outcomeFeedback",
    "candidates",
  ]);
  if (
    Object.keys(value.state).some((key) => !stateFields.has(key)) ||
    value.state.contractVersion !== DECISION_CONTRACT_VERSION ||
    typeof value.state.candidateCount !== "number" ||
    !Number.isInteger(value.state.candidateCount) ||
    !SUPPORTED_DECISION_CANDIDATE_COUNTS.includes(
      value.state.candidateCount as (typeof SUPPORTED_DECISION_CANDIDATE_COUNTS)[number],
    ) ||
    value.state.selectionOutcome !== DECISION_SELECTION_OUTCOME ||
    !isRecord(value.state.observation) ||
    (value.state.outcomeFeedback !== null && !isRecord(value.state.outcomeFeedback)) ||
    !Array.isArray(value.state.candidates) ||
    value.state.candidates.length !== value.state.candidateCount + 1
  ) {
    throw new HttpError(
      400,
      "invalid_decision_select",
      "state does not match the plan-selector contract",
    );
  }
  const candidateIds = decisionCandidateIds(value.state.candidateCount);
  for (const [index, candidate] of value.state.candidates.entries()) {
    const expectedId = candidateIds[index];
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some(
        (key) =>
          !["candidateId", "actions", "note", "previews", "projected"].includes(key),
      ) ||
      candidate.candidateId !== expectedId ||
      !Array.isArray(candidate.actions) ||
      (expectedId === "no_action"
        ? candidate.actions.length !== 0
        : candidate.actions.length < 1 || candidate.actions.length > 5) ||
      typeof candidate.note !== "string" ||
      !Array.isArray(candidate.previews) ||
      !isRecord(candidate.projected)
    ) {
      throw new HttpError(
        400,
        "invalid_decision_select",
        `state.candidates[${index}] is invalid`,
      );
    }
  }
  if (
    !isRecord(value.questions) ||
    Object.keys(value.questions).length !== 1 ||
    !isRecord(value.questions.terminal_outcome)
  ) {
    throw new HttpError(
      400,
      "invalid_decision_select",
      "questions must contain only terminal_outcome",
    );
  }
  const question = value.questions.terminal_outcome;
  const criteria = question.criteria;
  if (
    Object.keys(question).some(
      (key) => !["type", "instructions", "criteria"].includes(key),
    ) ||
    question.type !== "choice" ||
    question.instructions !== DECISION_SELECTION_INSTRUCTIONS ||
    !isRecord(criteria) ||
    Object.keys(criteria).length !== candidateIds.length ||
    candidateIds.some(
      (candidateId) => criteria[candidateId] !== decisionCriterion(candidateId),
    )
  ) {
    throw new HttpError(
      400,
      "invalid_decision_select",
      "terminal_outcome must be a choice over exactly the candidate IDs",
    );
  }
  return value as unknown as DecisionSelectRequest;
}

function inferenceStreamResponse(
  stream: ReadableStream,
  localDevOpen: boolean,
): Response {
  return new Response(stream, {
    headers: {
      ...adminHeaders(localDevOpen),
      "Cache-Control": "no-store",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}

async function inferenceRoute(
  request: Request,
  env: RuntimeEnv,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  const input = parseInferenceRequest(
    parseJsonBody(await readBoundedBody(request, MAX_BODY_BYTES)),
  );
  const options = {
    messages: input.messages,
    reasoning_effort: input.reasoning_effort,
    temperature: input.temperature,
    response_format: input.response_format,
  } as const;
  let result: unknown;
  switch (input.model) {
    case "@cf/deepseek-ai/deepseek-v4.1-flash-1017": {
      const stream = await env.AI.run("@cf/deepseek-ai/deepseek-v4.1-flash-1017", {
        ...options,
        stream: true,
        stream_options: { include_usage: true },
      });
      if (!(stream instanceof ReadableStream)) {
        throw new HttpError(502, "inference_failed", "Workers AI did not stream");
      }
      return inferenceStreamResponse(stream, admin.localDevOpen);
    }
    case "@cf/deepseek-ai/deepseek-v4-pro-0813": {
      const stream = await env.AI.run("@cf/deepseek-ai/deepseek-v4-pro-0813", {
        ...options,
        stream: true,
        stream_options: { include_usage: true },
      });
      if (!(stream instanceof ReadableStream)) {
        throw new HttpError(502, "inference_failed", "Workers AI did not stream");
      }
      return inferenceStreamResponse(stream, admin.localDevOpen);
    }
    case "@cf/zai-org/glm-5.3-flash":
      result = await env.AI.run("@cf/zai-org/glm-5.3-flash", options);
      break;
    case "@cf/zai-org/glm-5.3": {
      const stream = await env.AI.run("@cf/zai-org/glm-5.3", {
        ...options,
        stream: true,
        stream_options: { include_usage: true },
      });
      if (!(stream instanceof ReadableStream)) {
        throw new HttpError(502, "inference_failed", "Workers AI did not stream");
      }
      return inferenceStreamResponse(stream, admin.localDevOpen);
    }
  }
  return jsonResponse(toJsonValue(result), 200, adminHeaders(admin.localDevOpen));
}

async function decisionSelectRoute(
  request: Request,
  env: RuntimeEnv,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  const input = parseDecisionSelectRequest(
    parseJsonBody(await readBoundedBody(request, MAX_DECISION_SELECT_BODY_BYTES)),
  );
  const result = await (env.AI as unknown as ClefBinding).run(DECISION_MODEL, {
    model: "clef",
    state: input.state,
    questions: input.questions,
  });
  return jsonResponse(toJsonValue(result), 200, {
    ...adminHeaders(admin.localDevOpen),
    "Cache-Control": "no-store",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRestaurantId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
  );
}

function parseCreateRequest(value: unknown): CreateRequest {
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_game", "Body must be an object");
  }
  if (!Number.isSafeInteger(value.seed)) {
    throw new HttpError(400, "invalid_seed", "seed must be a safe integer");
  }
  if (
    !Number.isInteger(value.maxTicks) ||
    (value.maxTicks as number) < 1 ||
    (value.maxTicks as number) > MAX_GAME_TICKS
  ) {
    throw new HttpError(
      400,
      "invalid_max_ticks",
      `maxTicks must be an integer from 1 to ${MAX_GAME_TICKS}`,
    );
  }
  if (
    !Array.isArray(value.restaurants) ||
    value.restaurants.length < 2 ||
    value.restaurants.length > 4
  ) {
    throw new HttpError(
      400,
      "invalid_restaurants",
      "restaurants must contain 2-4 entries",
    );
  }

  const restaurants: CreateRestaurant[] = value.restaurants.map(
    (restaurant, index) => {
      if (!isRecord(restaurant) || !validateRestaurantId(restaurant.id)) {
        throw new HttpError(
          400,
          "invalid_restaurant_id",
          `restaurants[${index}].id must be a valid identifier`,
        );
      }
      if (
        typeof restaurant.name !== "string" ||
        restaurant.name.trim().length < 1 ||
        restaurant.name.trim().length > 80
      ) {
        throw new HttpError(
          400,
          "invalid_restaurant_name",
          `restaurants[${index}].name must contain 1-80 characters`,
        );
      }
      return { id: restaurant.id, name: restaurant.name.trim() };
    },
  );
  if (new Set(restaurants.map((restaurant) => restaurant.id)).size !== restaurants.length) {
    throw new HttpError(
      400,
      "duplicate_restaurant_id",
      "Restaurant IDs must be unique",
    );
  }

  return {
    seed: value.seed as number,
    maxTicks: value.maxTicks as number,
    restaurants,
  };
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) {
    return null;
  }
  return match[1];
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hashToken(token: string): Promise<string> {
  return toHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
}

async function secretsEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedDigest, expectedDigest);
}

async function requireAdmin(
  request: Request,
  env: RuntimeEnv,
): Promise<{ localDevOpen: boolean }> {
  if (!env.BENCHMARK_ADMIN_TOKEN) {
    return { localDevOpen: true };
  }

  const provided = extractBearerToken(request);
  if (!provided || !(await secretsEqual(provided, env.BENCHMARK_ADMIN_TOKEN))) {
    throw new HttpError(401, "admin_unauthorized", "Admin token is required");
  }
  return { localDevOpen: false };
}

function adminHeaders(localDevOpen: boolean): HeadersInit | undefined {
  return localDevOpen ? { "X-Admin-Auth": "local-dev-open" } : undefined;
}

function validateGameId(gameId: string): void {
  if (
    gameId.length < 1 ||
    gameId.length > 128 ||
    !/^[A-Za-z0-9-]+$/.test(gameId)
  ) {
    throw new HttpError(400, "invalid_game_id", "Invalid game ID");
  }
}

function artifactName(route: string): string | null {
  const match = /^artifacts\/([^/]+)$/.exec(route);
  if (!match) {
    return null;
  }
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, "invalid_artifact_name", "Invalid artifact name");
  }
  if (
    name.length < 1 ||
    name.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    throw new HttpError(
      400,
      "invalid_artifact_name",
      "Artifact names must contain 1-128 letters, digits, dots, underscores, or hyphens",
    );
  }
  return name;
}

function artifactContentType(name: string): string {
  if (name.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson")) {
    return "application/x-ndjson; charset=utf-8";
  }
  if (name.endsWith(".csv")) {
    return "text/csv; charset=utf-8";
  }
  return "application/octet-stream";
}

function embeddedGameId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.gameId === "string") {
    return value.gameId;
  }
  if (isRecord(value.summary) && typeof value.summary.gameId === "string") {
    return value.summary.gameId;
  }
  if (isRecord(value.metadata) && typeof value.metadata.id === "string") {
    return value.metadata.id;
  }
  return null;
}

function validateArtifactBody(
  name: string,
  body: Uint8Array,
  gameId: string,
): void {
  if (body.byteLength === 0) {
    throw new HttpError(400, "empty_artifact", "Artifact body cannot be empty");
  }
  if (!name.endsWith(".json") && !name.endsWith(".jsonl") && !name.endsWith(".ndjson")) {
    return;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw new HttpError(400, "invalid_utf8", "Artifact must be valid UTF-8");
  }
  const lines = name.endsWith(".json") ? [text] : text.split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new HttpError(400, "empty_artifact", "Artifact body cannot be empty");
  }
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new HttpError(400, "invalid_artifact_json", "Artifact contains invalid JSON");
    }
    const claimedGameId = embeddedGameId(value);
    if (claimedGameId && claimedGameId !== gameId) {
      throw new HttpError(
        400,
        "artifact_game_mismatch",
        `Artifact belongs to game ${claimedGameId}, not ${gameId}`,
      );
    }
  }
}

function parseInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value === undefined ? defaultValue : value;
  if (
    typeof resolved !== "number" ||
    !Number.isInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new HttpError(
      400,
      "invalid_control",
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return resolved;
}

async function parseOptionalObjectBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readBoundedBody(request, MAX_BODY_BYTES);
  if (text.trim() === "") {
    return {};
  }
  const value = parseJsonBody(text);
  if (!isRecord(value)) {
    throw new HttpError(400, "invalid_control", "Control body must be an object");
  }
  return value;
}

function withAdminHeaders(response: Response, localDevOpen: boolean): Response {
  if (!localDevOpen) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("X-Admin-Auth", "local-dev-open");
  return new Response(response.body, { status: response.status, headers });
}

async function createGameRoute(request: Request, env: RuntimeEnv): Promise<Response> {
  const admin = await requireAdmin(request, env);
  const body = parseCreateRequest(
    parseJsonBody(await readBoundedBody(request, MAX_CREATE_BODY_BYTES)),
  );
  const gameId = crypto.randomUUID();
  const rawSeats = body.restaurants.map((restaurant) => ({
    id: restaurant.id,
    name: restaurant.name,
    token: randomToken(),
  }));
  const seats: SeatInput[] = await Promise.all(
    rawSeats.map(async (seat) => ({
      actorId: seat.id,
      displayName: seat.name,
      tokenDigest: await hashToken(seat.token),
    })),
  );
  const config: GameConfig = {
    seed: body.seed,
    restaurantIds: body.restaurants.map((restaurant) => restaurant.id),
    maxTicks: body.maxTicks,
  };
  const result = await getGameRoom(env, gameId).initialize({
    gameId,
    config,
    seats,
  });
  if (result.status !== 201) {
    return withAdminHeaders(responseFromRpc(result), admin.localDevOpen);
  }

  return jsonResponse(
    toJsonValue({
      id: gameId,
      status: "paused",
      seats: rawSeats.map((seat) => ({
        restaurantId: seat.id,
        name: seat.name,
        token: seat.token,
      })),
    }),
    201,
    adminHeaders(admin.localDevOpen),
  );
}

function getGameRoom(env: RuntimeEnv, gameId: string): GameRoomRpcStub {
  const namespace: DurableObjectNamespace = env.GAME_ROOMS;
  return namespace.getByName(gameId) as GameRoomRpcStub;
}

async function routeGameRequest(
  request: Request,
  env: RuntimeEnv,
  gameId: string,
  route: string,
  url: URL,
): Promise<Response> {
  validateGameId(gameId);
  const stub = getGameRoom(env, gameId);

  if (request.method === "GET" && route === "public") {
    return responseFromRpc(await stub.publicView());
  }

  if (request.method === "GET" && route === "agent/state") {
    const token = extractBearerToken(request);
    if (!token) {
      return jsonResponse(
        { error: { code: "missing_token", message: "Bearer seat token is required" } },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }
    const requestId = request.headers.get("X-Request-Id");
    return responseFromRpc(await stub.agentState(token, requestId));
  }

  if (request.method === "POST" && route === "agent/actions") {
    const token = extractBearerToken(request);
    if (!token) {
      return jsonResponse(
        { error: { code: "missing_token", message: "Bearer seat token is required" } },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }
    const rawBody = await readBoundedBody(request, MAX_BODY_BYTES);
    return responseFromRpc(await stub.agentAction(token, rawBody));
  }

  if (request.method === "POST" && route.startsWith("control/")) {
    const admin = await requireAdmin(request, env);
    let result: RpcResult;
    if (route === "control/start") {
      const body = await parseOptionalObjectBody(request);
      result = await stub.controlStart({
        ticks: parseInteger(body.ticks, "ticks", 100, 1, MAX_START_TICKS),
        intervalMs: parseInteger(
          body.intervalMs,
          "intervalMs",
          1_000,
          MIN_INTERVAL_MS,
          MAX_INTERVAL_MS,
        ),
      });
    } else if (route === "control/pause") {
      await parseOptionalObjectBody(request);
      result = await stub.controlPause();
    } else if (route === "control/step") {
      const body = await parseOptionalObjectBody(request);
      result = await stub.controlStep({
        ticks: parseInteger(body.ticks, "ticks", 1, 1, MAX_STEP_TICKS),
      });
    } else {
      throw new HttpError(404, "not_found", "Route not found");
    }
    return withAdminHeaders(responseFromRpc(result), admin.localDevOpen);
  }

  if (route === "archive" && (request.method === "POST" || request.method === "GET")) {
    const admin = await requireAdmin(request, env);
    if (request.method === "POST") {
      await parseOptionalObjectBody(request);
      return withAdminHeaders(
        responseFromRpc(await stub.archiveSnapshot()),
        admin.localDevOpen,
      );
    }
    const objects = await listRunObjects(env.RUN_ARCHIVES, gameId);
    return jsonResponse(
      toJsonValue({
        gameId,
        objectCount: objects.length,
        totalBytes: objects.reduce((total, object) => total + object.bytes, 0),
        objects,
      }),
      200,
      adminHeaders(admin.localDevOpen),
    );
  }

  const artifact = artifactName(route);
  if (request.method === "PUT" && artifact !== null) {
    const admin = await requireAdmin(request, env);
    const game = await stub.publicView();
    if (game.status !== 200) {
      return withAdminHeaders(responseFromRpc(game), admin.localDevOpen);
    }
    const body = await readBoundedBytes(request, MAX_ARTIFACT_BYTES);
    validateArtifactBody(artifact, body, gameId);
    let stored;
    try {
      stored = await putImmutable(env.RUN_ARCHIVES, {
        key: `runs/${gameId}/agent/${artifact}`,
        value: body,
        contentType: artifactContentType(artifact),
        customMetadata: {
          artifact,
          category: "agent-artifact",
          gameId,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Immutable archive object conflict")) {
        throw new HttpError(
          409,
          "immutable_artifact_exists",
          "An artifact with this name already exists with different content",
        );
      }
      throw error;
    }
    const runManifest = await refreshRunManifest(env.RUN_ARCHIVES, gameId);
    return jsonResponse(
      toJsonValue({ gameId, artifact: stored, runManifest }),
      stored.replayed ? 200 : 201,
      {
        ...(adminHeaders(admin.localDevOpen) ?? {}),
        ...(stored.replayed ? { "Idempotency-Replayed": "true" } : {}),
      },
    );
  }

  if (request.method === "GET" && route === "export") {
    const admin = await requireAdmin(request, env);
    const result = await stub.exportData();
    if (result.status !== 200) {
      return withAdminHeaders(responseFromRpc(result), admin.localDevOpen);
    }
    const format = url.searchParams.get("format");
    const wantsJsonLines =
      format === "jsonl" ||
      (format === null && request.headers.get("Accept")?.includes("application/x-ndjson"));
    if (format !== null && format !== "json" && format !== "jsonl") {
      throw new HttpError(400, "invalid_export_format", "format must be json or jsonl");
    }
    if (wantsJsonLines) {
      return new Response(jsonLines(result.body), {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          ...(adminHeaders(admin.localDevOpen) ?? {}),
        },
      });
    }
    return jsonResponse(
      result.body,
      200,
      adminHeaders(admin.localDevOpen),
    );
  }

  throw new HttpError(404, "not_found", "Route not found");
}

export default {
  async fetch(request, env): Promise<Response> {
    const runtimeEnv: RuntimeEnv = env;
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/api/inference") {
        return await inferenceRoute(request, runtimeEnv);
      }
      if (request.method === "POST" && url.pathname === "/api/decision-select") {
        return await decisionSelectRoute(request, runtimeEnv);
      }
      if (request.method === "POST" && url.pathname === "/api/games") {
        return await createGameRoute(request, runtimeEnv);
      }

      const match = /^\/api\/games\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (match) {
        return await routeGameRequest(
          request,
          runtimeEnv,
          decodeURIComponent(match[1]),
          match[2],
          url,
        );
      }
      throw new HttpError(404, "not_found", "Route not found");
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error);
      }
      console.error(
        JSON.stringify({
          message: "Unhandled API error",
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return jsonResponse(
        { error: { code: "internal_error", message: "Internal server error" } },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
