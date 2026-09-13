import test from "node:test";
import assert from "node:assert/strict";
import { GenerateError } from "../src/core/types";
import {
  GENERATION_LENGTH_ERROR,
  contentFromCompletion,
  shouldReleaseAfterGenerateFailure,
} from "../src/model";

test("truncated generation throws without asking the engine to unload", () => {
  assert.throws(() => contentFromCompletion("length", '{"answerable":true'), {
    name: "GenerateError",
    message: GENERATION_LENGTH_ERROR,
  });
  try {
    contentFromCompletion("length", '{"answerable":true');
  } catch (error) {
    assert(error instanceof GenerateError);
    assert.equal(error.kind, "length");
  }
  assert.equal(
    shouldReleaseAfterGenerateFailure(
      new GenerateError("length", GENERATION_LENGTH_ERROR),
    ),
    false,
  );
});

test("ordinary generate failures keep the loaded engine", () => {
  assert.equal(
    shouldReleaseAfterGenerateFailure(new Error("The answer exceeded its budget.")),
    false,
  );
  assert.equal(
    shouldReleaseAfterGenerateFailure(new Error("GPU lost")),
    false,
  );
  assert.equal(contentFromCompletion("stop", "cited answer"), "cited answer");
  assert.equal(contentFromCompletion(undefined, undefined), "");
});

test("abort, worker crash, and timeout still release the engine", () => {
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    shouldReleaseAfterGenerateFailure(new Error("whatever"), aborted.signal),
    true,
  );
  assert.equal(
    shouldReleaseAfterGenerateFailure(
      new DOMException("Stopped.", "AbortError"),
    ),
    true,
  );
  assert.equal(
    shouldReleaseAfterGenerateFailure(
      new Error("The model worker stopped. Try loading the model again."),
    ),
    true,
  );
  assert.equal(
    shouldReleaseAfterGenerateFailure(
      new Error("The local model timed out. Try the compact model or search mode."),
    ),
    true,
  );
});
