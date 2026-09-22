/**
 * Reproducible local retrieval timing (no model, network, or timing assertions).
 *
 *   npx tsx scripts/benchmark-retrieval.ts
 *   npx tsx scripts/benchmark-retrieval.ts --output artifacts/retrieval-current.json
 *
 * Each cold observation creates a fresh library and index; warm observations reuse
 * one prepared index or the same library through the answer-path retrieval API.
 * File loading, JSON validation, and fixture generation are
 * excluded from timings. Output includes only labels, sizes, timings, and counts,
 * never local article titles, contents, questions, IDs, or paths.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateLibrary } from "../src/core/library";
import type { Library, Passage } from "../src/core/types";

type Retrieval = typeof import("../src/core/retrieval");
type Query = { label: string; text: string };
type Dataset = { label: string; library: Library; queries: Query[] };
type Summary = { medianMs: number; p95Ms: number; observations: number };

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]!;
  const value = args[i + 1];
  if (
    !["--output", "--retrieval-module", "--cold-runs", "--warm-runs"].includes(
      key,
    ) ||
    !value ||
    value.startsWith("--") ||
    options.has(key)
  ) {
    throw new Error(
      "Usage: tsx scripts/benchmark-retrieval.ts [--output FILE] [--retrieval-module FILE] [--cold-runs N] [--warm-runs N]",
    );
  }
  options.set(key, value);
}

function runs(option: string, fallback: number): number {
  const raw = options.get(option);
  if (raw === undefined) return fallback;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 1_000)
    throw new Error(`${option} must be an integer between 1 and 1000.`);
  return count;
}

const coldRuns = runs("--cold-runs", 3);
const warmRuns = runs("--warm-runs", 9);
const modulePath = options.get("--retrieval-module");
const { buildIndex, search, searchLibrary } = (await import(
  modulePath
    ? pathToFileURL(resolve(modulePath)).href
    : new URL("../src/core/retrieval.ts", import.meta.url).href
)) as Retrieval;
const librarySearch: (library: Library, question: string) => Passage[] =
  typeof searchLibrary === "function"
    ? searchLibrary
    : (library, question) => search(buildIndex(library), question);

function loadLibrary(relativePath: string): Library {
  return validateLibrary(
    JSON.parse(readFileSync(resolve(root, relativePath), "utf8")),
  );
}

const miss: Query = { label: "miss", text: "axolotl volcanology" };
// Many distinct terms exercise query preparation and scoring; repeat-only queries
// collapse during deduplication and do not measure this worst case. Keep the
// complete question under the UI's 500-character limit.
const longQuery: Query = {
  label: "long-query",
  text:
    "reset access " +
    Array.from({ length: 27 }, (_, i) => `unlistedconcept${i}`).join(" "),
};

function syntheticLibrary(): Library {
  const filler =
    "The support operator reviews routine workspace settings. Record the visible status and follow the approved steps for the current workflow. ";
  return validateLibrary({
    schemaVersion: 1,
    name: "Deterministic near-limit benchmark",
    documents: Array.from({ length: 100 }, (_, i) => {
      const prefix =
        i === 0
          ? "Zephyr is the first marker for this procedure.\n"
          : i === 42
            ? "Reset access by opening account settings and choosing the recovery action.\n"
            : `This is support procedure ${i}.\n`;
      const suffix =
        i === 0 ? "\nQuartz is the final marker for this procedure." : "";
      return {
        id: `benchmark-${i}`,
        title: `Support procedure ${i}`,
        text:
          prefix +
          filler.repeat(140).slice(0, 18_000 - prefix.length - suffix.length) +
          suffix,
      };
    }),
  });
}

const datasets: Dataset[] = [
  {
    label: "sample",
    library: loadLibrary("public/knowledge/starter.json"),
    queries: [
      { label: "matching", text: "How do I import support articles?" },
      { label: "paraphrase", text: "clear the cache" },
      miss,
      longQuery,
    ],
  },
];
const optionalFile = "artifacts/fd24-library.json";
const optionalPresent = existsSync(resolve(root, optionalFile));
if (optionalPresent) {
  datasets.push({
    label: "optional-local",
    library: loadLibrary(optionalFile),
    queries: [
      { label: "matching", text: "How do I process a refund?" },
      { label: "workflow", text: "check in reservation" },
      miss,
      longQuery,
    ],
  });
}
datasets.push({
  label: "synthetic-near-limit",
  library: syntheticLibrary(),
  queries: [
    { label: "matching", text: "reset access" },
    { label: "broad-match", text: "support workflow" },
    // Markers are at opposite ends of an 18,000-character article. No single
    // passage has both words, exercising article-wide fallback retrieval.
    { label: "cross-chunk", text: "zephyr quartz" },
    miss,
    longQuery,
  ],
});

function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    medianMs: Number(median.toFixed(3)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(3)),
    observations: sorted.length,
  };
}

// Compile and initialize the retrieval path without preparing any measured index.
const warmupLibrary = validateLibrary({
  schemaVersion: 1,
  documents: [
    { id: "warmup", title: "Warmup", text: "Reset access settings." },
  ],
});
for (let i = 0; i < 3; i++) search(buildIndex(warmupLibrary), "reset access");

const results = datasets.map(({ label, library, queries }) => {
  const warmIndex = buildIndex(library);
  const measurements = queries.map((query) => {
    const coldTimes: number[] = [];
    const warmTimes: number[] = [];
    const warmLibraryTimes: number[] = [];
    let hits: Passage[] = [];
    for (let i = 0; i < coldRuns; i++) {
      // Fresh object identity prevents a library-level cache from making this a
      // warm run. Allocation of this fixture copy is deliberately not measured.
      const freshLibrary: Library = {
        ...library,
        documents: library.documents.map((document) => ({ ...document })),
      };
      const started = performance.now();
      hits = search(buildIndex(freshLibrary), query.text);
      coldTimes.push(performance.now() - started);
    }
    search(warmIndex, query.text);
    for (let i = 0; i < warmRuns; i++) {
      const started = performance.now();
      hits = search(warmIndex, query.text);
      warmTimes.push(performance.now() - started);
    }
    librarySearch(library, query.text);
    for (let i = 0; i < warmRuns; i++) {
      const started = performance.now();
      hits = librarySearch(library, query.text);
      warmLibraryTimes.push(performance.now() - started);
    }
    return {
      query: query.label,
      queryCharacters: query.text.length,
      hits: hits.length,
      coldBuildAndSearch: summarize(coldTimes),
      warmSearch: summarize(warmTimes),
      warmLibrarySearch: summarize(warmLibraryTimes),
    };
  });
  return {
    dataset: label,
    documents: library.documents.length,
    bytes: Buffer.byteLength(JSON.stringify(library), "utf8"),
    passages: warmIndex.length,
    measurements,
  };
});

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  settings: {
    coldRuns,
    warmRuns,
    libraryRoute:
      typeof searchLibrary === "function"
        ? "searchLibrary"
        : "buildIndex-and-search",
  },
  notes: [
    "Cold measures buildIndex plus the first search on a fresh library; warm reuses an index after an untimed search.",
    "Warm library measures the answer-path retrieval API on the same library; older implementations build an index on every request.",
    "Initialization, input validation, and fixture allocation are excluded. Milliseconds are descriptive, with no timing assertions.",
    "The p95 is the nearest-rank percentile; use more runs for stable tail estimates.",
    ...(optionalPresent
      ? []
      : ["Optional local corpus is absent and was skipped."]),
  ],
  results,
};
const json = JSON.stringify(report, null, 2) + "\n";
const output = options.get("--output");
if (output) {
  const destination = resolve(output);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, json, "utf8");
}
process.stdout.write(json);
