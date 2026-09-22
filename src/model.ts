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

/** A length-capped completion leaves the engine healthy; any other failure releases it. */
export function shouldReleaseAfterGenerateFailure(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) return true;
  return !(error instanceof GenerateError && error.kind === "length");
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
  private lifetime: AbortController | null = null;
  ready = false;

  private readonly onWorkerFailure = (event: Event): void => {
    if (event.currentTarget === this.worker)
      this.release(
        new Error("The model worker stopped. Try loading the model again."),
      );
  };

  async load(
    id: string,
    progress: (report: InitProgressReport) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!MODELS.some((m) => m.id === id))
      throw new Error("Choose one of the packaged models.");
    if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
    this.release();
    const appConfig = makeAppConfig();
    const worker = new Worker(new URL("./model-worker.js", location.href), {
      type: "module",
    });
    this.worker = worker;
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    worker.addEventListener("error", this.onWorkerFailure);
    worker.addEventListener("messageerror", this.onWorkerFailure);
    try {
      const engine = new WebWorkerMLCEngine(worker, {
        appConfig,
        initProgressCallback: (report) => {
          if (this.worker === worker && !signal?.aborted) progress(report);
        },
        logLevel: "WARN",
      });
      this.engine = engine;
      await this.bounded(
        () => engine.reload(id, { context_window_size: 4096 }),
        lifetime.signal,
        signal,
        15 * 60_000,
      );
      lifetime.signal.throwIfAborted();
      if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
      this.ready = true;
    } catch (error) {
      if (this.worker === worker) this.release();
      throw error;
    }
  }
  async generate(
    messages: ChatMessage[],
    signal?: AbortSignal,
    sourceIds: string[] = [],
  ): Promise<string> {
    if (!this.ready || !this.engine || !this.worker || !this.lifetime)
      throw new GenerateError("unavailable", "Load a model first.");
    const engine = this.engine;
    const worker = this.worker;
    const lifetime = this.lifetime;
    try {
      const result = await this.bounded(
        () =>
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
        lifetime.signal,
        signal,
        90_000,
      );
      lifetime.signal.throwIfAborted();
      if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
      return contentFromCompletion(
        result.choices[0]?.finish_reason,
        result.choices[0]?.message.content,
      );
    } catch (error) {
      if (
        this.worker === worker &&
        shouldReleaseAfterGenerateFailure(error, signal)
      )
        this.release();
      throw error;
    }
  }
  release(reason: Error = new DOMException("Stopped.", "AbortError")): void {
    const worker = this.worker;
    const lifetime = this.lifetime;
    this.ready = false;
    this.worker = null;
    this.engine = null;
    this.lifetime = null;
    // Terminating a worker does not settle WebLLM's pending promises.
    lifetime?.abort(reason);
    worker?.removeEventListener("error", this.onWorkerFailure);
    worker?.removeEventListener("messageerror", this.onWorkerFailure);
    worker?.terminate();
  }
  async clearCache(id: string): Promise<void> {
    this.release();
    await deleteModelAllInfoInCache(id, makeAppConfig());
  }
  private async bounded<T>(
    task: () => Promise<T>,
    lifetime: AbortSignal,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
    lifetime.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    let released: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("Stopped.", "AbortError"));
      released = () => reject(lifetime.reason);
      signal?.addEventListener("abort", abort, { once: true });
      lifetime.addEventListener("abort", released, { once: true });
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "The local model timed out. Try the compact model or search mode.",
            ),
          ),
        timeoutMs,
      );
    });
    try {
      const result = await Promise.race([task(), interrupted]);
      if (signal?.aborted) throw new DOMException("Stopped.", "AbortError");
      lifetime.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      lifetime.removeEventListener("abort", released);
    }
  }
}
