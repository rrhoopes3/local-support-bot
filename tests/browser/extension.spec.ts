import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
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
  await page
    .locator("#import-files")
    .setInputFiles({
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
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "artifacts/extension-search.png",
    fullPage: true,
  });
});
test("invalid import preserves existing articles and treats HTML as inert text", async () => {
  await page
    .locator("#import-files")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"schemaVersion":2}'),
    });
  await expect(page.locator("#library-status")).toHaveClass(/error/);
  await expect(page.getByRole("heading", { name: "Test PMS" })).toBeVisible();
  await page
    .locator("#import-files")
    .setInputFiles({
      name: "unsafe.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "# Example\n<script>window.__injected=1</script> example instructions",
      ),
    });
  await expect(page.locator("#article-count")).toHaveText("1");
  await page.getByText("Browse articles", { exact: true }).click();
  await page.locator(".library-article summary").click();
  await expect(page.locator(".library-article p")).toContainText("<script>");
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
