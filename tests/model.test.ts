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
  assert.equal(contentFromCompletion("stop", "cited answer"), "cited answer");
  assert.equal(contentFromCompletion(undefined, undefined), "");
});

test("any other generate failure releases the engine, whatever its message", () => {
  for (const error of [
    new Error("GPU lost"),
    new Error("out of memory"),
    new Error("Device was lost."),
    new Error(GENERATION_LENGTH_ERROR),
    new GenerateError("failed", "Engine error."),
    new Error("The model worker stopped. Try loading the model again."),
    new Error("The local model timed out. Try the compact model or search mode."),
    new DOMException("Stopped.", "AbortError"),
    "not an Error",
  ])
    assert.equal(shouldReleaseAfterGenerateFailure(error), true, String(error));
});

test("abort releases the engine even when truncation raced it", () => {
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    shouldReleaseAfterGenerateFailure(
      new GenerateError("length", GENERATION_LENGTH_ERROR),
      aborted.signal,
    ),
    true,
  );
});
