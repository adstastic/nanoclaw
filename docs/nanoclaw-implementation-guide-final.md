# NanoClaw Skills System: Implementation Guide

## 1. How Users Maintain Their Local Codebase

### The Reality

Most users clone the repo, apply skills, and keep everything local. They don't fork, don't commit, and don't think of themselves as git users. The system must work for them without any git knowledge.

More experienced users may fork, commit, push, and manage their own git workflow. The system should accommodate them without getting in the way.

### The Model: Clone and Go

```
1. Clone nanoclaw/nanoclaw
2. Apply skills — the system handles everything
3. Optionally: fork, commit, push if you want backup and history
```

The skills system works entirely on the file system. It reads and writes files, maintains state in `.nanoclaw/state.yaml`, and uses `.nanoclaw/backup/` for safe rollback. Git is used internally for merge operations (`git merge-file`, `git rerere`) but the user never needs to interact with git directly.

### For Users Who Do Use Git

Users who fork and commit get additional benefits:

- Full history of every skill application
- Easy upstream pulls when new core versions release
- Team collaboration via shared repo
- `.nanoclaw/` committed means everyone gets the same state

But none of this is required. The system works the same either way.

### Pulling Core Updates

For users who forked:

```bash
git remote add upstream https://github.com/nanoclaw/nanoclaw.git
git fetch upstream
```

Then the skills update system handles the merge — not a raw `git merge upstream/main`, which would bypass state tracking and tests.

For users who cloned without forking: the update command fetches the new core version and applies it through the skills system directly.

---

## 2. Migration: From v0 to v0.1

### The Problem

Existing users have no `.nanoclaw/` directory, no state tracking, and custom modifications applied via the old skills system. The old system was non-deterministic — Claude Code implemented skills differently for each user. There's no uniformity and no reliable way to detect which skills were applied.

### Two Migration Paths

#### Option A: Fresh Start (Recommended)

User forks the new version and applies skills fresh using the new system. They get a clean, deterministic, maintainable codebase from day one.

Applying three or four skills takes minutes. The result is fully tracked, replayable, and maintainable. The old system was messy — drawing a line and saying "from here forward, it's deterministic" is the right move.

**The experience:**

```
> /init-nanoclaw

Initializing NanoClaw skills system...
  ✓ Created .nanoclaw/base/
  ✓ Created .nanoclaw/state.yaml
  ✓ Enabled git rerere
  ✓ Added .gitattributes

Ready. Apply your first skill with /add-whatsapp, /add-telegram, etc.
```

#### Option B: Snapshot Migration (For Users Who Can't Start Fresh)

For users with customizations they can't easily recreate, the system captures their entire current codebase as a single custom patch. No attempt is made to detect or decompose individual skills.

**The experience:**

```
> /migrate-to-skills-system

Migrating existing codebase to skills system...
  ✓ Identified core version: 0.4.2
  ✓ Created .nanoclaw/base/ from clean core 0.4.2
  ✓ Captured all modifications as custom patch (247 lines changed)
  ✓ Created .nanoclaw/state.yaml

Migrated. Your existing modifications are preserved as a custom patch.
From here, new skills will apply using the new deterministic system.

Tip: Over time, you can replace parts of the custom patch with proper
skill applications for better maintainability.
```

**Under the hood:**

1. Identify the core version (check package.json, or ask the user)
2. Create `.nanoclaw/base/` from the matching clean core
3. Diff everything: one big patch → `.nanoclaw/custom/migration.patch`
4. Create `state.yaml` with `skills_system_version: "0.1.0"`, zero skills, one custom modification

No heuristics, no skill detection. The state file records the truth: "here's your base, here's a patch of everything you changed."

### Messaging to Users

"We recommend starting fresh — applying skills with the new system takes a few minutes and gives you a clean, maintainable setup. If you have customizations you can't easily recreate, you can migrate your existing codebase as-is and start using the new system going forward."

### Fresh Installs (Post v0.1)

New users never see migration. The standard install flow creates `.nanoclaw/` from scratch.

---

## 3. Implementation Pieces

Everything that needs to be built, in priority order. The critical first step is validating the core merge primitive before building on top of it.

### Phase 0: Validate the Foundation ✅ COMPLETE

**0. End-to-End Merge + Rerere Test Harness** — `tests/phase0-merge-rerere.sh` (33 tests, all passing)

**Result**: `git rerere` does **not** natively recognize `git merge-file` output. The issue is that rerere requires unmerged index entries (stages 1/2/3), which `git merge-file` doesn't create. A thin adapter bridges the gap by creating these entries via `git update-index --index-info` after merge-file produces a conflict. See architecture doc Section 7 for the full adapter pattern.

All critical properties validated:
- merge-file + rerere adapter works end-to-end (learn, cache, auto-resolve)
- Resolutions portable between repos (shared cache)
- Same conflict always produces same rerere hash (deterministic)
- Adjacent lines (~3 line proximity) treated as single hunk

### Phase 1: Foundation (v0.1)

**1. `.nanoclaw/` Directory Structure and Init**

- Create `.nanoclaw/base/` from the current clean core
- Create empty `state.yaml` with `skills_system_version: "0.1.0"`
- Set up `.gitattributes`
- Enable `git rerere` (`git config rerere.enabled true`)
- Set up deterministic serialization for YAML/JSON output (sorted keys, consistent quoting)

**2. State File Manager**

- Read/write/update `state.yaml`
- Check `skills_system_version` before any operation — refuse if tooling is older than state schema
- Record skill applications, per-file hashes (base, skill, merged), custom patches
- Hash computation and comparison for drift detection

**3. Merge Engine (Wrapper Around Git)**

- Thin wrapper that runs `git merge-file` and interprets exit codes
- On conflict: runs the rerere index adapter (create blobs via `git hash-object -w`, set unmerged index entries via `git update-index --index-info`, set `MERGE_HEAD`/`MERGE_MSG`)
- Loads resolutions from `.nanoclaw/resolutions/` into local `git rerere` before merging (with hash verification)
- Calls `git rerere` to auto-resolve from cache or record preimage
- Reports clean merges vs. conflicts
- Triggers Level 2 (Claude Code) for unresolved conflicts
- Cleans up merge state after resolution (`rm MERGE_HEAD MERGE_MSG`, `git reset`)
- Gracefully skips rerere operations if not in a git repo (zip download users)

**4. Backup Manager**

- Before any operation, copy all files that will be modified to `.nanoclaw/backup/`
- On success, delete backup
- On failure, restore from backup
- Works regardless of git state — no commits required

**5. Skill Manifest Parser**

- Read `manifest.yaml` from skill directories
- Validate required fields (core_version, adds, modifies)
- Check dependencies and conflicts against current state
- Parse structured operations

**6. Structured Operations Handler (Minimal)**

- Parse `npm_dependencies` from manifests
- Merge dependencies into `package.json` programmatically (using deterministic serialization)
- Handle `env_additions` (append to `.env.example`)
- Run `npm install` once after all dependencies are merged
- Detect basic conflicts (incompatible version ranges, duplicate env vars)

This is pulled into Phase 1 because the first real multi-skill case will immediately hit `package.json` and lockfile churn without it.

**7. The Apply Flow**

The core operation. Ties everything together:
- Pre-flight checks (version, deps, conflicts, drift detection)
- Backup affected files
- Copy new files
- Run `git merge-file` for each modified file
- Resolution cache → rerere → Claude Code → user escalation
- Structured operations (batched)
- Update state
- Run tests
- Delete backup on success, restore on failure

**8. Migrate Existing Skills to New Format**

Convert every current skill from the old format (markdown + inline code) to the new format:
- `SKILL.md` — extract context and instructions
- `manifest.yaml` — create with proper metadata, structured operations
- `add/` — new files the skill introduces
- `modify/` — full modified files authored against the clean core
- `.intent.md` — write structured intent files for each modified file (What, Key sections, Invariants, Must-keep)
- `tests/` — create basic integration tests

Labor-intensive but essential. Every skill needs to be re-authored.

**9. Migration Support**

- Fresh start path: just `skills init` (already built as part of item 1)
- Snapshot migration: diff codebase against base, capture as single patch, create state file. Minimal tooling — a diff and a YAML write.

### Phase 2: Robustness (v0.2)

**10. Shared Resolution Cache Infrastructure**

- Full directory structure for `.nanoclaw/resolutions/`
- Hash computation and mandatory verification
- Loading resolutions into local rerere cache
- CI pipeline for generating resolutions from tested combinations

**11. Extended Structured Operations**

- Docker-compose service merging
- Port and service name collision detection
- Structured conflict resolution policies (automatic → Claude → user)
- Record resolved outcomes (actual versions, resolved ports) in state
- Batch operations across multiple skill applications

**12. Custom Modification Tracking**

- The customize start/commit flow
- Patch generation from snapshots
- Drift detection prompts before operations

**13. File Operations Handler**

- Renames, deletes, moves as declared in manifests
- Path remapping (compatibility maps shipped with core updates)
- State update after file ops

**14. Core Update Flow**

- Fetch new core version
- Backup affected files
- File operations and path remapping
- Three-way merge against base
- Re-apply custom patches with `git apply --3way`
- Load shipped resolutions
- Re-run structured operations
- Compatibility report
- Update base
- Run all tests
- Delete backup on success, restore on failure

### Phase 3: Scale (v0.3+)

**15. Uninstall (Replay Without)**

- Replay engine that reconstructs from state minus the removed skill
- Backup current state, restore on failure
- Warning for custom patches tied to the removed skill

**16. Rebase**

- Flatten accumulated state
- Regenerate skill diffs against new base
- Clear stale caches

**17. CI Test Matrix**

- Auto-generate test matrix from manifest `modifies` and `structured` field overlap
- Run pairwise and curated combination tests
- Generate and publish verified resolutions
- Automated testing on each skill or core update

**18. Community Resolution Submissions**

- Process for users to submit resolutions for new skill combinations
- Verification and testing pipeline
- Integration into the shared cache

---

## 4. Making the System Invisible

For a user who just applies official skills, the experience should feel like magic backed by git.

### What They See

```
> /add-whatsapp

Applying WhatsApp integration...
  ✓ Added src/channels/whatsapp.ts
  ✓ Updated src/server.ts
  ✓ Updated src/config.ts
  ✓ Installed dependencies
  ✓ Tests passing

WhatsApp integration ready. Set these environment variables:
  WHATSAPP_TOKEN=...
  WHATSAPP_VERIFY_TOKEN=...
  WHATSAPP_PHONE_ID=...
```

That's it.

### What They Don't See

- `git merge-file` running
- Resolution cache being checked
- State file being updated
- File hashes being computed
- Backup being created and cleaned up
- Structured operations batching dependencies

### Design Rules for Invisibility

**1. Silent on success, informative on issues.**

A clean application shows: what was added/updated, that tests pass, what env vars are needed. Nothing else.

Only surface internals when something goes wrong:
- Conflict resolved silently → don't mention it
- Test failure → "WhatsApp applied cleanly but tests are failing. Investigating..."
- Untracked changes → "You've modified server.ts since the last skill was applied. Want to record these changes before proceeding?"

**2. State management is silent.**

`.nanoclaw/state.yaml` and `.nanoclaw/backup/` are updated behind the scenes. The user never interacts with them.

**3. Nudge users toward good git hygiene, once.**

On the first skill apply, check the user's setup:

**If `origin` points to `nanoclaw/nanoclaw` (clone, not fork)** — suggest forking:

```
Tip: You're running directly from the NanoClaw repo. Forking gives
you backup, history, and easier updates.

[1] Help me fork now
[2] Maybe later
```

If they pick 1:

- Check if `gh` CLI is available → `gh repo fork` handles everything
- Otherwise: open `https://github.com/nanoclaw/nanoclaw/fork` in their browser, ask for their GitHub username, then:

```bash
git remote rename origin upstream
git remote add origin https://github.com/{username}/nanoclaw.git
git push -u origin main
```

```
Setting up remotes...
  ✓ Origin → github.com/gavrielcohen/nanoclaw
  ✓ Upstream → github.com/nanoclaw/nanoclaw
  ✓ Pushed current state to your fork

You're all set. Your work is backed up and you can pull future updates.
```

**If they're already on a fork but have uncommitted changes** — suggest committing:

```
Tip: You have uncommitted changes. Committing and pushing keeps your
work backed up and makes it easier to track what's changed.

[1] Commit and push now
[2] Maybe later
```

If they pick 1, commit all changes with a descriptive message and push to origin.

Both suggestions shown once per trigger, flagged in `.nanoclaw/config.yaml` so they don't nag. The system works fine either way — these are hygiene nudges, not requirements.

**4. The SKILL.md drives the UX.**

Claude Code reads `SKILL.md` and presents the skill's description and setup in natural language. The manifest, merge mechanics, and state tracking are invisible.

**5. Updates are one command.**

```
> /update-nanoclaw

Updating core: 0.5.0 → 0.6.0...
  ✓ WhatsApp integration — compatible
  ✓ Telegram integration — compatible
  ✓ All tests passing

Updated successfully.
```

**6. `.nanoclaw/` is infrastructure, not interface.**

Like `.git/` — powers everything, users never open it.

**7. Progressive disclosure.**

| User type | What they experience |
|---|---|
| Applies official skills | Run slash command, see success message, done |
| Applies multiple skills | Same — conflicts resolved silently via cache |
| Makes custom modifications | Prompted before next operation: "record these changes?" |
| Builds custom skills | Needs to understand manifest format and skill structure |
| Maintains the project | Works with CI, resolution cache, test matrix |

**8. Error messages are human.**

Bad:
```
git merge-file exited with code 1. Conflict in src/server.ts.
Checking .nanoclaw/resolutions/ for cached resolution...
No match found. Invoking Level 2 resolution...
```

Good:
```
WhatsApp and Telegram both add routing logic to the same part of server.ts.
Resolving... done. Both integrations are working.
```

Or when user input is needed:
```
Both WhatsApp and Telegram want to be the default message handler.
Which should handle messages when the source channel is unknown?
[1] WhatsApp
[2] Telegram
[3] Neither — require explicit channel routing
```

System concepts never appear in user-facing output.

---

## 5. The Minimal Path to v0.1

### Day One: Prove the Foundation

Validate `git merge-file` + `git rerere` integration with a small end-to-end test. This is non-negotiable — the entire architecture rests on it.

### What's Strictly Required for v0.1

1. **`.nanoclaw/base/`** — snapshot of clean core
2. **`state.yaml` manager** — read, write, hash computation, version checking
3. **Merge engine** — wrapper around `git merge-file`, ~100-200 lines
4. **Backup manager** — copy before, restore on failure, delete on success
5. **Manifest parser** — read YAML, extract fields
6. **Structured ops (minimal)** — npm dependencies + env vars
7. **One migrated skill** — convert one existing skill to new format as proof of concept
8. **The apply flow** — tie it all together
9. **Migration support** — `skills init` for fresh start, diff-and-patch for snapshot migration

### What Can Wait

- Shared resolution cache (user base is small enough that Claude resolving is fine)
- Extended structured operations (docker-compose, port collision detection)
- File operations (no renames in the near term)
- Uninstall/rebase (manual workaround: replay from scratch)
- CI test matrix (manual testing initially)

### The v0.1 Experience

A user with a fresh install (Option A — recommended):
1. Fork and clone
2. `skills init` creates `.nanoclaw/base/` and `state.yaml`
3. `/add-whatsapp` applies the skill using the new merge system
4. It works, tests pass, state is recorded
5. `/add-telegram` stacks on top, merge is clean, done

A user migrating their existing codebase (Option B):
1. Run `/migrate-to-skills-system`
2. System identifies their core version, diffs everything into one patch
3. Creates `.nanoclaw/` with zero skills and one custom modification
4. From here on, new skills apply deterministically on top

This is enough to prove the architecture and start getting feedback from real users.