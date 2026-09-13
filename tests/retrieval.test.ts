import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateLibrary,
  importTextFiles,
  safeSourceUrl,
} from "../src/core/library";
import {
  buildIndex,
  looksLikeIndexArticle,
  search,
  stem,
  tokenize,
} from "../src/core/retrieval";
import {
  answerQuestion,
  buildPrompt,
  citationsFor,
  validateGeneratedAnswer,
} from "../src/core/answer";
import { stripInlineUrls } from "../src/core/response";
import { GenerateError, type Library } from "../src/core/types";
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
test("welcome chip asks the phrasing the sample article uses", () => {
  const html = readFileSync(
    new URL("../public/panel.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /data-question="Can I use the model offline\?"/);
  assert.equal(
    search(buildIndex(sample), "Can I use the model offline?")[0]?.articleId,
    "local-model",
  );
});
test("light suffix stemming is deterministic on query and passage tokens", () => {
  assert.equal(stem("refunds"), "refund");
  assert.equal(stem("articles"), "article");
  assert.equal(stem("processor"), "process");
  assert.equal(stem("processors"), "process");
  assert.equal(stem("processed"), "process");
  assert.equal(stem("processing"), "process");
  assert.equal(stem("user"), "user");
  assert.equal(stem("charge"), stem("charged"));
  assert.equal(stem("charge"), stem("charging"));
  assert.equal(stem("decline"), stem("declined"));
  assert.equal(stem("create"), stem("created"));
  assert.equal(stem("weather"), "weather");
  assert.notEqual(stem("weather"), stem("weath"));
  assert.deepEqual(tokenize("process a refund"), tokenize("processor refunds"));
  assert.deepEqual(
    [...new Set(tokenize("charge charged charging"))],
    [stem("charge")],
  );
  assert(tokenize("add tax to a folio").includes(stem("add")));
  assert(tokenize("make a group booking").includes(stem("make")));
});
test("a single high-IDF term can pass the overlap gate", () => {
  const library: Library = {
    schemaVersion: 1,
    name: "idf",
    documents: [
      {
        id: "payments",
        title: "Payments",
        text: "Issue a refund to the guest folio after the supervisor PIN.",
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: "other-" + i,
        title: "Other " + i,
        text: "Housekeeping rooms keys reservations night audit.",
      })),
    ],
  };
  assert.equal(
    search(buildIndex(library), "How do I process a refund?")[0]?.articleId,
    "payments",
  );
});
test("article-level fallback joins terms split across chunks", () => {
  const filler = "rooms keys reservations housekeeping night audit inventory ";
  const library: Library = {
    schemaVersion: 1,
    name: "chunks",
    documents: [
      {
        id: "payments",
        title: "Payments",
        text: "alpha " + filler.repeat(20) + "beta ending",
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: "alpha-" + i,
        title: "Alpha " + i,
        text: "alpha " + filler,
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        id: "beta-" + i,
        title: "Beta " + i,
        text: "beta " + filler,
      })),
    ],
  };
  const hits = search(buildIndex(library), "alpha beta");
  assert.equal(hits[0]?.articleId, "payments");
  assert(hits.length > 0);
});
test("index-style catalog articles are downranked below procedures", () => {
  const library: Library = {
    schemaVersion: 1,
    name: "catalog",
    documents: [
      {
        id: "catalog",
        title: "Walkthrough catalog",
        text:
          "# Catalog\n- refund a payment\n- check in a guest\n- post a charge\n" +
          "- take payment\n- night audit\n- room move\n- checkout\n- stay history",
      },
      {
        id: "payments",
        title: "Payments, Live Mode, and Folios",
        text: "To process a refund, open the folio and choose the refund action.",
      },
    ],
  };
  assert.equal(
    looksLikeIndexArticle(
      library.documents[0]!.title,
      library.documents[0]!.text,
    ),
    true,
  );
  assert.equal(
    looksLikeIndexArticle(
      library.documents[1]!.title,
      library.documents[1]!.text,
    ),
    false,
  );
  assert.equal(
    search(buildIndex(library), "How do I process a refund?")[0]?.articleId,
    "payments",
  );
});
test("unrelated or empty queries produce no evidence and never call a model", async () => {
  for (const question of [
    "quantum entanglement theorem",
    "what is the weather today",
    "please help me",
  ]) {
    const result = await answerQuestion(sample, question, {
      generate: async () => {
        throw new Error("Must not be called");
      },
    });
    assert.equal(result.mode, "empty", question);
    assert.equal(result.citations.length, 0);
  }
});
test("weather does not match unrelated weath tokens", () => {
  const library: Library = {
    schemaVersion: 1,
    name: "weath",
    documents: [
      {
        id: "weath-code",
        title: "Housekeeping codes",
        text: "The weath token is an internal housekeeping code for linen.",
      },
    ],
  };
  assert.equal(
    search(buildIndex(library), "what is the weather today").length,
    0,
  );
});
test("add versus remove tax is distinguished when both procedures exist", () => {
  const library: Library = {
    schemaVersion: 1,
    name: "tax",
    documents: [
      {
        id: "add-tax",
        title: "Add tax to a folio",
        text: "To add tax to a folio, open the folio and post the tax charge code.",
      },
      {
        id: "remove-tax",
        title: "Remove tax from a folio",
        text: "To remove tax from a folio, open the folio and void the tax charge code.",
      },
    ],
  };
  const index = buildIndex(library);
  assert.equal(
    search(index, "add tax to a folio")[0]?.articleId,
    "add-tax",
  );
  assert.equal(
    search(index, "remove tax from a folio")[0]?.articleId,
    "remove-tax",
  );
});
test("add-user ranks the create-user article ahead of a refresh note", () => {
  const library: Library = {
    schemaVersion: 1,
    name: "users",
    documents: [
      {
        id: "login-surfaces",
        title: "Login surfaces",
        text: "Operators can create operator or GM users from the admin console.",
      },
      {
        id: "mobile-refresh",
        title: "Staff mobile app",
        text: "For cache issues, users may need to refresh or reinstall the app.",
      },
    ],
  };
  assert.equal(
    search(buildIndex(library), "how do I add a new user")[0]?.articleId,
    "login-surfaces",
  );
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
    "Go to a raw non-JSON line [S1]",
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
  assert.match(fallback.note ?? "", /could not finish/i);
  assert.doesNotMatch(fallback.note ?? "", /unavailable|unloaded/i);
  const cutOff = await answerQuestion(sample, "import support articles", {
    generate: async () => {
      throw new GenerateError("length", "The answer exceeded its budget.");
    },
  });
  assert.equal(cutOff.mode, "excerpts");
  assert.match(cutOff.note ?? "", /cut off/i);
  const unavailable = await answerQuestion(sample, "import support articles", {
    generate: async () => {
      throw new GenerateError("unavailable", "Load a model first.");
    },
  });
  assert.match(unavailable.note ?? "", /unavailable/i);
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
test("http(s) is stripped from statements; invented markup is rejected", async () => {
  const citations = citationsFor(
    search(buildIndex(sample), "import support articles"),
  );
  const withUrl =
    "Open https://admin.example.com to review the dashboard. [S1]";
  assert.equal(
    validateGeneratedAnswer(withUrl, citations),
    "Open to review the dashboard. [S1]",
  );
  assert.equal(
    stripInlineUrls("See www.example.com/help for steps."),
    "See for steps.",
  );
  const answer = await answerQuestion(sample, "import support articles", {
    generate: async () =>
      JSON.stringify({
        answerable: true,
        statements: [
          {
            text: "Articles stay in this browser. See https://example.com/help.",
            sourceId: "S1",
          },
        ],
      }),
  });
  assert.equal(answer.mode, "model");
  assert.doesNotMatch(answer.text, /https?:\/\//i);
  assert.match(answer.text, /Articles stay in this browser/);
  for (const raw of [
    JSON.stringify({
      answerable: true,
      statements: [{ text: "Open javascript:alert(1)", sourceId: "S1" }],
    }),
    JSON.stringify({
      answerable: true,
      statements: [{ text: "See [docs](https://evil.example)", sourceId: "S1" }],
    }),
    JSON.stringify({
      answerable: true,
      statements: [{ text: "<p>Injected</p>", sourceId: "S1" }],
    }),
  ]) {
    const result = await answerQuestion(sample, "import support articles", {
      generate: async () => raw,
    });
    assert.equal(result.mode, "excerpts", raw);
  }
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
