# Yunomia

A multi-agent orchestration shell for any project. Open Yunomia, point it at a folder, talk to a Lead agent about your goals, and it will scope the work, propose an agent fleet, and file the initial tickets. From there you have one window with a kanban, ticket inbox, bug-lessons archive, activity feed, and a real `claude` CLI session per agent — all per-project, all file-backed locally.

> Built with Tauri 2 + portable-pty + xterm.js. Vanilla JS frontend, no framework. Apple Silicon and Windows binaries.

---

## What you get

- **Project picker** — Yunomia tracks any number of project roots. Each project is independent: own kanban, own agent fleet, own brief, own state, own audit log.
- **Onboarding** — first time you open a project, the Lead agent interviews you about goals, scope, constraints, deploy targets. Writes your evolving understanding to `brief.md`. Proposes agents + tickets. You approve, Yunomia auto-spawns the heartbeat agents and creates the tickets.
- **Live kanban** — 7-column (Backlog → Triage → Assigned → In Progress → In Review → Done → Released). Click any card for a side panel: title click-to-edit, type / audience / assignee / status selects, body ✏ pencil, comment thread, schedule picker, Start / Handoff / Done.
- **Bug lessons** — when a `type=bug` ticket transitions to done, you're prompted to capture a Bug Lesson (BL-NNN) with symptom / root cause / fix / files / recognise pattern / prevent action / tags. Browseable archive.
- **Schedules** — set a `scheduled_for` on any ticket. Cards show 🔔 + relative time, red when overdue. A 30 s poller fires inbox notifications when due.
- **Inbox** — per-project notification queue with unprocessed badge. Schedules due, ticket assignments, comments, bug closures, agent proposals.
- **Activity feed** — read-only audit log of every transition / comment / lesson capture / agent change.
- **Reports** — today's open / in progress / in review / done summary, plus by-agent active counts.
- **Agent rail** — only shows agents actually in this project. Each row: emoji + code + status (working/waiting/blocked/idle) + colored pulse dot + ticket count + context % chip + per-agent PRE / CMPCT buttons + open-tab + kill.
- **Per-agent files** — every agent has `soul.md / kickoff.md / pre-compact.md / reawaken.md` editable in the Agents sub-tab.
- **Per-agent wakeup mode** — `heartbeat` (cron-fires every N minutes even with no work) for orchestrators like Lead/CEO; `on-assignment` (wakes only when ticketed) for workers. Configurable per agent.
- **Lead-proposed mid-project agents** — Lead writes `agent-proposal.json` to ask for a new agent. Yunomia surfaces a modal with previews of soul / kickoff / pre-compact / reawaken; click Approve and the four files are scaffolded + the agent is spawned.
- **Auto-compact at 50%** — when an agent's context hits 50% AND it's idle, `/pre-compact` fires automatically. Manual PRE / CMPCT buttons in the agent rail.
- **Crash recovery** — Yunomia closes mid-conversation? On reopen, a banner offers Resume buttons for recent Claude sessions in the project. Per-session 🗑 to delete.
- **Compliance hooks** — `eligible_actions` + kill-switch backend ready (UI consumption is ongoing).
- **Drag-resizable rails** — left agent rail and right new-ticket rail both resize. Persisted.
- **Light / Dark / Auto theme** — Settings (⚙ in topbar). Auto follows OS.

---

## Install

### macOS (Apple Silicon + Intel)

Download the latest `.dmg` from [Releases](https://github.com/phaddad90/Yunomia3/releases). Drag Yunomia.app to /Applications.

> **First-launch on macOS**: until the app is notarized you'll see "Yunomia is from an unidentified developer." Right-click the app → Open → Open to bypass once. After signing + notarization (see *Building & signing* below) this prompt is gone.

### Windows

Download the latest `.msi` from [Releases](https://github.com/phaddad90/Yunomia3/releases). Run the installer.

### Linux

Download the latest `.AppImage` or `.deb` from [Releases](https://github.com/phaddad90/Yunomia3/releases).

---

## Prerequisites

- **`claude` CLI** on `PATH` — Yunomia spawns this for each agent pty. If `which claude` returns nothing, Yunomia panes will be empty. Install from [claude.com/claude-code](https://claude.com/claude-code).
- That's it. Everything else (project state, brief, tickets, lessons, audit, agent files) lives at `~/.yunomia/projects/<sanitised-cwd>/`.

---

## How to use

### 1. Add your first project

- Click **+ Spawn agent**? No — first add a project. Top-bar **Project ▼ → + Add project…** → use the Browse… button to pick a folder. Project name auto-defaults to the folder basename.

### 2. Onboarding

- Yunomia opens the **Onboarding view** for new projects. Click **Spawn lead agent**.
- A new `🧭 LEAD` tab opens with `claude` running in your project. The founder kickoff auto-pastes after ~2.5 s and Lead starts the interview.
- Answer questions in the LEAD tab. Lead writes `brief.md` incrementally as you talk. Switch to the Dashboard tab to watch the brief grow live.
- When ready, Lead writes `proposed-tickets.json` and `proposed-agents.json` to your project state dir.
- Click **Approve brief — go active**. Yunomia ingests the proposals: creates each ticket, populates the agent roster, auto-spawns heartbeat agents.

### 3. Active mode

- Dashboard sub-tabs: **Kanban / Activity / Inbox / Lessons / Reports / Agents**.
- Kanban filters: search, assignee, type, due. Click any card → side panel with all editing affordances.
- Lessons tab captures + browses Bug Lessons. Bug-close hook auto-prompts when a `type=bug` ticket transitions to done.
- Agents tab is the project's roster config: per-agent model + wakeup mode (heartbeat | on-assignment) + heartbeat interval + collapsible Kickoff / Goals / Soul markdown editors.
- **Lead can propose new agents mid-project** — writes `agent-proposal.json`; Yunomia surfaces a modal; you approve, files are scaffolded, agent spawns.

### 4. Per-agent compact

- Each agent rail row has **PRE** and **CMPCT** buttons.
- Auto-compact fires automatically at 50 % context when the agent is idle.

### 5. Switching projects

- Top-bar Project picker. 🔴 prefix indicates onboarding hasn't completed yet.
- Each project is fully isolated: separate ptys, separate kanban, separate everything.

### 6. Closing & resuming

- Close the window any time. Conversation history is in `~/.claude/projects/...`.
- On reopen, a yellow banner offers **Resume** for the 3 most recent sessions in the current project. Per-entry 🗑 to delete a session permanently.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘T | Spawn agent (active phase only) |
| ⌘W | Close current pty tab |
| ⌘1 – ⌘9 | Switch to nth visible tab |
| ⌘R | Reload Yunomia |

---

## Building from source

```bash
git clone https://github.com/phaddad90/Yunomia3.git
cd Yunomia3
npm install
npm run dev          # Tauri dev — vite + cargo run, opens window
```

Production build:

```bash
npm run build        # vite build + cargo build --release + bundle
# .app / .dmg lands in src-tauri/target/release/bundle/
```

### macOS code signing & notarization

Once you have an Apple Developer account ($99/year) and a Developer ID Application certificate in Keychain:

1. Edit `src-tauri/tauri.conf.json` → `bundle.macOS.signingIdentity` to your cert's common name, e.g. `"Developer ID Application: Your Name (TEAMID)"`.
2. Set notarization env vars (read by Tauri's bundler):
   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_PASSWORD="app-specific-password"  # generate at appleid.apple.com
   export APPLE_TEAM_ID="ABCDEFGHIJ"
   ```
3. `npm run build`. The bundler signs + submits for notarization automatically. The resulting `.dmg` will install without the "unidentified developer" prompt.

### Windows build (from macOS or CI)

Easiest path is GitHub Actions — see `.github/workflows/release.yml`. To build locally on Windows:

```powershell
npm install
npm run build
```

Produces `.msi` in `src-tauri\target\release\bundle\msi\`.

### Releases via GitHub Actions

Push a tag matching `v*.*.*` (e.g. `git tag v0.1.0 && git push origin v0.1.0`). Actions builds for macOS + Windows + Linux and uploads artifacts to Releases automatically.

---

## State on disk

Everything Yunomia writes lives at `~/.yunomia/projects/<sanitised-cwd>/`:

```
agents/<CODE>/{kickoff,goals,soul,pre-compact,reawaken}.md
agents.json              # project roster
audit.json               # transition / comment / lesson log
brief.md                 # canonical project scope (Lead writes here)
comments.json            # ticket comments
inbox.json               # notification queue
kill-switch.json         # compliance kill-switch state
lessons.json             # Bug Lessons (BL-NNN)
prefix.txt               # 3-letter ticket id prefix derived from project name
schedules.json           # scheduled_for per ticket
state.json               # project lifecycle (onboarding / active)
tickets.json             # all tickets
```

Plus globally:

```
~/.yunomia/agent-models.json     # sticky model picks
~/.yunomia/pty-audit-<CODE>.log  # everything Yunomia wrote to each agent's stdin
```

**Sanitised cwd** = absolute path with `/` replaced by `-` and spaces by `_`.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Status

v0.1 — feature-complete, single-user. Public release pending Apple notarization + Windows signing certs. Compliance UI consumption + Pass B governance features (kill-switch UI, hook-driven exact context %) on the roadmap.
