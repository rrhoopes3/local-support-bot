import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";
let context: BrowserContext;
let page: Page;
let profile: string;
const errors: string[] = [];
const requests: string[] = [];
test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), "localsupbot-test-"));
  const extension = resolve("dist/extension");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      "--disable-extensions-except=" + extension,
      "--load-extension=" + extension,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(
    "chrome-extension://" + new URL(worker.url()).host + "/panel.html",
  );
});
test.afterAll(async () => {
  await context?.close();
  // This is an isolated profile created by this test, never a user browser profile.
  if (
    profile &&
    basename(profile).startsWith("localsupbot-test-") &&
    resolve(profile).startsWith(resolve(tmpdir()) + sep)
  )
    await rm(profile, { recursive: true, force: true });
});
test("real MV3 extension opens, searches, cites, imports, and persists without a model download", async () => {
  await expect(
    page.getByRole("heading", { name: "Sample workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "How do I import articles?" }).click();
  await expect(page.locator(".message.assistant")).toHaveAttribute(
    "data-mode",
    "excerpts",
  );
  await expect(page.locator(".source-card").first()).toContainText(
    "Importing support articles",
  );
  await page.getByRole("button", { name: "Clear chat", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Ask a support question" })
    .fill("quantum entanglement theorem");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.locator(".message.assistant")).toHaveAttribute(
    "data-mode",
    "empty",
  );
  const article = {
    schemaVersion: 1,
    name: "Test PMS",
    documents: [
      {
        id: "night-audit",
        title: "Night audit checklist",
        text: "The night audit checklist requires checking unresolved arrivals before closing the business day.",
        sourceUrl: "javascript:alert(1)",
      },
    ],
  };
  await page.locator("#import-files").setInputFiles({
    name: "pms.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(article)),
  });
  await expect(page.getByRole("heading", { name: "Test PMS" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Test PMS" })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Ask a support question" })
    .fill("night audit checklist");
  await page.getByRole("button", { name: "Send question" }).click();
  await expect(page.locator(".source-card")).toContainText(
    "unresolved arrivals",
  );
  await expect(page.locator(".source-card a")).toHaveCount(0);
  expect(requests.filter((url) => /^https?:/.test(url))).toEqual([]);
  const startupScripts = requests.filter((url) => url.endsWith(".js"));
  const loadedBytes = await Promise.all(
    startupScripts.map(
      async (url) =>
        (await stat(resolve("dist/extension", new URL(url).pathname.slice(1))))
          .size,
    ),
  );
  // The multi-megabyte WebLLM runtime is unnecessary for local article search.
  expect(loadedBytes.reduce((sum, size) => sum + size, 0)).toBeLessThan(
    100_000,
  );
  expect(startupScripts.some((url) => /\/model-[A-Z0-9]+\.js$/.test(url))).toBe(
    false,
  );
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "artifacts/extension-search.png",
    fullPage: true,
  });
});
test("invalid import preserves existing articles and treats HTML as inert text", async () => {
  await page.locator("#import-files").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"schemaVersion":2}'),
  });
  await expect(page.locator("#library-status")).toHaveClass(/error/);
  await expect(page.getByRole("heading", { name: "Test PMS" })).toBeVisible();
  await page.locator("#import-files").setInputFiles({
    name: "unsafe.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Example\n<script>window.__injected=1</script> example instructions",
    ),
  });
  await expect(page.locator("#article-count")).toHaveText("1");
  await expect(page.locator(".library-article p")).toHaveCount(0);
  await page.getByText("Browse articles", { exact: true }).click();
  await page.locator(".library-article summary").click();
  await expect(page.locator(".library-article p")).toContainText("<script>");
  await page.locator(".library-article summary").click();
  await page.locator(".library-article summary").click();
  await expect(page.locator(".library-article p")).toHaveCount(1);
  expect(await page.evaluate(() => Object.hasOwn(window, "__injected"))).toBe(
    false,
  );
});
test("bundled model runtime validates under extension CSP and recovers from download failure", async () => {
  const runtimeOk = await page.evaluate(async () => {
    const response = await fetch("./models/qwen3-0.6b.wasm");
    const bytes = await response.arrayBuffer();
    return WebAssembly.validate(bytes);
  });
  expect(runtimeOk).toBe(true);
  // Stall only the weight download to exercise a real worker startup and Stop.
  await context.route("https://huggingface.co/**", (route) =>
    route.abort("internetdisconnected"),
  );
  await page.getByRole("button", { name: "Load model", exact: true }).click();
  await expect(page.locator("#model-status")).toContainText(
    /Couldn’t load|Article search/,
    { timeout: 30_000 },
  );
  await expect(
    page.getByRole("button", { name: "Load model", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("#model-state")).toHaveText("Search ready");
  await context.unrouteAll({ behavior: "ignoreErrors" });
  expect(errors).toEqual([]);
});
test("welcome layout at narrow side-panel width", async () => {
  await page.getByRole("button", { name: "Restore sample library" }).click();
  await expect(
    page.getByRole("heading", { name: "Sample workspace" }),
  ).toBeVisible();
  await page.reload();
  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/extension-welcome.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Can I use this offline?" }).click();
  await expect(page.locator(".message.assistant")).toHaveAttribute(
    "data-mode",
    "excerpts",
  );
  await expect(page.locator(".source-card").first()).toContainText(
    "Local models and offline answers",
  );
});

test("Stop cancels model loading and restores the search controls", async () => {
  await page.evaluate(() => {
    document.getElementById("load-model")!.click();
    document.getElementById("cancel-load")!.click();
  });
  await expect(page.locator("#model-status")).toContainText(
    "Model loading stopped",
  );
  await expect(page.locator("#load-model")).toBeVisible();
  await expect(page.locator("#load-model")).toBeEnabled();
  await expect(page.locator("#send")).toBeEnabled();
  await expect(page.locator("#model-state")).toHaveText("Search ready");
});

test("Enter confirms IME input without prematurely submitting the question", async () => {
  await page.getByRole("button", { name: "Clear chat", exact: true }).click();
  const question = page.getByRole("textbox", {
    name: "Ask a support question",
  });
  await question.fill("Can I use this offline?");
  await question.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  await expect(page.locator(".message")).toHaveCount(0);
  await expect(question).toHaveValue("Can I use this offline?");
  await question.dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await expect(page.locator(".message")).toHaveCount(0);
  await question.press("Enter");
  await expect(page.locator(".message.assistant")).toHaveAttribute(
    "data-mode",
    "excerpts",
  );
});

test("imports library JSON with a UTF-8 byte order mark", async () => {
  await page.locator("#import-files").setInputFiles({
    name: "windows-library.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      "\uFEFF" +
        JSON.stringify({
          schemaVersion: 1,
          name: "Windows export",
          documents: [
            { id: "help", title: "Help", text: "Supported library import." },
          ],
        }),
    ),
  });
  await expect(
    page.getByRole("heading", { name: "Windows export" }),
  ).toBeVisible();
  await expect(page.locator("#library-status")).not.toHaveClass(/error/);
  expect(errors).toEqual([]);
});

test("Stop cancels a pending runtime import before any model worker starts", async () => {
  const coldPage = await context.newPage();
  const workers: string[] = [];
  coldPage.on("worker", (worker) => workers.push(worker.url()));
  coldPage.on("pageerror", (error) => errors.push(error.message));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtimeEntry = /\/model-[A-Z0-9]+\.js$/;
  await coldPage.route(runtimeEntry, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await coldPage.goto(page.url());
    const requested = coldPage.waitForRequest(runtimeEntry);
    await coldPage
      .getByRole("button", { name: "Load model", exact: true })
      .click();
    const runtimeRequest = await requested;
    await coldPage.locator("#cancel-load").click();
    await expect(coldPage.locator("#model-status")).toContainText(
      "Model loading stopped",
    );
    await expect(coldPage.locator("#send")).toBeEnabled();
    release();
    // Await the exact pending module, including its runtime dependencies.
    await coldPage.evaluate(async (url) => {
      await import(url);
    }, runtimeRequest.url());
    await expect(coldPage.locator("#model-status")).toContainText(
      "Model loading stopped",
    );
    expect(workers).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    release();
    await coldPage.unrouteAll({ behavior: "ignoreErrors" });
    await coldPage.close();
  }
});
