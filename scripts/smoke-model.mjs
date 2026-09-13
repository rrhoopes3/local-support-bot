import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
await mkdir(artifacts, { recursive: true });
const extension = resolve(root, "dist/extension");
const context = await chromium.launchPersistentContext(
  resolve(root, ".cache/model-smoke-profile"),
  {
    channel: "chromium",
    headless: true,
    args: [
      "--disable-extensions-except=" + extension,
      "--load-extension=" + extension,
    ],
  },
);
const offline = process.argv.includes("--offline");
const report = {
  offline,
  testedAt: new Date().toISOString(),
  model: "Qwen3-0.6B-q4f32_1-MLC",
  gpu: null,
  loadStatus: null,
  answer: null,
  mode: null,
  errors: [],
};
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.setViewportSize({ width: 410, height: 950 });
  await page.goto(
    "chrome-extension://" + new URL(worker.url()).host + "/panel.html",
  );
  await page.getByRole("heading", { name: "Sample workspace" }).waitFor();
  report.gpu = await page.evaluate(async () => {
    if (!navigator.gpu)
      return { available: false, reason: "WebGPU is unavailable" };
    const adapter = await navigator.gpu.requestAdapter();
    return adapter
      ? {
          available: true,
          info: {
            vendor: adapter.info?.vendor,
            architecture: adapter.info?.architecture,
            device: adapter.info?.device,
          },
          maxBufferSize: adapter.limits.maxBufferSize,
        }
      : { available: false, reason: "No GPU adapter" };
  });
  console.log(JSON.stringify(report.gpu));
  if (offline) await context.setOffline(true);
  await page.getByRole("button", { name: "Load model", exact: true }).click();
  let last = "";
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const status = await page.locator("#model-status").textContent();
    if (status !== last) {
      console.log(status);
      last = status;
    }
    if (await page.locator("#load-model").isVisible()) break;
    await page.waitForTimeout(5_000);
  }
  report.loadStatus = await page.locator("#model-status").textContent();
  if ((await page.locator("#model-state").textContent()) === "Model ready") {
    await page
      .getByRole("textbox", { name: "Ask a support question" })
      .fill("How do I import support articles?");
    await page.getByRole("button", { name: "Send question" }).click();
    await page
      .locator(".message.assistant[data-mode]")
      .waitFor({ timeout: 100_000 });
    report.answer = await page.locator(".message.assistant").innerText();
    report.mode = await page
      .locator(".message.assistant")
      .getAttribute("data-mode");
  }
  await page.screenshot({
    path: resolve(artifacts, "model-smoke.png"),
    fullPage: true,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(
    resolve(
      artifacts,
      offline ? "model-smoke-offline.json" : "model-smoke.json",
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  await context.close();
}
if (report.mode !== "model") process.exitCode = 1;
