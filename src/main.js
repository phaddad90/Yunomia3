// Yunomia frontend — pane manager + xterm.js mounting per pty.
// Conventions:
//   • Each pty has a stable string id (typically the AGENT code: "CEO", "QA").
//   • Tauri events: `pty://output/<id>` carries stdout/stderr; `pty://exit/<id>` fires on child exit.
//   • Resize event triggers TIOCSWINSZ via `pty_resize` invoke.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { initCompactOrchestrator, noteTaskBoundary, firePreCompact, fireCompact, noteContextPercent } from './lib/compact-orchestrator.js';
import { startHeartbeat, noteWakeupSent, noteStdoutFromAgent } from './lib/heartbeat.js';
import { initKanban, setKanbanProject } from './lib/kanban.js';
import { loadOnboardingForProject, renderOnboardingView, reopenOnboarding } from './lib/onboarding.js';
import { refresh as refreshKanban, getTicketStats, setFilter as setKanbanFilter } from './lib/kanban.js';
import { renderLessonsView, bindLessonModal } from './lib/lessons.js';
import { renderActivityView, renderInboxView, renderReportsView, renderAgentsView, unprocessedInboxCount } from './lib/views.js';
import { writeToAgent } from './lib/mc-bridge.js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

const AGENT_MODELS_DEFAULT = {
  LEAD:'claude-opus-4-7',
  CEO: 'claude-opus-4-7',
  SA:  'claude-sonnet-4-6',
  AD:  'claude-sonnet-4-6',
  WA:  'claude-sonnet-4-6',
  DA:  'claude-sonnet-4-6',
  QA:  'claude-haiku-4-5-20251001',
  WD:  'claude-sonnet-4-6',
  TA:  'claude-opus-4-7',
};


const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

const state = {
  ptys: new Map(),         // key = `${cwd}|${code}` → { term, fit, unlistens, cwd, code, model, temp, lastStdoutAt, lastWriteAt, blockedReason }
  activePane: 'dashboard',
  stickyModels: {},        // PH-134 Phase 2: agent → model, persisted via Rust store
  maxConcurrent: 3,        // PH-134 Phase 3: concurrency limit slider
  tempAgents: new Set(),   // PH-134 Phase 3: agents flagged for auto-dispose after one task
  projects: [],            // PH-134: known project roots, persisted in localStorage
  selectedProject: '',     // current project cwd (drives spawn + resume)
};

// localStorage keys for projects.
const LS_PROJECTS = 'yunomia.projects';
const LS_SELECTED = 'yunomia.selectedProject';
const ADD_PROJECT_VALUE = '__add__';

function loadProjects() {
  try {
    state.projects = JSON.parse(localStorage.getItem(LS_PROJECTS) || '[]');
  } catch { state.projects = []; }
  state.selectedProject = localStorage.getItem(LS_SELECTED) || state.projects[0] || '';
}
function saveProjects() {
  localStorage.setItem(LS_PROJECTS, JSON.stringify(state.projects));
  localStorage.setItem(LS_SELECTED, state.selectedProject || '');
}
function projectLabel(p) {
  // Show last path segment as label.
  if (!p) return '?';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}
async function renderProjectPicker() {
  const sel = $('#project-picker');
  if (!sel) return;
  sel.innerHTML = '';
  if (!state.projects.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(none — click to add)'; opt.disabled = true; opt.selected = true;
    sel.appendChild(opt);
  } else {
    // Annotate with a 🔴 prefix when phase=onboarding for that project.
    for (const p of state.projects) {
      let prefix = '';
      try {
        const ps = await invoke('project_state_get', { args: { cwd: p } });
        if (ps?.phase !== 'active') prefix = '🔴 ';
      } catch { /* ignore */ }
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = `${prefix}${projectLabel(p)}`;
      opt.title = p;
      if (p === state.selectedProject) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  const addOpt = document.createElement('option');
  addOpt.value = ADD_PROJECT_VALUE; addOpt.textContent = '+ Add project…';
  sel.appendChild(addOpt);
}
function bindProjectPicker() {
  const sel = $('#project-picker');
  sel.addEventListener('change', () => {
    if (sel.value === ADD_PROJECT_VALUE) {
      openAddProjectModal();
      renderProjectPicker();   // restore previous selection visually until modal commits
      return;
    }
    state.selectedProject = sel.value;
    saveProjects();
    void refreshResumeBanner();
    void window.__renderProjectView?.();
  });
}

function openAddProjectModal() {
  const modal = $('#project-modal');
  if (!modal) return;
  $('#proj-name').value = '';
  $('#proj-path').value = '';
  modal.classList.remove('hidden');
  setTimeout(() => $('#proj-path').focus(), 0);
}
function closeAddProjectModal() { $('#project-modal').classList.add('hidden'); }
function bindAddProjectModal() {
  $('#proj-cancel').addEventListener('click', closeAddProjectModal);
  $('#project-modal').addEventListener('click', (e) => { if (e.target.id === 'project-modal') closeAddProjectModal(); });
  $('#proj-browse').addEventListener('click', async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: 'Pick project root' });
      if (!picked) return;
      $('#proj-path').value = String(picked);
      // Default the name from the basename if user hasn't typed one.
      if (!$('#proj-name').value.trim()) {
        const parts = String(picked).split('/').filter(Boolean);
        $('#proj-name').value = parts[parts.length - 1] || '';
      }
    } catch (err) {
      console.warn('dialog open failed', err);
    }
  });
  $('#project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = $('#proj-path').value.trim().replace(/\/+$/, '');
    if (!path) return;
    if (!path.startsWith('/')) { alert('Use an absolute path (must start with /)'); return; }
    if (!state.projects.includes(path)) state.projects.push(path);
    state.selectedProject = path;
    saveProjects();
    renderProjectPicker();
    closeAddProjectModal();
    // Optional friendly name → write to project_state
    const name = $('#proj-name').value.trim();
    if (name) {
      try { await invoke('project_state_set', { args: { cwd: path, patch: { project_name: name } } }); } catch { /* ignore */ }
    }
    void refreshResumeBanner();
    void window.__renderProjectView?.();
  });
}

function setActivePane(id) {
  state.activePane = id;
  $$('#pane-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === id));
  $$('#panes .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === id));
  const ent = state.ptys.get(id);
  if (ent) {
    // The pane just transitioned from display:none to display:flex — its
    // clientHeight only resolves after layout. Fit at multiple delays so the
    // first paint, the first reflow, and a 250 ms-late paint all converge.
    const f = () => { try { ent.fit.fit(); } catch {} };
    requestAnimationFrame(() => requestAnimationFrame(f));
    setTimeout(f, 100);
    setTimeout(f, 300);
  }
}

// Show/hide tabs + panes based on currently selected project.
function applyProjectVisibility() {
  const cwd = state.selectedProject;
  $$('#pane-tabs .tab').forEach((t) => {
    if (t.dataset.pane === 'dashboard') return;     // always visible
    t.style.display = (t.dataset.cwd === cwd) ? '' : 'none';
  });
  $$('#panes .pane').forEach((p) => {
    if (p.dataset.pane === 'dashboard') return;
    if (p.dataset.cwd && p.dataset.cwd !== cwd && p.classList.contains('active')) {
      p.classList.remove('active');
      $$('#pane-tabs .tab').forEach((t) => t.classList.remove('active'));
      const dash = $('#pane-tabs .tab[data-pane="dashboard"]');
      const dashPane = $('#panes .pane[data-pane="dashboard"]');
      if (dash) dash.classList.add('active');
      if (dashPane) dashPane.classList.add('active');
      state.activePane = 'dashboard';
    }
  });
}

function bindUi() {
  $$('#pane-tabs .tab').forEach((t) => t.addEventListener('click', () => setActivePane(t.dataset.pane)));
  $('#spawn-agent').addEventListener('click', openSpawnModal);
  $('#spawn-cancel').addEventListener('click', closeSpawnModal);
  $('#spawn-form').addEventListener('submit', (e) => { e.preventDefault(); submitSpawn(); });
  $('#spawn-modal').addEventListener('click', (e) => { if (e.target.id === 'spawn-modal') closeSpawnModal(); });
  window.addEventListener('resize', () => {
    const ent = state.ptys.get(state.activePane);
    if (ent) ent.fit.fit();
  });
}

async function openSpawnModal() {
  // Pre-fill model from sticky persistence per agent code.
  try { state.stickyModels = await invoke('models_get'); } catch { /* ignore */ }
  syncSpawnModelDefault();
  // Pre-fill cwd from the picked project root.
  const cwdInput = $('#spawn-cwd');
  if (cwdInput) cwdInput.value = state.selectedProject || '';
  if (cwdInput) cwdInput.placeholder = state.selectedProject || 'absolute path';
  $('#spawn-code').addEventListener('change', syncSpawnModelDefault, { once: false });
  $('#spawn-modal').classList.remove('hidden');
}
function syncSpawnModelDefault() {
  const code = $('#spawn-code').value;
  const sticky = state.stickyModels?.[code];
  const fallback = AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
  $('#spawn-model').value = sticky || fallback;
}
function closeSpawnModal() { $('#spawn-modal').classList.add('hidden'); }

async function submitSpawn() {
  const code = $('#spawn-code').value;
  const model = $('#spawn-model').value || AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
  const cwd = ($('#spawn-cwd').value || state.selectedProject || '').trim();
  if (!cwd) { alert('Pick a project first (top-bar).'); return; }
  // Auto-add to project list if it's a new path.
  if (!state.projects.includes(cwd)) {
    state.projects.push(cwd);
    state.selectedProject = cwd;
    saveProjects();
    renderProjectPicker();
    void window.__renderProjectView?.();
  }
  const temp = $('#spawn-temp')?.checked || false;
  // PH-134 Phase 3 — concurrency limit guard.
  if (state.ptys.size >= state.maxConcurrent) {
    if (!confirm(`At concurrency limit (${state.maxConcurrent}). Spawn anyway?`)) return;
  }
  closeSpawnModal();
  try {
    await spawnAgent(code, model, cwd, { temp });
  } catch (err) {
    console.error('spawn failed', err);
    alert('Spawn failed: ' + (err?.message || err));
  }
}

// Context-window estimate poller. Runs every 5s for each running pty, stores
// the latest estimate on the pty entry. Tab head, pane overlay, and agent
// rail all read from there.
async function refreshContextStats() {
  for (const [, ent] of state.ptys.entries()) {
    if (ent.exited) continue;
    try {
      const est = await invoke('agent_context_estimate', { args: { cwd: ent.cwd } });
      ent.contextEstimate = est || null;
      // Auto-compact at 50% when idle.
      if (est && ent.cwd === state.selectedProject) {
        const status = deriveStatus(ent).state;
        noteContextPercent(ent.code, est.percent, status === 'idle');
      }
    } catch (e) { /* ignore — file probably not there yet */ }
  }
}
setInterval(refreshContextStats, 5000);
setTimeout(refreshContextStats, 1500);   // first reading shortly after boot

function contextChipHtml(est) {
  if (!est) return '';
  const p = est.percent ?? 0;
  const cls = p >= 50 ? 'cw-red' : p >= 30 ? 'cw-amber' : 'cw-green';
  return `<span class="cw-chip ${cls}" title="${est.tokens_estimated.toLocaleString()} tokens (~est) · session ${est.session_id.slice(0,8)}">${p}%</span>`;
}

// Composite key — same agent code can run independently per project.
// Must be Tauri-event-safe: only [A-Za-z0-9_-]. Slashes and pipes break
// the `pty://output/<id>` event channel silently → black-screen pty.
function ptyKey(cwd, code) {
  const safe = String(cwd).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe}__${code}`;
}
function visibleAgents() {
  const out = [];
  for (const [key, ent] of state.ptys.entries()) {
    if (ent.cwd === state.selectedProject) out.push({ key, ent });
  }
  return out;
}

// Spawn one agent in a new pty pane in the given project's cwd.
async function spawnAgent(code, model, cwd, opts = {}) {
  const key = ptyKey(cwd, code);
  if (state.ptys.has(key)) {
    setActivePane(key);
    return;
  }
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.pane = key;
  tabBtn.dataset.cwd = cwd;
  tabBtn.dataset.code = code;
  tabBtn.innerHTML = `<span class="status-dot" data-status="idle"></span><span class="tab-emoji">${tabEmoji(code)}</span> ${code} <span class="cw-slot"></span> <span class="tab-close" title="Kill" data-kill="1">×</span>`;
  tabBtn.addEventListener('click', (e) => {
    if (e.target.dataset.kill) { void killPty(key); return; }
    setActivePane(key);
  });
  $('#pane-tabs').appendChild(tabBtn);

  const pane = document.createElement('section');
  pane.className = 'pane';
  pane.dataset.pane = key;
  pane.dataset.cwd = cwd;
  const overlay = document.createElement('div');
  overlay.className = 'pane-overlay';
  overlay.innerHTML = `<span class="pane-overlay-model">${escapeHtml(model)}</span> <span class="pane-overlay-cw"></span>`;
  pane.appendChild(overlay);
  const termWrap = document.createElement('div');
  termWrap.className = 'term-wrap';
  pane.appendChild(termWrap);
  $('#panes').appendChild(pane);

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    theme: xtermTheme(),
    convertEol: true,
    scrollback: 10_000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termWrap);
  // Use rAF + a small extra delay so the pane's flex layout has settled
  // before fit reads clientWidth/clientHeight. Without this, fit() runs
  // against a 0×0 container and the term never grows.
  requestAnimationFrame(() => requestAnimationFrame(() => { try { fit.fit(); } catch {} }));
  setTimeout(() => { try { fit.fit(); } catch {} }, 200);
  // Watch the container — any resize (window grows, devtools open, sidebar
  // collapses) re-fits the terminal to fill the pane.
  const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
  ro.observe(termWrap);
  // Mouse-wheel → scroll the terminal's scrollback. xterm normally hooks
  // wheel itself but the flex wrapper can swallow events; explicit listener
  // makes scrollback reliably reachable.
  termWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const linesPerPx = 1 / 16;
    const delta = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) * linesPerPx));
    try { term.scrollLines(delta); } catch {}
  }, { passive: false });

  setActivePane(key);

  // Stream stdout from the pty into xterm.
  const unlistenOut = await listen(`pty://output/${key}`, (evt) => {
    term.write(evt.payload);
    noteStdoutFromAgent(code);
    const ent = state.ptys.get(key);
    if (ent) ent.lastStdoutAt = Date.now();
  });
  const unlistenExit = await listen(`pty://exit/${key}`, (evt) => {
    const code = evt.payload?.code ?? '?';
    term.writeln(`\r\n\x1b[31m[pty exited code=${code}]\x1b[0m`);
    term.writeln(`\x1b[33mIf this happened immediately, the spawn args were rejected by claude. Check that the 'claude' CLI is on PATH and the --permission-mode flag is supported on this version.\x1b[0m`);
    const ent = state.ptys.get(key);
    if (ent) ent.exited = true;
  });

  // Stdin: forward xterm input.
  term.onData((data) => {
    invoke('pty_write', { args: { id: key, data } }).catch((e) => console.warn('pty_write', e));
    const ent = state.ptys.get(key);
    if (ent) ent.lastWriteAt = Date.now();
  });
  // TIOCSWINSZ on resize.
  term.onResize(({ cols, rows }) => {
    invoke('pty_resize', { args: { id: key, cols, rows } }).catch((e) => console.warn('pty_resize', e));
  });

  state.ptys.set(key, {
    term, fit, ro, unlistens: [unlistenOut, unlistenExit],
    cwd, code, model, temp: !!opts.temp,
    lastStdoutAt: 0, lastWriteAt: 0, blockedReason: null, exited: false,
    spawnedAt: Date.now(),
  });
  if (opts.temp) state.tempAgents.add(key);

  // Spawn the actual claude process. Args:
  //   --model <model>                 per-agent /model selection
  //   --permission-mode acceptEdits   tiered-allowlist autonomy (internal trust)
  //   (project dir is the cwd; claude infers session there)
  // Crash-recovery resume path uses --resume <session_id>; passed via opts.resume.
  // opts.kickoff = onboarding kickoff prompt — auto-pasted after spawn (Lead path).
  const args = ['--model', model, '--permission-mode', 'acceptEdits'];
  if (opts.resume) args.push('--resume', opts.resume);
  // Spawn the actual claude process with composite key as pty id.
  try {
    await invoke('pty_spawn', {
      args: { id: key, command: 'claude', args, cwd, env: null, cols: term.cols, rows: term.rows },
    });
  } catch (e) {
    // Surface the error inside the xterm pane so it's not a silent black box.
    const msg = String(e?.message || e);
    term.writeln(`\x1b[31m[spawn failed]\x1b[0m ${msg}`);
    term.writeln(`\x1b[33mHints:\x1b[0m`);
    term.writeln('  • Is the `claude` CLI on your PATH? Try `which claude` in a normal terminal.');
    term.writeln('  • If --permission-mode is unsupported on this claude version, edit src/main.js');
    term.writeln('    and remove that flag.');
    return;
  }
  // Persist the sticky model so this agent re-spawns with the same one.
  try { await invoke('models_set', { args: { code, model } }); state.stickyModels[code] = model; }
  catch (e) { console.warn('models_set failed', e); }
  // PH-134 onboarding — auto-paste the lead kickoff after pty boot. Two-second
  // delay so claude has finished its TUI splash before we shove the prompt in.
  // Determine kickoff content: explicit opts.kickoff (Lead bootstrap) wins,
  // else read the per-agent kickoff.md from the project. If empty, no paste.
  let kickoffContent = opts.kickoff || '';
  if (!kickoffContent && code !== 'LEAD') {
    try {
      kickoffContent = await invoke('agent_file_get', { args: { cwd, code, kind: 'kickoff' } }) || '';
    } catch { /* ignore */ }
  }
  if (kickoffContent && kickoffContent.trim()) {
    const ent = state.ptys.get(key);
    if (ent && !ent.kickoffFired) {
      ent.kickoffFired = true;
      setTimeout(async () => {
        try {
          await invoke('pty_write', { args: { id: key, data: kickoffContent } });
          await new Promise((r) => setTimeout(r, 250));
          await invoke('pty_write', { args: { id: key, data: '\r' } });
        } catch (e) { console.warn('kickoff paste failed', e); }
      }, 2500);
    }
  }
}

// PH-134 Phase 2 — wakeup prompt content.
// For an already-running agent (the v3 case), the wakeup is a short ping;
// the agent already loaded their full kickoff at spawn. Spawn-time kickoff
// content can be wired later by reading SaaS Architect/<AGENT>-kickoff.md
// (deferred — not strictly needed for Phase 2 smoke).
function buildWakeupPrompt({ ticketHumanId, reason }) {
  const ref = ticketHumanId ? ` (${ticketHumanId})` : '';
  return `\n\n[Yunomia wakeup — ${reason}${ref}] Check your queue.\n`;
}

async function onWakeup(payload) {
  const { agentCode, ticketHumanId, reason } = payload;
  // Wakeup goes to the agent running in the CURRENT project (not arbitrary instance).
  const key = ptyKey(state.selectedProject, agentCode);
  if (!state.ptys.has(key)) return;
  try {
    await invoke('pty_write', { args: { id: key, data: buildWakeupPrompt(payload) } });
    noteWakeupSent(agentCode, ticketHumanId, reason);
    const ent = state.ptys.get(key);
    if (ent) ent.lastWriteAt = Date.now();
    console.info(`[wakeup] ${key} ← ${reason}`);
  } catch (err) {
    console.warn(`[wakeup] write failed for ${key}`, err);
  }
}

function maybeDisposeTempAgent(agentCode) {
  const key = ptyKey(state.selectedProject, agentCode);
  if (!state.tempAgents.has(key)) return;
  console.info(`[temp-agent] ${key} completed first task — auto-disposing in 30s`);
  state.tempAgents.delete(key);
  setTimeout(() => { void killPty(key); }, 30_000);
}

async function killPty(key) {
  const ent = state.ptys.get(key);
  if (!ent) return;
  try { await invoke('pty_kill', { args: { id: key } }); } catch { /* ignore */ }
  ent.unlistens.forEach((u) => u());
  try { ent.ro?.disconnect(); } catch { /* ignore */ }
  ent.term.dispose();
  state.ptys.delete(key);
  state.tempAgents.delete(key);
  $$('#pane-tabs .tab').forEach((t) => { if (t.dataset.pane === key) t.remove(); });
  $$('#panes .pane').forEach((p) => { if (p.dataset.pane === key) p.remove(); });
  if (state.activePane === key) setActivePane('dashboard');
}

function tabEmoji(code) {
  const e = { LEAD:'🧭', CEO:'🎯', SA:'🟧', AD:'🟦', WA:'🟪', DA:'🟨', QA:'🟥', WD:'🌐', TA:'🛠', PETER:'🎩' };
  return e[code] || '⬛';
}

// Project picker — load + render at boot, drives spawn cwd + resume banner.
loadProjects();
renderProjectPicker();
bindProjectPicker();
bindAddProjectModal();
void refreshResumeBanner();

// Status state machine — derived per pty from stdout/write timing + flags.
function deriveStatus(ent) {
  if (!ent || ent.exited) return { state: 'idle', label: 'exited' };
  if (ent.blockedReason) return { state: 'blocked', label: ent.blockedReason };
  const now = Date.now();
  const sinceOut = ent.lastStdoutAt ? now - ent.lastStdoutAt : Infinity;
  const sinceIn  = ent.lastWriteAt  ? now - ent.lastWriteAt  : Infinity;
  if (sinceOut < 3_000) return { state: 'working', label: 'working' };
  if (sinceIn  < 20_000 && sinceOut > sinceIn) return { state: 'waiting', label: 'waiting' };
  if (sinceOut < 30_000) return { state: 'waiting', label: 'thinking' };
  return { state: 'idle', label: 'idle' };
}

// Render the agent rail. Project-scoped — shows ONLY agents that actually
// exist for this project (currently running ptys). No phantom 9-slot fleet.
// New agents arrive via Lead's brief-approval flow OR explicit + Spawn agent.
function renderAgentRail() {
  const root = document.getElementById('agent-rail');
  if (!root) return;
  const cwd = state.selectedProject;
  const running = visibleAgents();      // [{ key, ent }] for this project
  const head = `<div class="ar-head">
    <span>Agents</span>
    <button id="ar-add" class="ar-add" title="Spawn agent">+</button>
  </div>`;
  if (!running.length) {
    root.innerHTML = `${head}<div class="ar-empty">No agents in this project yet. Click <b>+</b> to spawn one — or let the brief's proposed agents auto-populate after approval.</div>`;
  } else {
    let stats;
    try { stats = getTicketStats(); } catch { stats = { byAgent: {} }; }
    const list = running.map(({ key, ent }) => {
      const code = ent.code;
      const { state: stat, label } = deriveStatus(ent);
      const ticketCount = stats.byAgent[code] || 0;
      const ticketBadge = ticketCount > 0 ? `<span class="ar-tickets" title="${ticketCount} open ticket${ticketCount===1?'':'s'}">${ticketCount}</span>` : '';
      return `<li class="ar-row ar-${stat}" data-code="${code}" data-key="${key}">
        <span class="ar-emoji">${tabEmoji(code)}</span>
        <div class="ar-mid">
          <span class="ar-code">${code} ${ticketBadge}</span>
          <span class="ar-label">${escapeHtml(label)} ${contextChipHtml(ent.contextEstimate)}</span>
          <span class="ar-cmpct-row">
            <button class="ar-cmpct" data-act="precompact" title="Run /pre-compact">PRE</button>
            <button class="ar-cmpct" data-act="compact" title="Run /compact">CMPCT</button>
          </span>
        </div>
        <span class="ar-dot" data-status="${stat}"></span>
        <button class="ar-action" data-act="open" title="Open tab">↗</button>
        <button class="ar-action ar-kill" data-act="kill" title="Kill">✕</button>
      </li>`;
    }).join('');
    root.innerHTML = `${head}<ul class="ar-list">${list}</ul>`;
  }
  root.querySelector('#ar-add')?.addEventListener('click', () => {
    document.getElementById('spawn-agent')?.click();
  });
  root.querySelectorAll('.ar-row').forEach((row) => {
    const key = row.dataset.key;
    row.querySelector('[data-act="open"]')?.addEventListener('click', (e) => { e.stopPropagation(); setActivePane(key); });
    row.querySelector('[data-act="kill"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Kill ${row.dataset.code}?`)) return;
      void killPty(key);
    });
    row.querySelector('[data-act="precompact"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void firePreCompact(row.dataset.code);
    });
    row.querySelector('[data-act="compact"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void fireCompact(row.dataset.code);
    });
  });
}

// Update tab status dots + agent rail + context-window chips every second.
function statusLoopTick() {
  for (const [key, ent] of state.ptys.entries()) {
    const tab = document.querySelector(`#pane-tabs .tab[data-pane="${CSS.escape(key)}"] .status-dot`);
    if (tab) tab.dataset.status = deriveStatus(ent).state;
    const cwSlot = document.querySelector(`#pane-tabs .tab[data-pane="${CSS.escape(key)}"] .cw-slot`);
    if (cwSlot) cwSlot.innerHTML = contextChipHtml(ent.contextEstimate);
    const overlay = document.querySelector(`#panes .pane[data-pane="${CSS.escape(key)}"] .pane-overlay-cw`);
    if (overlay) overlay.innerHTML = ent.contextEstimate ? `${contextChipHtml(ent.contextEstimate)} <span class="pane-overlay-tok">${ent.contextEstimate.tokens_estimated.toLocaleString()} / 200K tok</span>` : '';
  }
  renderAgentRail();
}
setInterval(statusLoopTick, 1000);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Sub-tab switcher inside Dashboard pane.
function bindSubtabs() {
  document.querySelectorAll('#subtabs .subtab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#subtabs .subtab').forEach((x) => x.classList.toggle('active', x === b));
      const which = b.dataset.sub;
      document.querySelectorAll('.subview').forEach((v) => v.hidden = v.dataset.view !== which);
      // Filters bar only shows on Kanban.
      const filt = document.getElementById('kanban-filters');
      if (filt) filt.hidden = which !== 'kanban';
      // Right rail "new ticket" form only on Kanban.
      const railRight = document.querySelector('.rail-right');
      if (railRight) railRight.hidden = which !== 'kanban';
      void renderSubview(which);
    });
  });
}
async function renderSubview(which) {
  const cwd = state.selectedProject;
  if (!cwd) return;
  if (which === 'kanban')   { /* kanban renders itself via initKanban */ }
  if (which === 'activity') await renderActivityView(document.getElementById('activity-root'), cwd);
  if (which === 'inbox')    { await renderInboxView(document.getElementById('inbox-root'), cwd); refreshInboxBadge(); }
  if (which === 'lessons')  await renderLessonsView(document.getElementById('lessons-root'), cwd);
  if (which === 'reports')  await renderReportsView(document.getElementById('reports-root'), cwd);
  if (which === 'agents')   await renderAgentsView(document.getElementById('agents-root'), cwd);
}
async function refreshInboxBadge() {
  const cwd = state.selectedProject;
  const badge = document.getElementById('sub-badge-inbox');
  if (!cwd || !badge) return;
  const n = await unprocessedInboxCount(cwd);
  if (n > 0) { badge.hidden = false; badge.textContent = String(n); }
  else { badge.hidden = true; }
}
window.__refreshInboxBadge = refreshInboxBadge;
window.__renderLessons = () => renderSubview('lessons');
bindSubtabs();
bindLessonModal(() => state.selectedProject);

// Kanban filter wiring.
document.getElementById('filter-q')?.addEventListener('input', (e) => setKanbanFilter('q', e.target.value));
document.getElementById('filter-assignee')?.addEventListener('change', (e) => setKanbanFilter('assignee', e.target.value));
document.getElementById('filter-type')?.addEventListener('change', (e) => setKanbanFilter('type', e.target.value));
document.getElementById('filter-due')?.addEventListener('change', (e) => setKanbanFilter('due', e.target.value));

// Agent proposal poller — Lead writes agent-proposal.json mid-project; we
// surface it as a modal. User approves → ingests, spawns, clears the file.
async function proposalTick() {
  const cwd = state.selectedProject;
  if (!cwd) return;
  if (!document.getElementById('proposal-modal').classList.contains('hidden')) return; // already open
  let p = null;
  try { p = await invoke('agent_proposal_read', { args: { cwd } }); } catch { return; }
  if (!p) return;
  showProposalModal(p);
}
setInterval(proposalTick, 5000);
setTimeout(proposalTick, 1500);

function showProposalModal(p) {
  const modal = document.getElementById('proposal-modal');
  modal.querySelector('.proposal-summary').innerHTML = `
    <div class="proposal-row"><b>Code</b> ${escapeHtml(p.code)}</div>
    <div class="proposal-row"><b>Model</b> ${escapeHtml(p.model || 'claude-sonnet-4-6')}</div>
    <div class="proposal-row"><b>Wakeup</b> ${escapeHtml(p.wakeup_mode || 'on-assignment')}${p.heartbeat_min ? ` · ${p.heartbeat_min} min` : ''}</div>
    <div class="proposal-row"><b>Why</b> ${escapeHtml(p.reason || '(no reason)')}</div>
  `;
  modal.querySelectorAll('.proposal-pre').forEach((el) => {
    el.textContent = p[el.dataset.field] || '(default — Yunomia will fill in)';
  });
  document.getElementById('proposal-approve').onclick = async () => {
    try {
      const agent = await invoke('agent_proposal_approve', { args: { cwd: state.selectedProject, proposal: p } });
      modal.classList.add('hidden');
      // Auto-spawn if heartbeat (orchestrator); else stay dormant until ticket assigned.
      if (agent.wakeup_mode === 'heartbeat') {
        try { await spawnAgent(agent.code, agent.model, state.selectedProject, {}); } catch {}
      }
      void renderProjectView();
    } catch (err) { alert('Approve failed: ' + (err?.message || err)); }
  };
  document.getElementById('proposal-reject').onclick = async () => {
    if (!confirm(`Reject ${p.code} proposal? Lead will need to write a new one.`)) return;
    try { await invoke('agent_proposal_clear', { args: { cwd: state.selectedProject } }); } catch {}
    modal.classList.add('hidden');
  };
  modal.classList.remove('hidden');
}

// Schedule poller — every 30s checks schedules_due_now; appends to inbox + osascript.
async function scheduleTick() {
  const cwd = state.selectedProject;
  if (!cwd) return;
  try {
    const due = await invoke('schedules_due_now', { args: { cwd } }) || [];
    for (const d of due) {
      await invoke('inbox_append', { args: {
        cwd, kind: 'schedule.due',
        ticketHumanId: d.ticket_human_id,
        summary: `${d.ticket_human_id} scheduled time hit — ${d.ticket_title}`,
      }});
    }
    if (due.length) refreshInboxBadge();
  } catch { /* ignore */ }
}
setInterval(scheduleTick, 30_000);
setTimeout(scheduleTick, 3000);

// Brief auto-refresh poll — preserves form inputs by only updating the
// brief <pre> content, not re-running the whole render.
setInterval(async () => {
  if (document.getElementById('onboarding-root')?.hidden) return;
  const cwd = state.selectedProject;
  if (!cwd) return;
  try {
    const fresh = await invoke('brief_get', { args: { cwd } });
    const pre = document.querySelector('.onb-brief');
    if (pre && fresh) {
      // Only update if changed — avoids cursor jump if user is selecting text.
      if (pre.textContent !== fresh) pre.textContent = fresh;
    }
  } catch { /* ignore */ }
}, 3000);

// Project view switcher — onboarding (no project, or phase=onboarding) vs
// active (full kanban). Re-renders on project change + after brief approval.
async function renderProjectView() {
  applyProjectVisibility();
  const onbRoot    = document.getElementById('onboarding-root');
  const activeRoot = document.getElementById('dashboard-active');
  const spawnBtn   = document.getElementById('spawn-agent');
  const cwd = state.selectedProject;
  if (!cwd) {
    if (onbRoot)   { onbRoot.hidden = false; onbRoot.innerHTML = `<div class="onb-empty">Pick or add a project (top bar) to begin.</div>`; }
    if (activeRoot) activeRoot.hidden = true;
    if (spawnBtn)   spawnBtn.hidden = true;     // no project → no manual spawn
    return;
  }
  const { state: projState, brief } = await loadOnboardingForProject(cwd);
  if (projState.phase !== 'active') {
    if (activeRoot) activeRoot.hidden = true;
    if (onbRoot)    onbRoot.hidden = false;
    if (spawnBtn)   spawnBtn.hidden = true;     // onboarding spawns Lead via the onb CTA
    const leadKey = ptyKey(cwd, 'LEAD');
    const leadRunning = state.ptys.has(leadKey);
    renderOnboardingView({
      container: onbRoot,
      cwd,
      state: projState,
      brief,
      spawnAgent: (code, model, cwd, opts) => spawnAgent(code, model, cwd, opts),
      onApproved: () => renderProjectView(),
      leadRunning,
    });
  } else {
    if (onbRoot)    onbRoot.hidden = true;
    if (activeRoot) activeRoot.hidden = false;
    if (spawnBtn)   spawnBtn.hidden = false;    // active → manual spawn allowed
    initKanban({
      cwd,
      onWakeup: (payload) => onWakeup(payload),
    });
    // Render brief preview panel above kanban (collapsed by default).
    document.getElementById('brief-name').textContent = projState.project_name || projectLabel(cwd);
    document.getElementById('brief-content').textContent = brief || '(empty — Lead never wrote a brief?)';
    const reopenBtn = document.getElementById('brief-reopen');
    if (reopenBtn && !reopenBtn.dataset.bound) {
      reopenBtn.dataset.bound = '1';
      reopenBtn.addEventListener('click', async () => {
        if (!confirm('Re-open onboarding? Kanban will be hidden until you re-approve the brief.')) return;
        await reopenOnboarding(state.selectedProject);
        await renderProjectView();
      });
    }
  }
  // Dashboard tab badge: open ticket count for the current project.
  setTimeout(() => {
    try {
      const stats = getTicketStats();
      const tab = document.querySelector('#pane-tabs .tab[data-pane="dashboard"]');
      if (tab) {
        let badge = tab.querySelector('.tab-badge');
        if (stats.totalOpen > 0) {
          if (!badge) { badge = document.createElement('span'); badge.className = 'tab-badge'; tab.appendChild(badge); }
          badge.textContent = String(stats.totalOpen);
        } else if (badge) {
          badge.remove();
        }
      }
    } catch { /* kanban may not be hydrated yet */ }
  }, 200);
}

// Expose so the project picker triggers re-render too.
window.__renderProjectView = renderProjectView;
void renderProjectView();

// ─── Drag-to-resize rails ───
// Saves widths to localStorage; restores on boot. Min 180px, max 50vw.
const LS_RAIL_LEFT  = 'yunomia.railLeftW';
const LS_RAIL_RIGHT = 'yunomia.railRightW';
function applyRailWidths() {
  const left  = parseInt(localStorage.getItem(LS_RAIL_LEFT)  || '240', 10);
  const right = parseInt(localStorage.getItem(LS_RAIL_RIGHT) || '320', 10);
  document.documentElement.style.setProperty('--rail-left-w',  `${left}px`);
  document.documentElement.style.setProperty('--rail-right-w', `${right}px`);
}
applyRailWidths();
function bindResizers() {
  document.querySelectorAll('.resizer').forEach((r) => {
    r.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const side = r.dataset.resize;
      const startX = e.clientX;
      const startLeft  = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--rail-left-w'), 10) || 240;
      const startRight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--rail-right-w'), 10) || 320;
      document.body.style.cursor = 'col-resize';
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (side === 'left') {
          const next = Math.max(180, Math.min(window.innerWidth * 0.5, startLeft + dx));
          document.documentElement.style.setProperty('--rail-left-w', `${next}px`);
          localStorage.setItem(LS_RAIL_LEFT, String(Math.round(next)));
        } else {
          const next = Math.max(180, Math.min(window.innerWidth * 0.5, startRight - dx));
          document.documentElement.style.setProperty('--rail-right-w', `${next}px`);
          localStorage.setItem(LS_RAIL_RIGHT, String(Math.round(next)));
        }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}
bindResizers();

// ─── Theme ───
const LS_THEME = 'yunomia.theme';
function applyTheme() {
  const pref = localStorage.getItem(LS_THEME) || 'light';
  let resolved = pref;
  if (pref === 'auto') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = resolved;
  // Re-apply xterm theme to every running pty so the terminal pane follows.
  const t = xtermTheme();
  for (const ent of state.ptys?.values?.() || []) {
    try { ent.term.options.theme = t; } catch { /* xterm v5 API */ }
  }
  // Term-wrap background (the area outside the canvas) too.
  document.querySelectorAll('.pane .term-wrap').forEach((w) => { w.style.background = t.background; });
}

function xtermTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (dark) return {
    background: '#0a0a0b', foreground: '#ededed',
    cursor: '#ff5722', selectionBackground: '#3a1f17',
    black: '#3f3f46', red: '#f87171', green: '#4ade80', yellow: '#facc15',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d4d8',
    brightBlack: '#71717a', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fafafa',
  };
  return {
    background: '#ffffff', foreground: '#1a1a1a',
    cursor: '#d93a00', selectionBackground: '#ffe4d6',
    black: '#1a1a1a', red: '#d93a00', green: '#16a34a', yellow: '#a16207',
    blue: '#1d4ed8', magenta: '#7e22ce', cyan: '#0891b2', white: '#525252',
    brightBlack: '#525252', brightRed: '#dc2626', brightGreen: '#15803d', brightYellow: '#854d0e',
    brightBlue: '#1e40af', brightMagenta: '#6b21a8', brightCyan: '#0e7490', brightWhite: '#1a1a1a',
  };
}
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem(LS_THEME) || 'light') === 'auto') applyTheme();
});

// ─── Settings modal ───
function bindSettings() {
  const btn   = document.getElementById('settings-btn');
  const modal = document.getElementById('settings-modal');
  if (!btn || !modal) return;
  btn.addEventListener('click', () => openSettings());
  document.getElementById('settings-close').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target.id === 'settings-modal') modal.classList.add('hidden'); });
}
async function openSettings() {
  const modal = document.getElementById('settings-modal');
  // Theme toggle (icon buttons)
  const pref = localStorage.getItem(LS_THEME) || 'light';
  modal.querySelectorAll('#theme-toggle button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === pref);
    btn.onclick = () => {
      localStorage.setItem(LS_THEME, btn.dataset.theme);
      applyTheme();
      modal.querySelectorAll('#theme-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
    };
  });
  // Max concurrent
  const slider = document.getElementById('settings-max-concurrent');
  const val    = document.getElementById('settings-max-concurrent-val');
  slider.value = String(state.maxConcurrent);
  val.textContent = String(state.maxConcurrent);
  slider.oninput = () => {
    state.maxConcurrent = parseInt(slider.value, 10) || 3;
    val.textContent = String(state.maxConcurrent);
    localStorage.setItem('yunomia.maxConcurrent', String(state.maxConcurrent));
  };
  // Per-agent model defaults moved to per-project Agents tab.
  modal.classList.remove('hidden');
}
bindSettings();

// Restore maxConcurrent on boot.
state.maxConcurrent = parseInt(localStorage.getItem('yunomia.maxConcurrent') || '3', 10);

// Keyboard shortcuts — match IDE muscle memory.
//   Cmd+T  = open spawn-agent modal (when active phase)
//   Cmd+W  = close current tab (if not Dashboard)
//   Cmd+1..9 = switch to nth tab
window.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  // Cmd+T → spawn
  if (e.key === 't' && !e.shiftKey) {
    const btn = document.getElementById('spawn-agent');
    if (btn && !btn.hidden) { e.preventDefault(); btn.click(); }
    return;
  }
  // Cmd+W → close current pane (skip Dashboard)
  if (e.key === 'w') {
    if (state.activePane && state.activePane !== 'dashboard') {
      e.preventDefault();
      void killPty(state.activePane);
    }
    return;
  }
  // Cmd+1..9 → switch tab
  if (e.key >= '1' && e.key <= '9') {
    const tabs = $$('#pane-tabs .tab').filter((t) => t.style.display !== 'none');
    const idx = parseInt(e.key, 10) - 1;
    if (tabs[idx]) { e.preventDefault(); tabs[idx].click(); }
  }
});

bindUi();

// PH-134 Phase 2 — bridge to MC + auto-compact orchestrator.
void initCompactOrchestrator();
startMcBridge({
  getRunningAgents: () => Array.from(state.ptys.keys()),
  onWakeup,
  onTaskBoundary: (evt) => {
    noteTaskBoundary(evt);
    maybeDisposeTempAgent(evt.agentCode);
  },
});

// Heartbeat — per-agent. Agents with wakeup_mode=heartbeat fire on cron.
startHeartbeat({
  getRunningAgents: () => visibleAgents().map(({ ent }) => ent.code),
  rewakeAgent: (code, ticketHumanId, reason) => onWakeup({ agentCode: code, ticketHumanId, reason }),
});

// PH-134 Phase 3 — crash recovery. Enumerates recent Claude sessions for the
// currently-selected project root and renders a banner offering Resume.
async function refreshResumeBanner() {
  document.querySelectorAll('.resume-banner').forEach((b) => b.remove());
  const cwd = state.selectedProject;
  if (!cwd) return;
  let sessions = [];
  try {
    sessions = await invoke('enumerate_sessions', { args: { cwd, limit: 8 } }) || [];
  } catch (err) { console.warn('enumerate_sessions failed', err); return; }
  if (!sessions.length) return;
  const recent = sessions.slice(0, 3);
  const html = recent.map((s) => {
    const when = s.modified ? new Date(s.modified).toLocaleString() : '?';
    return `<span class="resume-pill" data-sid="${s.session_id}">
      <button class="resume-btn" data-sid="${s.session_id}">Resume ${s.session_id.slice(0,8)} · ${when}</button>
      <button class="resume-kill" data-sid="${s.session_id}" title="Delete this session">🗑</button>
    </span>`;
  }).join(' ');
  const banner = document.createElement('div');
  banner.className = 'resume-banner';
  banner.innerHTML = `<span>Recent sessions in <b>${projectLabel(cwd)}</b>:</span> ${html} <button class="resume-dismiss" type="button">✕</button>`;
  document.body.insertBefore(banner, document.body.firstChild);
  banner.querySelectorAll('.resume-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const sid = b.dataset.sid;
      const code = 'LEAD';
      banner.remove();
      const model = state.stickyModels?.[code] || AGENT_MODELS_DEFAULT[code] || 'claude-sonnet-4-6';
      await spawnAgent(code, model, cwd, { resume: sid });
    });
  });
  banner.querySelectorAll('.resume-kill').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = b.dataset.sid;
      if (!confirm(`Delete session ${sid.slice(0,8)}? Conversation history will be lost permanently.`)) return;
      try {
        await invoke('delete_session', { args: { cwd, sessionId: sid } });
        b.closest('.resume-pill')?.remove();
        // If banner now empty, remove it.
        if (!banner.querySelectorAll('.resume-pill').length) banner.remove();
      } catch (err) { alert('Delete failed: ' + (err?.message || err)); }
    });
  });
  banner.querySelector('.resume-dismiss').addEventListener('click', () => banner.remove());
}

// Expose for console debugging during dogfood.
window.yunomia = { state, firePreCompact };
