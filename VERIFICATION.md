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
