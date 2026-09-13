# Third-party components

This scaffold depends on WebLLM and its MLC runtime, and can download Qwen3 model artifacts. Dependency versions are pinned in package-lock.json. The build preserves dependency legal notices in linked .LEGAL.txt files.

- WebLLM: https://github.com/mlc-ai/web-llm
- MLC compiled runtimes: https://github.com/mlc-ai/binary-mlc-llm-libs
- Qwen3 0.6B model and license: https://huggingface.co/Qwen/Qwen3-0.6B
- Qwen3 1.7B model and license: https://huggingface.co/Qwen/Qwen3-1.7B
- MLC converted model artifacts: https://huggingface.co/mlc-ai

The exact compiled-runtime URLs, upstream revision, sizes, and SHA-256 checksums are in vendor/models.lock.json. Model weights are downloaded by the user's browser rather than redistributed in this repository.
