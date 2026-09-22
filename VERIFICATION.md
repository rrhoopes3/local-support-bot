# Scaffold verification — 2026-09-13

- TypeScript: passed.
- Core behavior: 32 tests passed (stemming including charge/decline/create, enable/enabled, schedule/scheduled, menu/menus, and status/statuses; contractions so `won't` is not `won`; date words that rank passages without deciding coverage and cannot open the gate alone; single-word questions; one-distinctive-word gate limits, including no title-only distinctive hit; a lone generic title word not retrieving an unrelated article; numbered and "Step N" procedures and "How do I…" titles not treated as catalogs; add/create counted as one question word; article fallback returning only matching passages; add vs remove tax; add↔create ranking; the offline welcome chip; grounded context; structured source IDs; invented URLs falling back to excerpts; only leading `<think>` blocks stripped; only truncation keeping the engine; typed generate-failure notes; cancellation; import validation; and the checked-in retrieval eval, which reports optional misses as test diagnostics).
- Packaged extension: 5/5 Chromium tests passed (real MV3 load, local storage, import, inert text rendering, no initial external requests, model failure recovery, cancellation, narrow layout, and the offline welcome chip returning Local models evidence).
- The real-GPU smoke runs below predate the generate-failure release change and were not repeated after it.
- Qwen3 0.6B q4f32: loaded successfully and generated source-linked statements on the host NVIDIA Ampere GPU.
- Offline: cached model reloaded and generated a cited answer with Chromium networking disabled.
- Browser/model smoke runs reported no page errors.
- UI inspected at 320 px width; composer has its own layout region and does not overlay the scrolling conversation.

The real-model checks used the sample article question “How do I import support articles?” This verifies runtime operation, including offline loading; it is not a PMS answer-quality benchmark. Qwen3 1.7B's runtime is packaged and its hash verified, but its weights/inference have not been exercised here. The CI workflow has been scaffolded; it has not run on GitHub.

Local-only artifacts (gitignored):

- artifacts/extension-welcome.png and artifacts/extension-search.png
- artifacts/model-smoke.json and artifacts/model-smoke-offline.json
- artifacts/model-smoke.png
- artifacts/fd24-library.json — 23 local SupportBot product articles exported for review/import

All extension JavaScript and WebAssembly are bundled. Model weights are not included in Git; Chrome downloads them on explicit model loading. The test browser cache is separate from the user's normal Chrome profile.

## Retrieval tightening — 2026-09-15

Automated only. No GPU, browser, or fleet session was run for this pass.

- Distinctive two-word exception now requires the unmatched word to be a support action (`clear`, `process`, `add`, …). Leftover nouns (`time`, `price`, `history`) plus a rare library term no longer retrieve.
- Clock questions (`what time is it`, `what's the time`) return no evidence even when `time` and another library word co-occur.
- `size`/`characters` and `maximum`/`limit` are one question word each, so "what is the maximum article size" hits the sample import article. That eval case is required.
- Unit tests: 36/36, including the optional local corpus when `artifacts/fd24-library.json` is present.
- `npm run pack` writes `artifacts/localsupbot-extension.zip` from `dist/extension`. Unzip before Load unpacked.

## Performance and lookup reliability — 2026-09-22

- `npm run check`: TypeScript, all 62 unit/evaluation tests, and extension build passed. The optional local corpus was present: its procedure questions and all 23 title lookups passed.
- `npm run test:browser`: all 8 real MV3 Chromium tests passed, including search-only startup size, storage/import behavior, IME input, failure recovery, and cancellation while the model runtime import is stalled.
- `npm run smoke:model -- --offline`: cached Qwen3 0.6B loaded on the host NVIDIA Ampere GPU with networking disabled and generated a cited answer to the sample import question. No page errors. Qwen3 1.7B inference was not repeated.
- Search startup loads approximately 21 KB of panel/shared JavaScript; the approximately 5.8 MB WebLLM runtime is deferred until a model action. Library article bodies are rendered only when expanded.
- Lookup indexing now reuses token counts, article aggregates, and inverted postings. Regression tests cover invalidation after mutable library/passage changes, isolated returned results, Unicode and numeric tokens, check-in/out variants, doubled inflections, time questions, bulleted procedures, complementary evidence, distinctive terms in long articles, and bounded Unicode-safe chunks.
- Worker ownership and cancellation tests exercise the real WebLLM adapter with a fake worker protocol, including stale-load races, release during pending work, worker crashes, setup failures, and keeping the engine after a length cap.

Local benchmark: Node 24.14.0 on Windows x64, 5 cold and 31 warm observations per query. The synthetic library contains 100 articles, 2,300 passages, and 1,806,458 UTF-8 bytes. The before implementation was preserved locally before editing. These are lookup timings, not GPU-generation or whole-UI response times.

| Near-limit query            | Previous warm library median | Updated warm library median | Updated p95 |
| --------------------------- | ---------------------------: | --------------------------: | ----------: |
| Focused match               |                    34.087 ms |                    0.022 ms |    0.032 ms |
| Broad match                 |                    33.421 ms |                    2.199 ms |    2.394 ms |
| Terms split across passages |                    41.314 ms |                    0.024 ms |    0.035 ms |
| No match                    |                    38.576 ms |                    0.016 ms |    0.017 ms |
| 488-character question      |                    61.008 ms |                    0.025 ms |    0.074 ms |

Cold index construction plus first lookup remains approximately 31–35 ms on that synthetic library. The local 23-article corpus's focused lookup improved from 5.416 ms to 0.023 ms warm. All 13 benchmark cases retained their hit counts; relevance is checked separately by the regression/evaluation suites. Timings depend on hardware, corpus, and query, and the benchmark intentionally has no timing pass/fail threshold.

Reproduce with:

```powershell
npm run benchmark:retrieval -- --cold-runs 5 --warm-runs 31 --output artifacts/retrieval-current.json
```

Local gitignored reports: `artifacts/retrieval-baseline.json`, `artifacts/retrieval-current.json`, and `artifacts/model-smoke-offline.json`. The rebuilt unpacked extension is in `dist/extension`; the refreshed ZIP is `artifacts/localsupbot-extension.zip`.

Retrieval remains lexical. Unknown paraphrases can still miss, and unrelated questions can pass the overlap gate if they share enough incidental words. Citation validation still checks source identity and formatting rather than factual entailment.
