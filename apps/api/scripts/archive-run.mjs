#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { gzipSync } from "node:zlib";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function usage(message) {
  if (message) {
    process.stderr.write(`${message}\n\n`);
  }
  process.stderr.write(
    "Usage: node scripts/archive-run.mjs --base-url URL --game-id ID " +
      "--token-file PATH FILE...\n",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage(`${name} requires a value`);
  }
  args.splice(index, 2);
  return value;
}

const baseUrl = option("--base-url")?.replace(/\/$/, "");
const gameId = option("--game-id");
const tokenFile = option("--token-file");
if (!baseUrl || !gameId || !tokenFile || args.length === 0) {
  usage();
}

const token = (await readFile(tokenFile, "utf8")).trim();
if (!token) {
  usage("Token file is empty");
}
const authorization = { Authorization: `Bearer ${token}` };
const expected = new Map();
const artifactManifest = {
  schemaVersion: 1,
  gameId,
  artifacts: [],
};

function digest(body) {
  return createHash("sha256").update(body).digest("hex");
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Archive API returned non-JSON status ${response.status}: ${text.slice(0, 500)}`,
    );
  }
}

async function upload(name, body) {
  const sha256 = digest(body);
  const response = await fetch(
    `${baseUrl}/api/games/${encodeURIComponent(gameId)}/artifacts/${encodeURIComponent(name)}`,
    { method: "PUT", headers: authorization, body },
  );
  const result = await responseJson(response);
  if (!response.ok) {
    throw new Error(`Upload failed for ${name}: ${response.status} ${JSON.stringify(result)}`);
  }
  if (result.artifact?.sha256 !== sha256 || result.artifact?.bytes !== body.byteLength) {
    throw new Error(`Server digest mismatch for ${name}`);
  }
  expected.set(`runs/${gameId}/agent/${name}`, sha256);
  return { name, bytes: body.byteLength, sha256 };
}

for (const path of args) {
  const name = basename(path);
  const body = await readFile(path);
  const original = {
    name,
    bytes: body.byteLength,
    sha256: digest(body),
  };
  if (body.byteLength <= MAX_UPLOAD_BYTES) {
    artifactManifest.artifacts.push({
      ...original,
      storage: { encoding: "identity", objects: [await upload(name, body)] },
    });
    continue;
  }

  const compressed = gzipSync(body, { level: 6 });
  const objects = [];
  for (let offset = 0, index = 0; offset < compressed.byteLength; index += 1) {
    const part = compressed.subarray(offset, offset + MAX_UPLOAD_BYTES);
    const partName = `${name}.gz.${String(index).padStart(4, "0")}`;
    objects.push(await upload(partName, part));
    offset += part.byteLength;
  }
  artifactManifest.artifacts.push({
    ...original,
    storage: {
      encoding: "gzip",
      compressedBytes: compressed.byteLength,
      compressedSha256: digest(compressed),
      objects,
    },
  });
}

const manifestBody = Buffer.from(`${JSON.stringify(artifactManifest, null, 2)}\n`);
await upload("agent-artifacts-manifest.json", manifestBody);

const archiveResponse = await fetch(
  `${baseUrl}/api/games/${encodeURIComponent(gameId)}/archive`,
  { method: "POST", headers: authorization },
);
const archive = await responseJson(archiveResponse);
if (!archiveResponse.ok) {
  throw new Error(
    `Engine snapshot failed: ${archiveResponse.status} ${JSON.stringify(archive)}`,
  );
}

const inventoryResponse = await fetch(
  `${baseUrl}/api/games/${encodeURIComponent(gameId)}/archive`,
  { headers: authorization },
);
const inventory = await responseJson(inventoryResponse);
if (!inventoryResponse.ok) {
  throw new Error(
    `Archive inventory failed: ${inventoryResponse.status} ${JSON.stringify(inventory)}`,
  );
}
const objects = new Map(inventory.objects.map((object) => [object.key, object]));
for (const [key, sha256] of expected) {
  if (objects.get(key)?.sha256 !== sha256) {
    throw new Error(`Archive inventory did not verify ${key}`);
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      gameId,
      snapshotId: archive.snapshotId,
      uploadedArtifacts: expected.size,
      objectCount: inventory.objectCount,
      totalBytes: inventory.totalBytes,
      verified: true,
    },
    null,
    2,
  )}\n`,
);
