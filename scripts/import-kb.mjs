import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, relative, dirname, extname, basename } from "node:path";
const sourceArg = process.argv[2];
if (!sourceArg)
  throw new Error(
    "Usage: npm run import:kb -- <knowledge-directory> [output.json]",
  );
const source = resolve(sourceArg);
const output = resolve(process.argv[3] || "artifacts/library.json");
const documents = [];
async function walk(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (
      entry.isFile() &&
      [".md", ".txt"].includes(extname(entry.name).toLowerCase())
    ) {
      const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "").trim();
      if (!text) continue;
      if (text.length > 60_000)
        throw new Error("Split oversized article: " + relative(source, file));
      const title =
        text
          .split("\n")
          .find((line) => line.trim())
          ?.replace(/^#+\s*/, "")
          .slice(0, 200) || basename(file);
      documents.push({ id: "article-" + (documents.length + 1), title, text });
    }
  }
}
await walk(source);
if (documents.length > 100)
  throw new Error("Split this corpus into libraries of up to 100 articles.");
const json =
  JSON.stringify(
    { schemaVersion: 1, name: basename(source), documents },
    null,
    2,
  ) + "\n";
if (Buffer.byteLength(json) > 2_000_000)
  throw new Error("Keep each library under 2 MB.");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, json);
console.log(
  documents.length +
    " articles exported to " +
    output +
    ". Review before importing.",
);
