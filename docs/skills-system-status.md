# Skills System Implementation Status

## Overview

The skills system makes skill application deterministic using `git merge-file` + `git rerere`, replacing the old non-deterministic approach where Claude Code interpreted markdown and applied changes differently for each user. Skills are self-contained packages carrying full modified files, applied via three-way merge against a shared base.

## What's Been Built

### Phase 0: Foundation Validation (Complete)

Validated that `git merge-file` + `git rerere` work together via a 33-test harness. Key discovery: rerere requires unmerged index entries (stages 1/2/3) that `git merge-file` doesn't create. An adapter bridges this by creating blob objects and index entries after merge-file produces a conflict.

Validated properties:
- rerere strips marker labels and hashes only the conflict body
- Resolutions are portable between repos
- Same conflict always produces the same rerere hash
- Adjacent line changes (< ~3 lines apart) are treated as one hunk

### Phase 1: Skills Engine (Complete — on branch `feat/skills-engine-v0.1`)

10 core modules in `skills-engine/`:

| Module | Purpose |
|--------|---------|
| `types.ts` | Type definitions: `SkillManifest`, `SkillState`, `ApplyResult`, etc. |
| `constants.ts` | Shared constants: `NANOCLAW_DIR`, `STATE_FILE`, `BASE_DIR`, `SKILLS_SCHEMA_VERSION`, etc. |
| `state.ts` | Read/write `.nanoclaw/state.yaml`, record skill applications, compute file hashes for drift detection |
| `backup.ts` | Copy files before operations, restore on failure, delete on success |
| `merge.ts` | Wrapper around `git merge-file` + rerere adapter (create blobs, unmerged index entries, MERGE_HEAD/MERGE_MSG) |
| `manifest.ts` | Parse `manifest.yaml`, validate fields, check deps/conflicts/core_version against state |
| `structured.ts` | Merge npm dependencies into `package.json`, append env vars to `.env.example`, run `npm install` |
| `init.ts` | Create `.nanoclaw/base/` from current source, create initial `state.yaml`, enable rerere |
| `apply.ts` | The apply flow: pre-flight, backup, copy adds, merge modifies, structured ops, update state, run tests, cleanup |
| `migrate.ts` | `initSkillsSystem()` for fresh start, `migrateExisting()` for snapshot migration |
| `index.ts` | Public API exports |

Supporting files:
- `scripts/apply-skill.ts` — CLI entry point for applying skills
- `vitest.skills.config.ts` — Test config for skill package tests

### Phase 2: Robustness (Complete — on branch `feat/skills-engine-v0.1`)

7 new/extended modules plus comprehensive unit tests:

| Module | Purpose |
|--------|---------|
| `lock.ts` | Atomic operation locking (`.nanoclaw/lock`) with stale lock detection |
| `customize.ts` | Custom modification tracking: `startCustomize`, `commitCustomize`, `abortCustomize` |
| `file-ops.ts` | File operations handler: renames, deletes, moves with safety checks |
| `resolution-cache.ts` | Shared resolution cache: load/save resolutions, rerere hash integration |
| `update.ts` | Core update flow: `previewUpdate` and `applyUpdate` |
| `fs-utils.ts` | Shared utilities (copyDir) |
| `structured.ts` | Extended: semver-compatible dependency merging, docker-compose service merging |

Bug fixes applied during Phase 2:
- Rerere auto-resolve: conflict markers now written to working tree path before adapter runs
- `oursContent` reads current file (not base) for correct rerere stage 2
- Atomic lock acquisition (`{ flag: 'wx' }`) prevents TOCTOU race
- `execFileSync` throughout merge.ts to prevent command injection via file paths
- Atomic state writes (write-to-temp + `fs.renameSync`)
- Scoped `cleanupMergeState(filePath)` to avoid dropping unrelated staged changes
- Resolution cache uses actual rerere hash from `rr-cache/` directory
- Numeric comparison for semver version parts (not string)
- Backup rollback cleans up newly added files
- Skill test commands stored in `structured_outcomes` for update flow

Unit tests (10 test files in `__tests__/`):

| Test File | Coverage |
|-----------|----------|
| `state.test.ts` | Read/write roundtrip, version guard, record skill, hash computation |
| `backup.test.ts` | Create, restore, clear, skip missing |
| `manifest.test.ts` | Parse valid/invalid, check deps/conflicts, optional defaults |
| `merge.test.ts` | Clean merge, conflict merge, isGitRepo |
| `structured.test.ts` | NPM deps, env vars, semver compat, docker-compose, port collision |
| `lock.test.ts` | Acquire/release, detect active lock, stale cleanup |
| `constants.test.ts` | Path consistency |
| `customize.test.ts` | Start/commit/abort flow, empty diff |
| `file-ops.test.ts` | Rename, delete, move, safety checks |
| `resolution-cache.test.ts` | Load/save resolutions, hash matching |
| `update.test.ts` | Preview (6 tests), apply update (6 tests) |

### Skill Packages (2 Complete)

**Telegram** (`.claude/skills/add-telegram/`) — first skill, live validated:

```
.claude/skills/add-telegram/
  SKILL.md                              # 5-phase orchestrator
  manifest.yaml                         # grammy dep, env vars
  add/src/channels/telegram.ts          # TelegramChannel class
  add/src/channels/telegram.test.ts     # 50 unit tests
  modify/src/index.ts                   # Clean core + multi-channel support
  modify/src/index.ts.intent.md         # Structured intent
  modify/src/config.ts                  # Clean core + Telegram config
  modify/src/config.ts.intent.md        # Structured intent
  modify/src/routing.test.ts            # Updated routing tests
  tests/telegram.test.ts                # Package integration test
```

**Discord** (`.claude/skills/add-discord/`) — second skill, live validated:

```
.claude/skills/add-discord/
  SKILL.md                              # 5-phase orchestrator
  manifest.yaml                         # discord.js dep, env vars
  add/src/channels/discord.ts           # DiscordChannel class
  add/src/channels/discord.test.ts      # Unit tests with discord.js mock
  modify/src/index.ts                   # Clean core + multi-channel (telegram+discord)
  modify/src/index.ts.intent.md         # Structured intent
  modify/src/config.ts                  # Clean core + Discord config
  modify/src/config.ts.intent.md        # Structured intent
  modify/src/routing.test.ts            # Updated routing tests
  tests/discord.test.ts                 # Package integration test
```

Note: Discord and Telegram are independent skills — both authored against the clean core base with `depends: []`. Discord's `modify/` files contain the clean core + Discord changes only (no Telegram code). When both are applied, `git merge-file` combines each skill's changes relative to the shared base. Overlapping lines (e.g., `getAvailableGroups` filter) produce a conflict that gets resolved once and cached by rerere.

### End-to-End Validation (Complete)

Both skills applied to a live instance:
1. `initSkillsSystem()` created `.nanoclaw/base/` and `state.yaml`
2. Telegram skill applied — clean merges, all tests pass
3. Discord skill applied on top — clean merges against accumulated base, all tests pass
4. Both bots connected and responding to messages alongside WhatsApp

### Architecture & Design Docs (Complete, synced with v0.1)

- `docs/nanoclaw-architecture-final.md` — Full architecture, updated to match v0.1 implementation
- `docs/nanoclaw-implementation-guide-final.md` — Implementation guide with phased plan

## What's NOT on the Branch

The branch (`feat/skills-engine-v0.1`) contains only the skills engine, skill packages, and docs. It does **not** contain any source changes from applying skills. The principle: skills modify code in user installations, not in the main repo. The main codebase stays clean.

## What's Next (Phase 3+)

- Uninstall (replay without the skill)
- Rebase (flatten accumulated layers)
- CI test matrix (auto-generated from manifest overlap)
- Community resolution submissions
- Path remapping for file renames across skill versions
- Three-part file hashes (base/skill_modified/merged) for better drift diagnosis
- Additional manifest fields: `author`, `license`, `min_skills_system_version`, `tested_with`, `post_apply`

## Key Design Decisions

1. **Skills live in `.claude/skills/`** — integrates with Claude Code's built-in skill system. Running `/add-telegram` triggers `SKILL.md` which orchestrates both code application and interactive setup.

2. **Skills engine lives in `skills-engine/`** — separate from runtime `src/`, with its own `tsconfig.json`. It's tooling that operates on source files but is never compiled to `dist/` or targeted by skills. Invoked via `tsx` at apply time.

3. **Full modified files, not patches** — `git merge-file` requires three full files. Auditable via diff, deterministic, works even if the user has moved code around.

4. **`.nanoclaw/` is gitignored** — it's local per-installation state (like `node_modules/`). Each user's `.nanoclaw/base/` and `state.yaml` reflect their specific installation.

5. **`readEnvFile()` pattern** — NanoClaw deliberately does NOT load `.env` into `process.env`. All `.env` values must be explicitly requested. Skills that add config exports must add their keys to the `readEnvFile()` call and use the `envConfig` fallback.

6. **Stable base** — `.nanoclaw/base/` is the clean core before any skills or customizations. It's the stable common ancestor for all three-way merges. Only updated on core updates.
