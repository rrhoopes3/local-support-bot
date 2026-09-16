import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, relative, join, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist/extension");
const output = resolve(root, "artifacts/localsupbot-extension.zip");

if (relative(root, dist) !== join("dist", "extension"))
  throw new Error("Unsafe pack input path.");
if (relative(root, output) !== join("artifacts", "localsupbot-extension.zip"))
  throw new Error("Unsafe pack output path.");

let manifest;
try {
  manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));
} catch {
  throw new Error("Run npm run build before npm run pack.");
}

async function walk(directory) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const full = join(directory, name);
    const info = await stat(full);
    if (info.isDirectory()) files.push(...(await walk(full)));
    else if (info.isFile()) files.push(full);
  }
  return files;
}

function zipName(file) {
  return relative(dist, file).split(sep).join("/");
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}
function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

const files = await walk(dist);
if (!files.length) throw new Error("dist/extension is empty. Run npm run build.");

const locals = [];
const centrals = [];
let offset = 0;
for (const file of files) {
  const name = zipName(file);
  if (!name || name.startsWith("..")) throw new Error("Refusing to pack " + file);
  const uncompressed = await readFile(file);
  const compressed = deflateRawSync(uncompressed);
  const useStore = compressed.length >= uncompressed.length;
  const payload = useStore ? uncompressed : compressed;
  const method = useStore ? 0 : 8;
  const checksum = crc32(uncompressed);
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(checksum),
    u32(payload.length),
    u32(uncompressed.length),
    u16(nameBytes.length),
    u16(0),
    nameBytes,
    payload,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(method),
    u16(0),
    u16(0),
    u32(checksum),
    u32(payload.length),
    u32(uncompressed.length),
    u16(nameBytes.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(offset),
    nameBytes,
  ]);
  locals.push(local);
  centrals.push(central);
  offset += local.length;
}
const centralDir = Buffer.concat(centrals);
const end = Buffer.concat([
  u32(0x06054b50),
  u16(0),
  u16(0),
  u16(files.length),
  u16(files.length),
  u32(centralDir.length),
  u32(offset),
  u16(0),
]);
await mkdir(resolve(root, "artifacts"), { recursive: true });
await writeFile(output, Buffer.concat([...locals, centralDir, end]));
console.log(
  "Packed " +
    files.length +
    " files (v" +
    manifest.version +
    ") to " +
    output,
);
