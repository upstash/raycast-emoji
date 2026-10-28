// Seeds an Upstash Redis vector index with every emoji in data/.
//
//   VECTOR.CREATE text2emoji DIM 1536 METRIC COSINE EXISTSOK
//   VECTOR.ADD text2emoji <emoji> BASE64-FP32 <embedding>   (once per emoji)
//
// Needs UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (read-write) and
// OPENAI_API_KEY, e.g. in .env for `npm run seed`. Embeddings are cached in
// .cache/embeddings.json keyed by text, so re-seeding only embeds what changed.
import { Redis } from "@upstash/redis";
import { mkdir, readFile, writeFile } from "fs/promises";
import { embeddingText, loadEnrichment } from "./embedding-text.mjs";

const INDEX_NAME = "text2emoji";
const DIMENSION = 1536;
const EMBEDDING_MODEL = "text-embedding-3-small";
const CACHE_PATH = "./.cache/embeddings.json";
const EMBED_BATCH_SIZE = 200;
const ADD_CONCURRENCY = 32;

for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "OPENAI_API_KEY"]) {
    if (!process.env[name]) throw new Error(`${name} is not set.`);
}

/** Embeds strings with OpenAI. Returns base64 FP32 blobs, which VECTOR.ADD accepts as BASE64-FP32. */
async function embed(input) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input, encoding_format: "base64" }),
    });
    if (!response.ok) throw new Error(`OpenAI embeddings failed (${response.status}): ${await response.text()}`);
    const { data } = await response.json();
    return data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

async function loadCache() {
    try {
        const cache = JSON.parse(await readFile(CACHE_PATH, "utf-8"));
        return cache.model === EMBEDDING_MODEL ? cache.embeddings : {};
    } catch {
        return {};
    }
}

const enrichment = await loadEnrichment();
const entries = JSON.parse(await readFile("./data/emoji_data.json", "utf-8")).map((entry) => ({
    id: entry.id,
    text: embeddingText(entry, enrichment),
}));

const embeddings = await loadCache();
const missing = entries.filter((entry) => !embeddings[entry.text]);
if (missing.length > 0) {
    const start = performance.now();
    const batches = [];
    for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) batches.push(missing.slice(i, i + EMBED_BATCH_SIZE));
    await Promise.all(
        batches.map(async (batch) => {
            const vectors = await embed(batch.map((entry) => entry.text));
            batch.forEach((entry, i) => { embeddings[entry.text] = vectors[i]; });
        }),
    );
    console.log(`Embedded ${missing.length} emojis in ${batches.length} requests, ${((performance.now() - start) / 1000).toFixed(1)}s`);
    await mkdir("./.cache", { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ model: EMBEDDING_MODEL, embeddings }));
} else {
    console.log(`All ${entries.length} embeddings loaded from ${CACHE_PATH}`);
}

const redis = Redis.fromEnv();
const index = await redis.vector.createIndex({ name: INDEX_NAME, dimension: DIMENSION, metric: "COSINE", existsOk: true });

const start = performance.now();
let next = 0;
let added = 0;
async function worker() {
    while (next < entries.length) {
        const entry = entries[next++];
        const inserted = await index.add(entry.id, { base64: embeddings[entry.text] });
        added += inserted;
    }
}
await Promise.all(Array.from({ length: ADD_CONCURRENCY }, worker));
console.log(`VECTOR.ADD: ${entries.length} upserted (${added} new) in ${((performance.now() - start) / 1000).toFixed(1)}s`);
console.log(`Index ${INDEX_NAME}: ${await index.count()} vectors, ${JSON.stringify(await index.info())}`);
