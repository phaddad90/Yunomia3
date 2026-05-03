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

## Research and development history

Yunomia is the third generation of an evolving experiment in turning a fleet of Claude Code sessions into something that behaves like a focused team rather than a pile of terminals. The arc:

### v1: Project Yunomia (concept stage)

The first attempt was raw: shell scripts, file-backed kickoffs, manual paste-relay between an orchestrator and worker terminals. It proved the core idea (multiple Claude Code sessions playing distinct roles, coordinating through written verdicts and a shared task list) but the operating overhead was high. Every wakeup, every handoff, every lesson capture was Peter typing.

### v2: Mission Control (PrintPepper, 2026 Q1 to Q2)

Mission Control was the working version of v1: a single-tenant browser dashboard at `localhost:4600` riding on top of PrintPepper's admin API. It introduced the seven-column kanban, the agent rail with traffic-light status, the per-ticket comment thread, the Bug Lessons archive (BL-NNN), the CEO inbox, the schedule poller, the heartbeat ticker, the file-backed kickoff and soul documents, and the compliance engine (`single-task-focus`, `qa-pass-required`, `bug-needs-lesson`, `patch-snake-case-rejected`, kill-switch, lint warnings).

Across roughly 130 tickets (PH-001 through PH-130-ish, on the `feature/printpepper-mission-control` branch), the system grew from a kanban viewer to a real orchestration surface. By the end of v2 the agents were filing their own lessons, the heartbeat was nudging stuck agents, and the compliance engine was rejecting bad ticket transitions. The drift point was that everything was tied to one company (PrintPepper), one admin API, one localhost server. It worked, but it could not move.

### v3: Yunomia (this repo)

v3 keeps the v2 operating model and packages it as a portable desktop application. Tauri shell, ptys hosting real Claude Code sessions, embedded kanban with no external server, file-backed everything at `~/.yunomia/`, project-agnostic by design, signed binaries for macOS and Windows.

The design decisions that survived from v2: file-backed kickoffs and souls (PH-090), the seven-column kanban (PH-051 through PH-097), Bug Lessons schema (PH-088 to PH-098), the per-agent traffic-light rail (PH-080, PH-094), Mission Control as a single window (PH-061 design doc), the auto-compact-at-50% rule (Peter's `feedback_compact_at_50pct.md`), and the compliance engine pattern (PH-123 convergence, PH-126 deploy).

The new ideas in v3: project picker so one app hosts many fleets; onboarding via a Lead agent that interviews the user, writes the brief, proposes the team, and files initial tickets; agent-side mid-project proposals (Lead writes `agent-proposal.json`); per-agent wakeup mode (`heartbeat` versus `on-assignment`); per-agent kickoff, goals, soul, pre-compact, and reawaken markdown all editable in-app; programmatic wakeup over pty stdin (no human paste); the bug-protocol gate (agent must consult lessons before working a bug); sentinel-file lesson ingestion (agents log lessons, not the user); xterm-based pane management with light and dark theming; and crash recovery via Claude Code's session resume.

The throughline: every layer of the operating model that worked in v2 is here, lifted out of PrintPepper-specific plumbing and packaged so any project can use it.

---

## License

MIT. See [LICENSE](./LICENSE).
