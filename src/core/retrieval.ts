import type { Library, Passage } from "./types";

const STOP = new Set(
  "a about an and are as at be by can do does for from help how i if in is it me my of on or please tell that the this to walk what when where which who why with you your show through".split(
    " ",
  ),
);
const CHUNK_CHARS = 900;
/** Catalog titles. "How do I…" and single-walkthrough titles are procedures. */
const INDEX_TITLE =
  /\b(walkthroughs|table of contents|article index|index of)\b/i;
const INDEX_SCORE_SCALE = 0.2;
const DISTINCTIVE_DF = 0.1;
const ARTICLE_COVERAGE = 0.35;
const SYNONYM_GROUPS = [
  ["add", "create"],
  ["size", "characters"],
  ["maximum", "limit"],
];

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
  else if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("is"))
    word = word.slice(0, -1);
  if (word.endsWith("ing") && word.length > 5) {
    const next = word.slice(0, -3);
    if (next.length >= 3) word = next;
  } else if (word.endsWith("ed") && word.length > 4) {
    const next = word.slice(0, -2);
    if (next.length >= 3) word = next;
  }
  if (word.endsWith("e") && word.length > 3) word = word.slice(0, -1);
  // menus/menu, statuses/status, and focused/focus all meet at "…u".
  if (word.endsWith("us") && word.length > 3) word = word.slice(0, -1);
  if (word.endsWith("or") && word.length > 6) word = word.slice(0, -2);
  return word;
}

/** How-to verbs that may stand in for a missing library word ("clear the cache"). */
const ACTIONS = new Set(
  "add create clear reset unload load refresh wipe flush purge empty process issue post delete remove update install download enable disable restore export import restart reboot cancel".split(
    " ",
  ).map(stem),
);

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
/** Date words rank passages ("today's arrivals") but do not decide whether a question is covered. */
const MODIFIERS = new Set(["today", "tomorrow", "yesterday"].map(stem));
/** Clock questions collapse to leftover library nouns after stopword stripping. */
const CLOCK_QUESTION = /\bwhat(?:['’]s| is) the time\b|\bwhat time is it\b/i;

function expandContractions(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bwon[’']t\b/g, "will not")
    .replace(/\bcan[’']t\b/g, "can not")
    .replace(/n[’']t\b/g, " not");
}

export function tokenize(text: string): string[] {
  return (expandContractions(text).match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** One entry per question word; synonyms widen what satisfies it without counting as extra matches. */
function queryConcepts(terms: string[]): string[][] {
  const seen = new Set<string>();
  const concepts: string[][] = [];
  for (const term of terms) {
    if (seen.has(term)) continue;
    const variants = [term, ...(SYNONYMS.get(term) ?? [])];
    for (const variant of variants) seen.add(variant);
    concepts.push(variants);
  }
  return concepts;
}

/** Catalog / walkthrough-index pages steal BM25 from the actual procedure. */
export function looksLikeIndexArticle(title: string, text: string): boolean {
  if (INDEX_TITLE.test(title)) return true;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 8) return false;
  // Numbered and "Step N" lines are procedure steps, not catalog entries.
  const headingLike = lines.filter(
    (line) =>
      line.length <= 70 &&
      !/[.?!]$/.test(line) &&
      /^[-*`#]*\s*\p{L}/u.test(line) &&
      !/^step\s*\d/i.test(line),
  );
  return headingLike.length >= 8 && headingLike.length / lines.length >= 0.55;
}

function termIdf(df: number, n: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function isDistinctive(df: number, n: number): boolean {
  return df === 1 || (df > 0 && df / n <= DISTINCTIVE_DF);
}

function isActionConcept(variants: string[]): boolean {
  return variants.some((term) => ACTIONS.has(term));
}

type ArticleInfo = { titleTerms: Set<string>; isIndex: boolean };

function articleInfo(index: Passage[]): Map<string, ArticleInfo> {
  const parts = new Map<string, { title: string; texts: string[] }>();
  for (const passage of index) {
    const article = parts.get(passage.articleId);
    if (article) article.texts.push(passage.text);
    else
      parts.set(passage.articleId, {
        title: passage.title,
        texts: [passage.text],
      });
  }
  const info = new Map<string, ArticleInfo>();
  for (const [id, { title, texts }] of parts)
    info.set(id, {
      titleTerms: new Set(tokenize(title)),
      isIndex: looksLikeIndexArticle(title, texts.join("\n")),
    });
  return info;
}

function indexScale(article: ArticleInfo, concepts: string[][]): number {
  if (!article.isIndex) return 1;
  const titleHits = concepts.filter((variants) =>
    variants.some((term) => article.titleTerms.has(term)),
  ).length;
  const titleHeavy =
    titleHits >= 2 || (titleHits > 0 && titleHits === concepts.length);
  return titleHeavy ? 1 : INDEX_SCORE_SCALE;
}

function enoughOverlap(
  matched: number[],
  concepts: string[][],
  conceptFrequency: number[],
  n: number,
  bodyTokens: string[],
): boolean {
  const all = concepts.map((_, position) => position);
  const gating = all.filter(
    (position) => !concepts[position]!.every((term) => MODIFIERS.has(term)),
  );
  // Date-only (or modifier-only) questions never open the gate.
  if (!gating.length) return false;
  const hits = matched.filter((position) => gating.includes(position));
  const q = gating.length;
  if (!hits.length) return false;
  if (hits.length >= Math.min(2, q) && hits.length / q >= 0.25) return true;
  // One distinctive body word can carry a two-word how-to paraphrase whose
  // other word is a support action that never appears ("clear the cache",
  // "process a refund"). Leftover nouns from another question type (time,
  // price, history) do not open the gate. Date words cannot form the pair,
  // and a title-only hit is not enough.
  const hit = hits[0]!;
  const missed = gating.find((position) => !hits.includes(position));
  return (
    q === 2 &&
    all.length === q &&
    hits.length === 1 &&
    missed !== undefined &&
    isDistinctive(conceptFrequency[hit]!, n) &&
    conceptFrequency[missed] === 0 &&
    isActionConcept(concepts[missed]!) &&
    concepts[hit]!.some((term) => bodyTokens.includes(term))
  );
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

/** Scores the best-matching variant of each concept; `matched` lists concept positions. */
function scoreConcepts(
  tokens: string[],
  concepts: string[][],
  idf: Map<string, number>,
  averageLength: number,
  titleTerms: Set<string>,
): { score: number; matched: number[] } {
  let score = 0;
  const matched: number[] = [];
  concepts.forEach((variants, position) => {
    let best = 0;
    for (const term of variants) {
      const count = tokens.filter((t) => t === term).length;
      if (count)
        best = Math.max(
          best,
          termScore(
            count,
            idf.get(term)!,
            tokens.length,
            averageLength,
            titleTerms.has(term),
          ),
        );
    }
    if (best > 0) {
      matched.push(position);
      score += best;
    }
  });
  return { score, matched };
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
  bodyTokens: string[];
  matched: number[];
};

export function search(
  index: Passage[],
  question: string,
  limit = 3,
): Passage[] {
  if (CLOCK_QUESTION.test(question)) return [];
  const concepts = queryConcepts([...new Set(tokenize(question))]);
  if (!concepts.length || !index.length) return [];
  const tokens = index.map((p) => tokenize(p.title + " " + p.text));
  const bodyTokens = index.map((p) => tokenize(p.text));
  const averageLength =
    tokens.reduce((sum, ts) => sum + ts.length, 0) / tokens.length || 1;
  const n = index.length;
  const idf = new Map(
    concepts
      .flat()
      .map((term) => [
        term,
        termIdf(tokens.filter((ts) => ts.includes(term)).length, n),
      ]),
  );
  const conceptFrequency = concepts.map(
    (variants) =>
      tokens.filter((ts) => variants.some((term) => ts.includes(term))).length,
  );
  const articles = articleInfo(index);
  const scored: ScoredRow[] = index.map((passage, i) => {
    const ts = tokens[i]!;
    const { score, matched } = scoreConcepts(
      ts,
      concepts,
      idf,
      averageLength,
      articles.get(passage.articleId)!.titleTerms,
    );
    return {
      passage: { ...passage, score },
      tokens: ts,
      bodyTokens: bodyTokens[i]!,
      matched,
    };
  });
  const articleMatches = new Map<string, Set<number>>();
  for (const row of scored) {
    let seen = articleMatches.get(row.passage.articleId);
    if (!seen) {
      seen = new Set();
      articleMatches.set(row.passage.articleId, seen);
    }
    for (const position of row.matched) seen.add(position);
  }
  const hits: Passage[] = [];
  for (const row of scored) {
    if (!row.matched.length) continue;
    row.passage.score +=
      ARTICLE_COVERAGE * articleMatches.get(row.passage.articleId)!.size;
    row.passage.score *= indexScale(
      articles.get(row.passage.articleId)!,
      concepts,
    );
    if (
      enoughOverlap(
        row.matched,
        concepts,
        conceptFrequency,
        n,
        row.bodyTokens,
      )
    )
      hits.push(row.passage);
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (hits.length) return hits.slice(0, Math.max(0, limit));
  return articleFallback(
    scored,
    concepts,
    conceptFrequency,
    n,
    averageLength,
    idf,
    articles,
    limit,
  );
}

function articleFallback(
  scored: ScoredRow[],
  concepts: string[][],
  conceptFrequency: number[],
  n: number,
  averageLength: number,
  idf: Map<string, number>,
  articles: Map<string, ArticleInfo>,
  limit: number,
): Passage[] {
  const byArticle = new Map<string, ScoredRow[]>();
  for (const row of scored) {
    const rows = byArticle.get(row.passage.articleId);
    if (rows) rows.push(row);
    else byArticle.set(row.passage.articleId, [row]);
  }
  let bestId = "";
  let bestScore = 0;
  for (const [articleId, rows] of byArticle) {
    const article = articles.get(articleId)!;
    const { score, matched } = scoreConcepts(
      rows.flatMap((row) => row.tokens),
      concepts,
      idf,
      averageLength,
      article.titleTerms,
    );
    if (
      !enoughOverlap(
        matched,
        concepts,
        conceptFrequency,
        n,
        rows.flatMap((row) => row.bodyTokens),
      )
    )
      continue;
    const total =
      (score + ARTICLE_COVERAGE * matched.length) *
      indexScale(article, concepts);
    if (total > bestScore || (total === bestScore && articleId < bestId)) {
      bestScore = total;
      bestId = articleId;
    }
  }
  if (!bestId) return [];
  return byArticle
    .get(bestId)!
    .filter((row) => row.matched.length > 0)
    .map((row) => row.passage)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}
