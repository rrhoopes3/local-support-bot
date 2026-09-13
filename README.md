# LocalSupBot

A standalone Chrome Manifest V3 side panel that answers support questions from a local knowledge library. Articles live in extension storage. Retrieval is local BM25 with light stemming. Optional Qwen3 inference runs on the user's GPU through WebLLM in a dedicated worker, constrained to JSON statements with source IDs that are checked before rendering. Nothing leaves the machine except the one-time model download.

## Load the scaffold

Requirements: Node.js 22+, npm, and desktop Chrome 120+ with WebGPU support for model answers. Article search does not require WebGPU.

```powershell
cd B:\Grok\LocalSupBot
npm ci
npm run setup:models
npm run check
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select this repository's `dist/extension` directory.
3. Pin **LocalSupBot** and click its toolbar icon to open the side panel.
4. Search the sample articles immediately, or import your own Markdown/text files or library JSON.
5. Click **Load model** to download weights and enable composed answers.

The initial download can take several minutes. No cloud inference endpoint or API key is used. The compact Qwen3 0.6B model is selected initially; Qwen3 1.7B is also packaged as an option. These q4f32 builds avoid requiring the optional shader-f16 GPU feature. WebLLM's published approximate GPU budgets are 1.9 GB and 2.6 GB respectively; actual memory and speed depend on the machine.

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

1. Local BM25-style lexical retrieval selects up to three passages, each no more than 900 characters. Query and passage tokens share a cheap suffix stemmer (`s`/`es`/`ed`/`ing`, a trailing `e` so `charge` meets `charged`, and `or` so `process` meets `processor`).
2. A passage can pass with two overlapping terms or one distinctive term (about 10% document frequency and a minimum IDF). If no passage passes, fall back to the best article-level score so terms split across 900-character chunks can still retrieve. Walkthrough catalogs and other index-only articles are downranked so procedures win. Off-topic questions return no evidence and never call the model.
3. If a model is loaded, pass only the question, selected passages, and fixed grounding instructions.
4. Constrain generation to JSON statements with allowed source IDs. Validate each statement, render the citations in code, and reject model-created markdown/HTML/`javascript:` links or repeated paragraphs. Copied `http(s)` / `www.` addresses are stripped from shown text; clickable source URLs still come only from library metadata.
5. If generation is truncated, refuses, or fails citation checks, show the actual passages and keep the loaded model. A length-cap note says the answer was cut off; other generate failures do not claim the model was unloaded. Stop, a worker crash, or a timeout still releases the worker.

Citation checks establish source identity and formatting; they **do not prove that a model's claims follow from the sources**. `tests/eval-questions.json` is the checked-in retrieval eval for the sample library and, when present, `artifacts/fd24-library.json`. Lexical search can still miss paraphrases. Semantic retrieval/reranking is a future provider extension.

The extension has no content script and cannot read or alter the host page. It cannot execute PMS actions or launch WebSupBot walkthrough overlays. Those integrations are explicit future extension points.

## Model packaging and network boundary

- JavaScript and model WebAssembly are bundled into the extension.
- `npm run setup:models` downloads the two compiled runtimes from a pinned MLC binary repository revision and verifies hashes in `vendor/models.lock.json`.
- `npm run build` verifies those hashes again. It performs no network download.
- Weight/config/tokenizer downloads happen only when Load model is clicked, using WebLLM's cache.
- Network permissions cover Hugging Face and its download CDN hosts. The packaged runtime comes from extension-local URLs, not a runtime remote-code host.
- Model requests download public files; prompts and article contents are never uploaded by the application.
- This is an unpacked development scaffold. Chrome Web Store review/publishing is not part of this repository setup.

The model worker has load/generation timeouts, error handling, and cancellation. A load can be stopped immediately. Stopping generation, a worker crash, or a timeout releases the worker; the next load normally reuses cached weights. A truncated or otherwise failed generation keeps the GPU session and falls back to source excerpts.

## Development and verification

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run preview
```

`npm test` includes `tests/eval-questions.json`: sample-library paraphrases always run. Optional local-corpus questions and title self-retrieval run when `artifacts/fd24-library.json` is present and skip when it is not. Expected optional-corpus hits are resolved from titles in that gitignored file, not from checked-in article IDs.

Preview serves the same panel at `http://127.0.0.1:4173/panel.html` with the extension's CSP. It uses browser localStorage in place of Chrome extension storage and does not test toolbar integration.

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
| `scripts/`                | Build, runtime vendoring, KB export, preview, model smoke test      |
| `tests/`                  | Core behavior, retrieval eval, and actual extension tests           |

## Next integrations

- Add semantic retrieval while keeping article IDs and source excerpts intact.
- Add versioned, authenticated knowledge synchronization for deployed PMS fleets.
- Add a published-guide provider/player independently of model generation.
- Benchmark real support questions, false premises, missing articles, and wrong citations.
- Expand per-device capability reporting, model selection, and cache controls.

Upstream references: [WebLLM](https://webllm.mlc.ai/docs/), [Chrome side panels](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), [Qwen3 0.6B](https://huggingface.co/Qwen/Qwen3-0.6B), [Qwen3 1.7B](https://huggingface.co/Qwen/Qwen3-1.7B).
