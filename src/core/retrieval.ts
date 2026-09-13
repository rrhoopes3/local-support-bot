import type { Library, Passage } from "./types";

const STOP = new Set(
  "a an and are as at be by can do does for from how i if in is it me my of on or please that the this to today tomorrow yesterday walk what when where which with you your show through".split(
    " ",
  ),
);
const CHUNK_CHARS = 900;
const INDEX_TITLE =
  /\b(walkthroughs?|table of contents|article index|index of|how do i)\b/i;
const INDEX_SCORE_SCALE = 0.2;
const DISTINCTIVE_DF = 0.1;
const ARTICLE_COVERAGE = 0.35;
const SYNONYM_GROUPS = [["add", "create"]];

export function stem(token: string): string {
  let word = token;
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) word = word.slice(0, -3) + "y";
  else if (
    word.endsWith("sses") ||
    word.endsWith("xes") ||
    word.endsWith("zes") ||
    word.endsWith("ches") ||
    word.endsWith("shes")
  )
    word = word.slice(0, -2);
  else if (
    word.endsWith("s") &&
    !word.endsWith("ss") &&
    !word.endsWith("us") &&
    !word.endsWith("is")
  )
    word = word.slice(0, -1);
  if (word.endsWith("ing") && word.length > 5) {
    const next = word.slice(0, -3);
    if (next.length >= 3) word = next;
  } else if (word.endsWith("ed") && word.length > 4) {
    const next = word.slice(0, -2);
    if (next.length >= 3) word = next;
  }
  if (word.endsWith("e") && word.length > 3 && !word.endsWith("le"))
    word = word.slice(0, -1);
  if (word.endsWith("or") && word.length > 6) word = word.slice(0, -2);
  return word;
}

function synonymIndex(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    const stems = [...new Set(group.map(stem))];
    for (const item of stems)
      map.set(
        item,
        stems.filter((other) => other !== item),
      );
  }
  return map;
}

const SYNONYMS = synonymIndex();

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

function expandQuery(terms: string[]): string[] {
  const out = new Set<string>();
  for (const term of terms) {
    out.add(term);
    for (const syn of SYNONYMS.get(term) ?? []) out.add(syn);
  }
  return [...out];
}

/** Catalog / walkthrough-index pages steal BM25 from the actual procedure. */
export function looksLikeIndexArticle(title: string, text: string): boolean {
  if (INDEX_TITLE.test(title)) return true;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 8) return false;
  const headingLike = lines.filter(
    (line) =>
      line.length <= 70 &&
      !/[.?!]$/.test(line) &&
      /^[-*`#\d.]*\s*[\p{L}]/u.test(line),
  );
  return headingLike.length >= 8 && headingLike.length / lines.length >= 0.55;
}

function termIdf(df: number, n: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function isDistinctive(df: number, n: number): boolean {
  if (df <= 0) return false;
  if (df === 1) return true;
  if (df / n > DISTINCTIVE_DF) return false;
  return termIdf(df, n) >= termIdf(Math.max(1, DISTINCTIVE_DF * n), n);
}

function titleHeavy(query: string[], titleTerms: Set<string>): boolean {
  const hits = query.filter((term) => titleTerms.has(term)).length;
  return hits >= 2 || (hits > 0 && hits === query.length);
}

function indexScale(
  title: string,
  text: string,
  query: string[],
  titleTerms: Set<string>,
): number {
  if (!looksLikeIndexArticle(title, text)) return 1;
  return titleHeavy(query, titleTerms) ? 1 : INDEX_SCORE_SCALE;
}

function enoughOverlap(
  matches: number,
  queryLength: number,
  matched: string[],
  frequency: Map<string, number>,
  n: number,
): boolean {
  if (!matches) return false;
  if (matches >= 2 && matches / queryLength >= 0.25) return true;
  return matched.some((term) => isDistinctive(frequency.get(term) ?? 0, n));
}

function termScore(
  count: number,
  idf: number,
  docLen: number,
  averageLength: number,
  titleBoost: boolean,
): number {
  const normalized =
    (count * 2.2) /
    (count + 1.2 * (0.25 + (0.75 * docLen) / averageLength));
  return idf * normalized + (titleBoost ? 0.55 : 0);
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

type ScoredRow = {
  passage: Passage;
  tokens: string[];
  matched: string[];
  gated: boolean;
};

export function search(
  index: Passage[],
  question: string,
  limit = 3,
): Passage[] {
  const query = expandQuery([...new Set(tokenize(question))]);
  if (!query.length || !index.length) return [];
  const tokens = index.map((p) => tokenize(p.title + " " + p.text));
  const averageLength =
    tokens.reduce((sum, ts) => sum + ts.length, 0) / tokens.length || 1;
  const n = index.length;
  const frequency = new Map(
    query.map((term) => [
      term,
      tokens.filter((ts) => ts.includes(term)).length,
    ]),
  );
  const idfFor = (term: string) => termIdf(frequency.get(term)!, n);
  const scored: ScoredRow[] = index.map((passage, i) => {
    const ts = tokens[i]!;
    const titleTerms = new Set(tokenize(passage.title));
    let score = 0;
    const matched: string[] = [];
    for (const term of query) {
      const count = ts.filter((t) => t === term).length;
      if (!count) continue;
      matched.push(term);
      score += termScore(
        count,
        idfFor(term),
        ts.length,
        averageLength,
        titleTerms.has(term),
      );
    }
    return {
      passage: { ...passage, score },
      tokens: ts,
      matched,
      gated: false,
    };
  });
  const articleMatches = new Map<string, Set<string>>();
  for (const row of scored) {
    let seen = articleMatches.get(row.passage.articleId);
    if (!seen) {
      seen = new Set();
      articleMatches.set(row.passage.articleId, seen);
    }
    for (const term of row.matched) seen.add(term);
  }
  for (const row of scored) {
    const titleTerms = new Set(tokenize(row.passage.title));
    row.passage.score +=
      ARTICLE_COVERAGE * (articleMatches.get(row.passage.articleId)?.size ?? 0);
    row.passage.score *= indexScale(
      row.passage.title,
      row.passage.text,
      query,
      titleTerms,
    );
    row.gated = enoughOverlap(
      row.matched.length,
      query.length,
      row.matched,
      frequency,
      n,
    );
  }
  const hits = scored
    .filter((row) => row.gated && row.passage.score > 0)
    .map((row) => row.passage)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (hits.length) return hits.slice(0, Math.max(0, limit));
  return articleFallback(
    scored,
    query,
    frequency,
    n,
    averageLength,
    idfFor,
    limit,
  );
}

function articleFallback(
  scored: ScoredRow[],
  query: string[],
  frequency: Map<string, number>,
  n: number,
  averageLength: number,
  idfFor: (term: string) => number,
  limit: number,
): Passage[] {
  const byArticle = new Map<
    string,
    { title: string; texts: string[]; rows: ScoredRow[] }
  >();
  for (const row of scored) {
    const id = row.passage.articleId;
    let group = byArticle.get(id);
    if (!group) {
      group = { title: row.passage.title, texts: [], rows: [] };
      byArticle.set(id, group);
    }
    group.rows.push(row);
    group.texts.push(row.passage.text);
  }
  let bestId = "";
  let bestScore = 0;
  for (const [articleId, group] of byArticle) {
    const combined = group.rows.flatMap((row) => row.tokens);
    const titleTerms = new Set(tokenize(group.title));
    let score = 0;
    const matched: string[] = [];
    for (const term of query) {
      const count = combined.filter((t) => t === term).length;
      if (!count) continue;
      matched.push(term);
      score += termScore(
        count,
        idfFor(term),
        combined.length,
        averageLength,
        titleTerms.has(term),
      );
    }
    score += ARTICLE_COVERAGE * matched.length;
    score *= indexScale(
      group.title,
      group.texts.join("\n"),
      query,
      titleTerms,
    );
    if (
      !enoughOverlap(matched.length, query.length, matched, frequency, n) ||
      score <= 0
    )
      continue;
    if (score > bestScore || (score === bestScore && articleId < bestId)) {
      bestScore = score;
      bestId = articleId;
    }
  }
  if (!bestId) return [];
  return byArticle
    .get(bestId)!
    .rows.filter((row) => row.passage.score > 0)
    .map((row) => row.passage)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
