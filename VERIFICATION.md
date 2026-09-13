# Scaffold verification — 2026-09-13

- TypeScript: passed.
- Core behavior: 26 tests passed (verb stemming including charge/decline/create, weather not over-stemmed, tighter overlap gating, add vs remove tax, add↔create ranking, welcome-chip phrasing, grounded context, structured source IDs, URL stripping from statements, typed generate-failure notes, cancellation, import validation, and the checked-in retrieval eval).
- Packaged extension: 5/5 Chromium tests passed (real MV3 load, local storage, import, inert text rendering, no initial external requests, model failure recovery, cancellation, narrow layout, and the offline welcome chip returning Local models evidence).
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
