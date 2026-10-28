import { Redis } from "@upstash/redis";
import { z } from "zod";
import { EMOJIS, type EmojiEntry } from "./emojis";

export const INDEX_NAME = "text2emoji";
const EMBEDDING_MODEL = "text-embedding-3-small";

export type EmojiMatch = EmojiEntry & { score: number | null };

export type SearchConfig =
  { kind: "direct"; redisUrl: string; redisToken: string; openaiApiKey: string } | { kind: "proxy"; proxyUrl: string };

export interface SearchResponse {
  /** The query these matches answer, trimmed. */
  query: string;
  matches: EmojiMatch[];
  /** Time spent in VECTOR.QUERY, measured where the query ran. */
  redisLatencyMs: number | null;
}

export interface Preferences {
  upstashRedisRestUrl?: string;
  upstashRedisRestToken?: string;
  openaiApiKey?: string;
  proxyUrl?: string;
}

/**
 * Direct Redis access when all three credentials are set, else the proxy when
 * its URL is set, else null: the command then shows instant word matches only.
 */
export function configFromPreferences(preferences: Preferences): SearchConfig | null {
  const redisUrl = preferences.upstashRedisRestUrl?.trim();
  const redisToken = preferences.upstashRedisRestToken?.trim();
  const openaiApiKey = preferences.openaiApiKey?.trim();
  if (redisUrl && redisToken && openaiApiKey) {
    return { kind: "direct", redisUrl, redisToken, openaiApiKey };
  }
  const proxyUrl = preferences.proxyUrl?.trim();
  return proxyUrl ? { kind: "proxy", proxyUrl: proxyUrl.replace(/\/+$/, "") } : null;
}

const emojiByChar = new Map(EMOJIS.map((entry) => [entry.emoji, entry]));

function toMatch(emoji: string, score: number | null): EmojiMatch {
  const entry = emojiByChar.get(emoji);
  return entry ? { ...entry, score } : { emoji, name: emoji, description: "", group: emoji, clock: false, score };
}

const MENTIONS_TIME = /\b(clock|o'?clock|time|hours?|minutes?|noon|midnight|thirty)\b|\d/i;

// Keeps the best of each group of gendered variants, and at most one clock face
// unless the query is about time. Hits arrive best first.
function refineHits(hits: { id: string; score: number }[], query: string, topK: number): EmojiMatch[] {
  const maxClocks = MENTIONS_TIME.test(query) ? Infinity : 1;
  const seenGroups = new Set<string>();
  let clocks = 0;
  const matches: EmojiMatch[] = [];
  for (const hit of hits) {
    const entry = emojiByChar.get(hit.id);
    if (entry) {
      if (seenGroups.has(entry.group)) continue;
      if (entry.clock && clocks >= maxClocks) continue;
      seenGroups.add(entry.group);
      if (entry.clock) clocks++;
    }
    matches.push(toMatch(hit.id, hit.score));
    if (matches.length === topK) break;
  }
  return matches;
}

const openAiEmbeddingSchema = z.object({
  data: z.array(z.object({ embedding: z.string() })).min(1),
});

async function embed({ text, apiKey, signal }: { text: string; apiKey: string; signal?: AbortSignal }) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, encoding_format: "base64" }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenAI returned ${response.status}. Check the OpenAI API Key preference.`);
  }
  return openAiEmbeddingSchema.parse(await response.json()).data[0].embedding;
}

const clients = new Map<string, Redis>();

function redisFor({ redisUrl, redisToken }: { redisUrl: string; redisToken: string }) {
  const key = `${redisUrl}\n${redisToken}`;
  let client = clients.get(key);
  if (!client) {
    client = new Redis({ url: redisUrl, token: redisToken });
    clients.set(key, client);
  }
  return client;
}

const proxyResponseSchema = z.object({
  emojis: z.array(z.string()),
  results: z.array(z.object({ emoji: z.string(), score: z.number() })).optional(),
  latencyMs: z.number().optional(),
});

export async function searchEmojis({
  config,
  query,
  topK,
  signal,
}: {
  config: SearchConfig;
  query: string;
  topK: number;
  signal?: AbortSignal;
}): Promise<SearchResponse> {
  // Every call embeds the query and runs VECTOR.QUERY live; nothing is cached.
  switch (config.kind) {
    case "direct": {
      const vector = await embed({ text: query, apiKey: config.openaiApiKey, signal });
      const index = redisFor(config).vector.index(INDEX_NAME);
      const start = performance.now();
      const hits = await index.query({ vector: { base64: vector }, topK: Math.min(topK * 4, 100) });
      const redisLatencyMs = performance.now() - start;
      return { query, matches: refineHits(hits, query, topK), redisLatencyMs };
    }
    case "proxy": {
      const params = new URLSearchParams({ q: query, topK: String(topK) });
      const response = await fetch(`${config.proxyUrl}/api/search-emojis?${params}`, { signal });
      if (!response.ok) {
        throw new Error(`Search proxy returned ${response.status}.`);
      }
      const body = proxyResponseSchema.parse(await response.json());
      // A proxy may return only `emojis`, without scores.
      const matches = body.results
        ? body.results.map((result) => toMatch(result.emoji, result.score))
        : body.emojis.map((emoji) => toMatch(emoji, null));
      return { query, matches, redisLatencyMs: body.latencyMs ?? null };
    }
    default: {
      const _exhaustive: never = config;
      return _exhaustive;
    }
  }
}
