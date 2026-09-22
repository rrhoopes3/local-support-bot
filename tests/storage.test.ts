import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readLibrary, saveLibrary } from "../src/storage";
import type { Library } from "../src/core/types";

const KEY = "localsupbot.library.v1";
const sample: Library = {
  schemaVersion: 1,
  name: "Saved articles",
  documents: [{ id: "help", title: "Help", text: "Support instructions." }],
};

function replaceGlobal(t: TestContext, name: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}

function previewStore(t: TestContext): Map<string, string> {
  const values = new Map<string, string>();
  replaceGlobal(t, "chrome", undefined);
  replaceGlobal(t, "localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return values;
}

test("missing preview storage is empty but corrupt saved values are rejected", async (t) => {
  const values = previewStore(t);
  assert.equal(await readLibrary(), null);
  for (const raw of ["", "false", "0", '\"\"', "invalid JSON"]) {
    values.set(KEY, raw);
    await assert.rejects(readLibrary(), raw);
  }
});

test("preview storage round-trips articles and preserves them after invalid saves", async (t) => {
  const values = previewStore(t);
  await saveLibrary(sample);
  assert.equal(
    (await readLibrary())?.documents[0]?.text,
    sample.documents[0]!.text,
  );
  const previous = values.get(KEY);
  await assert.rejects(
    saveLibrary({ ...sample, schemaVersion: 2 } as unknown as Library),
  );
  assert.equal(values.get(KEY), previous);
});

test("extension storage validates falsy saved values instead of using sample fallback", async (t) => {
  let saved: unknown;
  replaceGlobal(t, "chrome", {
    storage: { local: { get: async () => ({ [KEY]: saved }) } },
  });
  assert.equal(await readLibrary(), null);
  for (saved of [false, 0, ""]) await assert.rejects(readLibrary());
  saved = sample;
  assert.equal((await readLibrary())?.name, sample.name);
});
