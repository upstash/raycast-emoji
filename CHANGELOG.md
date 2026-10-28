# Emoji Finder Changelog

## [Initial Version] - {PR_MERGE_DATE}

- Semantic emoji search over 1,870 emojis with Upstash Redis Vector (`VECTOR.QUERY`) and OpenAI embeddings
- Instant word matches on every keystroke, replaced by semantic results 70ms after typing stops
- The best match stays selected; Enter pastes it, with copy actions as alternatives
- Direct Upstash Redis and OpenAI credentials, or an optional search proxy URL
- Seed script that creates and fills the vector index
