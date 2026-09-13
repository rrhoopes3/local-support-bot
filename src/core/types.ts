export interface Article {
  id: string;
  title: string;
  text: string;
  sourceUrl?: string;
  updatedAt?: string;
}
export interface Library {
  schemaVersion: 1;
  name: string;
  documents: Article[];
}
export interface Passage {
  id: string;
  articleId: string;
  title: string;
  text: string;
  locator: string;
  sourceUrl?: string;
  score: number;
}
export interface Citation {
  id: string;
  articleId: string;
  title: string;
  locator: string;
  text: string;
  sourceUrl?: string;
}
export interface Answer {
  mode: "model" | "excerpts" | "empty";
  text: string;
  citations: Citation[];
  note?: string;
}
export type ChatMessage = { role: "system" | "user"; content: string };
export type GenerateFailureKind = "length" | "unavailable" | "failed";
export class GenerateError extends Error {
  readonly kind: GenerateFailureKind;
  constructor(kind: GenerateFailureKind, message: string) {
    super(message);
    this.name = "GenerateError";
    this.kind = kind;
  }
}
export interface Generator {
  generate(
    messages: ChatMessage[],
    signal?: AbortSignal,
    sourceIds?: string[],
  ): Promise<string>;
}
