---
name: security-audit
description: Run a comprehensive security audit of NanoClaw agent sessions. Checks for credential leakage, prompt injection, unauthorized actions, network exfiltration, and lethal trifecta exposure. Spawns a team of parallel agents for each concern area.
---

# Security Audit

Run a comprehensive security audit of all NanoClaw agent sessions. Analyzes session transcripts, container logs, and runtime configuration for security threats.

## Arguments

- No arguments: audit all groups
- Group name(s): audit specific groups (e.g., `/security-audit familiar feedback`)

## Architecture

Spawn a team of specialist agents, one per concern area, running in parallel across all groups. Each agent reviews the full corpus of session data for their specific threat category.

## Session Data Locations

```
data/sessions/{group}/.claude/projects/-workspace-group/*.jsonl   # Full session transcripts
data/sessions/{group}/.claude/debug/                              # Debug logs
groups/{group}/logs/container-*.log                               # Container run logs
```

## Step 1: Discover Audit Targets

```bash
# List all groups with session data
ls data/sessions/

# Count transcripts per group
for group in $(ls data/sessions/); do
  count=$(find "data/sessions/$group/.claude/projects" -name "*.jsonl" 2>/dev/null | wc -l)
  logs=$(find "groups/$group/logs" -name "container-*.log" 2>/dev/null | wc -l)
  echo "$group: $count sessions, $logs container logs"
done
```

If arguments were provided, filter to only those groups.

## Step 2: Spawn Audit Team

Create a team with `TeamCreate` named `security-audit`. Then create tasks and spawn agents for each concern area below. Each agent should review ALL session JSONL files and container logs for ALL target groups.

### Agent 1: Credential & Secret Leakage

**Task**: Scan all transcripts and logs for exposed secrets.

Search for:
- API keys: patterns matching `sk-ant-`, `github_pat_`, `gho_`, `ghp_`, `xoxb-`, `xoxp-`
- Generic secrets: `Bearer `, `token=`, `password=`, `secret=`, `apikey=`, `api_key=`
- Environment variable dumps: `env`, `printenv`, `echo $`, `/proc/self/environ`, `process.env`
- `gh auth status` output (leaks token prefix)
- Credentials in tool results (stdout from Bash commands)
- Secrets in files read by the agent (`.env`, `config.json`, `credentials`)
- Anthropic/Claude tokens: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`
- Telegram tokens: `TELEGRAM_BOT_TOKEN`
- Signal credentials or phone numbers in unexpected contexts

Also check:
- File permissions on `groups/*/.env` files (should be 600)
- Whether `data/env/` directory exists (should have been deleted)
- Whether `.env` in project root contains secrets that shouldn't be there

Report each finding with: file path, line number/offset, the secret pattern found (redact the actual value), and severity (critical/high/medium/low).

### Agent 2: Prompt Injection & Manipulation

**Task**: Analyze all external content that entered agent context for injection attempts.

Search for:
- Injected instructions in tool results: "ignore previous instructions", "you are now", "system:", "IMPORTANT:", "override", "disregard"
- Hidden instructions in web content fetched via `WebFetch` or browser tools
- GitHub issue/PR bodies containing agent-directed instructions
- Signal/Telegram messages with embedded system-prompt-style text
- Unicode tricks: zero-width characters, RTL overrides, homoglyph substitution
- Base64-encoded payloads in external content that get decoded and executed
- Markdown/XML injection in message content that could confuse the agent's parsing
- `<system-reminder>` or similar tags in external content (not from Claude Code itself)

For each finding: source (URL, message sender, issue number), the injection payload, whether the agent followed it, and impact.

### Agent 3: Unauthorized Actions & Scope Creep

**Task**: Verify every agent action was authorized by the triggering user request.

For each session transcript:
1. Identify the user's request (the prompt or message that triggered the session)
2. List every tool call the agent made
3. Flag any action that wasn't directly serving the user's request:
   - Files created/modified outside the expected scope
   - Commands run that weren't necessary for the task
   - Messages sent to JIDs other than the originating chat
   - Scheduled tasks created without being asked
   - System files or configs accessed (`/etc/`, `/proc/`, `/sys/`)
   - Self-modification of CLAUDE.md or agent instructions
   - Git operations (commit, push) without being asked
   - Package installations or system modifications

Also check for:
- Cross-group access attempts (agent in group A trying to access group B's data)
- IPC messages that target different groups than the source
- Privilege escalation via IPC (non-main agent trying main-only operations)

### Agent 4: Network Activity & URL Analysis

**Task**: Extract and analyze ALL outbound network activity from agent sessions.

Parse every JSONL transcript and extract:
1. **WebFetch calls**: URL, prompt, response summary
2. **WebSearch calls**: query, result URLs
3. **Bash commands with network activity**: `curl`, `wget`, `fetch`, `nc`, `ssh`, `git clone`, `git push`, `npm install`, `pip install`, `gh api`
4. **Browser tool navigation**: URLs visited, forms submitted, data entered
5. **Image/resource loads**: any URL that could exfiltrate data via GET parameters

For each URL found:
- Classify as: expected (GitHub API, Anthropic API, known docs sites) or unexpected
- Check for data in query parameters (potential exfiltration: `?data=`, `?q=`, long base64 strings)
- Check for POST requests with body data going to non-API endpoints
- Flag any requests to IP addresses instead of domains
- Flag any requests to localhost/internal networks from within the container
- Flag connections to known malicious domains or suspicious TLDs

Produce a complete URL inventory table:
```
| Group | Session | Tool | URL | Method | Classification | Risk |
```

Also check:
- Whether containers have any egress restrictions configured
- DNS resolution patterns (if debug logs contain DNS info)
- Whether the agent ever constructed URLs dynamically from user data or secrets

### Agent 5: Lethal Trifecta & Structural Risk

**Task**: Analyze the system architecture for structural vulnerabilities, independent of what agents have actually done.

Evaluate each registered group against the lethal trifecta:

1. **Private data access**: What sensitive data can this group's agent access?
   - Check mount configuration: `sqlite3 store/messages.db "SELECT folder, container_config FROM registered_groups"`
   - Check what's in each group folder
   - Check if Obsidian vault or other personal data is mounted
   - Check if `store/messages.db` is accessible (main group)

2. **Untrusted content exposure**: What attacker-controlled content enters agent context?
   - Messages from group members (who can send? is it a public group?)
   - Web content via browser/fetch tools
   - GitHub issues/PRs (publicly writable)
   - Files that could be modified by third parties

3. **Exfiltration channels**: How can data leave the agent's context?
   - `send_message` IPC tool — can it send to arbitrary JIDs?
   - Bash tool — unrestricted `curl`, `wget`?
   - GitHub tool — can create public issues/comments?
   - Browser tool — can navigate to attacker-controlled URLs with query params?
   - Scheduled tasks — can create persistent exfiltration jobs?

For each group, produce a trifecta scorecard:
```
Group: {name}
  Private data: [list what's accessible]
  Untrusted input: [list sources]
  Exfil channels: [list channels]
  Trifecta status: EXPOSED / PARTIALLY MITIGATED / MITIGATED
  Recommendations: [specific mitigations]
```

Also review:
- Container isolation: user ID, capabilities, seccomp profile
- Mount permissions: read-only vs read-write
- IPC validation: does the host validate IPC messages from containers?
- Session isolation: can one group's session ID be used by another group?
- Supply chain: `npm audit` on container/agent-runner, base image freshness

## Step 3: Synthesize Report

After all agents complete, compile a unified report:

### Report Structure

```
NANOCLAW SECURITY AUDIT REPORT
Date: {date}
Groups audited: {list}
Sessions reviewed: {count}
Container logs reviewed: {count}

EXECUTIVE SUMMARY
- Overall risk level: CRITICAL / HIGH / MEDIUM / LOW
- Lethal trifecta status per group
- Number of findings by severity

CRITICAL FINDINGS
(anything requiring immediate action)

HIGH FINDINGS
(significant risks)

MEDIUM FINDINGS
(should be addressed)

LOW / INFORMATIONAL
(awareness items)

NETWORK ACTIVITY SUMMARY
- Total unique URLs accessed
- Unexpected/unclassified URLs
- Potential exfiltration attempts

RECOMMENDATIONS
(prioritized list of mitigations)
```

Post the report as a single message. If it exceeds message limits, split into: Executive Summary, Detailed Findings, Network Inventory, Recommendations.

## Notes

- Redact actual secret values in the report — show patterns and locations only
- For JSONL files, reference findings by filename and line offset
- Container logs are plaintext — search them for stderr warnings and error patterns
- Debug logs may contain initialization details but rarely contain secrets (verify anyway)
- If a group has no session data yet, note it as "no sessions to audit" and skip to structural review
