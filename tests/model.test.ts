import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { GenerateError } from "../src/core/types";
import {
  GENERATION_LENGTH_ERROR,
  LocalModel,
  MODELS,
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
    new Error(
      "The local model timed out. Try the compact model or search mode.",
    ),
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

interface WorkerRequest {
  kind: string;
  uuid: string;
  content?: unknown;
}

/** Exercises WebLLM's real adapter without downloading weights or needing a GPU. */
class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  static failStartup = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  requests: WorkerRequest[] = [];
  terminated = false;

  constructor() {
    super();
    TestWorker.instances.push(this);
  }
  postMessage(request: WorkerRequest): void {
    if (TestWorker.failStartup) throw new Error("Worker setup failed.");
    this.requests.push(request);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(kind: string, content?: unknown): void {
    const request = [...this.requests]
      .reverse()
      .find((item) => item.kind === kind);
    assert(request, "Expected worker request " + kind);
    this.onmessage?.(
      new MessageEvent("message", {
        data: { kind: "return", uuid: request.uuid, content },
      }),
    );
  }
  progress(): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: {
          kind: "initProgressCallback",
          content: { progress: 0.5, text: "Loading", timeElapsed: 1 },
        },
      }),
    );
  }
}

function testModel(t: TestContext): LocalModel {
  TestWorker.instances = [];
  TestWorker.failStartup = false;
  for (const [name, value] of Object.entries({
    Worker: TestWorker,
    location: { href: "https://local.test/panel.html" },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const model = new LocalModel();
  t.after(() => model.release());
  return model;
}

async function readyModel(model: LocalModel): Promise<TestWorker> {
  const loading = model.load(MODELS[0]!.id, () => {});
  const worker = TestWorker.instances.at(-1)!;
  worker.reply("reload");
  await loading;
  return worker;
}

test(
  "release immediately cancels a pending load",
  { timeout: 1000 },
  async (t) => {
    const model = testModel(t);
    const loading = model.load(MODELS[0]!.id, () => {});
    const rejected = assert.rejects(loading, { name: "AbortError" });
    model.release();
    await rejected;
    assert.equal(model.ready, false);
    assert.equal(TestWorker.instances[0]!.terminated, true);
  },
);

test(
  "a superseded load cannot stop its replacement or report stale progress",
  { timeout: 1000 },
  async (t) => {
    const model = testModel(t);
    let progress = 0;
    const first = model.load(MODELS[0]!.id, () => progress++);
    const rejected = assert.rejects(first, { name: "AbortError" });
    const oldWorker = TestWorker.instances[0]!;
    const replacement = model.load(MODELS[1]!.id, () => progress++);
    const worker = TestWorker.instances[1]!;
    oldWorker.progress();
    worker.progress();
    worker.reply("reload");
    await Promise.all([rejected, replacement]);
    assert.equal(progress, 1);
    assert.equal(model.ready, true);
    assert.equal(oldWorker.terminated, true);
    assert.equal(worker.terminated, false);
  },
);

test(
  "reloading while generating cancels only the old worker",
  { timeout: 1000 },
  async (t) => {
    const model = testModel(t);
    const oldWorker = await readyModel(model);
    const generated = model.generate(
      [{ role: "user", content: "Help" }],
      undefined,
      ["S1"],
    );
    const rejected = assert.rejects(generated, { name: "AbortError" });
    const worker = await readyModel(model);
    await rejected;
    assert.equal(model.ready, true);
    assert.equal(worker.terminated, false);
    assert.equal(oldWorker.terminated, true);
  },
);

test(
  "worker failures reject active operations and release idle engines",
  { timeout: 1000 },
  async (t) => {
    const model = testModel(t);
    for (const event of ["error", "messageerror"]) {
      const worker = await readyModel(model);
      const generated = model.generate(
        [{ role: "user", content: "Help" }],
        undefined,
        ["S1"],
      );
      const rejected = assert.rejects(generated, /model worker stopped/);
      worker.dispatchEvent(new Event(event));
      await rejected;
      assert.equal(model.ready, false);
      assert.equal(worker.terminated, true);
    }
    const idleWorker = await readyModel(model);
    idleWorker.dispatchEvent(new Event("error"));
    assert.equal(model.ready, false);
    assert.equal(idleWorker.terminated, true);
    await assert.rejects(model.generate([]), /Load a model first/);
  },
);

test("an aborted load does not start a worker or replace a healthy model", async (t) => {
  const model = testModel(t);
  const worker = await readyModel(model);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    model.load(MODELS[1]!.id, () => {}, controller.signal),
    {
      name: "AbortError",
    },
  );
  assert.equal(TestWorker.instances.length, 1);
  assert.equal(worker.terminated, false);
  assert.equal(model.ready, true);
});

test("an already cancelled generation sends no completion request", async (t) => {
  const model = testModel(t);
  const worker = await readyModel(model);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(model.generate([], controller.signal), {
    name: "AbortError",
  });
  assert.equal(
    worker.requests.some(
      (request) => request.kind === "chatCompletionNonStreaming",
    ),
    false,
  );
  assert.equal(worker.terminated, true);
});

test("a worker created before engine setup fails is released", async (t) => {
  const model = testModel(t);
  TestWorker.failStartup = true;
  await assert.rejects(
    model.load(MODELS[0]!.id, () => {}),
    /Worker setup failed/,
  );
  assert.equal(TestWorker.instances[0]!.terminated, true);
  assert.equal(model.ready, false);
});

test("length-capped completions leave the real adapter available for another answer", async (t) => {
  const model = testModel(t);
  const worker = await readyModel(model);
  const generated = model.generate(
    [{ role: "user", content: "Help" }],
    undefined,
    ["S1"],
  );
  worker.reply("chatCompletionNonStreaming", {
    choices: [{ finish_reason: "length", message: { content: "partial" } }],
  });
  await assert.rejects(generated, { message: GENERATION_LENGTH_ERROR });
  assert.equal(model.ready, true);
  assert.equal(worker.terminated, false);
  const next = model.generate(
    [{ role: "user", content: "Help again" }],
    undefined,
    ["S1"],
  );
  worker.reply("chatCompletionNonStreaming", {
    choices: [
      { finish_reason: "stop", message: { content: "complete answer" } },
    ],
  });
  assert.equal(await next, "complete answer");
});
