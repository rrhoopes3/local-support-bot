import { responseSchema } from "./core/response";
import {
  WebWorkerMLCEngine,
  deleteModelAllInfoInCache,
  prebuiltAppConfig,
  type AppConfig,
  type InitProgressReport,
} from "@mlc-ai/web-llm";
import modelOptions from "../models.json";
import { GenerateError, type ChatMessage, type Generator } from "./core/types";

export const MODELS = modelOptions;
export function makeAppConfig(): AppConfig {
  return {
    cacheBackend: "cache",
    model_list: MODELS.map((option) => {
      const record = prebuiltAppConfig.model_list.find(
        (r) => r.model_id === option.id,
      );
      if (!record)
        throw new Error("This WebLLM version does not contain " + option.id);
      return {
        ...record,
        model_lib: new URL(option.wasmPath, location.href).href,
        overrides: { ...record.overrides, context_window_size: 4096 },
      };
    }),
  };
}

export const GENERATION_LENGTH_ERROR = "The answer exceeded its budget.";

/** Keep the GPU session after truncated/failed generate; release on abort, crash, or timeout. */
export function shouldReleaseAfterGenerateFailure(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof GenerateError) return false;
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("model worker stopped") || message.includes("timed out")
  );
}

export function contentFromCompletion(
  finishReason: string | undefined,
  content: string | null | undefined,
): string {
  if (finishReason === "length")
    throw new GenerateError("length", GENERATION_LENGTH_ERROR);
  return content || "";
}

/** Dedicated worker per panel. Closing the panel releases the GPU; cached weights persist. */
export class LocalModel implements Generator {
  private worker: Worker | null = null;
  private engine: WebWorkerMLCEngine | null = null;
  ready = false;

  async load(
    id: string,
    progress: (report: InitProgressReport) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!MODELS.some((m) => m.id === id))
      throw new Error("Choose one of the packaged models.");
    this.release();
    const worker = new Worker(new URL("./model-worker.js", location.href), {
      type: "module",
    });
    this.worker = worker;
    const engine = new WebWorkerMLCEngine(worker, {
      appConfig: makeAppConfig(),
      initProgressCallback: progress,
      logLevel: "WARN",
    });
    this.engine = engine;
    try {
      await this.bounded(
        engine.reload(id, { context_window_size: 4096 }),
        worker,
        signal,
        15 * 60_000,
      );
      this.ready = true;
    } catch (error) {
      this.release();
      throw error;
    }
  }
  async generate(
    messages: ChatMessage[],
    signal?: AbortSignal,
    sourceIds: string[] = [],
  ): Promise<string> {
    if (!this.ready || !this.engine || !this.worker)
      throw new GenerateError("unavailable", "Load a model first.");
    const engine = this.engine;
    try {
      const result = await this.bounded(
        engine.chat.completions.create({
          messages,
          max_tokens: 240,
          temperature: 0.5,
          top_p: 0.8,
          presence_penalty: 1.0,
          repetition_penalty: 1.05,
          response_format: {
            type: "json_object",
            schema: responseSchema(sourceIds),
          },
          extra_body: { enable_thinking: false },
        }),
        this.worker,
        signal,
        90_000,
      );
      return contentFromCompletion(
        result.choices[0]?.finish_reason,
        result.choices[0]?.message.content,
      );
    } catch (error) {
      if (shouldReleaseAfterGenerateFailure(error, signal)) this.release();
      throw error;
    }
  }
  release(): void {
    this.ready = false;
    this.worker?.terminate();
    this.worker = null;
    this.engine = null;
  }
  async clearCache(id: string): Promise<void> {
    this.release();
    await deleteModelAllInfoInCache(id, makeAppConfig());
  }
  private async bounded<T>(
    task: Promise<T>,
    worker: Worker,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    let failure: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("Stopped.", "AbortError"));
      failure = () =>
        reject(
          new Error("The model worker stopped. Try loading the model again."),
        );
      signal?.addEventListener("abort", abort, { once: true });
      worker.addEventListener("error", failure);
      worker.addEventListener("messageerror", failure);
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "The local model timed out. Try the compact model or search mode.",
            ),
          ),
        timeoutMs,
      );
      if (signal?.aborted) abort();
    });
    try {
      return await Promise.race([task, interrupted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.removeEventListener("error", failure);
      worker.removeEventListener("messageerror", failure);
    }
  }
}
