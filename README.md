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

Grab the latest signed `.dmg` from [Releases](https://github.com/phaddad90/Yunomia3/releases). Drag Yunomia.app into Applications. The app is signed and notarized with Peter's Apple Developer account, so it opens normally on first launch.

### Windows

Download the latest `.msi` from [Releases](https://github.com/phaddad90/Yunomia3/releases). Run the installer.

### Linux

Download the `.AppImage` (run directly) or `.deb` (install with `sudo dpkg -i`) from [Releases](https://github.com/phaddad90/Yunomia3/releases).

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

The Dashboard tab now shows sub-tabs: **Kanban**, **Activity**, **Inbox**, **Lessons**, **Reports**, and **Agents**.

- **Kanban** has a filter bar (search, assignee, type, due). Click any card for a side panel with all editing affordances and a schedule picker.
- **Lessons** lists every Bug Lesson agents have captured. The bug-close hook reminds the assigned agent to file a lesson via the sentinel-file flow.
- **Agents** is the project's roster config. Per-agent: model, wakeup mode, heartbeat interval, plus collapsible Kickoff, Goals, and Soul markdown editors.

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

Everything Yunomia writes lives at `~/.yunomia/projects/<sanitised-cwd>/`:

```
agents/<CODE>/{kickoff,goals,soul,pre-compact,reawaken}.md
agents.json              project roster
audit.json               transition / comment / lesson log
brief.md                 canonical project scope (Lead writes here)
comments.json            ticket comments
inbox.json               notification queue
kill-switch.json         compliance kill-switch state
lessons.json             Bug Lessons (BL-NNN)
pending-lessons/         agent-written lesson sentinels (auto-ingested)
prefix.txt               3-letter ticket id prefix derived from project name
schedules.json           scheduled_for per ticket
state.json               project lifecycle (onboarding / active)
tickets.json             all tickets
```

Plus globally:

```
~/.yunomia/agent-models.json     sticky model picks
~/.yunomia/pty-audit-<CODE>.log  every byte Yunomia wrote to each agent's stdin
```

`<sanitised-cwd>` is the absolute path with `/` replaced by `-` and spaces replaced by `_`.

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

## License

MIT. See [LICENSE](./LICENSE).
