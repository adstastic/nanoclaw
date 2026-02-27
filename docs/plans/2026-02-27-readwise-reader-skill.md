# Readwise Reader Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the main group agent access to the user's Readwise Reader library (synced via Obsidian plugin) so it can triage, prioritise, and curate reading recommendations.

**Architecture:** Pure skill-based — one SKILL.md file teaches the agent how to navigate Readwise content already synced to the Obsidian vault at `/workspace/extra/obsidian/Readwise/readwise/`. A section added to the main group's CLAUDE.md ensures discovery. No code changes, no API keys, no new dependencies.

**Tech Stack:** Markdown skill files only. Agent uses existing Bash/Glob/Grep/Read/Write tools.

---

### Task 1: Create the readwise-reader skill

**Files:**
- Create: `container/skills/readwise-reader/SKILL.md`

**Step 1: Create the skill directory**

```bash
mkdir -p container/skills/readwise-reader
```

**Step 2: Write the skill file**

Create `container/skills/readwise-reader/SKILL.md` with the following content:

```markdown
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
```

**Step 3: Verify skill file is valid**

```bash
head -5 container/skills/readwise-reader/SKILL.md
```

Expected: frontmatter with `name: readwise-reader` and `description:` fields.

**Step 4: Commit**

```bash
git add container/skills/readwise-reader/SKILL.md
git commit -m "feat: add readwise-reader skill for reading backlog curation"
```

---

### Task 2: Create main group CLAUDE.md

The main group (DM) currently has no group-specific CLAUDE.md. The SDK auto-discovers `CLAUDE.md` in the working directory (`/workspace/group/` = `groups/main/` on host). This file provides main-group-only instructions.

**Files:**
- Create: `groups/main/CLAUDE.md`

**Step 1: Create the groups/main directory**

```bash
mkdir -p groups/main
```

**Step 2: Write the main group CLAUDE.md**

Create `groups/main/CLAUDE.md` with:

```markdown
# Main

This is the user's personal DM channel. You have access to tools and data not available to group agents.

## Obsidian Vault

The user's Obsidian vault is mounted at `/workspace/extra/obsidian/` (read-write). Use it for:
- Reading and writing notes
- Accessing synced content (Readwise, etc.)

## Readwise Reader

The user's Readwise Reader library is synced to the Obsidian vault at `/workspace/extra/obsidian/Readwise/readwise/`. Use the readwise-reader skill to:
- Triage and prioritise the reading backlog
- Discuss topics by searching across saved articles, books, podcasts, and tweets
- Run batch digests that produce curated reading lists

Curated output goes to `/workspace/extra/obsidian/Readwise/curated/`.
```

**Step 3: Verify the file is in place**

```bash
cat groups/main/CLAUDE.md
```

Expected: content as written above.

**Step 4: Commit**

```bash
git add groups/main/CLAUDE.md
git commit -m "feat: add main group CLAUDE.md with Readwise Reader instructions"
```

---

### Task 3: Rebuild agent container and deploy

The skill files are synced from `container/skills/` into the container's `.claude/skills/` at startup (handled by `container-runner.ts`). No container rebuild needed — the host copies skills before each container launch. But we do need to clear the main group's session so the agent rediscovers tools/skills.

**Files:**
- No files changed, operational steps only.

**Step 1: Clear the main group session to force fresh skill discovery**

```bash
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = 'main'"
```

**Step 2: Restart the service**

```bash
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw.agent
```

**Step 3: Verify skill is available**

Check logs after restart:

```bash
tail -f /tmp/nanoclaw.log
```

Expected: no errors on startup. When a message is sent to the DM, the agent should have the readwise-reader skill available.

**Step 4: Commit (nothing to commit — operational step)**

No commit needed for this task.

---

### Task 4: Test the integration

Manual testing via Signal DM conversation with the agent.

**Step 1: Test on-demand discussion**

Send to the agent in Signal DM:
> "What articles do I have about decision making?"

Expected: agent uses Grep to search the Readwise vault, finds matching articles, summarises highlights.

**Step 2: Test triage**

Send to the agent:
> "Triage 5 items from my reading backlog"

Expected: agent reads 5 unprocessed articles, creates `/workspace/extra/obsidian/Readwise/curated/` directory, writes a reading list and processed.md.

**Step 3: Verify output files**

```bash
ls ~/personal/Readwise/curated/
cat ~/personal/Readwise/curated/processed.md
```

Expected: `processed.md` exists with ~5 entries, a dated reading list file exists.

**Step 4: Test scheduled task setup**

Send to the agent:
> "Schedule a daily reading digest at 8am that processes 20 new items from my Readwise backlog"

Expected: agent uses `schedule_task` to create a cron task. Verify:

```bash
sqlite3 store/messages.db "SELECT * FROM tasks WHERE group_folder = 'main'"
```

Expected: a task row with cron schedule `0 8 * * *`.
