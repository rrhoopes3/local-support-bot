import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateLibrary } from "../src/core/library";
import {
  buildIndex,
  looksLikeIndexArticle,
  search,
} from "../src/core/retrieval";
import type { Library } from "../src/core/types";

const cases = JSON.parse(
  readFileSync(new URL("./eval-questions.json", import.meta.url), "utf8"),
) as { sample: EvalCase[]; fd24: EvalCase[] };

type EvalCase = {
  id: string;
  question: string;
  acceptableIds?: string[];
  titleNeedles?: string[];
  optional?: boolean;
};

function loadLibrary(rel: string): Library {
  return validateLibrary(
    JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")),
  );
}

function expectedIds(library: Library, item: EvalCase): string[] {
  if (item.acceptableIds?.length) return item.acceptableIds;
  const needles = (item.titleNeedles ?? []).map((needle) =>
    needle.toLowerCase(),
  );
  return library.documents
    .filter((doc) =>
      needles.some((needle) => doc.title.toLowerCase().includes(needle)),
    )
    .map((doc) => doc.id);
}

function assertHit(
  library: Library,
  item: EvalCase,
  label: string,
): { articleId: string; ms: number } | undefined {
  const started = performance.now();
  const allowed = expectedIds(library, item);
  const hits = search(buildIndex(library), item.question, 3);
  const ms = performance.now() - started;
  if (!hits.length) {
    if (item.optional) return undefined;
    assert.fail(
      `${label} ${item.id}: no evidence for ${JSON.stringify(item.question)}`,
    );
  }
  if (!allowed.length) {
    assert.fail(`${label} ${item.id}: no library titles matched the eval needles`);
  }
  const rank = hits.findIndex((hit) => allowed.includes(hit.articleId));
  if (rank !== 0) {
    if (item.optional && rank === -1) return undefined;
    assert.fail(
      `${label} ${item.id}: expected ${allowed.join("|")} first, got ${hits
        .slice(0, 3)
        .map((hit) => hit.articleId)
        .join(", ")}`,
    );
  }
  return { articleId: hits[rank]!.articleId, ms };
}

test("sample library eval questions hit the intended articles", () => {
  const library = loadLibrary("../public/knowledge/starter.json");
  for (const item of cases.sample as EvalCase[]) {
    assertHit(library, item, "sample");
  }
});

const optionalCorpusPath = fileURLToPath(
  new URL("../artifacts/fd24-library.json", import.meta.url),
);
const optionalCorpusPresent = existsSync(optionalCorpusPath);

// Optional-corpus eval has no add-user case: that library has no add-user procedure,
// so a passing rank would be dishonest. add↔create ranking is covered in retrieval tests.
test(
  "optional local corpus eval questions hit procedure articles when present",
  { skip: !optionalCorpusPresent },
  () => {
    const library = validateLibrary(
      JSON.parse(readFileSync(optionalCorpusPath, "utf8")),
    );
    let slowest = 0;
    for (const item of cases.fd24 as EvalCase[]) {
      const result = assertHit(library, item, "optional-corpus");
      if (result) slowest = Math.max(slowest, result.ms);
      const hits = search(buildIndex(library), item.question);
      const top = library.documents.find(
        (doc) => doc.id === hits[0]?.articleId,
      );
      assert(top, `${item.id} should retrieve an article`);
      assert.equal(
        looksLikeIndexArticle(top.title, top.text),
        false,
        `${item.id} should not rank a catalog/index article first`,
      );
    }
    assert(slowest < 50, `optional corpus search exceeded 50ms (${slowest.toFixed(1)}ms)`);
  },
);

test(
  "optional local corpus title self-retrieval stays complete",
  { skip: !optionalCorpusPresent },
  () => {
    const library = validateLibrary(
      JSON.parse(readFileSync(optionalCorpusPath, "utf8")),
    );
    const index = buildIndex(library);
    const missed = library.documents.filter(
      (doc) => search(index, doc.title)[0]?.articleId !== doc.id,
    );
    assert.deepEqual(
      missed.map((doc) => doc.id),
      [],
      "title self-retrieval missed " + missed.map((d) => d.id).join(", "),
    );
    assert.equal(library.documents.length, 23);
  },
);
