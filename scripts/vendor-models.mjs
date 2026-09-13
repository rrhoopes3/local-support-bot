import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
const options = JSON.parse(
  await readFile(new URL("../models.json", import.meta.url), "utf8"),
);
const directory = new URL("../vendor/models/", import.meta.url);
const lockUrl = new URL("../vendor/models.lock.json", import.meta.url);
const binaryRevision = "025bcaf3780fa8254f5e5efd3bfea0a5397248f4";
await mkdir(directory, { recursive: true });
let lock;
try {
  lock = JSON.parse(await readFile(lockUrl, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const entries = [];
for (const option of options) {
  const pinned = lock?.models.find((item) => item.id === option.id);
  const record = prebuiltAppConfig.model_list.find(
    (item) => item.model_id === option.id,
  );
  if (!record) throw new Error("Missing WebLLM model " + option.id);
  const source =
    pinned?.url ??
    record.model_lib.replace("/main/", "/" + binaryRevision + "/");
  const file = option.wasmPath.split("/").at(-1);
  const target = new URL(file, directory);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes || (pinned && hash(bytes) !== pinned.sha256)) {
    console.log("Downloading packaged runtime: " + option.id);
    const response = await fetch(source, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(source + " returned " + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (!bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])))
    throw new Error("Expected WebAssembly bytes for " + option.id);
  const sha256 = hash(bytes);
  if (pinned && sha256 !== pinned.sha256)
    throw new Error("Runtime checksum mismatch: " + option.id);
  await writeFile(target, bytes);
  entries.push({
    id: option.id,
    file,
    url: source,
    sha256,
    bytes: bytes.length,
  });
  console.log(option.id + ": " + bytes.length + " bytes, SHA-256 verified");
}
await writeFile(
  lockUrl,
  JSON.stringify(
    {
      schemaVersion: 1,
      webllmVersion: "0.2.85",
      binaryRevision,
      models: entries,
    },
    null,
    2,
  ) + "\n",
);
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
