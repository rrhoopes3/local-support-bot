import { answerQuestion } from "./core/answer";
import {
  importTextFiles,
  MAX_LIBRARY_BYTES,
  validateLibrary,
} from "./core/library";
import type { Answer, Library } from "./core/types";
import { LocalModel, MODELS } from "./model";
import { readLibrary, saveLibrary } from "./storage";

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error("Missing element: " + id);
  return el as T;
}
const model = new LocalModel();
const select = element<HTMLSelectElement>("model-select");
const load = element<HTMLButtonElement>("load-model");
const progress = element<HTMLProgressElement>("load-progress");
const modelStatus = element("model-status");
const libraryStatus = element("library-status");
const fileInput = element<HTMLInputElement>("import-files");
const question = element<HTMLTextAreaElement>("question");

const log = element("conversation");
let library: Library = { schemaVersion: 1, name: "No library", documents: [] };
let busy = false;
let active: AbortController | null = null;

function status(el: HTMLElement, text: string, error = false): void {
  el.textContent = text;
  el.classList.toggle("error", error);
}
function updateState(): void {
  element("model-state").textContent = model.ready
    ? "Model ready"
    : "Search ready";
  element("answer-mode").textContent = model.ready
    ? "On-device model · cited answers"
    : "Local search · sources included";
}
function setBusy(value: boolean): void {
  busy = value;
  for (const id of [
    "model-select",
    "load-model",
    "unload-model",
    "clear-cache",
    "restore-demo",
    "export-library",
    "import-files",
    "send",
    "clear-chat",
  ]) {
    (element(id) as HTMLButtonElement).disabled = value;
  }
  question.disabled = value;
  document
    .querySelectorAll<HTMLButtonElement>(".suggestion")
    .forEach((button) => (button.disabled = value));
}
function modelInfo(): void {
  const selected = MODELS.find((m) => m.id === select.value)!;
  element("model-info").textContent =
    "4-bit weights · about " +
    (selected.vramMB / 1024).toFixed(1) +
    " GB GPU memory budget. First load downloads hundreds of MB to over 1 GB.";
}
for (const m of MODELS) select.add(new Option(m.label, m.id));
select.addEventListener("change", () => {
  model.release();
  modelInfo();
  updateState();
  status(modelStatus, "Model selected. Click Load model to use it.");
});
modelInfo();

function showLibrary(): void {
  element("library-name").textContent = library.name;
  element("article-count").textContent = String(library.documents.length);
  const list = element("article-list");
  list.replaceChildren();
  for (const doc of library.documents) {
    const details = document.createElement("details");
    details.className = "library-article";
    const title = document.createElement("summary");
    title.textContent = doc.title;
    const body = document.createElement("p");
    body.textContent = doc.text;
    details.append(title, body);
    list.append(details);
  }
}
function clearChat(): void {
  log.querySelectorAll(".message").forEach((message) => message.remove());
  element("welcome").hidden = false;
}
async function sampleLibrary(): Promise<Library> {
  const response = await fetch("./knowledge/starter.json");
  if (!response.ok)
    throw new Error("Could not open the bundled sample library.");
  return validateLibrary(await response.json());
}

load.addEventListener("click", async () => {
  if (busy) return;
  active = new AbortController();
  setBusy(true);
  load.hidden = true;
  element("cancel-load").hidden = false;
  progress.hidden = false;
  progress.value = 0;
  status(
    modelStatus,
    "Preparing the local model. The first download can take several minutes.",
  );
  try {
    await model.load(
      select.value,
      (report) => {
        progress.value = report.progress;
        status(modelStatus, report.text);
      },
      active.signal,
    );
    status(modelStatus, "Ready. Answers will be generated on this device.");
  } catch (error) {
    status(
      modelStatus,
      active.signal.aborted
        ? "Model loading stopped. Article search is ready."
        : "Couldn’t load the model. " +
            messageFor(error) +
            " Article search still works.",
      !active.signal.aborted,
    );
  } finally {
    active = null;
    setBusy(false);
    load.hidden = false;
    element("cancel-load").hidden = true;
    progress.hidden = true;
    updateState();
  }
});
element("cancel-load").addEventListener("click", () => active?.abort());
element("stop-answer").addEventListener("click", () => active?.abort());
element("unload-model").addEventListener("click", () => {
  model.release();
  updateState();
  status(modelStatus, "Model memory released. Cached weights are kept.");
});
element("clear-cache").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    await model.clearCache(select.value);
    status(
      modelStatus,
      "Selected model cache removed. Your articles are still here.",
    );
  } catch (error) {
    status(modelStatus, messageFor(error), true);
  } finally {
    setBusy(false);
    updateState();
  }
});

fileInput.addEventListener("change", async () => {
  if (busy || !fileInput.files?.length) return;
  const files = [...fileInput.files];
  setBusy(true);
  try {
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_LIBRARY_BYTES)
      throw new Error("Select files totaling less than 2 MB.");
    const jsonFiles = files.filter((file) => /\.json$/i.test(file.name));
    let next: Library;
    if (jsonFiles.length) {
      if (files.length !== 1)
        throw new Error(
          "Import one library JSON, or a group of Markdown/text files.",
        );
      next = validateLibrary(JSON.parse(await files[0]!.text()));
    } else {
      next = importTextFiles(
        await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            text: await file.text(),
          })),
        ),
      );
    }
    await saveLibrary(next);
    library = next;
    showLibrary();
    clearChat();
    status(
      libraryStatus,
      library.documents.length + " articles imported and saved on this device.",
    );
  } catch (error) {
    status(libraryStatus, messageFor(error), true);
  } finally {
    fileInput.value = "";
    setBusy(false);
  }
});
element("restore-demo").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    const next = await sampleLibrary();
    await saveLibrary(next);
    library = next;
    showLibrary();
    clearChat();
    status(libraryStatus, "Sample library restored.");
  } catch (error) {
    status(libraryStatus, messageFor(error), true);
  } finally {
    setBusy(false);
  }
});
element("export-library").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "localsupbot-library.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function appendMessage(role: "user" | "assistant", text: string): HTMLElement {
  element("welcome").hidden = true;
  const container = document.createElement("article");
  container.className = "message " + role;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "YOU" : "LOCALSUPBOT";
  const body = document.createElement("div");
  body.className = "message-text";
  body.textContent = text;
  container.append(label, body);
  log.append(container);
  container.scrollIntoView({ block: "end" });
  return container;
}
function renderAnswer(container: HTMLElement, answer: Answer): void {
  container.querySelector(".message-text")!.textContent = answer.text;
  container.dataset.mode = answer.mode;
  if (answer.note) {
    const note = document.createElement("p");
    note.className = "answer-note";
    note.textContent = answer.note;
    container.append(note);
  }
  for (const source of answer.citations) {
    const details = document.createElement("details");
    details.className = "source-card";
    details.open = answer.mode === "excerpts";
    const summary = document.createElement("summary");
    const id = document.createElement("span");
    id.className = "source-id";
    id.textContent = "[" + source.id + "]";
    summary.append(
      id,
      document.createTextNode(source.title + " · " + source.locator),
    );
    const passage = document.createElement("p");
    passage.textContent = source.text;
    details.append(summary, passage);
    if (source.sourceUrl) {
      const link = document.createElement("a");
      link.href = source.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open source article ↗";
      details.append(link);
    }
    container.append(details);
  }
}
function messageFor(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error.slice(0, 400)
      : "Something went wrong. Please try again.";
}
element<HTMLFormElement>("ask-form").addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();
    if (busy || !question.value.trim()) return;
    const text = question.value.trim();
    appendMessage("user", text);
    const answerEl = appendMessage(
      "assistant",
      model.ready
        ? "Reading the matching passages on this device…"
        : "Searching your articles…",
    );
    question.value = "";
    active = new AbortController();
    setBusy(true);
    element("stop-answer").hidden = false;
    try {
      renderAnswer(
        answerEl,
        await answerQuestion(
          library,
          text,
          model.ready ? model : undefined,
          active.signal,
        ),
      );
    } catch (error) {
      answerEl.querySelector(".message-text")!.textContent = active.signal
        .aborted
        ? "Stopped. Ask another question when you’re ready."
        : messageFor(error);
    } finally {
      active = null;
      setBusy(false);
      element("stop-answer").hidden = true;
      updateState();
      if (!model.ready)
        status(
          modelStatus,
          "Article search is ready. Load a model for composed answers.",
        );
      question.focus();
    }
  },
);
question.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    element<HTMLFormElement>("ask-form").requestSubmit();
  }
});
document.querySelectorAll<HTMLButtonElement>(".suggestion").forEach((button) =>
  button.addEventListener("click", () => {
    if (busy) return;
    question.value = button.dataset.question || "";
    element<HTMLFormElement>("ask-form").requestSubmit();
  }),
);
element("clear-chat").addEventListener("click", clearChat);
window.addEventListener("pagehide", () => {
  active?.abort();
  model.release();
});
setBusy(true);
try {
  library = (await readLibrary()) ?? (await sampleLibrary());
  showLibrary();
  status(
    libraryStatus,
    library.name === "Sample workspace"
      ? "Sample articles describe LocalSupBot. Import your PMS knowledge to get started."
      : "",
  );
} catch (error) {
  showLibrary();
  status(
    libraryStatus,
    "Saved library could not be loaded. Import a library or restore samples. " +
      messageFor(error),
    true,
  );
} finally {
  setBusy(false);
}
