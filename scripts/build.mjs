import { build } from "esbuild";
import { readFile, mkdir, cp, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist/extension");
let lock;
try {
  lock = JSON.parse(
    await readFile(resolve(root, "vendor/models.lock.json"), "utf8"),
  );
} catch {
  throw new Error(
    "Run npm run setup:models first to package the model runtimes.",
  );
}
for (const model of lock.models) {
  let bytes;
  try {
    bytes = await readFile(resolve(root, "vendor/models", model.file));
  } catch {
    throw new Error("Missing " + model.file + ". Run npm run setup:models.");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== model.sha256)
    throw new Error("Runtime checksum mismatch: " + model.file);
}
// Only this repository's generated extension directory may be removed.
if (relative(root, dist) !== join("dist", "extension"))
  throw new Error("Unsafe build output path.");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, "public"), dist, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    panel: "src/panel.ts",
    background: "src/background.ts",
    "model-worker": "src/model-worker.ts",
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  splitting: true,
  minify: true,
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
});
await mkdir(resolve(dist, "models"), { recursive: true });
for (const model of lock.models)
  await copyFile(
    resolve(root, "vendor/models", model.file),
    resolve(dist, "models", model.file),
  );
await copyFile(
  resolve(root, "vendor/models.lock.json"),
  resolve(dist, "models/runtime-provenance.json"),
);
console.log("Unpacked extension: " + dist);
