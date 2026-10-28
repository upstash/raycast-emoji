import { Action, ActionPanel, Grid, Keyboard, getPreferenceValues, openExtensionPreferences } from "@raycast/api";
import { showFailureToast, usePromise } from "@raycast/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { EMOJIS, POPULAR } from "./emojis";
import { createLexicalIndex } from "./lexical";
import { configFromPreferences, searchEmojis, type EmojiMatch, type Preferences } from "./search";

// Local word matches render on every keystroke; the semantic Upstash Redis
// Vector search starts 70ms after the last one and replaces them.
const SEMANTIC_DEBOUNCE_MS = 70;
const lexicalIndex = createLexicalIndex(EMOJIS);
const RESULT_COUNTS = ["12", "24", "48"] as const;
type ResultCount = (typeof RESULT_COUNTS)[number];

function isResultCount(value: string): value is ResultCount {
  return RESULT_COUNTS.some((count) => count === value);
}

const emojiByChar = new Map(EMOJIS.map((entry) => [entry.emoji, entry]));
const POPULAR_MATCHES: EmojiMatch[] = POPULAR.flatMap((emoji) => {
  const entry = emojiByChar.get(emoji);
  return entry ? [{ ...entry, score: null }] : [];
});

function useDebounced(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function formatScore(score: number) {
  return `${Math.round(score * 100)}% match`;
}

// Enter pastes the selected emoji into the app behind Raycast.
function EmojiActions({ match, configured }: { match: EmojiMatch; configured: boolean }) {
  return (
    <ActionPanel>
      <Action.Paste title="Paste Emoji" content={match.emoji} />
      <Action.CopyToClipboard title="Copy Emoji" content={match.emoji} />
      <Action.CopyToClipboard
        title="Copy Emoji Name & Description"
        content={`${match.emoji} ${match.name}: ${match.description}`}
        shortcut={Keyboard.Shortcut.Common.Copy}
      />
      {!configured && <Action title="Open Extension Preferences" onAction={openExtensionPreferences} />}
    </ActionPanel>
  );
}

export default function Command() {
  const config = useMemo(() => configFromPreferences(getPreferenceValues<Preferences>()), []);
  const [searchText, setSearchText] = useState("");
  const [resultCount, setResultCount] = useState<ResultCount>("24");
  const term = searchText.trim();
  const query = useDebounced(term, SEMANTIC_DEBOUNCE_MS);
  const topK = Number(resultCount);
  const instantMatches = useMemo<EmojiMatch[]>(
    () => lexicalIndex.search(term, topK).map((entry) => ({ ...entry, score: null })),
    [term, topK],
  );
  const abortable = useRef<AbortController>(null);
  const { data, isLoading, error } = usePromise(
    async (q: string, topK: number) =>
      config ? searchEmojis({ config, query: q, topK, signal: abortable.current?.signal }) : null,
    [query, topK],
    {
      abortable,
      execute: config !== null && query.length > 0,
      onError: (err) => {
        showFailureToast(err, { title: "Emoji search failed" });
      },
    },
  );

  // Semantic results count only when they answer what is typed right now.
  const semantic = data && data.query === term ? data : null;

  // Never blank the grid: with no local match yet, keep what is shown.
  const shown = useRef<EmojiMatch[]>(POPULAR_MATCHES);
  let matches: EmojiMatch[];
  if (!term) matches = POPULAR_MATCHES;
  else if (semantic) matches = semantic.matches;
  else if (instantMatches.length > 0) matches = instantMatches;
  else matches = shown.current;
  shown.current = matches;

  // Keep the best match (top left) selected whenever the results change, so
  // Enter always pastes #1. Arrow keys can still move the selection.
  const resultsKey = matches.map((match) => match.emoji).join(" ");
  const [selectedId, setSelectedId] = useState<string | undefined>(matches[0]?.emoji);
  useEffect(() => {
    setSelectedId(matches[0]?.emoji);
  }, [resultsKey]);

  let sectionTitle = "Popular";
  let sectionSubtitle = "Describe a feeling, a situation, or a thing";
  if (term && semantic) {
    sectionTitle = "Results";
    const latency = semantic.redisLatencyMs === null ? "" : ` in ${Math.round(semantic.redisLatencyMs)}ms`;
    sectionSubtitle = `${semantic.matches.length} matches${latency} via Upstash Redis Vector`;
  } else if (term && !config) {
    sectionTitle = "Word Matches";
    sectionSubtitle = "Add Upstash Redis and OpenAI keys in preferences for semantic search";
  } else if (term && error) {
    sectionTitle = "Instant Matches";
    sectionSubtitle = "Semantic search failed, showing word matches";
  } else if (term) {
    sectionTitle = "Instant Matches";
    sectionSubtitle = `${instantMatches.length} word matches, searching Upstash Redis Vector…`;
  }

  return (
    <Grid
      columns={6}
      inset={Grid.Inset.Small}
      filtering={false}
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      selectedItemId={selectedId}
      onSelectionChange={(id) => {
        if (id) setSelectedId(id);
      }}
      searchBarPlaceholder="Describe an emoji (e.g. 'deploying on friday', 'mind blown', 'coffee break')..."
      searchBarAccessory={
        <Grid.Dropdown
          tooltip="Number of results"
          storeValue
          value={resultCount}
          onChange={(value) => {
            if (isResultCount(value)) setResultCount(value);
          }}
        >
          {RESULT_COUNTS.map((count) => (
            <Grid.Dropdown.Item key={count} title={`${count} results`} value={count} />
          ))}
        </Grid.Dropdown>
      }
    >
      <Grid.Section title={sectionTitle} subtitle={sectionSubtitle}>
        {matches.map((match) => (
          <Grid.Item
            key={match.emoji}
            id={match.emoji}
            content={{ value: match.emoji, tooltip: match.description }}
            title={match.name}
            subtitle={match.score === null ? undefined : formatScore(match.score)}
            keywords={[match.name]}
            actions={<EmojiActions match={match} configured={config !== null} />}
          />
        ))}
      </Grid.Section>
    </Grid>
  );
}
