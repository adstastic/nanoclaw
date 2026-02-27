# Readwise Reader Skill Design

**Date:** 2026-02-27
**Status:** Approved

## Goal

Give the personal agent (main group DM) access to the user's Readwise Reader library so it can triage, prioritise, and curate a reading backlog. Content is synced to the Obsidian vault via the official Readwise Obsidian plugin — the agent reads from the vault, no API needed.

## What the Agent Should Do

1. **Triage & prioritise** — scan unprocessed articles/books/podcasts/tweets, read metadata and highlights, build prioritised reading lists based on existing tags, favourites, highlight density, and recurring themes
2. **On-demand discussion** — when asked about a topic or specific item, search the Readwise vault and synthesise relevant highlights and notes
3. **Batch digest** — scheduled daily task that processes new items and updates reading lists, with a brief Signal message summary

## Architecture

### No code changes required

The entire integration is:
- 1 new skill file: `container/skills/readwise-reader/SKILL.md`
- 1 addition to `groups/main/CLAUDE.md`
- Agent-created state files in the vault on first run

### Vault Layout

The Readwise Obsidian plugin syncs to `/workspace/extra/obsidian/Readwise/readwise/` (mounted read-write for main group):

```
Readwise/readwise/
├── Articles/    (421+ web articles)
├── Books/       (book highlights)
├── Podcasts/    (podcast notes)
└── Tweets/      (saved tweets)
```

### File Format

Each synced item is a markdown file with:
- **Metadata block**: Author (`[[name]]`), Full Title, Category (`#articles`/`#books`/etc), Document Tags (`[[best]]`, `[[re-read]]`, topic tags), Summary, URL
- **Highlights section**: Individual highlights with optional `- Note:` annotations

### Skill File: `container/skills/readwise-reader/SKILL.md`

Teaches the agent:
1. Where Readwise content lives in the vault
2. How to parse the file format (metadata, tags, highlights)
3. Three curation workflows: triage, discuss, batch digest
4. How to track processing state
5. How to write curated output

### Processing State: `Readwise/curated/`

Agent-managed folder in the Obsidian vault:
- `processed.md` — list of filenames already triaged (one per line), agent appends as it processes
- `YYYY-MM-DD-reading-list.md` — dated reading lists with priority tiers and one-line summaries
- `themes.md` — agent-maintained file of detected interests/themes, evolves as more content is processed

### Scheduled Task

Set up via the agent's `schedule_task` IPC tool on first interaction:
- **Schedule**: Daily at 8am (`0 8 * * *`)
- **Context mode**: `group` (retains conversation history and preferences)
- **Prompt**: "Process new Readwise items and update reading list"
- **Batch size**: 20 items per run
- **Output**: Updates reading list in vault, sends brief Signal message summary

### Main Group CLAUDE.md

Add a section so the agent discovers the skill:

```markdown
## Readwise Reader
You have access to the user's Readwise Reader library synced to the Obsidian vault.
Use the readwise-reader skill to navigate, triage, and curate reading recommendations.
```

## Implementation Steps

1. Create `container/skills/readwise-reader/SKILL.md` with vault layout, file format guide, and curation workflow instructions
2. Add Readwise section to `groups/main/CLAUDE.md`
3. Test: ask the agent to triage a few articles and verify it creates the curated output correctly
4. Set up scheduled task via conversation with the agent
