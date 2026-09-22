import type { Article, Library, Passage } from "./types";

const STOP = new Set(
  "a about an and are as at be by can do does for from help how i if in is it me my of on or please tell that the this to walk what when where which who why with you your show through".split(
    " ",
  ),
);
const CHUNK_CHARS = 900;
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
  else if (/((ss|x|z|ch|sh)es)$/.test(word)) word = word.slice(0, -2);
  else if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("is"))
    word = word.slice(0, -1);
  let inflected = false;
  if (word.endsWith("ing") && word.length > 5) {
    word = word.slice(0, -3);
    inflected = true;
  } else if (word.endsWith("ed") && word.length > 4) {
    word = word.slice(0, -2);
    inflected = true;
  }
  // reset/resetting, stop/stopped and run/running. Keep add/added and install/installing.
  if (inflected && word.length > 3 && /([bdgmnprt])\1$/.test(word))
    word = word.slice(0, -1);
  if (word.endsWith("e") && word.length > 3) word = word.slice(0, -1);
  if (word.endsWith("us") && word.length > 3) word = word.slice(0, -1);
  if (word.endsWith("or") && word.length > 6) word = word.slice(0, -2);
  return word;
}

const ACTIONS = new Set(
  "add create clear reset unload load refresh wipe flush purge empty process issue post delete remove update install download enable disable restore export import restart reboot cancel"
    .split(" ")
    .map(stem),
);
const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  const stems = [...new Set(group.map(stem))];
  for (const term of stems)
    SYNONYMS.set(
      term,
      stems.filter((other) => other !== term),
    );
}
const MODIFIERS = new Set(["today", "tomorrow", "yesterday"].map(stem));
// Keep topical questions such as "what is the time limit for check-in" searchable.
const CLOCK_QUESTION =
  /\bwhat(?:['’]s| is) the time(?=\s*(?:[?!.]|$|(?:in|on|at)\b))|\bwhat time is it\b/i;

export function tokenize(text: string): string[] {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bwon[’']t\b/g, "will not")
    .replace(/\bcan[’']t\b/g, "can not")
    .replace(/n[’']t\b/g, " not")
    // These directions carry meaning that stopword removal would otherwise erase.
    .replace(/\bcheck(?:ed|ing)?[\s\-‐‑–]+(in|out)(s)?\b/g, "check$1$2")
    .replace(
      /\bcheck(?:ed|ing)?\s+((?:(?:a|an|the|this|that|my|your|our)\s+)?(?:guests?|reservations?|customers?|visitors?|them|him|her|me|us))\s+(in|out)\b/g,
      "check$2 $1",
    );
  return (normalized.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [])
    .filter((t) => (t.length > 1 || /^\p{N}$/u.test(t)) && !STOP.has(t))
    .map(stem);
}

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

export function looksLikeIndexArticle(title: string, text: string): boolean {
  if (INDEX_TITLE.test(title)) return true;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 8) return false;
  // Bulleted UI instructions are procedures too, including Markdown checklists.
  const steps = lines.filter((line) =>
    /^(?:[-*+]\s+(?:\[[ xX]\]\s*)?)?(?:open|select|choose|click|tap|enter|pick|press|confirm|save)\b/i.test(
      line,
    ),
  );
  if (steps.length >= 3 && steps.length / lines.length >= 0.4) return false;
  const headings = lines.filter(
    (line) =>
      line.length <= 70 &&
      !/[.?!]$/.test(line) &&
      /^[-*`#]*\s*\p{L}/u.test(line) &&
      !/^step\s*\d/i.test(line),
  );
  return headings.length >= 8 && headings.length / lines.length >= 0.55;
}

type Counts = Map<string, number>;
type IndexedRow = {
  passage: Passage;
  title: string;
  text: string;
  articleId: string;
  counts: Counts;
  length: number;
  bodyTerms: Set<string>;
};
type ArticleInfo = {
  titleTerms: Set<string>;
  isIndex: boolean;
  counts: Counts;
  length: number;
  bodyTerms: Set<string>;
};
type PreparedIndex = {
  rows: IndexedRow[];
  articles: Map<string, ArticleInfo>;
  postings: Map<string, number[]>;
  averageLength: number;
};
const preparedIndexes = new WeakMap<Passage[], PreparedIndex>();
const libraryIndexes = new WeakMap<
  Library,
  { documents: Article[]; index: Passage[] }
>();

function addCounts(counts: Counts, terms: Iterable<string>): void {
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
}

/** Cached tokens and postings are validated against source fields, including in-place edits. */
function prepareIndex(index: Passage[]): PreparedIndex {
  const cached = preparedIndexes.get(index);
  if (
    cached &&
    cached.rows.length === index.length &&
    cached.rows.every((row, i) => {
      const p = index[i]!;
      return (
        row.passage === p &&
        row.title === p.title &&
        row.text === p.text &&
        row.articleId === p.articleId
      );
    })
  )
    return cached;
  const articles = new Map<string, ArticleInfo>();
  const articleTexts = new Map<string, string[]>();
  const titleTokens = new Map<string, string[]>();
  const postings = new Map<string, number[]>();
  let totalLength = 0;
  const rows = index.map((passage, position) => {
    let title = titleTokens.get(passage.title);
    if (!title) {
      title = tokenize(passage.title);
      titleTokens.set(passage.title, title);
    }
    const body = tokenize(passage.text);
    const counts: Counts = new Map();
    addCounts(counts, title);
    addCounts(counts, body);
    const length = title.length + body.length;
    totalLength += length;
    for (const term of counts.keys()) {
      const positions = postings.get(term);
      if (positions) positions.push(position);
      else postings.set(term, [position]);
    }
    let article = articles.get(passage.articleId);
    if (!article) {
      article = {
        titleTerms: new Set(title),
        isIndex: false,
        counts: new Map(),
        length: 0,
        bodyTerms: new Set(),
      };
      articles.set(passage.articleId, article);
      articleTexts.set(passage.articleId, []);
    }
    articleTexts.get(passage.articleId)!.push(passage.text);
    article.length += length;
    for (const [term, count] of counts)
      article.counts.set(term, (article.counts.get(term) ?? 0) + count);
    for (const term of body) article.bodyTerms.add(term);
    return {
      passage,
      title: passage.title,
      text: passage.text,
      articleId: passage.articleId,
      counts,
      length,
      bodyTerms: new Set(body),
    };
  });
  for (const row of rows) {
    const texts = articleTexts.get(row.articleId);
    if (texts) {
      articles.get(row.articleId)!.isIndex = looksLikeIndexArticle(
        row.title,
        texts.join("\n"),
      );
      articleTexts.delete(row.articleId);
    }
  }
  const prepared = {
    rows,
    articles,
    postings,
    averageLength: totalLength / rows.length || 1,
  };
  preparedIndexes.set(index, prepared);
  return prepared;
}

function indexScale(article: ArticleInfo, concepts: string[][]): number {
  if (!article.isIndex) return 1;
  const hits = concepts.filter((variants) =>
    variants.some((term) => article.titleTerms.has(term)),
  ).length;
  return hits >= 2 || (hits > 0 && hits === concepts.length)
    ? 1
    : INDEX_SCORE_SCALE;
}

type Query = {
  concepts: string[][];
  frequencies: number[];
  gating: Set<number>;
  n: number;
};
function enoughOverlap(
  matched: number[],
  query: Query,
  bodyTerms: Set<string>,
): boolean {
  const { concepts, frequencies, gating, n } = query;
  const hits = matched.filter((position) => gating.has(position));
  const q = gating.size;
  if (!q || !hits.length) return false;
  if (hits.length >= Math.min(2, q) && hits.length / q >= 0.25) return true;
  const hit = hits[0]!;
  const missed = [...gating].find((position) => position !== hit);
  const df = frequencies[hit]!;
  return (
    q === 2 &&
    concepts.length === q &&
    hits.length === 1 &&
    missed !== undefined &&
    (df === 1 || (df > 0 && df / n <= DISTINCTIVE_DF)) &&
    frequencies[missed] === 0 &&
    concepts[missed]!.some((term) => ACTIONS.has(term)) &&
    concepts[hit]!.some((term) => bodyTerms.has(term))
  );
}

function scoreConcepts(
  counts: Counts,
  length: number,
  concepts: string[][],
  idf: Map<string, number>,
  averageLength: number,
  titleTerms: Set<string>,
): { score: number; matched: number[] } {
  let score = 0;
  const matched: number[] = [];
  const normalization = 1.2 * (0.25 + (0.75 * length) / averageLength);
  concepts.forEach((variants, position) => {
    let best = 0;
    for (const term of variants) {
      const count = counts.get(term) ?? 0;
      if (count)
        best = Math.max(
          best,
          (idf.get(term)! * count * 2.2) / (count + normalization) +
            (titleTerms.has(term) ? 0.55 : 0),
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
    const body = doc.text.replace(/\r\n?/g, "\n");
    let start = 0;
    while (start < body.length) {
      let end = Math.min(start + CHUNK_CHARS, body.length);
      if (end < body.length) {
        const newline = body.lastIndexOf("\n", end);
        if (newline > start + CHUNK_CHARS / 2) end = newline;
        else {
          let boundary = end;
          while (
            boundary > start + CHUNK_CHARS / 2 &&
            !/\s/u.test(body[boundary]!)
          )
            boundary--;
          if (boundary > start + CHUNK_CHARS / 2) end = boundary;
        }
        // Do not split UTF-16 pairs when an unbroken token must be cut.
        if (/[\uD800-\uDBFF]/.test(body[end - 1]!)) end--;
      }
      const text = body.slice(start, end).trim();
      if (text)
        chunks.push({
          id: doc.id + "#" + (chunks.length + 1),
          articleId: doc.id,
          title: doc.title,
          text,
          locator: "passage " + (chunks.length + 1),
          sourceUrl: doc.sourceUrl,
          score: 0,
        });
      if (end === body.length) break;
      start = Math.max(start + 1, end - 100);
      // Keep the overlap, but begin on a complete word rather than indexing a suffix.
      while (
        start < end &&
        !/\s/u.test(body[start - 1]!) &&
        !/\s/u.test(body[start]!)
      )
        start++;
    }
    return chunks;
  });
}

/** Reuse the compiled library between questions; imports and in-place edits invalidate it. */
export function searchLibrary(
  library: Library,
  question: string,
  limit = 3,
): Passage[] {
  let cached = libraryIndexes.get(library);
  if (
    !cached ||
    cached.documents.length !== library.documents.length ||
    !cached.documents.every((doc, i) => {
      const current = library.documents[i]!;
      return (
        doc.id === current.id &&
        doc.title === current.title &&
        doc.text === current.text &&
        doc.sourceUrl === current.sourceUrl
      );
    })
  ) {
    cached = {
      documents: library.documents.map((doc) => ({ ...doc })),
      index: buildIndex(library),
    };
    libraryIndexes.set(library, cached);
  }
  return search(cached.index, question, limit);
}

type ScoredRow = {
  passage: Passage;
  matched: number[];
  bodyMatched: number[];
  bodyTerms: Set<string>;
};
const compareRows = (a: ScoredRow, b: ScoredRow): number =>
  b.passage.score - a.passage.score || a.passage.id.localeCompare(b.passage.id);

/** Fill the source budget with complementary query evidence, including adjacent article chunks. */
function selectEvidence(
  rows: ScoredRow[],
  limit: number,
  gating: Set<number>,
  companions: Map<string, ScoredRow[]>,
): Passage[] {
  const remaining = [...rows].sort(compareRows);
  const queued = new Set(rows);
  const chosen: Passage[] = [];
  const covered = new Set<number>();
  const bodyCovered = new Set<number>();
  const texts = new Map<string, Set<string>>();
  while (remaining.length && chosen.length < limit) {
    let best = 0;
    if (chosen.length) {
      let bestGain = -1;
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i]!;
        const gain =
          candidate.matched.filter(
            (position) => gating.has(position) && !covered.has(position),
          ).length *
            (gating.size + 1) +
          candidate.bodyMatched.filter(
            (position) => gating.has(position) && !bodyCovered.has(position),
          ).length;
        if (
          gain > bestGain ||
          (gain === bestGain && compareRows(candidate, remaining[best]!) < 0)
        ) {
          best = i;
          bestGain = gain;
        }
      }
    }
    const row = remaining.splice(best, 1)[0]!;
    const text = row.passage.text.replace(/\s+/g, " ").trim();
    let seen = texts.get(row.passage.articleId);
    if (!seen) {
      seen = new Set();
      texts.set(row.passage.articleId, seen);
    }
    if (seen.has(text)) continue;
    seen.add(text);
    chosen.push(row.passage);
    for (const position of row.matched) covered.add(position);
    for (const position of row.bodyMatched) bodyCovered.add(position);
    // A passage matching two words may need another passage from its article to
    // supply the third. That companion need not pass the gate in isolation.
    for (const companion of companions.get(row.passage.articleId) ?? []) {
      if (
        !queued.has(companion) &&
        companion.bodyMatched.some(
          (position) => gating.has(position) && !bodyCovered.has(position),
        )
      ) {
        queued.add(companion);
        remaining.push(companion);
      }
    }
  }
  return chosen;
}
export function search(
  index: Passage[],
  question: string,
  limit = 3,
): Passage[] {
  if (!(limit > 0) || CLOCK_QUESTION.test(question)) return [];
  limit = Math.floor(limit);
  if (!limit) return [];
  const concepts = queryConcepts(tokenize(question));
  const gating = new Set(
    concepts.flatMap((variants, i) =>
      variants.every((term) => MODIFIERS.has(term)) ? [] : [i],
    ),
  );
  if (!gating.size || !index.length) return [];
  const prepared = prepareIndex(index);
  const { rows, articles, postings, averageLength } = prepared;
  const n = rows.length;
  const candidates = new Set<number>();
  const idf = new Map<string, number>();
  const frequencies = concepts.map((variants) => {
    // Rarity is measured by article so adding chunks cannot hide a unique topic.
    const union = new Set<string>();
    for (const term of variants) {
      const positions = postings.get(term) ?? [];
      idf.set(
        term,
        Math.log(1 + (n - positions.length + 0.5) / (positions.length + 0.5)),
      );
      for (const position of positions) {
        union.add(rows[position]!.articleId);
        candidates.add(position);
      }
    }
    return union.size;
  });
  if (!candidates.size) return [];
  const query = { concepts, frequencies, gating, n: articles.size };
  const byArticle = new Map<string, ScoredRow[]>();
  const articleMatches = new Map<string, Set<number>>();
  for (const i of candidates) {
    const row = rows[i]!;
    const article = articles.get(row.articleId)!;
    const { score, matched } = scoreConcepts(
      row.counts,
      row.length,
      concepts,
      idf,
      averageLength,
      article.titleTerms,
    );
    const bodyMatched = matched.filter((position) =>
      concepts[position]!.some((term) => row.bodyTerms.has(term)),
    );
    const scored = {
      passage: { ...row.passage, score },
      matched,
      bodyMatched,
      bodyTerms: row.bodyTerms,
    };
    const grouped = byArticle.get(row.articleId);
    if (grouped) grouped.push(scored);
    else {
      byArticle.set(row.articleId, [scored]);
      articleMatches.set(row.articleId, new Set());
    }
    for (const position of matched)
      articleMatches.get(row.articleId)!.add(position);
  }
  const hits: ScoredRow[] = [];
  let bestFallback:
    | { rows: ScoredRow[]; coverage: number; score: number; id: string }
    | undefined;
  let directCoverage = 0;
  for (const [articleId, grouped] of byArticle) {
    const article = articles.get(articleId)!;
    const matched = [...articleMatches.get(articleId)!];
    const scale = indexScale(article, concepts);
    const coverage =
      matched.filter((position) => gating.has(position)).length * scale;
    const hasBodyMatch = grouped.some((row) => row.bodyMatched.length > 0);
    let hasDirectHit = false;
    for (const row of grouped) {
      row.passage.score =
        (row.passage.score + ARTICLE_COVERAGE * matched.length) * scale;
      // Repeated titles must not make a short filler chunk beat the actual instructions.
      if (!row.bodyMatched.length && hasBodyMatch)
        row.passage.score *= INDEX_SCORE_SCALE;
      if (enoughOverlap(row.matched, query, row.bodyTerms)) {
        hits.push(row);
        hasDirectHit = true;
      }
    }
    if (hasDirectHit) {
      directCoverage = Math.max(directCoverage, coverage);
      continue;
    }
    if (!enoughOverlap(matched, query, article.bodyTerms)) continue;
    const scored = scoreConcepts(
      article.counts,
      article.length,
      concepts,
      idf,
      averageLength,
      article.titleTerms,
    );
    const score = (scored.score + ARTICLE_COVERAGE * matched.length) * scale;
    if (
      !bestFallback ||
      coverage > bestFallback.coverage ||
      (coverage === bestFallback.coverage &&
        (score > bestFallback.score ||
          (score === bestFallback.score && articleId < bestFallback.id)))
    )
      bestFallback = { rows: grouped, coverage, score, id: articleId };
  }
  // A partial match elsewhere must not suppress a more complete multi-passage answer.
  if (
    bestFallback &&
    (!hits.length || bestFallback.coverage > directCoverage)
  ) {
    const selected = selectEvidence(
      bestFallback.rows,
      limit,
      gating,
      byArticle,
    );
    return selected.concat(
      selectEvidence(hits, limit - selected.length, gating, byArticle),
    );
  }
  return selectEvidence(hits, limit, gating, byArticle);
}
