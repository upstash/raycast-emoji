// Builds the text each emoji is embedded with, and the description clients
// show. Shared by scripts/seed.mjs and scripts/build-emojis.mjs.
//
// - Usage phrases from data/emoji_enrichment.json say how people use an
//   emoji ("launch day" for 🚀), which its visual description misses.
// - Clock faces get strictly literal text. Their generated descriptions
//   ("midnight", "late night") pulled them into unrelated queries.
import { readFile } from "fs/promises";

const HOURS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** "six-thirty" -> "6:30", "twelve o’clock" -> "12:00", anything else -> null. */
export function clockTime(name) {
    const match = /^(\w+)(?: o’clock|-thirty)$/.exec(name);
    if (!match || !(match[1] in HOURS)) return null;
    return `${HOURS[match[1]]}:${name.endsWith("thirty") ? "30" : "00"}`;
}

export async function loadEnrichment() {
    return JSON.parse(await readFile("./data/emoji_enrichment.json", "utf-8"));
}

/** Description clients display and match words against. */
export function describe(entry, enrichment) {
    const { emoji, originalDescription: name, llmDescription } = entry.metadata;
    const time = clockTime(name);
    if (time) return `Analog clock face showing ${time}.`;
    const base = llmDescription.replace(/\s*\u2014\s*/g, ", ");
    const phrases = enrichment[emoji];
    return phrases ? `${base} Often used for: ${phrases.join(", ")}.` : base;
}

/** Text sent to the embedding model for an emoji. */
export function embeddingText(entry, enrichment) {
    const name = entry.metadata.originalDescription;
    return `${name}. ${describe(entry, enrichment)}`;
}
