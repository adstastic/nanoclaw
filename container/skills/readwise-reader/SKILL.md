---
name: readwise-reader
description: Navigate, triage, and curate reading recommendations from the Readwise Reader library synced to the Obsidian vault. Use when the user asks about their reading backlog, wants recommendations, or when running a scheduled reading digest.
---

# Readwise Reader

Your user's Readwise Reader library is synced to the Obsidian vault via the Readwise plugin.

## Where content lives

All synced content is at `/workspace/extra/obsidian/Readwise/readwise/`:

```
Readwise/readwise/
  Articles/    -- web articles (largest collection)
  Books/       -- book highlights
  Podcasts/    -- podcast notes
  Tweets/      -- saved tweets
```

Each item is a markdown file named after the title.

## File format

Every file follows this structure:

```
# Title

![rw-book-cover](image-url)

## Metadata
- Author: [[Author Name]]
- Full Title: Full Title Here
- Category: #articles
- Document Tags: [[tag1]] [[tag2]]
- Summary: Brief summary text
- URL: https://original-url.com

## Highlights
- Highlight text ([View Highlight](url))
    - Tags: [[favorite]]
    - Note: User's annotation
```

Key fields for prioritisation:
- **Document Tags**: `[[best]]`, `[[re-read]]`, `[[favorite]]` indicate high-value items
- **Highlight Tags**: `[[favorite]]` on individual highlights signals key passages
- **Note**: User annotations on highlights reveal what resonated
- **Summary**: Quick overview without reading the full article

## Curation workflows

### 1. Triage (when asked to process the backlog)

1. Read `/workspace/extra/obsidian/Readwise/curated/processed.md` to get the list of already-processed filenames. If the file doesn't exist, start fresh.
2. Glob all `*.md` files in each category folder (Articles, Books, Podcasts, Tweets).
3. Filter out already-processed filenames.
4. For each unprocessed item (batch of ~20 at a time):
   a. Read the file's metadata block (first ~15 lines) and highlights.
   b. Score based on: existing tags (best/re-read/favorite = high), highlight count and density, user notes present, thematic match to `/workspace/extra/obsidian/Readwise/curated/themes.md`.
5. Write results to `/workspace/extra/obsidian/Readwise/curated/YYYY-MM-DD-reading-list.md`:

```
# Reading List YYYY-MM-DD

## Must Read
- **Title** by Author -- one-line summary (Tags: best, re-read)

## Worth Reading
- **Title** by Author -- one-line summary (Tags: topic)

## Skim
- **Title** by Author -- one-line summary
```

6. Append processed filenames to `/workspace/extra/obsidian/Readwise/curated/processed.md` (one per line, include category prefix like `Articles/filename.md`).
7. Update `/workspace/extra/obsidian/Readwise/curated/themes.md` if new recurring themes emerge.

### 2. Discuss (when asked about a topic or specific item)

1. Use Grep to search across `/workspace/extra/obsidian/Readwise/readwise/` for the topic.
2. Read matching files in full (metadata + highlights + notes).
3. Synthesise: summarise key insights, quote relevant highlights, note connections between sources.

### 3. Batch digest (scheduled task)

Same as Triage, but:
- Process a fixed batch of 20 new items.
- Send a brief summary via `send_message`: "Processed X new items. Y recommended as must-read. Reading list updated."
- If nothing new to process, produce no output (silence = nothing to report).

## State files

All state is in `/workspace/extra/obsidian/Readwise/curated/`:

| File | Purpose |
|------|---------|
| `processed.md` | One filename per line (e.g. `Articles/Some Title.md`). Append-only log of triaged items. |
| `YYYY-MM-DD-reading-list.md` | Dated reading lists with priority tiers. |
| `themes.md` | Detected interests and recurring themes. Evolves as more content is processed. Start with initial themes from the first batch of tagged/favourited items. |

Create the `curated/` directory and these files on first run if they don't exist.
