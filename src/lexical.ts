// Instant local emoji matching. Scores query words against each emoji's name
// and description so the grid updates on every keystroke, before the semantic
// Upstash Redis Vector results arrive.
import type { EmojiEntry } from "./emojis";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
]);

const WEIGHTS = {
  nameExact: 10,
  namePrefix: 6,
  descriptionExact: 3,
  descriptionPrefix: 1.5,
  namePhrase: 8,
  nameIsQuery: 20,
} as const;

interface IndexedEmoji {
  entry: EmojiEntry;
  order: number;
  nameLower: string;
  nameTokens: string[];
  descriptionTokens: string[];
}

// "celebrating" -> "celebrat", so it also prefix-matches "celebration".
function stem(token: string): string | null {
  const stemmed = token.replace(/(ing|ed|es|s)$/, "");
  return stemmed.length >= 5 ? stemmed : null;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// `prefix` is the token itself for the word being typed, or its stem.
function scoreToken(doc: IndexedEmoji, token: string, prefix: string | null): number {
  let best = 0;
  for (const word of doc.nameTokens) {
    if (word === token) return WEIGHTS.nameExact;
    if (prefix && word.startsWith(prefix)) best = Math.max(best, WEIGHTS.namePrefix);
  }
  // Words under 3 letters ("mi") match only an exact name word.
  if (token.length < 3) return best;
  for (const word of doc.descriptionTokens) {
    if (word === token) best = Math.max(best, WEIGHTS.descriptionExact);
    else if (prefix && word.startsWith(prefix)) best = Math.max(best, WEIGHTS.descriptionPrefix);
  }
  return best;
}

export interface LexicalIndex {
  /** Up to `topK` emojis ranked by word overlap with `query`; the last word also matches as a prefix. */
  search: (query: string, topK: number) => EmojiEntry[];
}

/** Precomputes tokens once; `search` then runs in about a millisecond for 1,870 emojis. */
export function createLexicalIndex(emojis: EmojiEntry[]): LexicalIndex {
  const docs: IndexedEmoji[] = emojis.map((entry, order) => ({
    entry,
    order,
    nameLower: entry.name.toLowerCase(),
    nameTokens: [...new Set(tokenize(entry.name))],
    descriptionTokens: [...new Set(tokenize(entry.description))],
  }));

  function rank(query: string): { doc: IndexedEmoji; score: number }[] {
    const raw = query.trim();
    if (!raw) return [];
    const tokens = tokenize(raw);
    const meaningful = tokens.filter((token) => !STOPWORDS.has(token));
    const queryTokens = meaningful.length > 0 ? meaningful : tokens;
    const lastToken = tokens[tokens.length - 1];
    const prefixes = queryTokens.map((token) => (token === lastToken && token.length >= 3 ? token : stem(token)));
    const phrase = raw.toLowerCase();

    const scored: { doc: IndexedEmoji; score: number }[] = [];
    for (const doc of docs) {
      if (doc.entry.emoji === raw) {
        scored.push({ doc, score: Infinity });
        continue;
      }
      let score = 0;
      let matched = 0;
      for (let i = 0; i < queryTokens.length; i++) {
        const tokenScore = scoreToken(doc, queryTokens[i], prefixes[i]);
        if (tokenScore > 0) matched++;
        score += tokenScore;
      }
      if (matched === 0) continue;
      if (phrase.length >= 3 && doc.nameLower.includes(phrase)) score += WEIGHTS.namePhrase;
      if (doc.nameLower === phrase) score += WEIGHTS.nameIsQuery;
      // Favour emojis that match every word of a multi-word query.
      score *= matched / queryTokens.length;
      scored.push({ doc, score });
    }

    scored.sort((a, b) => b.score - a.score || a.doc.order - b.doc.order);
    return scored;
  }

  function search(query: string, topK: number): EmojiEntry[] {
    return rank(query)
      .slice(0, topK)
      .map(({ doc }) => doc.entry);
  }

  return { search };
}
