export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

function sortForJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JSON numbers must be finite");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }

  if (typeof value === "object") {
    const sorted: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        sorted[key] = sortForJson(item);
      }
    }
    return sorted;
  }

  throw new TypeError(`Value of type ${typeof value} is not JSON-serializable`);
}

export function toJsonValue(value: unknown): JsonValue {
  return sortForJson(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForJson(value));
}

export function parseJson(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}

// This digest is an audit correlation value, not an authentication primitive.
export function stateDigest(canonicalStateJson: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = new TextEncoder().encode(canonicalStateJson);

  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }

  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
