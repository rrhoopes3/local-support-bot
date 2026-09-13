import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateLibrary,
  importTextFiles,
  safeSourceUrl,
} from "../src/core/library";
import { buildIndex, search } from "../src/core/retrieval";
import {
  answerQuestion,
  buildPrompt,
  citationsFor,
  validateGeneratedAnswer,
} from "../src/core/answer";
import type { Library } from "../src/core/types";
const sample = validateLibrary(
  JSON.parse(
    readFileSync(
      new URL("../public/knowledge/starter.json", import.meta.url),
      "utf8",
    ),
  ),
);

test("retrieval ranks the article that answers the question", () => {
  assert.equal(
    search(buildIndex(sample), "How do I import support articles?")[0]
      ?.articleId,
    "import-articles",
  );
  assert.equal(
    search(buildIndex(sample), "Can I use the model offline?")[0]?.articleId,
    "local-model",
  );
});
test("unrelated or empty queries produce no evidence and never call a model", async () => {
  for (const question of ["quantum entanglement theorem", "please help me"]) {
    const result = await answerQuestion(sample, question, {
      generate: async () => {
        throw new Error("Must not be called");
      },
    });
    assert.equal(result.mode, "empty");
    assert.equal(result.citations.length, 0);
  }
});
test("long articles are covered with bounded passages", () => {
  const text = "alpha ".repeat(400) + "needle ending";
  const index = buildIndex({
    schemaVersion: 1,
    name: "test",
    documents: [{ id: "a", title: "test", text }],
  });
  assert(index.every((p) => p.text.length <= 900));
  assert(index.at(-1)?.text.endsWith("needle ending"));
});
test("model gets bounded evidence with provenance and no conversation contamination", () => {
  const citations = citationsFor(
    search(buildIndex(sample), "local model offline"),
  );
  const messages = buildPrompt("local model offline", citations);
  assert(messages.reduce((size, m) => size + m.content.length, 0) < 5000);
  assert(messages[0]?.content.includes("untrusted data"));
  assert(messages[1]?.content.includes('"id":"S1"'));
});
test("valid cited generation is returned with only referenced sources", async () => {
  const answer = await answerQuestion(
    sample,
    "How do I import support articles?",
    {
      generate: async () =>
        JSON.stringify({
          answerable: true,
          statements: [
            {
              text: "Choose Import articles and select Markdown or text files.",
              sourceId: "S1",
            },
          ],
        }),
    },
  );
  assert.equal(answer.mode, "model");
  assert.deepEqual(
    answer.citations.map((c) => c.id),
    ["S1"],
  );
});
test("unknown citations, uncited paragraphs, reasoning, fabricated links, and refusal fall back to excerpts", async () => {
  const candidates = [
    "Do this. [S99]",
    "Do this without citations.",
    "Supported. [S1]\n\nInvented extra step.",
    "<think>unfinished",
    "INSUFFICIENT_EVIDENCE",
    "Go to https://evil.example [S1]",
    "<script>alert(1)</script> [S1]",
  ];
  for (const raw of candidates) {
    const result = await answerQuestion(sample, "import support articles", {
      generate: async () => raw,
    });
    assert.equal(result.mode, "excerpts", raw);
    assert(result.citations.length > 0);
  }
});
test("model crashes fall back to evidence, but cancellation propagates", async () => {
  const fallback = await answerQuestion(sample, "import support articles", {
    generate: async () => {
      throw new Error("GPU lost");
    },
  });
  assert.equal(fallback.mode, "excerpts");
  const controller = new AbortController();
  await assert.rejects(
    answerQuestion(
      sample,
      "import support articles",
      {
        generate: async () => {
          controller.abort();
          return "Answer. [S1]";
        },
      },
      controller.signal,
    ),
    { name: "AbortError" },
  );
});
test("citation checks do not claim to prove factual correctness", () => {
  const citations = citationsFor(search(buildIndex(sample), "import articles"));
  assert.equal(
    validateGeneratedAnswer(
      "A wrong claim with a valid citation. [S1]",
      citations,
    ),
    "A wrong claim with a valid citation. [S1]",
  );
});
test("library rejects duplicate IDs, oversized text, and unsafe source URLs", () => {
  const doc = { id: "a", title: "A", text: "Text" };
  assert.throws(
    () => validateLibrary({ schemaVersion: 1, documents: [doc, doc] }),
    /unique/,
  );
  assert.throws(
    () =>
      validateLibrary({
        schemaVersion: 1,
        documents: [{ ...doc, text: "a".repeat(60_001) }],
      }),
    /60,000/,
  );
  assert.equal(safeSourceUrl("javascript:alert(1)"), undefined);
  assert.equal(safeSourceUrl("https://user:password@example.com"), undefined);
  assert.equal(
    safeSourceUrl("https://example.com/help"),
    "https://example.com/help",
  );
});
test("Markdown import validates format and preserves inert text", () => {
  const library: Library = importTextFiles([
    { name: "article.md", text: "# Article\n<script>window.evil=1</script>" },
  ]);
  assert.equal(library.documents[0]?.title, "Article");
  assert(library.documents[0]?.text.includes("<script>"));
  assert.throws(
    () => importTextFiles([{ name: "page.html", text: "test" }]),
    /Markdown/,
  );
});

test("structured answers require retrieved source IDs and reject missing evidence", async () => {
  const candidates = [
    JSON.stringify({
      answerable: true,
      statements: [{ text: "Invented", sourceId: "S99" }],
    }),
    JSON.stringify({ answerable: false, statements: [] }),
    JSON.stringify({ answerable: true, statements: [] }),
    JSON.stringify({
      answerable: true,
      statements: [
        { text: "Repeated.", sourceId: "S1" },
        { text: "Repeated.", sourceId: "S1" },
      ],
    }),
  ];
  for (const raw of candidates) {
    const answer = await answerQuestion(sample, "import support articles", {
      generate: async () => raw,
    });
    assert.equal(answer.mode, "excerpts");
  }
});
