# Yunomia3

A multi-agent orchestration shell for any project. Open Yunomia, point it at a folder, talk to a Lead agent about your goals, and it will scope the work, propose an agent fleet, and file the initial tickets. From there you have one window with a kanban, ticket inbox, bug-lessons archive, activity feed, and a real Claude Code session per agent. Everything is per-project and file-backed locally.

> Built on Tauri 2 + portable-pty + xterm.js. Vanilla JS frontend, no framework. macOS Apple Silicon, macOS Intel, Windows, and Linux binaries.

---

## What you get

- **Project picker** that tracks any number of project roots. Each project is fully independent: its own kanban, agent fleet, brief, state, and audit log.
- **Onboarding flow.** First time you open a project, the Lead agent interviews you about goals, scope, constraints, and deploy targets. It writes your understanding to `brief.md`, proposes an agent fleet plus an initial ticket list, and you approve. Yunomia then auto-spawns the heartbeat agents and creates the tickets.
- **Live kanban** with seven columns (Backlog, Triage, Assigned, In Progress, In Review, Done, Released). Click any card for a side panel: title click-to-edit, type, audience, assignee, status, body editor with a pencil toggle, comment thread, schedule picker, and Start, Handoff, Done actions.
- **Bug lessons.** Agents (not you) capture lessons after closing a bug, via a sentinel-file flow. Browseable archive at `BL-NNN`. Compliance engine blocks `/handoff` and `/done` on bug tickets until the agent has consulted the lessons archive and cited a parallel or stated none was found.
- **Schedules.** Set a `scheduled_for` on any ticket. Cards show a bell with relative time, red when overdue. A 30 second poller fires inbox notifications when due.
- **Inbox** is a per-project notification queue with an unprocessed-count badge. Schedules due, ticket assignments, comments, bug closures, agent proposals, and lesson ingests all land here.
- **Activity feed** is a read-only audit log of every transition, comment, lesson capture, and agent change.
- **Reports** show today's open, in progress, in review, and done counts plus an active-tickets-per-agent breakdown.
- **Agent rail** shows only agents actually in this project. Each row carries an emoji, code, status (working, waiting, blocked, idle), colored pulse dot, ticket count, context-percent chip, per-agent PRE and CMPCT buttons, plus open-tab and kill controls.
- **Per-agent files.** Every agent has `soul.md`, `kickoff.md`, `pre-compact.md`, and `reawaken.md`, editable in the Agents sub-tab. The bug protocol is baked into the default soul and kickoff so every spawned agent inherits it.
- **Composer input.** Each agent pane has a real textarea pinned below the terminal. Type your message, hit Enter to send, Shift+Enter for a newline. Multi-line messages go to the agent as one bracketed-paste chunk so Claude sees one message with embedded newlines instead of multiple submissions. Click into the terminal itself when you need slash commands, Esc, or arrow-key passthrough.
- **Files subtab.** A lazy-loaded directory tree rooted at the project. Click a file to open in your OS default app (Preview for images, browser for HTML, Pages for `.docx`). Click a folder to expand inline. `node_modules`, `.git`, `dist`, `target`, `.venv`, and friends are filtered out so the tree stays useful.
- **Clickable paths in terminal output.** When an agent says "I created `/path/to/foo.html`", that path becomes a link. Click to open in the OS default app. Right-click anywhere on a recognised path for **Open / Reveal in Finder / Copy path**. Same context menu in the Files subtab for consistency.
- **Per-agent wakeup mode.** Either `heartbeat` (cron-fires every N minutes even with no work) for orchestrators like Lead and CEO, or `on-assignment` (wakes only when a ticket lands) for workers. Configurable per agent.
- **Lead-proposed mid-project agents.** Lead writes `agent-proposal.json` to ask for a new agent. Yunomia surfaces a modal with previews of the soul, kickoff, pre-compact, and reawaken templates. Approve and the four files are scaffolded plus the agent is spawned.
- **Auto-compact at 50% context** when an agent is idle. Manual PRE and CMPCT buttons live in each agent rail row.
- **Crash recovery.** Close Yunomia mid-conversation, and on reopen a banner offers Resume buttons for the recent Claude sessions in this project. Each entry has a trash button to delete the session permanently.
- **Compliance engine.** Backend ready for eligible-actions, single-task focus, bug-protocol gate, and a global kill-switch. UI consumption is rolling out.
- **Drag-resizable rails.** Both the left agent rail and the right new-ticket rail resize. Persisted across launches.
- **Light, Dark, or Auto theme.** Theme controls the entire UI including the terminal panes. Auto follows your OS setting.

---

## Install

### macOS (Apple Silicon and Intel)

Grab the latest signed `.dmg` from [Releases](https://github.com/phaddad90/Yunomia3/releases). Drag Yunomia.app into Applications. The app is signed and notarized so it opens normally on first launch.

### Windows

Download the latest `.msi` from [Releases](https://github.com/phaddad90/Yunomia3/releases). Run the installer.

### Linux

Download the `.AppImage` (run directly) or `.deb` (install with `sudo dpkg -i`) from [Releases](https://github.com/phaddad90/Yunomia3/releases).

### Auto-updates

Yunomia checks for updates on launch (silently, throttled to every 6 hours). When a new version is published, a green banner appears at the top of the app: click **Install & restart** and the new build downloads, replaces the current install, and relaunches. No manual reinstall.

The updater is cryptographically signed; only releases produced by the project's GitHub Actions pipeline are accepted.

You can force a check anytime via Settings → Updates → **Check for updates**.

---

## Prerequisites

- **`claude` CLI on PATH.** Yunomia spawns it for each agent's pty. If `which claude` (macOS / Linux) or `where claude` (Windows) returns nothing, the agent panes will be empty. Install from [claude.com/claude-code](https://claude.com/claude-code).
- That is the only external dependency. All Yunomia state lives at `~/.yunomia/projects/<sanitised-cwd>/`.

---

## How to use

### 1. Add a project

In the top bar, open the **Project** dropdown and pick `+ Add project...`. A modal opens. Use the Browse button to choose a folder, or paste an absolute path. The project name defaults to the folder basename. Click Add.

### 2. Onboarding

Yunomia opens the **Onboarding view** for new projects. Click **Spawn lead agent**.

A new LEAD tab opens with `claude` running in your project root. The founder kickoff auto-pastes after about two and a half seconds and Lead starts the interview.

Answer questions in the LEAD tab. Lead writes `brief.md` incrementally as you talk. Switch to the Dashboard tab to watch the brief grow live.

When ready, Lead writes `proposed-tickets.json` and `proposed-agents.json` to your project state directory.

Click **Approve brief, go active**. Yunomia ingests the proposals: it creates each ticket, populates the agent roster, and auto-spawns the agents marked `heartbeat`.

### 3. Active mode

The Dashboard tab now shows sub-tabs: **Kanban**, **Activity**, **Inbox**, **Lessons**, **Reports**, **Agents**, **Files**, **Credentials**, and **Deploys**.

- **Kanban** has a filter bar (search, assignee, type, due). Click any card for a side panel with all editing affordances and a schedule picker.
- **Lessons** lists every Bug Lesson agents have captured. The bug-close hook reminds the assigned agent to file a lesson via the sentinel-file flow.
- **Agents** is the project's roster config. Per-agent: model, wakeup mode, heartbeat interval, plus collapsible Kickoff, Goals, and Soul markdown editors.
- **Files** is the project's directory tree. Click a file to open it in the OS default app, or right-click anywhere for Open / Reveal / Copy path.
- **Credentials** holds per-project secrets (SSH keys, passwords, tokens, env values, JSON). Stored in your OS keychain; the file `credentials.json` carries names + types only. Used by Deploys for env injection.
- **Deploys** lists deploy targets, each a shell command with an approval rule (`auto`, `requires-peter`, `requires-qa`, `requires-tag`) and optional preflight + injected credential. Run / dry-run buttons; live output streams into a runner panel.

Lead can propose new agents at any time during the project. When it writes `agent-proposal.json`, Yunomia surfaces a modal so you can approve or reject. Approving scaffolds the four agent files, adds the agent to the roster, and (if `heartbeat`) spawns it.

### 4. Per-agent compact

Each agent rail row has **PRE** (run `/pre-compact`) and **CMPCT** (run `/compact`) buttons.

Auto-compact also fires at 50% context when the agent is idle, so you usually do not need the buttons.

### 5. Switching projects

Use the top bar Project picker. A red dot prefix means onboarding has not yet been approved for that project.

Each project is fully isolated: separate ptys, separate kanban, separate everything.

### 6. Closing and resuming

Close the window any time. Conversation history lives in `~/.claude/projects/...`.

On reopen, a yellow banner offers Resume buttons for the three most recent sessions in the current project. Each entry has a trash icon to delete that session permanently.

---

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
|---|---|---|
| Send composer message | Enter | Enter |
| Newline in composer | Shift+Enter | Shift+Enter |
| Open file path in terminal | Cmd+click | Ctrl+click |
| Reveal / Open / Copy path | right-click | right-click |
| Spawn agent (active phase only) | ⌘T | Ctrl+T |
| Close current pty tab | ⌘W | Ctrl+W |
| Switch to tab N | ⌘1 to ⌘9 | Ctrl+1 to Ctrl+9 |
| Reload Yunomia | ⌘R | Ctrl+R |
| Open Settings | click the gear icon | click the gear icon |

---

## Bug protocol (how agents work bugs)

This is enforced by Yunomia's compliance engine, baked into every default agent soul and kickoff, and re-stated in the wakeup prompt that fires when a bug ticket lands on an agent.

1. The agent receives a wakeup carrying the bug protocol directive.
2. Before writing fix code, the agent reads `lessons.json` for the project and searches for parallels by symptom, files, and tags.
3. The agent posts an in_progress comment containing one of these lines verbatim:
   - `Lesson cited: BL-NNN, <how it applies>`
   - `Lessons cited: BL-NNN, BL-MMM, <how they apply>`
   - `No matching lessons in N reviewed`
4. The compliance engine blocks `/handoff` and `/done` on bug tickets until that line is present.
5. After closing the bug, the agent writes a new lesson as JSON to `~/.yunomia/projects/<sanitised-cwd>/pending-lessons/<uuid>.json`. Yunomia ingests within 10 seconds, archives it as `BL-NNN`, drops it into the inbox, and removes the sentinel file.

The schema for the sentinel file is documented in every agent's default `kickoff.md`.

---

## State on disk

State is split between the project folder (artifacts you'd want in git) and the operator's home (private to your machine).

**`<cwd>/.yunomia/`** — project artifacts, intended to be git-committed:

```
brief.md                 canonical project scope (Lead writes here)
agents.json              project roster
agents/<CODE>/{kickoff,soul,pre-compact,reawaken}.md   per-agent identity
lessons.json             Bug Lessons (BL-NNN)
taxonomy.json            project-specific audiences + ticket types
tickets.json             all tickets
comments.json            ticket comments
schedules.json           scheduled_for per ticket
prefix.txt               3-letter ticket id prefix
counter.txt              monotonic ticket counter
proposed-tickets.json    Lead's draft tickets (transient, ingested on approve)
proposed-agents.json     Lead's proposed fleet (transient)
```

**`~/.yunomia/projects/<sanitised-cwd>/`** — operator-local, not committed:

```
state.json               project lifecycle (onboarding / active)
audit.json               transition / comment / lesson log
inbox.json               notification queue
kill-switch.json         compliance kill-switch state
agent-sessions.json      agent_code → claude-code session_id
agent-proposal.json      Lead's mid-project agent proposals (transient)
pending-lessons/         agent-written lesson sentinels (auto-ingested)
credentials.json         credential names + types (values live in OS keychain)
deploys.json             deploy targets
```

Plus globally:

```
~/.yunomia/agent-models.json     sticky model picks
~/.yunomia/pty-audit-<CODE>.log  every byte Yunomia wrote to each agent's stdin
```

`<sanitised-cwd>` is the absolute path with `/` replaced by `-` and spaces replaced by `_`. On first launch after upgrade, public files in the operator dir migrate to `<cwd>/.yunomia/` automatically.

---

## Token-use philosophy

Every design decision in Yunomia is filtered through one question: does this waste tokens? Multi-agent orchestration burns API spend fast if you let it. The patterns below are the ones that survived contact with real workloads.

### Lessons over rediscovery

Agents must consult `lessons.json` before touching a bug ticket. The compliance engine refuses to let `/handoff` or `/done` pass on a bug until the agent has cited a parallel lesson or stated none was found. A bug fixed once is a fix template for every future near-match: cheap pattern lookup beats expensive re-derivation, and the savings compound as the archive grows. Agents file their own lessons via a sentinel-file flow on bug closure, so the archive grows without operator effort.

### Wakeups are events, not polls

The naive way to keep a fleet alive is to ping every agent on a cron. That bills you for a full LLM turn just to confirm the agent has nothing to do. Yunomia inverts it: every agent has a `wakeup_mode`. Workers default to `on-assignment`, meaning their pty stays idle (zero tokens) until the kanban routes a ticket to them, at which point a minimal wakeup prompt fires over pty stdin. Only orchestrators (Lead, CEO) opt into `heartbeat` mode for periodic fleet sweeps, and even those run on long intervals (default 60 minutes) and produce one short check per tick.

### Programmatic wakeup, not session restart

When a wakeup does fire, it's a stdin write to an existing pty, not a fresh `claude` invocation. The session keeps its system prompt, kickoff, soul, and prior context. A wakeup costs roughly the same as a normal user message. Restarting a session would cost the full kickoff plus rebuilding any in-memory context.

### Compact early, compact when idle

Sessions degrade past about 50% context utilisation: late-context summaries are lossier than early ones, so a session compacted at 80% generates a worse summary than one compacted at 50%. Yunomia's auto-compact orchestrator fires `/pre-compact` then `/compact` when an agent crosses 50% AND is idle. Idle gating prevents mid-thought interruption; the 50% ceiling keeps summary quality high. Each agent also has a per-role `pre-compact.md` template that tells it what to summarise, so the post-compact session reorients in tens of tokens instead of hundreds.

### Per-agent model selection

Not every task needs Opus. The fleet picks per role: Haiku for verification-heavy work like QA, Sonnet for general engineering, Opus reserved for design and scoping (typically Lead and CEO). Configurable per agent in the project's roster, and Lead's proposed-agents JSON can recommend models per role on first onboarding.

### Single-task focus

The compliance engine prevents an agent from `/start`ing a second ticket while another is already in progress. The motivation is partly discipline, but it's also a cost lever: an agent juggling tickets pays context-switching tax (re-loading state, re-stating decisions) on every flip. One ticket at a time keeps each session's context narrow and short.

### File-backed canonical state

Every piece of long-lived state (brief, agents, tickets, comments, audit, lessons, schedules, soul, kickoff, pre-compact, reawaken) lives as plain JSON or markdown on disk. Agents read canonical files via `Read` rather than asking the operator to reconstruct context in chat. The cheapest token is the one you didn't generate.

### Onboarding compresses the operator's biggest cost

Most multi-agent setups bleed tokens during scoping, when the operator types lengthy briefs into multiple agents one at a time. Yunomia's onboarding has a single Lead agent interview the operator once, write the brief, propose the fleet, and then distribute that scope to all subsequently-spawned agents via per-agent kickoff and soul files. The interview cost is paid once; the distribution is free.

---

## Research and development history

Yunomia is the third generation of an evolving experiment in turning a fleet of Claude Code sessions into something that behaves like a focused team rather than a pile of terminals.

### v1: single-agent shell with deployable subagents

A single Claude Code instance running in a browser CLI, given the ability to dispatch subagents for delimited tasks. Proved out the basic shape of orchestration plus delegation, exposed the cost of poor handoff hygiene, and made the case for an explicit task list and a written verdict format. Did not yet have a distinct fleet of named, role-specific agents.

### v2: Mission Control

A browser-based mission-control dashboard for a fleet of named role-specific agents. Introduced the seven-column kanban, the agent rail with traffic-light status, per-ticket comment threads, the Bug Lessons archive, the per-agent kickoff/soul/pre-compact files, the compliance engine (single-task focus, lesson-on-bug-close, QA verdict, kill-switch, lint warnings), the heartbeat ticker, and the schedule poller. The operating model worked but the dashboard was tightly bound to one project's admin API and a localhost server; it could not be packaged or distributed.

### v3: Yunomia (this repo, in development)

Lifts the v2 operating model out of any single-project assumptions and packages it as a portable desktop application. Tauri shell, ptys hosting real Claude Code sessions, embedded kanban with no external server, file-backed everything at `~/.yunomia/`, project-agnostic by design, signed binaries for macOS and Windows.

What survived from v2: the kanban shape, Bug Lessons schema and bug-close hook, per-agent kickoff/soul/pre-compact/reawaken pattern, agent-rail traffic lights, compliance engine philosophy, auto-compact-at-50%, and the heartbeat split into mechanical and judgement layers.

What's net-new in v3: project picker so one app hosts many fleets; the Lead-led onboarding flow (interview, brief, proposal, approval); mid-project agent proposals with auto-scaffolded soul/kickoff/pre-compact/reawaken templates; per-agent wakeup mode so workers stay dormant until ticketed (the biggest token saver); programmatic wakeup over pty stdin, no human paste; the bug-protocol gate forcing lessons-archive consultation before fix code; sentinel-file lesson ingestion so agents log their own lessons; xterm-based pane management with theme-aware terminals; and crash recovery via Claude Code's session resume.

v3 is still in active development. Compliance UI consumption, per-rule kill-switch UI, exact context-percent via Claude Code hooks, and a few governance polish items are on the near-term roadmap.

---

## Changelog

Newest first. Skipped numbers (v0.1.3, v0.1.4, v0.1.9, v0.1.11) were CI dry-runs that never published — they got superseded mid-build by the next tag.

### v0.1.17 — single composer input, image paste, drag-drop

The composer in v0.1.12 sat on top of xterm's existing input layer instead of replacing it. Both could receive keystrokes, which made typing ambiguous and produced the "two input areas" feel. v0.1.17 makes the composer the single source of input.

- **xterm input disabled** (`disableStdin: true`). The terminal renders claude's TUI but never accepts keystrokes. Click the terminal area and focus jumps back to the composer.
- **Special keys forwarded by the composer** so claude's TUI still gets them:
  - `Esc` cancels claude's current op (or clears the composer if it has text)
  - `Ctrl+C` sends SIGINT-style interrupt to the pty
  - `Tab` / `Shift+Tab` pass through when the composer is empty
  - `↑` / `↓` arrows pass through to claude's input history when the composer is empty
- **Image paste in the composer.** Paste a screenshot — Yunomia saves it to `~/.yunomia/clipboard/<uuid>.png` and inserts the absolute path into the textarea. Hit Enter and claude code receives the path with your message; it can `Read` the image natively.
- **Drag-drop image** support, same path. The composer outline turns red while dragging to indicate the drop zone.
- **Focus ring on the composer** when active so it's unambiguous which area takes input.

### v0.1.16 — project-folder storage, agent kickoffs, per-agent context, taxonomy

Big architectural change plus a cluster of fixes for issues that surfaced during real onboarding runs.

- **Project artifacts now live in `<cwd>/.yunomia/`.** Brief, agents config, agent kickoff/soul/pre-compact/reawaken markdown, lessons, tickets, comments, schedules, taxonomy, prefix, counter — all of it lives in a `.yunomia/` directory in your project root, intended to be committed to git. Migration runs automatically the first time a project is touched after upgrade. Operator state (state.json, audit.json, inbox.json, kill-switch.json, pty audit logs, agent-session map, pending-lessons sentinels) stays in `~/.yunomia/projects/<sanitised>/`.
- **Auto-scaffold per-agent kickoffs on Approve.** When you approve the brief, every agent in `proposed-agents.json` gets a `agents/<CODE>/{kickoff,soul,pre-compact,reawaken}.md` written automatically. Kickoffs include the project name, role from Lead's `reason` field, a 1.5KB excerpt from `brief.md`, and the bug protocol. Auto-spawned heartbeat agents (CEO etc.) now boot with full role identity instead of being a blank Claude session in the same cwd as Lead.
- **Per-agent context %.** Spawn snapshots the timestamp; ~5 s later we discover which JSONL claude-code created and pin it as the agent's `session_id` in `agent-sessions.json`. Future context-% queries use that specific JSONL, not "the newest in cwd". Fixes the "LEAD and CEO show identical 20%" illusion.
- **Customisable taxonomy.** Lead writes `taxonomy.json` during onboarding listing the project's audiences and ticket types. The new-ticket dropdowns render from this file at project switch time. Falls back to a generic `[product, ops, internal] × [feature, bug, doc, ops, migration, gate]` if missing. Removes the PrintPepper-specific `admin/app` baggage permanently.
- **Approve-time validation.** The Approve modal now shows the actual counts found in `proposed-tickets.json` and `proposed-agents.json`, with a loud warning if tickets is 0 (the "Lead claimed 15 tickets but wrote 0" failure mode). After approve, a final summary tells you exactly what was created.
- **Discoverable "Re-open onboarding" + "Re-ingest proposals".** Both buttons now live in a project-actions row above the subtabs, always visible. The re-ingest button reads the proposals files again (e.g. after asking Lead to re-write its missing tickets file) and ingests anything new without flipping the project back to onboarding mode.
- **Updated Lead kickoff prompt.** Tells Lead to write to `<cwd>/.yunomia/proposed-*.json` (not the legacy operator path), to write a `taxonomy.json`, and explicitly warns against the failure modes Lead has actually hit (claiming N tickets but writing 0, writing one file and skipping another).

### v0.1.15 — credentials, deploys, git/CI

Three layers landing together for high-velocity dev:

- **Credentials store** keyed off the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret). Each entry has a name, kind (`ssh-key` / `password` / `token` / `env` / `json`), optional env var name, and optional note. Names + types live in `credentials.json`; values never touch disk. Show / Edit / Delete controls in the new **Credentials** subtab. Reads, writes, deletes audit-log automatically (`cred.read`, `cred.write`, `cred.delete`).
- **Deploy targets** in the new **Deploys** subtab. Each target is a shell command run from the project root, with optional preflight (e.g. `npm test && npm run build`) and an approval rule:
  - `auto` — runs immediately
  - `requires-peter` — only PETER can trigger
  - `requires-qa` — needs a comment from QA on the linked ticket containing `QA verdict: pass`
  - `requires-tag` — ticket must carry the `deploy-approved` tag
  Targets can reference a credential by name; on run, that secret is injected into the child env (as `<env_var>` if set on the cred, else `CRED_<NAME>`). Stdout / stderr stream live to a runner panel. Every run audits `deploy.start` / `deploy.complete` (or `deploy.blocked`).
- **Git status badge** next to the project picker: branch, dirty marker, ahead/behind. **CI badge** alongside it shows the most recent GitHub Actions run for the project (queued / running / pass / fail) — click to open in browser. Both poll on a 60 s tick.
- **Create PR from a ticket.** The ticket side panel has an `↗ Create PR` button that calls `gh pr create` with the ticket's title + body, drops the resulting URL as a comment on the ticket, and opens the PR in your browser. Closes the loop kanban → branch → PR.

All gh-driven features degrade gracefully if `gh` isn't installed or authenticated — badges hide, PR creation surfaces the error.

### v0.1.14 — pty PATH seeded from login shell

- pty children now inherit the user's login-shell PATH, not the minimal PATH that macOS gives Finder-launched apps. Fixes "Native installation exists but ~/.local/bin is not in your PATH" warnings from claude code, and "1 MCP server failed" errors when an MCP server config points to `npx <something>` that wasn't reachable.
- The PATH is queried once via `<shell> -lc 'echo $PATH'` (so user `.zshrc` / `.bashrc` customisations come through) and merged with a hardcoded fallback list so the app stays usable even on stripped-down systems.

### v0.1.13 — file tree + clickable paths

- **Files subtab** under the project dashboard: lazy-loaded directory tree rooted at the project. Click a file to open in the OS default app, click a folder to expand inline. Skips `node_modules`, `.git`, `dist`, `target`, `.venv`, `__pycache__`, `.next`, `.cache`.
- **Clickable file paths in xterm.** Absolute paths (`/Users/...`, `/home/...`, `/tmp/...`) and bare relative paths with common extensions become links. Cmd/Ctrl+click opens; right-click anywhere on a recognised path shows **Open / Reveal in Finder / Copy path**.
- New `src-tauri/src/files.rs` module with `list_dir`, `open_path`, and `reveal_path` Tauri commands. `list_dir` validates that requested paths stay inside the project cwd.

### v0.1.12 — VS Code-style composer

- Real HTML textarea pinned below each agent pane. Enter sends; Shift+Enter inserts a newline (native textarea behaviour, no escape-sequence guessing).
- Multi-line messages go to the pty as one bracketed-paste chunk (`\x1b[200~ … \x1b[201~\r`), so Claude Code's TUI sees one message with embedded newlines instead of multiple submissions.
- Click on the terminal area itself to focus xterm directly when you need slash commands, Esc, or arrow-key passthrough.
- Replaced the previous `attachCustomKeyEventHandler` shift+enter intercept which was producing visible artefacts.

### v0.1.10 — Shift+Enter intercept + correct boot width

- xterm's hidden textarea now gets focus on pane activation, click, and immediately after pty spawn, so the user's keystrokes actually reach the pty.
- pty_spawn waits for layout to settle and runs `fit()` synchronously before spawning, so Claude Code's TUI knows the real terminal width from boot instead of being told later via TIOCSWINSZ (which doesn't repaint the box-drawing chrome).
- Shipped manually via partial-publish fallback: macOS-aarch64, Windows, Linux. Apple notarization hung on Intel mac.

### v0.1.8 — xterm focus calls

- Three explicit `term.focus()` calls (pane activation, click on terminal, post-spawn). Before this, keystrokes after spawning Lead would land on the dashboard chrome instead of the pty.

### v0.1.7 — Spawn-lead `ReferenceError` fix

- `FOUNDER_KICKOFF` was declared `(projectName, projectPath, briefPath)` but the body referenced `${cwd}` four times, so every "Spawn lead agent" click threw `Can't find variable: cwd` before the pty even opened. This bug shipped in v0.1.0 through v0.1.6. v0.1.7 is the first build where Spawn lead actually works.

### v0.1.6 — split build/publish CI workflow

- Matrix jobs now bundle + sign + notarize only, then upload to per-platform Actions artifacts. A single `publish` job downloads everything, builds `latest.json`, and creates the GitHub Release in one shot.
- Eliminates the parallel-write race on the release manifest that caused half the v0.1.5 jobs to fail with `Error updating policy`.

### v0.1.5 — code/CI polish

- Bundle identifier is now `io.yunomia.shell` (was `io.yunomia.app`; Apple recommends not ending with `.app`).
- Dropped unused `anyhow!` import.

### v0.1.2 — updater check returns tagged result

- `bootCheckForUpdates` now returns `{kind: 'available' | 'none' | 'error'}` instead of returning `null` for both error and no-update. The earlier shape produced false "you're on the latest version" toasts when the updater request actually failed.

### v0.1.1 — claude auto-resolve + first-run install gate

- `claude` binary resolution walks 8 common install dirs (`/usr/local/bin`, `/opt/homebrew/bin`, `~/.npm-global/bin`, `~/.local/bin`, `~/.bun/bin`, `~/Library/pnpm`, `~/.volta/bin`, `~/.cargo/bin`), then falls back to asking the user's login shell via `<shell> -lc 'which claude'`. Without this, Finder-launched Yunomia couldn't find `claude` because macOS gives Finder apps a minimal PATH.
- First-run install-gate modal blocks Spawn until `claude` is detected. New `claude_status` Tauri command returns `{found, path}`.
- Better error surfacing: spawn errors now write into the xterm pane instead of failing silently.

### v0.1.0 — initial public release

- Tauri 2 desktop shell hosting one Claude Code pty per agent.
- Project picker, onboarding (Lead-led interview, brief, agent fleet + ticket proposals, approval flow).
- Seven-column kanban with side-panel editors, comments, schedule picker.
- Bug Lessons archive with sentinel-file ingestion and bug-protocol compliance gate.
- Per-agent kickoff/soul/pre-compact/reawaken markdown templates.
- Heartbeat / on-assignment wakeup modes; auto-compact at 50% context.
- Crash recovery via Claude Code session resume.
- Signed builds for macOS Apple Silicon, macOS Intel, Windows, and Linux. Tauri auto-updater wired against the public GitHub Releases manifest.

---

## License

MIT. See [LICENSE](./LICENSE).
