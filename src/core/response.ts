import type { Citation } from "./types";

export function responseSchema(sourceIds: string[]): string {
  if (!sourceIds.length)
    throw new Error("Generation requires retrieved sources.");
  return JSON.stringify({
    type: "object",
    properties: {
      answerable: { type: "boolean" },
      statements: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            sourceId: { type: "string", enum: sourceIds },
          },
          required: ["text", "sourceId"],
          additionalProperties: false,
        },
      },
    },
    required: ["answerable", "statements"],
    additionalProperties: false,
  });
}
/** Drop copied http(s)/www addresses; keep the surrounding claim. */
export function stripInlineUrls(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>[\]()]+/gi, " ")
    .replace(/\bwww\.[^\s<>[\]()]+/gi, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Source identity is validated separately from the truth of the generated claim. */
export function decodeModelResponse(
  raw: string,
  citations: Citation[],
): string | null {
  try {
    const parsed = JSON.parse(
      raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
    );
    if (
      parsed?.answerable !== true ||
      !Array.isArray(parsed.statements) ||
      !parsed.statements.length ||
      parsed.statements.length > 3
    )
      return null;
    const allowed = new Set(citations.map((c) => c.id));
    const statements: string[] = [];
    for (const statement of parsed.statements) {
      if (
        !statement ||
        typeof statement.text !== "string" ||
        !statement.text.trim() ||
        statement.text.length > 700 ||
        !allowed.has(statement.sourceId)
      )
        return null;
      const claim = stripInlineUrls(statement.text.trim());
      if (!claim) return null;
      statements.push(claim + " [" + statement.sourceId + "]");
    }
    return statements.join("\n\n");
  } catch {
    return null;
  }
}
