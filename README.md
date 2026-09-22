# LocalSupBot

A standalone Chrome Manifest V3 side panel that answers support questions from a local knowledge library. Articles live in extension storage. Retrieval is local BM25 with light stemming. Optional Qwen3 inference runs on the user's GPU through WebLLM in a dedicated worker, constrained to JSON statements with source IDs that are checked before rendering. Nothing leaves the machine except the one-time model download.

## Load the unpacked extension

Requirements: Node.js 22+, npm, and desktop Chrome 120+. Article search does not require WebGPU. Composed answers need WebGPU and a first-time model download.

```powershell
cd B:\Grok\LocalSupBot
npm ci
npm run setup:models
npm run build
```

`npm run check` also typechecks, runs unit tests, and builds. Use that when you want the automated suite as well as `dist/extension`.

1. Open `chrome://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select this repository's `dist/extension` directory (not the repo root).
3. Pin **LocalSupBot** and click its toolbar icon to open the side panel.
4. Search the sample articles immediately, or import your own Markdown/text files or library JSON.
5. Optionally click **Load model** to download weights and enable composed answers.

Chrome cannot load a `.zip` directly. To copy a build to another machine:

```powershell
npm run pack
```

That writes `artifacts/localsupbot-extension.zip` (gitignored). Unzip it to a folder, then **Load unpacked** on that folder. This repository does not publish to the Chrome Web Store. A managed fleet can use the same unzipped folder or the organization's existing Chrome extension policy; there is no store listing or signed `.crx` here.

The initial model download can take several minutes. No cloud inference endpoint or API key is used. The compact Qwen3 0.6B model is selected initially; Qwen3 1.7B is also packaged as an option. These q4f32 builds avoid requiring the optional shader-f16 GPU feature. WebLLM's published approximate GPU budgets are 1.9 GB and 2.6 GB respectively; actual memory and speed depend on the machine. Search mode stays available if WebGPU is missing or a load fails.

After weights are cached, model loading can work offline while the browser retains those assets. Closing the panel releases its worker and GPU memory. Reopen the panel and click Load model to reload cached weights. Remove selected model cache clears that model's downloads; Release memory keeps them.

## Import FD24 / SupportBot articles

The runtime is independent of SupportBot and WebSupBot. An export script converts an existing Markdown knowledge folder into the library format:

```powershell
npm run import:kb -- B:\Grok\supportbot\domains\fd24.us\knowledge artifacts/fd24-library.json
```

Review the output and import it through **Import articles**. This reads the source folder and writes the export; it does not change SupportBot. The export is intentionally under gitignored `artifacts/`, so private knowledge is not bundled or committed by accident.

Imports replace the current library. Export first to keep a copy. Limits: 100 articles, 60,000 characters per article, 2 MB total. See `examples/library.json` for the versioned schema. Optional `sourceUrl` values must be HTTP(S); all displayed text is rendered as text, not HTML.

Knowledge is stored in `chrome.storage.local`, not synchronized to a cloud account. Chat is in memory only. Each question is independent; previous messages do not enter subsequent prompts. Sample content describes this extension and is not a PMS policy manual.

## Answer behavior

1. The library is split into overlapping passages of at most 900 characters, preferring newline and word boundaries. Token counts, article metadata, and inverted postings are prepared once and reused between questions. Library imports, replacement, and edits invalidate the cache; returned results are independent copies.
2. Local BM25 retrieval uses Unicode normalization, light suffix stemming (including `reset`/`resetting`), numeric tokens, and a small synonym map. `add`/`create`, `size`/`characters`, and `maximum`/`limit` each count as one concept. Check-in and check-out spelling variants and common inflections retain their different meanings.
3. Evidence must match at least two question concepts covering a quarter of the question, or the only concept of a one-concept question. A single distinctive body concept can carry a two-concept paraphrase only when the unmatched concept is a support action absent from the library (for example, `clear the cache`). Distinctiveness is measured across articles, so a long article is not penalized for repeating its topic in several passages. Date words help ranking but cannot open the evidence gate. Live-clock questions are rejected; documented check-in times and time limits remain searchable.
4. Up to three passages are selected. Procedures outrank catalog pages, including common numbered and bulleted instructions. Actual body matches outrank title-only filler. Matching companion passages supply question concepts split across chunks; a partial match elsewhere does not suppress a more complete article. Questions that fail the gate return no evidence and never call the model.
5. When a model is loaded, only the current question, selected passages, and fixed grounding instructions enter the prompt. Generation is constrained to JSON statements with allowed source IDs. Citation IDs and output formatting are checked before rendering; invented addresses, links, markup, or repeated paragraphs fall back to excerpts. Clickable source URLs come only from library metadata.
6. Model refusal or invalid citations show the passages and keep the loaded model. A length-capped generation also keeps the model. Stop, a worker crash, a timeout, or another engine failure releases the worker and promptly settles pending work. A superseded operation cannot release its replacement model.

The model runtime JavaScript is loaded only when **Load model** or **Remove selected model cache** is used, keeping search startup small. Article bodies in the library browser are rendered when expanded.

Citation checks establish source identity and formatting; they **do not prove that a model's claims follow from the sources**. Retrieval is lexical: it can miss paraphrases without shared terms and can admit an unrelated question sharing enough incidental words. `tests/eval-questions.json` evaluates the sample library and, when present, `artifacts/fd24-library.json`; focused regressions cover normalization, ranking, chunk coverage, and cache invalidation.

The extension has no content script and cannot read or alter the host page. It cannot execute PMS actions or launch walkthrough overlays.

## Model packaging and network boundary

- JavaScript and model WebAssembly are bundled into the extension.
- `npm run setup:models` downloads the two compiled runtimes from a pinned MLC binary repository revision and verifies hashes in `vendor/models.lock.json`.
- `npm run build` verifies those hashes again. It performs no network download.
- Weight/config/tokenizer downloads happen only when Load model is clicked, using WebLLM's cache.
- Network permissions cover Hugging Face and its download CDN hosts. The packaged runtime comes from extension-local URLs, not a runtime remote-code host.
- Model requests download public files; prompts and article contents are never uploaded by the application.
- This is an unpacked extension. Chrome Web Store review/publishing is not part of this repository. Use `npm run pack` for a zip of `dist/extension`.

The model worker has load/generation timeouts, error handling, and cancellation. A load can be stopped immediately. A truncated generation keeps the GPU session and falls back to source excerpts. Any other generate failure, including stopping, a worker crash, a timeout, or a GPU/engine error, releases the worker; the next load normally reuses cached weights.

## Development and verification

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run benchmark:retrieval -- --output artifacts/retrieval-current.json
npm run preview
```

`npm test` includes `tests/eval-questions.json`: sample-library paraphrases always run. Optional local-corpus questions and title self-retrieval run when `artifacts/fd24-library.json` is present and skip when it is not. Expected optional-corpus hits are resolved from titles in that gitignored file, not from checked-in article IDs.

```powershell
npm run pack
```

writes `artifacts/localsupbot-extension.zip` after a fresh build. Unzip it before Load unpacked.

Preview serves the same panel at `http://127.0.0.1:4173/panel.html` with the extension's CSP. It uses browser localStorage in place of Chrome extension storage and does not test toolbar integration.

The retrieval benchmark reports cold initialization, warm index search, and warm library search for the sample library, optional local corpus, and a deterministic 1.8 MB / 100-article library. It includes broad matches, cross-passage queries, misses, and a question near the 500-character limit. Timings are descriptive; there are no machine-dependent timing assertions in the benchmark. Increase `--cold-runs` and `--warm-runs` for more observations.

Browser tests load the **real MV3 build** in a temporary, isolated Chromium profile. They verify import/storage, source rendering, no initial external requests, inert imported HTML, runtime validation, loading cancellation, offline model failure recovery, and narrow layouts. The main suite does not download model weights.

For an optional real GPU/model check, which downloads weights into an isolated cached test profile:

```powershell
npm run smoke:model
npm run smoke:model -- --offline
```

The smoke script writes `artifacts/model-smoke.json` and a screenshot. It exits unsuccessfully if the machine cannot complete a model answer. This separates browser compatibility from article-search test results.

## Layout

| Path                      | Purpose                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `src/core/`               | Corpus schema, retrieval, prompts, citation checks, answer fallback |
| `src/model.ts`            | WebLLM worker lifecycle, loading, generation, cancellation          |
| `src/model-worker.ts`     | Packaged inference worker                                           |
| `src/panel.ts`            | Side-panel UI and article import/export                             |
| `src/storage.ts`          | Extension storage; preview fallback                                 |
| `public/`                 | Manifest, panel markup/styles, sample library                       |
| `models.json`             | Allowed model IDs and local runtime paths                           |
| `vendor/models.lock.json` | Pinned runtime provenance and checksums                             |
| `scripts/`                | Build, zip pack, runtime vendoring, KB export, preview, model smoke |
| `tests/`                  | Core behavior, retrieval eval, and actual extension tests           |

## Scope

LocalSupBot is a search-first unpacked Chrome side panel. That path is what this repository ships: import a library, retrieve passages, and optionally compose a cited on-device answer.

Not in this repository:

- Semantic retrieval or reranking
- Cloud or authenticated knowledge sync for a PMS fleet
- PMS actions, walkthrough overlays, or control of another product
- A Chrome Web Store listing or a signed enterprise installer

Optional Qwen3 quality and WebGPU availability vary by machine. Search mode does not need a GPU.

Upstream references: [WebLLM](https://webllm.mlc.ai/docs/), [Chrome side panels](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), [Qwen3 0.6B](https://huggingface.co/Qwen/Qwen3-0.6B), [Qwen3 1.7B](https://huggingface.co/Qwen/Qwen3-1.7B).
