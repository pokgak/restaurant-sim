import { canonicalJson, type JsonValue } from "./json";

export const ARCHIVE_SCHEMA_VERSION = 1;

export interface ArchiveObjectDescriptor {
  key: string;
  bytes: number;
  sha256: string;
  etag: string;
  contentType: string;
}

interface ImmutablePutResult extends ArchiveObjectDescriptor {
  replayed: boolean;
}

function bytesFrom(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sha256(value: string | Uint8Array): Promise<{
  bytes: Uint8Array;
  hex: string;
}> {
  const bytes = bytesFrom(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return { bytes: new Uint8Array(digest), hex: hex(digest) };
}

export function jsonLines(data: JsonValue): string {
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    !Array.isArray(data.environmentEvents) ||
    !Array.isArray(data.logs)
  ) {
    throw new Error("Durable Object returned an invalid export");
  }
  const lines = [
    JSON.stringify({ type: "metadata", data: data.metadata }),
    JSON.stringify({ type: "results", data: data.results }),
    JSON.stringify({ type: "profit_timeline", data: data.profitTimeline }),
    ...data.environmentEvents.map((event) =>
      JSON.stringify({ type: "environment_event", data: event }),
    ),
    ...data.logs.map((log) => JSON.stringify({ type: "agent_log", data: log })),
  ];
  return `${lines.join("\n")}\n`;
}

async function existingDescriptor(
  bucket: R2Bucket,
  key: string,
  expectedSha256: string,
  expectedBytes: number,
  contentType: string,
): Promise<ArchiveObjectDescriptor | null> {
  const existing = await bucket.head(key);
  if (!existing) {
    return null;
  }

  let existingSha256 = existing.customMetadata?.sha256;
  if (!existingSha256) {
    const body = await bucket.get(key);
    if (!body) {
      return null;
    }
    existingSha256 = (await sha256(new Uint8Array(await body.arrayBuffer()))).hex;
  }
  if (existing.size !== expectedBytes || existingSha256 !== expectedSha256) {
    throw new Error(`Immutable archive object conflict at ${key}`);
  }

  return {
    key,
    bytes: existing.size,
    sha256: existingSha256,
    etag: existing.etag,
    contentType: existing.httpMetadata?.contentType ?? contentType,
  };
}

export async function putImmutable(
  bucket: R2Bucket,
  input: {
    key: string;
    value: string | Uint8Array;
    contentType: string;
    customMetadata: Record<string, string>;
  },
): Promise<ImmutablePutResult> {
  const bytes = bytesFrom(input.value);
  const digest = await sha256(bytes);
  const existing = await existingDescriptor(
    bucket,
    input.key,
    digest.hex,
    bytes.byteLength,
    input.contentType,
  );
  if (existing) {
    return { ...existing, replayed: true };
  }

  const onlyIfAbsent = new Headers({ "If-None-Match": "*" });
  const stored = await bucket.put(input.key, bytes, {
    onlyIf: onlyIfAbsent,
    httpMetadata: { contentType: input.contentType },
    customMetadata: {
      ...input.customMetadata,
      archiveSchemaVersion: String(ARCHIVE_SCHEMA_VERSION),
      sha256: digest.hex,
    },
    sha256: digest.bytes,
  });
  if (!stored) {
    const raced = await existingDescriptor(
      bucket,
      input.key,
      digest.hex,
      bytes.byteLength,
      input.contentType,
    );
    if (!raced) {
      throw new Error(`Archive object disappeared after a conditional write: ${input.key}`);
    }
    return { ...raced, replayed: true };
  }

  return {
    key: stored.key,
    bytes: stored.size,
    sha256: digest.hex,
    etag: stored.etag,
    contentType: input.contentType,
    replayed: false,
  };
}

export async function listRunObjects(
  bucket: R2Bucket,
  gameId: string,
): Promise<Array<{
  key: string;
  bytes: number;
  etag: string;
  uploadedAt: string;
  contentType: string | null;
  sha256: string | null;
}>> {
  const prefix = `runs/${gameId}/`;
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      cursor,
      include: ["httpMetadata", "customMetadata"],
    });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return objects
    .map((object) => ({
      key: object.key,
      bytes: object.size,
      etag: object.etag,
      uploadedAt: object.uploaded.toISOString(),
      contentType: object.httpMetadata?.contentType ?? null,
      sha256: object.customMetadata?.sha256 ?? null,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export async function refreshRunManifest(
  bucket: R2Bucket,
  gameId: string,
): Promise<JsonValue> {
  const manifestKey = `runs/${gameId}/manifest.json`;
  const objects = (await listRunObjects(bucket, gameId)).filter(
    (object) => object.key !== manifestKey,
  );
  const manifest = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    gameId,
    generatedAt: Date.now(),
    objectCount: objects.length,
    totalBytes: objects.reduce((total, object) => total + object.bytes, 0),
    objects,
  };
  const body = canonicalJson(manifest);
  const digest = await sha256(body);
  await bucket.put(manifestKey, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      archiveSchemaVersion: String(ARCHIVE_SCHEMA_VERSION),
      category: "run-manifest",
      gameId,
      sha256: digest.hex,
    },
    sha256: digest.bytes,
  });
  return manifest;
}
