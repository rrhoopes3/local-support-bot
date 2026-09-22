import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIndex,
  looksLikeIndexArticle,
  search,
  searchLibrary,
  stem,
  tokenize,
} from "../src/core/retrieval";
import type { Article, Library } from "../src/core/types";

function library(documents: Article[]): Library {
  return { schemaVersion: 1, name: "Lookup regression fixtures", documents };
}

function article(id: string, title: string, text: string): Article {
  return { id, title, text };
}

test("doubled consonant inflections retrieve their base action", () => {
  for (const [base, inflected] of [
    ["reset", "resetting"],
    ["stop", "stopped"],
    ["run", "running"],
  ]) {
    const index = buildIndex(
      library([
        article("guide", "Account help", `${base} the password check.`),
      ]),
    );
    assert.equal(search(index, `${inflected} password`)[0]?.articleId, "guide");
  }
  assert.notEqual(stem("fill"), stem("file"));
  assert.equal(stem("filled"), stem("fill"));
});

test("check-in and check-out spellings retain distinct intents", () => {
  const index = buildIndex(
    library([
      article(
        "arrival",
        "Check-in",
        "Check-in time is 3 PM. Open the guest reservation and check in.",
      ),
      article(
        "departure",
        "Check-out",
        "Check-out time is 11 AM. Open the guest reservation and check out.",
      ),
    ]),
  );
  for (const question of [
    "checkin",
    "check-in",
    "check in",
    "checking in a guest",
    "checked in a guest",
    "checked-in guests",
    "check a guest in",
  ])
    assert.equal(search(index, question)[0]?.articleId, "arrival", question);
  for (const question of [
    "checkout",
    "check-out",
    "check out",
    "checking out a guest",
    "checked out a guest",
    "checked-out guests",
    "check a guest out",
  ])
    assert.equal(search(index, question)[0]?.articleId, "departure", question);
});

test("clock filtering permits documented time limits and check-in times", () => {
  const index = buildIndex(
    library([
      article("arrival", "Check-in time", "Check-in time is 3 PM."),
      article(
        "refunds",
        "Refund time limit",
        "The time limit for refunds is 30 days after payment.",
      ),
    ]),
  );
  assert.equal(
    search(index, "what is the time for check in")[0]?.articleId,
    "arrival",
  );
  assert.equal(
    search(index, "what is the time limit for refunds")[0]?.articleId,
    "refunds",
  );
  assert.deepEqual(search(index, "what time is it"), []);
});

test("single digit error codes distinguish otherwise matching articles", () => {
  const index = buildIndex(
    library([
      article("one", "Error 1", "Error 1 means the card was declined."),
      article("two", "Error 2", "Error 2 means the connection is unavailable."),
    ]),
  );
  assert.equal(search(index, "error 1")[0]?.articleId, "one");
  assert.equal(search(index, "error 2")[0]?.articleId, "two");
});

test("canonically equivalent Unicode terms match", () => {
  const index = buildIndex(
    library([
      article("cafe", "Café connection", "Open the Café network settings."),
    ]),
  );
  assert.equal(search(index, "Cafe\u0301 connection")[0]?.articleId, "cafe");
});

test("imperative bullet procedures are not demoted as article catalogs", () => {
  const steps = [
    "- Open Front Desk",
    "- Select the reservation",
    "- Open the guest folio",
    "- Choose Refund",
    "- Enter the amount",
    "- Pick the original card",
    "- Add a note for audit",
    "- Click Save",
  ].join("\n");
  assert.equal(looksLikeIndexArticle("Refund a payment", steps), false);
  const index = buildIndex(
    library([
      article("procedure", "Refund a payment", steps),
      article(
        "note",
        "Payments overview",
        "Refunds go back to the original card. A supervisor can approve a refund.",
      ),
    ]),
  );
  assert.equal(search(index, "refund card")[0]?.articleId, "procedure");
});

test("article evidence across chunks remains eligible beside a partial hit", () => {
  const filler = "rooms keys housekeeping night audit inventory ";
  const index = buildIndex(
    library([
      article(
        "complete",
        "Detailed procedure",
        "alpha " +
          filler.repeat(35) +
          "beta " +
          filler.repeat(35) +
          "gamma ending",
      ),
      article("partial", "Minor note", "alpha beta appear here briefly."),
    ]),
  );
  const hits = search(index, "alpha beta gamma", 3);
  assert(hits.some((hit) => hit.articleId === "complete"));
  const evidence = hits.map((hit) => hit.text).join(" ");
  for (const term of ["alpha", "beta", "gamma"])
    assert(evidence.includes(term), `Selected evidence should cover ${term}`);
});

test("a title-only tail does not outrank a passage containing the procedure", () => {
  const text = (
    "To reset your password, open Security and select Reset password. " +
    "filler ".repeat(1000)
  ).slice(0, 901);
  const index = buildIndex(
    library([article("account", "Reset password", text)]),
  );
  assert.match(search(index, "reset password")[0]?.text ?? "", /Security/);
});

test("matching companion passages complete evidence when the article has a direct hit", () => {
  const filler = "rooms keys housekeeping night audit inventory ";
  const index = buildIndex(
    library([
      article(
        "complete",
        "Detailed procedure",
        "alpha beta " + filler.repeat(40) + "gamma ending",
      ),
    ]),
  );
  const hits = search(index, "alpha beta gamma", 3);
  const evidence = hits.map((hit) => hit.text).join(" ");
  for (const term of ["alpha", "beta", "gamma"])
    assert(evidence.includes(term), "Selected evidence should cover " + term);
});

test("a distinctive article remains eligible when its matching term spans many passages", () => {
  for (const repeat of [1, 50]) {
    const index = buildIndex(
      library([
        article(
          "cache",
          "Browser maintenance",
          "The cache stores downloaded files. ".repeat(repeat),
        ),
      ]),
    );
    assert.equal(
      search(index, "clear cache")[0]?.articleId,
      "cache",
      "repetitions: " + repeat,
    );
  }
});

test("chunks preserve words, normalized newlines, and complete Unicode pairs", () => {
  const body = Array.from(
    { length: 350 },
    (_, i) =>
      "token" +
      i +
      "Résumé😀" +
      (i % 9 === 0 ? "\r\n" : i % 17 === 0 ? "\r" : " "),
  ).join("");
  const index = buildIndex(library([article("unicode", "Unicode", body)]));
  assert(index.length > 1);
  assert(
    index.every(
      (passage) => passage.text.length <= 900 && passage.text.length > 0,
    ),
  );
  assert.deepEqual(
    new Set(index.flatMap((passage) => tokenize(passage.text))),
    new Set(tokenize(body)),
  );
  assert(index.every((passage) => !passage.text.includes("\r")));

  // An unbroken string forces the hard character limit through a surrogate pair.
  const unbroken = "a".repeat(899) + "😀" + "b".repeat(899) + "😀";
  const hardChunks = buildIndex(
    library([article("hard", "Unicode", unbroken)]),
  );
  assert.equal(hardChunks.map((passage) => passage.text).join(""), unbroken);
  for (const passage of hardChunks) {
    assert(passage.text.length <= 900);
    assert.doesNotMatch(
      passage.text,
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  }
});

test("library cache follows text, title, source URL, and document replacement", () => {
  const doc = article(
    "account",
    "Account help",
    "Reset the forgotten password.",
  );
  doc.sourceUrl = "https://example.com/original";
  const source = library([doc]);
  assert.equal(searchLibrary(source, "password")[0]?.articleId, "account");

  doc.text = "Review billing statements.";
  assert.deepEqual(searchLibrary(source, "password"), []);

  doc.title = "Password help";
  assert.equal(searchLibrary(source, "password")[0]?.articleId, "account");

  doc.sourceUrl = "https://example.com/updated";
  assert.equal(
    searchLibrary(source, "password")[0]?.sourceUrl,
    "https://example.com/updated",
  );

  source.documents = [
    article("network", "Connection help", "Reset the router."),
  ];
  assert.deepEqual(searchLibrary(source, "password"), []);
  assert.equal(searchLibrary(source, "router")[0]?.articleId, "network");
});

test("prepared passage cache follows edits and replacement in an existing array", () => {
  const index = buildIndex(
    library([article("support", "Support", "Refund card payments.")]),
  );
  assert.equal(search(index, "refund")[0]?.articleId, "support");
  index[0]!.text = "Housekeeping inventory.";
  assert.deepEqual(search(index, "refund"), []);
  index[0]!.title = "Refund support";
  assert.equal(search(index, "refund")[0]?.articleId, "support");
  index[0] = {
    ...index[0]!,
    id: "network#1",
    articleId: "network",
    title: "Network support",
    text: "Restart the router.",
    sourceUrl: "https://example.com/network",
  };
  assert.deepEqual(search(index, "refund"), []);
  assert.equal(
    search(index, "router")[0]?.sourceUrl,
    "https://example.com/network",
  );
});

test("reordering indexed passages preserves deterministic results", () => {
  const index = buildIndex(
    library([
      article("first", "Support", "Reset password in account settings."),
      article("second", "Support", "Reset password in account settings."),
    ]),
  );
  const before = search(index, "reset password").map((hit) => hit.id);
  index.reverse();
  assert.deepEqual(
    search(index, "reset password").map((hit) => hit.id),
    before,
  );
});

test("search results are isolated copies with query-specific scores", () => {
  const index = buildIndex(
    library([
      article("account", "Account help", "Reset the forgotten password."),
    ]),
  );
  const first = search(index, "password")[0]!;
  assert(first.score > 0);
  assert.equal(index[0]!.score, 0);
  first.text = "Changed only in the returned result.";
  first.score = -100;
  const second = search(index, "password")[0]!;
  assert.notEqual(first, second);
  assert.match(second.text, /forgotten password/);
  assert(second.score > 0);
});
