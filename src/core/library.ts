import type { Article, Library } from "./types";

export const MAX_LIBRARY_BYTES = 2_000_000;
export const MAX_ARTICLE_CHARS = 60_000;
export const MAX_ARTICLES = 100;

export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function validateLibrary(input: unknown): Library {
  if (!input || typeof input !== "object")
    throw new Error("Expected a knowledge library object.");
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.documents)) {
    throw new Error(
      "Use a version 1 library with a documents array. See examples/library.json.",
    );
  }
  if (raw.documents.length > MAX_ARTICLES)
    throw new Error("Import up to 100 articles at a time.");
  const ids = new Set<string>();
  const documents: Article[] = raw.documents.map((item: unknown) => {
    if (!item || typeof item !== "object")
      throw new Error("Each article must be an object.");
    const doc = item as Record<string, unknown>;
    if (
      typeof doc.id !== "string" ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(doc.id) ||
      ids.has(doc.id)
    ) {
      throw new Error(
        "Article IDs must be unique and use letters, numbers, dots, underscores, or hyphens.",
      );
    }
    if (
      typeof doc.title !== "string" ||
      !doc.title.trim() ||
      doc.title.length > 200
    ) {
      throw new Error("Each article needs a title of 1–200 characters.");
    }
    if (
      typeof doc.text !== "string" ||
      !doc.text.trim() ||
      doc.text.length > MAX_ARTICLE_CHARS
    ) {
      throw new Error("Each article needs text of 1–60,000 characters.");
    }
    ids.add(doc.id);
    return {
      id: doc.id,
      title: doc.title.trim(),
      text: doc.text.trim(),
      sourceUrl: safeSourceUrl(doc.sourceUrl),
      updatedAt:
        typeof doc.updatedAt === "string"
          ? doc.updatedAt.slice(0, 40)
          : undefined,
    };
  });
  const library: Library = {
    schemaVersion: 1,
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim().slice(0, 120)
        : "My support articles",
    documents,
  };
  if (
    new TextEncoder().encode(JSON.stringify(library)).length > MAX_LIBRARY_BYTES
  ) {
    throw new Error("Keep the complete library under 2 MB.");
  }
  return library;
}

export function importTextFiles(
  files: { name: string; text: string }[],
): Library {
  return validateLibrary({
    schemaVersion: 1,
    name: "My support articles",
    documents: files.map((file, index) => {
      if (!/\.(md|txt)$/i.test(file.name))
        throw new Error("Choose Markdown (.md) or text (.txt) files.");
      const text = file.text
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .trim();
      const title = text
        .split("\n")
        .find((line) => line.trim())
        ?.replace(/^#+\s*/, "")
        .slice(0, 200);
      return { id: "article-" + (index + 1), title: title || file.name, text };
    }),
  });
}
