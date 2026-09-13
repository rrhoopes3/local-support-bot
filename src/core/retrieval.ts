import type { Library, Passage } from "./types";

const STOP = new Set(
  "a an and are as at be by can do does for from how i in is it me my of on or please that the this to walk what when where which with you your show through".split(
    " ",
  ),
);
const CHUNK_CHARS = 900;
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );
}
export function buildIndex(library: Library): Passage[] {
  return library.documents.flatMap((doc) => {
    const chunks: Passage[] = [];
    const body = doc.text.replace(/\r\n/g, "\n");
    let start = 0;
    while (start < body.length) {
      let end = Math.min(start + CHUNK_CHARS, body.length);
      if (end < body.length) {
        const boundary = body.lastIndexOf("\n", end);
        if (boundary > start + CHUNK_CHARS / 2) end = boundary;
      }
      chunks.push({
        id: doc.id + "#" + (chunks.length + 1),
        articleId: doc.id,
        title: doc.title,
        text: body.slice(start, end).trim(),
        locator: "passage " + (chunks.length + 1),
        sourceUrl: doc.sourceUrl,
        score: 0,
      });
      if (end === body.length) break;
      start = end - 100;
    }
    return chunks;
  });
}
export function search(
  index: Passage[],
  question: string,
  limit = 3,
): Passage[] {
  const query = [...new Set(tokenize(question))];
  if (!query.length || !index.length) return [];
  const tokens = index.map((p) => tokenize(p.title + " " + p.text));
  const averageLength =
    tokens.reduce((sum, ts) => sum + ts.length, 0) / tokens.length || 1;
  const frequency = new Map(
    query.map((term) => [
      term,
      tokens.filter((ts) => ts.includes(term)).length,
    ]),
  );
  return index
    .map((passage, i) => {
      const ts = tokens[i]!;
      const titleTerms = new Set(tokenize(passage.title));
      let score = 0;
      let matches = 0;
      for (const term of query) {
        const count = ts.filter((t) => t === term).length;
        if (!count) continue;
        matches++;
        const df = frequency.get(term)!;
        const idf = Math.log(1 + (index.length - df + 0.5) / (df + 0.5));
        const normalized =
          (count * 2.2) /
          (count + 1.2 * (0.25 + (0.75 * ts.length) / averageLength));
        score += idf * normalized + (titleTerms.has(term) ? 0.4 : 0);
      }
      // A relevance heuristic, not a calibrated probability of a correct answer.
      const enoughOverlap =
        matches >= Math.min(2, query.length) && matches / query.length >= 0.25;
      return { ...passage, score: enoughOverlap ? score : 0 };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
